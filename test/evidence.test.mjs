import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchEvidence, htmlToText, parsePrice, hostAllowed, checkEvidence } from '../lib/evidence.mjs';
import { DEFAULT_POLICY } from '../lib/policy.mjs';
import { renderShop } from '../lib/shop.mjs';

const hubText = htmlToText(renderShop('usb-c-hub'));
test('parsePrice', () => { assert.equal(parsePrice('Hub $24.99'), 24.99); assert.equal(parsePrice('$1,299.00'), 1299); assert.equal(parsePrice('free'), null); });
test('quote found, price matches', () => assert.ok(matchEvidence({ text: hubText, quote: '7-in-1  usb-c HUB $24.99', amount: 24.99 }).ok));
test('misquoted price is rejected', () => {
  const m = matchEvidence({ text: hubText, quote: '7-in-1 USB-C Hub $14.99', amount: 14.99 });
  assert.equal(m.ok, false); assert.equal(m.found, false);
});
test('amount must equal quoted price x qty', () => assert.equal(matchEvidence({ text: hubText, quote: '7-in-1 USB-C Hub $24.99', amount: 19.99 }).ok, false));
test('injected page flagged', () => {
  const m = matchEvidence({ text: htmlToText(renderShop('evil-hub')), quote: 'USB-C hub $19.99', amount: 19.99 });
  assert.equal(m.found, true); assert.equal(m.injection, true); assert.equal(m.ok, false);
});
test('host must map to merchant', () => {
  assert.ok(hostAllowed(DEFAULT_POLICY, 'gadgets.example', 'http://localhost:8811/shop/x').ok);
  assert.equal(hostAllowed(DEFAULT_POLICY, 'gadgets.example', 'https://evil-gadgets.example.net/x').ok, false);
  assert.equal(hostAllowed(DEFAULT_POLICY, 'gadgets.example', 'https://gadgets.example.evil.com/x').ok, false);
});
test('checkEvidence uses injected fetcher', async () => {
  const r = await checkEvidence(DEFAULT_POLICY, { merchant: 'gadgets.example', amount: 24.99, evidence_url: 'http://localhost/shop/usb-c-hub', evidence_quote: '7-in-1 USB-C Hub $24.99' }, async () => ({ text: hubText, page_sha256: 'x' }));
  assert.ok(r.ok);
});
test('missing evidence denied when required', async () => assert.equal((await checkEvidence(DEFAULT_POLICY, { merchant: 'gadgets.example' })).ok, false));
