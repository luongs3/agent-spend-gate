import { createHash } from 'node:crypto';
// Deterministic JSON: sorted keys, no whitespace. Used for hashes and signatures.
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
