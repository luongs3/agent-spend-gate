import { sha256 } from './canonical.mjs';

const MAX_BYTES = 1024 * 1024;
const INJECTION = [/\bignore (all |any |your |the )?(previous |prior )?(instructions|budget|rules|limits|policy)/i,
  /\bSYSTEM\s*:/, /\bdisregard (your|all|previous)/i, /\byou are (an? )?(ai|assistant|agent)\b/i, /\bnew instructions\b/i];

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
export const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

export function parsePrice(s) {
  const m = String(s).match(/\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export function hostAllowed(policy, merchant, url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return { ok: false, host: null }; }
  const hosts = policy.merchant_hosts?.[merchant] || [merchant];
  return { ok: hosts.some(h => host === h || host.endsWith('.' + h)), host };
}

// Pure matcher over already-fetched page text.
export function matchEvidence({ text, quote, amount, quantity = 1 }) {
  const reasons = [];
  const found = !!quote && normalize(text).includes(normalize(quote));
  if (!found) reasons.push('evidence_quote not found verbatim on the page');
  const price = parsePrice(quote || '');
  if (price === null) reasons.push('no $ price in evidence_quote');
  else if (Math.round(price * 100) * quantity !== Math.round(Number(amount) * 100))
    reasons.push(`quoted price $${price.toFixed(2)} x${quantity} != requested amount $${Number(amount).toFixed(2)}`);
  const inj = INJECTION.filter(r => r.test(text)).map(r => r.source);
  if (inj.length) reasons.push('evidence page contains instructions aimed at AI agents (prompt injection)');
  return { ok: reasons.length === 0, found, price, injection: inj.length > 0, reasons };
}

// The gate fetches evidence itself: no redirects, 5s timeout, 1MB cap.
export async function fetchEvidence(url) {
  const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'agent-spend-gate/1.0' } });
  if (r.status >= 300 && r.status < 400) throw new Error(`evidence url redirected (${r.status}); redirects not followed`);
  if (!r.ok) throw new Error(`evidence url returned HTTP ${r.status}`);
  const reader = r.body.getReader(); const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    n += value.length; if (n > MAX_BYTES) { reader.cancel(); throw new Error('evidence page larger than 1MB'); }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return { text: htmlToText(raw), page_sha256: sha256(raw) };
}

export async function checkEvidence(policy, req, fetcher = fetchEvidence) {
  const out = { url: req.evidence_url || null, quote: req.evidence_quote || null, found: false, page_sha256: null };
  if (!req.evidence_url || !req.evidence_quote) {
    return { ...out, ok: !policy.require_evidence, reasons: policy.require_evidence ? ['evidence_url and evidence_quote are required'] : [] };
  }
  const h = hostAllowed(policy, req.merchant, req.evidence_url);
  if (!h.ok) return { ...out, ok: false, reasons: [`evidence host ${h.host} does not belong to merchant ${req.merchant}`] };
  let page;
  try { page = await fetcher(req.evidence_url); } catch (e) { return { ...out, ok: false, reasons: [`evidence fetch failed: ${e.message}`] }; }
  const m = matchEvidence({ text: page.text, quote: req.evidence_quote, amount: req.amount, quantity: Number(req.quantity ?? 1) });
  return { ...out, found: m.found, page_sha256: page.page_sha256, injection: m.injection, ok: m.ok, reasons: m.reasons };
}
