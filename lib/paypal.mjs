// Minimal PayPal REST client (sandbox): OAuth, Orders v2, Payments v2 authorizations.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TEST_CARD = { number: '4032039317984658', expiry: '2030-12', security_code: '123', name: 'Test Buyer' };

export function loadCreds() {
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
    return { client_id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET,
      base: process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com' };
  }
  const file = process.env.PAYPAL_CREDS_FILE || join(homedir(), '.config/me-secrets/paypal-sandbox-us.json');
  if (!existsSync(file)) throw new Error(`PayPal creds not found (set PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET or PAYPAL_CREDS_FILE)`);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  return { client_id: c.client_id, secret: c.secret, base: c.base || 'https://api-m.sandbox.paypal.com' };
}

export function createPayPal(creds = loadCreds()) {
  if (!creds.base.includes('sandbox')) throw new Error('refusing to run against non-sandbox PayPal');
  let token = null, tokenExp = 0;

  async function getToken() {
    if (token && Date.now() < tokenExp - 60_000) return token;
    const r = await fetch(`${creds.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${creds.client_id}:${creds.secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok) throw new Error(`PayPal OAuth failed: ${r.status}`);
    const j = await r.json();
    token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
    return token;
  }

  async function call(method, path, body, extraHeaders = {}) {
    const r = await fetch(`${creds.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json',
        Prefer: 'return=representation', ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    return { http: r.status, ok: r.ok, json, debug_id: r.headers.get('paypal-debug-id') || json?.debug_id || null };
  }

  // Card-funded order: intent CAPTURE completes immediately, AUTHORIZE holds funds.
  async function createOrder({ intent, amount, currency, description, requestId, simulateDecline }) {
    const headers = { 'PayPal-Request-Id': requestId };
    if (simulateDecline) headers['PayPal-Mock-Response'] = JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' });
    const res = await call('POST', '/v2/checkout/orders', {
      intent,
      purchase_units: [{ amount: { currency_code: currency, value: Number(amount).toFixed(2) }, description: description.slice(0, 127) }],
      payment_source: { card: TEST_CARD },
    }, headers);
    const pu = res.json?.purchase_units?.[0]?.payments;
    const cap = pu?.captures?.[0], auth = pu?.authorizations?.[0];
    return {
      http: res.http, ok: res.ok, debug_id: res.debug_id,
      order_id: res.json?.id || null,
      order_status: res.json?.status || null,
      capture_id: cap?.id || null, authorization_id: auth?.id || null,
      status: cap?.status || auth?.status || res.json?.status || res.json?.name || `HTTP_${res.http}`,
      error: res.ok ? null : (res.json?.details?.[0]?.issue || res.json?.name || `HTTP_${res.http}`),
    };
  }

  async function captureAuthorization(id, requestId) {
    const res = await call('POST', `/v2/payments/authorizations/${id}/capture`, {}, { 'PayPal-Request-Id': requestId });
    return { http: res.http, ok: res.ok, debug_id: res.debug_id, capture_id: res.json?.id || null,
      status: res.json?.status || `HTTP_${res.http}`, error: res.ok ? null : (res.json?.details?.[0]?.issue || res.json?.name) };
  }

  async function voidAuthorization(id, requestId) {
    const res = await call('POST', `/v2/payments/authorizations/${id}/void`, null, { 'PayPal-Request-Id': requestId });
    return { http: res.http, ok: res.ok, debug_id: res.debug_id, status: res.ok ? 'VOIDED' : `HTTP_${res.http}`,
      error: res.ok ? null : (res.json?.details?.[0]?.issue || res.json?.name) };
  }

  return { createOrder, captureAuthorization, voidAuthorization, base: creds.base };
}
