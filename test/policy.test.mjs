import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, evaluatePolicy, idempotencyKey } from '../lib/policy.mjs';
const P = DEFAULT_POLICY;
const req = { merchant: 'gadgets.example', item: 'hub', amount: 24.99, currency: 'USD', ship_to: 'home' };
const st = () => ({ spentTodayCents: 0, recentKeys: new Map() });

test('allows a normal order', () => assert.equal(evaluatePolicy(P, req, st()).verdict, 'ALLOW'));
test('holds over hold_over', () => assert.equal(evaluatePolicy(P, { ...req, amount: 129 }, st()).verdict, 'HOLD'));
test('denies over per_order_cap', () => assert.equal(evaluatePolicy(P, { ...req, amount: 150.01 }, st()).verdict, 'DENY'));
test('denies unknown ship_to', () => assert.match(evaluatePolicy(P, { ...req, ship_to: '13 Attacker St' }, st()).reasons.join(), /ship_to/));
test('denies merchant not allowlisted', () => assert.equal(evaluatePolicy(P, { ...req, merchant: 'x.example' }, st()).verdict, 'DENY'));
test('denies quantity over max', () => assert.equal(evaluatePolicy(P, { ...req, quantity: 5 }, st()).verdict, 'DENY'));
test('denies wrong currency', () => assert.equal(evaluatePolicy(P, { ...req, currency: 'EUR' }, st()).verdict, 'DENY'));
test('denies daily cap', () => assert.match(evaluatePolicy(P, req, { spentTodayCents: 15000, recentKeys: new Map() }).reasons.join(), /daily_cap/));
test('dedupes within window, allows after', () => {
  const s = st(); s.recentKeys.set(idempotencyKey(req), 1_000_000);
  assert.equal(evaluatePolicy(P, req, s, 1_000_000 + 30_000).verdict, 'DENY');
  assert.equal(evaluatePolicy(P, req, s, 1_000_000 + 61_000).verdict, 'ALLOW');
});
