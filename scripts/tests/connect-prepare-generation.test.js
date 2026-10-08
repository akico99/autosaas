'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareTravelGeneration } = require('../../src/connect/prepareGeneration');
const now = Date.parse('2026-10-08T06:00:00Z');
function product(eligibility = 'unknown') {
  return { id: 'p', connectKind: 'travel', affiliateUrlRaw: 'https://naver.me/issued', eligibility,
    variants: [{ id: 'adult', priceCheckedAt: '2026-10-08T05:00:00Z', amountMinor: 229000 }],
    facts: [{ field: 'variant:adult:price', status: 'verified', value: 229000 }] };
}
function input(item) { return { catalog: { products: [item], sources: [] }, productIds: ['p'], variantIds: ['adult'], now }; }
test('a legacy issued-link product is automatically checked while preserving the selected option', async () => {
  const fresh = product('verified'); let calls = 0;
  const result = await prepareTravelGeneration({ ...input(product()), refreshProduct: async (request) => { calls++; assert.equal(request.productId, 'p'); return { ok: true, product: fresh, variantIds: ['adult', 'child'] }; }, readCatalog: () => ({ products: [fresh], sources: [] }) });
  assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(result.catalog.products[0].eligibility, 'verified');
});
test('fresh verified products do not trigger another collection', async () => {
  const result = await prepareTravelGeneration({ ...input(product('verified')), refreshProduct: () => assert.fail('unexpected refresh') });
  assert.equal(result.ok, true); assert.equal(result.refreshed, false);
});
test('missing selection stops before collection and asks for the specific next action', async () => {
  const result = await prepareTravelGeneration({ ...input(product()), variantIds: [], refreshProduct: () => assert.fail('unexpected collection') });
  assert.equal(result.ok, false); assert.match(result.error, /상품 옵션/);
});
test('a failed check or removed option stops before writing with an actionable explanation', async () => {
  const blocked = await prepareTravelGeneration({ ...input(product()), refreshProduct: async () => ({ ok: false, error: '페이지 응답 시간 초과' }) });
  assert.equal(blocked.ok, false); assert.match(blocked.error, /시간 초과/);
  const changed = await prepareTravelGeneration({ ...input(product()), refreshProduct: async () => ({ ok: true, product: product('verified'), variantIds: ['child'] }) });
  assert.equal(changed.ok, false); assert.match(changed.error, /옵션/);
});
test('excluded products cannot be re-enabled automatically; stale price checks trigger refresh', async () => {
  const excluded = await prepareTravelGeneration({ ...input(product('excluded')), refreshProduct: () => assert.fail('excluded product refreshed') });
  assert.equal(excluded.ok, false);
  const item = product('verified'); item.variants[0].priceCheckedAt = '2026-10-07T00:00:00Z';
  let called = false;
  const result = await prepareTravelGeneration({ ...input(item), refreshProduct: async () => { called = true; return { ok: false, error: '오프라인' }; } });
  assert.equal(called, true); assert.equal(result.ok, false);
});
