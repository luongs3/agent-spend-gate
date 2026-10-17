import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createReceiptLog, verifyChain } from '../lib/receipts.mjs';

function mk() { const log = createReceiptLog(); for (let i = 0; i < 4; i++) log.append({ decision: 'ALLOW', request: { amount: 10 + i }, reasons: [] }); return log; }
test('valid chain verifies', () => { const l = mk(); assert.deepEqual(l.verify().ok, true); assert.equal(l.receipts[0].seq, 1); });
test('modified field detected', () => {
  const l = mk(); const c = structuredClone(l.receipts); c[2].request.amount = 9999;
  const v = verifyChain(c, l.publicKey); assert.equal(v.ok, false); assert.equal(v.broken_at, 3);
});
test('re-hashed but unsigned edit detected', async () => {
  const l = mk(); const c = structuredClone(l.receipts); c[1].decision = 'DENY';
  const { receiptHash } = await import('../lib/receipts.mjs'); c[1].hash = receiptHash(c[1]);
  assert.equal(verifyChain(c, l.publicKey).broken_at, 2);
});
test('deleted receipt detected', () => { const l = mk(); const c = structuredClone(l.receipts); c.splice(1, 1); assert.equal(verifyChain(c, l.publicKey).ok, false); });
test('wrong key rejected', () => { const l = mk(); assert.equal(verifyChain(l.receipts, generateKeyPairSync('ed25519').publicKey).reason, 'bad signature'); });
