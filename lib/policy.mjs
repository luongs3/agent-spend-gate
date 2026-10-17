import { canonical, sha256 } from './canonical.mjs';

export const DEFAULT_POLICY = {
  currency: 'USD',
  per_order_cap: 150,
  daily_cap: 160,
  hold_over: 100,
  max_quantity: 1,
  dedupe_window_s: 60,
  merchant_allowlist: ['gadgets.example'],
  // Which evidence hosts count as the merchant's own site (demo catalog is served locally).
  merchant_hosts: { 'gadgets.example': ['gadgets.example', 'localhost', '127.0.0.1'] },
  allowed_ship_to: ['home', 'office'],
  require_evidence: true,
};

export const policyHash = (p) => sha256(canonical(p));
const cents = (x) => Math.round(Number(x) * 100);

// Pure policy evaluation. Evidence is checked separately; this only looks at the request + spend state.
// Returns { verdict: 'ALLOW'|'HOLD'|'DENY', reasons: [] }
export function evaluatePolicy(policy, req, state = { spentTodayCents: 0, recentKeys: new Map() }, now = Date.now()) {
  const deny = [];
  const amount = Number(req.amount);
  const qty = Number(req.quantity ?? 1);
  if (!Number.isFinite(amount) || amount <= 0) deny.push('amount must be a positive number');
  if (!Number.isInteger(qty) || qty < 1) deny.push('quantity must be a positive integer');
  if (String(req.currency || '').toUpperCase() !== policy.currency) deny.push(`currency ${req.currency} not allowed (policy: ${policy.currency})`);
  if (!policy.merchant_allowlist.includes(req.merchant)) deny.push(`merchant ${req.merchant} not on allowlist`);
  if (!policy.allowed_ship_to.includes(req.ship_to)) deny.push(`ship_to "${req.ship_to}" not an allowlisted address`);
  if (qty > policy.max_quantity) deny.push(`quantity ${qty} exceeds max_quantity ${policy.max_quantity}`);
  if (cents(amount) > cents(policy.per_order_cap)) deny.push(`amount $${amount.toFixed(2)} exceeds per_order_cap $${policy.per_order_cap}`);
  if (state.spentTodayCents + cents(amount) > cents(policy.daily_cap))
    deny.push(`daily_cap $${policy.daily_cap} would be exceeded (spent $${(state.spentTodayCents / 100).toFixed(2)} today)`);
  const key = idempotencyKey(req);
  const last = state.recentKeys.get(key);
  if (last && now - last < policy.dedupe_window_s * 1000)
    deny.push(`duplicate of an order placed ${Math.round((now - last) / 1000)}s ago (dedupe window ${policy.dedupe_window_s}s)`);
  if (deny.length) return { verdict: 'DENY', reasons: deny };
  if (cents(amount) > cents(policy.hold_over))
    return { verdict: 'HOLD', reasons: [`amount $${amount.toFixed(2)} over hold_over $${policy.hold_over}: funds authorized, awaiting human approval`] };
  return { verdict: 'ALLOW', reasons: ['within policy'] };
}

export function idempotencyKey(req) {
  // Keyed on what the money is for (merchant + evidence page + amount), not the free-text item name:
  // an LLM rewording "USB-C hub" as "7-in-1 USB-C Hub" must not slip a second order past dedupe.
  const product = req.evidence_url ? String(req.evidence_url).split(/[?#]/)[0] : String(req.item).toLowerCase().trim();
  return sha256(canonical({ m: req.merchant, p: product, a: cents(req.amount), s: req.ship_to, q: Number(req.quantity ?? 1) })).slice(0, 32);
}
