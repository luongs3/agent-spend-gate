// Agent Spend Gate server: UI, REST API, demo shop, and MCP (Streamable HTTP) endpoint.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGate, REQUEST_PAYMENT_SCHEMA } from './lib/gate.mjs';
import { createPayPal } from './lib/paypal.mjs';
import { createReceiptLog } from './lib/receipts.mjs';
import { renderShop } from './lib/shop.mjs';
import { runAgent } from './agent.mjs';
import { exportDisputePack } from './lib/dispute.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROTOCOL = '2025-11-25';

export function startServer({ port = Number(process.env.PORT || 8811), dataDir = join(ROOT, 'data') } = {}) {
  const paypal = createPayPal();
  const log = createReceiptLog({ file: join(dataDir, 'receipts.jsonl'), keyFile: join(dataDir, 'gate-key.pem') });
  const gate = createGate({ paypal, log });
  const baseUrl = process.env.PUBLIC_BASE || `http://localhost:${port}`;
  if (process.env.PUBLIC_BASE) {
    const h = new URL(process.env.PUBLIC_BASE).hostname;
    gate.policy.merchant_hosts['gadgets.example'].push(h);
  }
  const settings = { simulateDecline: false };

  const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  const readBody = (req) => new Promise((ok, bad) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } }); });

  async function mcp(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'agent-spend-gate', version: '1.0.0' },
      instructions: 'Call request_payment to spend money. The gate enforces policy and verifies evidence; you never hold payment credentials.' });
    if (method?.startsWith('notifications/')) return null;
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [
      { name: 'request_payment', description: 'Request a payment. Gate checks spend policy + fetches evidence_url to verify the quoted price, then pays via PayPal (sandbox) or holds for human approval. Returns a signed receipt.', inputSchema: REQUEST_PAYMENT_SCHEMA },
      { name: 'get_receipts', description: 'Return recent signed receipts and chain verification status.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } },
    ] });
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      if (name === 'request_payment') {
        const r = await gate.requestPayment(args, { simulateDecline: settings.simulateDecline, context: { source: 'mcp' } });
        return reply({ content: [{ type: 'text', text: JSON.stringify({ decision: r.decision, reasons: r.reasons, seq: r.seq, paypal: r.paypal, hash: r.hash }) }],
          structuredContent: r, isError: r.decision === 'DENY' || r.decision === 'FAILED' });
      }
      if (name === 'get_receipts') {
        const list = log.receipts.slice(-(args.limit || 20));
        return reply({ content: [{ type: 'text', text: JSON.stringify({ chain: log.verify(), receipts: list }) }] });
      }
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(ROOT, 'public/index.html')));
      }
      if (req.method === 'GET' && (p === '/shop' || p.startsWith('/shop/'))) {
        const html = renderShop(p.slice(6));
        if (!html) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
      }
      if (p === '/mcp') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only (stateless Streamable HTTP)' }, { Allow: 'POST' });
        const msg = await readBody(req);
        const out = Array.isArray(msg) ? (await Promise.all(msg.map(mcp))).filter(Boolean) : await mcp(msg);
        if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
        return send(res, 200, out, { 'MCP-Protocol-Version': PROTOCOL });
      }
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, { policy: gate.policy, settings, spent_today: gate.state.spentTodayCents / 100, open_holds: gate.openHolds(), public_key: log.publicKeyPem, paypal_base: paypal.base });
      if (req.method === 'POST' && p === '/api/policy') { const b = await readBody(req); gate.setPolicy(b); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && p === '/api/settings') { Object.assign(settings, await readBody(req)); return send(res, 200, settings); }
      if (req.method === 'POST' && p === '/api/reset-day') { gate.resetDay(); return send(res, 200, { ok: true }); }
      if (req.method === 'GET' && p === '/api/receipts') return send(res, 200, { receipts: log.receipts, open_holds: gate.openHolds() });
      if (req.method === 'POST' && p === '/api/verify') {
        const b = await readBody(req).catch(() => ({}));
        if (b.tamper_seq) { // demo: verify a copy with one field altered, to show detection
          const copy = structuredClone(log.receipts); const t = copy.find(r => r.seq === Number(b.tamper_seq));
          if (t) t.request.amount = Number(t.request.amount) + 1000;
          const { verifyChain } = await import('./lib/receipts.mjs');
          return send(res, 200, { ...verifyChain(copy, log.publicKey), tampered: true });
        }
        return send(res, 200, log.verify());
      }
      if (req.method === 'GET' && p === '/api/receipts/export') return send(res, 200, exportDisputePack(log), { 'Content-Disposition': 'attachment; filename="dispute-evidence-pack.json"' });
      if (req.method === 'POST' && p === '/api/request_payment') { const b = await readBody(req); return send(res, 200, await gate.requestPayment(b, { simulateDecline: settings.simulateDecline, context: { source: 'api' } })); }
      if (req.method === 'POST' && p.match(/^\/api\/holds\/\d+\/(approve|reject)$/)) {
        const [, , , seq, action] = p.split('/');
        return send(res, 200, await gate.resolveHold(seq, action, 'human (UI)'));
      }
      if (req.method === 'POST' && p === '/api/agent') {
        const b = await readBody(req);
        const out = await runAgent({ message: b.message, gate, paypal, baseUrl, simulateDecline: b.simulate_decline ?? settings.simulateDecline });
        return send(res, 200, out);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: e.message }); }
  });
  return new Promise(ok => server.listen(port, () => ok({ server, gate, log, port, baseUrl })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer();
  console.log(`Agent Spend Gate on http://localhost:${port}  (MCP: POST /mcp)`);
}
