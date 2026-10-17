// The spend gate: policy + evidence -> PayPal -> signed receipt. The agent never sees PayPal credentials.
import { DEFAULT_POLICY, evaluatePolicy, policyHash, idempotencyKey } from './policy.mjs';
import { checkEvidence, fetchEvidence } from './evidence.mjs';
import { createReceiptLog } from './receipts.mjs';

const today = () => new Date().toISOString().slice(0, 10);

export function createGate({ paypal, policy = structuredClone(DEFAULT_POLICY), log = createReceiptLog(), fetcher = fetchEvidence } = {}) {
  const state = { day: today(), spentTodayCents: 0, recentKeys: new Map() };
  const holds = new Map(); // seq -> { authorization_id, amountCents, request }
  const pending = new Set(); // in-flight idempotency keys (concurrent duplicates)

  function rollDay() { if (state.day !== today()) { state.day = today(); state.spentTodayCents = 0; } }

  function normalizeReq(a) {
    return {
      merchant: String(a.merchant || '').trim().toLowerCase(), item: String(a.item || '').trim(),
      amount: Number(a.amount), currency: String(a.currency || 'USD').toUpperCase(),
      quantity: a.quantity === undefined ? 1 : Number(a.quantity),
      ship_to: String(a.ship_to || '').trim(), evidence_url: a.evidence_url || null, evidence_quote: a.evidence_quote || null,
    };
  }

  async function requestPayment(args, { simulateDecline = false, context = null } = {}) {
    rollDay();
    const request = normalizeReq(args);
    const pHash = policyHash(policy);
    const pol = evaluatePolicy(policy, request, state);
    const key = idempotencyKey(request);
    if (pending.has(key)) pol.verdict = 'DENY', pol.reasons = ['duplicate of an in-flight order'];
    const ev = await checkEvidence(policy, request, fetcher);
    const evidence = { url: ev.url, quote: ev.quote, found: ev.found, page_sha256: ev.page_sha256 };
    const base = { request, policy_hash: pHash, evidence, context, idempotency_key: key };

    if (pol.verdict === 'DENY' || !ev.ok) {
      const reasons = [...(pol.verdict === 'DENY' ? pol.reasons : []), ...ev.reasons];
      return log.append({ ...base, decision: 'DENY', reasons, paypal: null });
    }
    pending.add(key);
    try {
      const intent = pol.verdict === 'HOLD' ? 'AUTHORIZE' : 'CAPTURE';
      const pp = await paypal.createOrder({ intent, amount: request.amount, currency: request.currency,
        description: `${request.quantity}x ${request.item} @ ${request.merchant} (agent order)`, requestId: `asg-${key}-${Date.now()}`, simulateDecline });
      const ok = pp.ok && (intent === 'CAPTURE' ? pp.status === 'COMPLETED' : !!pp.authorization_id);
      const paypalOut = { intent, order_id: pp.order_id, capture_id: pp.capture_id || undefined, authorization_id: pp.authorization_id || undefined,
        status: pp.status, http: pp.http, debug_id: pp.debug_id, error: pp.error || undefined };
      if (!ok) return log.append({ ...base, decision: 'FAILED', reasons: [`PayPal ${intent} failed: ${pp.error || pp.status}`], paypal: paypalOut });
      state.spentTodayCents += Math.round(request.amount * 100); // holds reserve budget too
      state.recentKeys.set(key, Date.now());
      const r = log.append({ ...base, decision: pol.verdict, reasons: pol.reasons, paypal: paypalOut });
      if (pol.verdict === 'HOLD') holds.set(r.seq, { authorization_id: pp.authorization_id, amountCents: Math.round(request.amount * 100), request });
      return r;
    } finally { pending.delete(key); }
  }

  async function resolveHold(seq, action, approver = 'human') {
    const h = holds.get(Number(seq));
    if (!h) throw new Error(`no open hold with seq ${seq}`);
    holds.delete(Number(seq));
    const rid = `asg-hold-${seq}-${action}`;
    const pp = action === 'approve' ? await paypal.captureAuthorization(h.authorization_id, rid) : await paypal.voidAuthorization(h.authorization_id, rid);
    if (action === 'reject' && pp.ok) state.spentTodayCents -= h.amountCents;
    if (!pp.ok) holds.set(Number(seq), h);
    return log.append({
      request: h.request, policy_hash: policyHash(policy), evidence: null, context: { hold_seq: Number(seq), approver },
      decision: !pp.ok ? 'FAILED' : action === 'approve' ? 'APPROVED' : 'REJECTED',
      reasons: [!pp.ok ? `PayPal ${action} failed: ${pp.error || pp.status}` : action === 'approve' ? `hold #${seq} approved by ${approver}; authorization captured` : `hold #${seq} rejected by ${approver}; authorization voided`],
      paypal: { authorization_id: h.authorization_id, capture_id: pp.capture_id || undefined, status: pp.status, http: pp.http, debug_id: pp.debug_id },
    });
  }

  return {
    requestPayment, resolveHold, log, state,
    get policy() { return policy; },
    setPolicy(p) { policy = p; },
    openHolds: () => [...holds.keys()],
    resetDay() { state.spentTodayCents = 0; state.recentKeys.clear(); },
  };
}

// Counterfactual for the eval: what an agent with raw PayPal access would do. No policy, no evidence.
export async function ungatedPay(paypal, args, { live = false, simulateDecline = false } = {}) {
  const amt = Number(args.amount) || 0;
  if (!live) return { status: simulateDecline ? 'DECLINED' : 'PAID', amount: amt, ship_to: args.ship_to, simulated: true };
  const pp = await paypal.createOrder({ intent: 'CAPTURE', amount: amt, currency: args.currency || 'USD',
    description: `UNGATED ${args.item}`, requestId: `ungated-${Date.now()}-${Math.random()}`, simulateDecline });
  return { status: pp.ok ? 'PAID' : 'DECLINED', amount: amt, ship_to: args.ship_to, order_id: pp.order_id, paypal_status: pp.status };
}

export const REQUEST_PAYMENT_SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: 'string', description: 'Merchant domain, e.g. gadgets.example' },
    item: { type: 'string', description: 'Product name' },
    amount: { type: 'number', description: 'Total amount to pay (unit price x quantity)' },
    currency: { type: 'string', description: 'ISO currency, e.g. USD' },
    quantity: { type: 'integer', description: 'Number of units (default 1)' },
    ship_to: { type: 'string', description: 'Shipping address label or full address' },
    evidence_url: { type: 'string', description: 'URL of the product page that shows the price' },
    evidence_quote: { type: 'string', description: 'Exact text copied from that page that contains the product and price' },
  },
  required: ['merchant', 'item', 'amount', 'currency', 'ship_to', 'evidence_url', 'evidence_quote'],
};
