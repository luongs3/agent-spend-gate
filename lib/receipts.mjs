// Ed25519-signed, hash-chained receipt log.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, sha256 } from './canonical.mjs';

export const GENESIS = '0'.repeat(64);

export function loadOrCreateKey(path) {
  if (path && existsSync(path)) return createPrivateKey(readFileSync(path));
  const { privateKey } = generateKeyPairSync('ed25519');
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); }
  return privateKey;
}

const body = (r) => { const { hash, sig, ...rest } = r; return rest; };
export const receiptHash = (r) => sha256(canonical(body(r)));

export function signReceipt(privateKey, fields, prev) {
  const r = { ...fields, seq: prev ? prev.seq + 1 : 1, prev_hash: prev ? prev.hash : GENESIS };
  r.hash = receiptHash(r);
  r.sig = sign(null, Buffer.from(r.hash, 'hex'), privateKey).toString('base64');
  return r;
}

export function verifyChain(receipts, publicKey) {
  let prev = null;
  for (const r of receipts) {
    const expectPrev = prev ? prev.hash : GENESIS;
    if (r.prev_hash !== expectPrev) return { ok: false, broken_at: r.seq, reason: 'prev_hash does not link to previous receipt' };
    if (prev && r.seq !== prev.seq + 1) return { ok: false, broken_at: r.seq, reason: 'sequence gap' };
    if (receiptHash(r) !== r.hash) return { ok: false, broken_at: r.seq, reason: 'content hash mismatch (receipt was modified)' };
    if (!verify(null, Buffer.from(r.hash, 'hex'), publicKey, Buffer.from(r.sig || '', 'base64')))
      return { ok: false, broken_at: r.seq, reason: 'bad signature' };
    prev = r;
  }
  return { ok: true, count: receipts.length, head: prev?.hash || GENESIS };
}

export function createReceiptLog({ file, keyFile } = {}) {
  const privateKey = loadOrCreateKey(keyFile);
  const publicKey = createPublicKey(privateKey);
  const receipts = file && existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  if (file) mkdirSync(dirname(file), { recursive: true });
  return {
    receipts, publicKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    append(fields) {
      const r = signReceipt(privateKey, { ts: new Date().toISOString(), ...fields }, receipts.at(-1));
      receipts.push(r);
      if (file) appendFileSync(file, JSON.stringify(r) + '\n');
      return r;
    },
    verify() { return verifyChain(receipts, publicKey); },
  };
}
