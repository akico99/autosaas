'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectIpcHandlers, validateConnectRequest } = require('../../src/connect/service');

test('connect IPC schemas reject renderer paths, context and policy overrides', () => {
  assert.equal(validateConnectRequest('connect:catalog', {}).ok, true);
  for (const input of [
    { path: 'C:/outside/catalog.json' },
    { policyVersion: 'forged' },
    { connectContext: { connectKind: 'travel' } },
  ]) assert.equal(validateConnectRequest('connect:catalog', input).ok, false);
  assert.equal(validateConnectRequest('connect:prepareDelivery', { id: 'draft-1', post: {} }).ok, false);
  assert.equal(validateConnectRequest('connect:prepareDelivery', { id: 'draft-1', connectContext: {} }).ok, false);
  assert.equal(validateConnectRequest('connect:saveProduct', { product: { connectKind: 'travel', variants: [{ amountMinor: 1000, path: 'C:/secret' }] }, sources: [] }).ok, false);
});

test('travel import forwards the saved product and variant selections to generation', () => {
  const { buildTravelImportRequest } = require('../../src/connect/service');
  const request = buildTravelImportRequest({
    topicId: 'travel-connect', profileKey: 'travel-a', keyword: '다낭 가족여행',
    productIds: ['p1', 'p2'], variantIds: ['v1', 'v2'], experience: '예약 전 확인', travelTopic: 'worldtravel', text: '원고 본문',
  });
  assert.deepEqual(request, {
    topicId: 'travel-connect', profileKey: 'travel-a', keyword: '다낭 가족여행',
    productIds: ['p1', 'p2'], variantIds: ['v1', 'v2'], experience: '예약 전 확인', travelTopic: 'worldtravel',
  });
});

test('connect IPC rejects an untrusted sender before invoking the service', async () => {
  const handlers = new Map();
  let calls = 0;
  createConnectIpcHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    isTrustedSender: () => false,
    service: { catalog: () => { calls += 1; return { ok: true }; } },
  });
  const result = await handlers.get('connect:catalog')({ sender: {} }, {});
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test('connect IPC dispatches only validated requests from the trusted sender', async () => {
  const handlers = new Map();
  let request;
  createConnectIpcHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    isTrustedSender: () => true,
    service: { prepareDelivery: (input) => { request = input; return { ok: true, status: 'review' }; } },
  });
  const result = await handlers.get('connect:prepareDelivery')({ sender: {} }, { id: 'draft-1' });
  assert.deepEqual(result, { ok: true, status: 'review' });
  assert.deepEqual(request, { id: 'draft-1' });
});

test('travel keyword preparation uses injected collectors and matches against normalized products', async () => {
  let workbookPath = null;
  const service = require('../../src/connect/service').createConnectService({
    catalogFile: 'fixture',
    readCatalog: () => ({ version: 1, products: [{ id: 'p1', connectKind: 'travel', travelDetails: { destination: '다낭' } }], sources: [] }),
    selectWorkbook: async () => ({ canceled: false, filePath: 'C:/picked/ads.xlsx' }),
    readWorkbook: async (file) => { workbookPath = file; return { rows: [{ keyword: '다낭 가족여행', monthlyPc: 10, monthlyMobile: 20 }], sourceFileName: 'ads.xlsx' }; },
    autocomplete: async () => ['다낭 가족여행 코스'],
    observe: async () => [{ keyword: '다낭 가족여행', measured: true, blocked: false, blocks: [{ blockKind: 'blog', blogCount: 3 }] }],
    now: () => new Date('2026-10-08T00:00:00.000Z'),
  });
  const result = await service.prepareKeywords({ seed: '다낭 여행', productIds: ['p1'], questions: [], importXlsx: true });
  assert.equal(workbookPath, 'C:/picked/ads.xlsx');
  assert.equal(result.ok, true);
  assert.ok(result.rows.some((row) => row.keyword === '다낭 가족여행' && row.productIds.includes('p1')));
  assert.equal(result.meta.sourceFileName, 'ads.xlsx');
});

test('keyword questions cannot cite source ids absent from the catalog', async () => {
  const service = require('../../src/connect/service').createConnectService({
    catalogFile: 'fixture',
    readCatalog: () => ({ version: 1, products: [{ id: 'p1', connectKind: 'travel', travelDetails: { destination: '다낭' } }], sources: [] }),
  });
  await assert.rejects(service.prepareKeywords({ seed: '다낭 여행', productIds: ['p1'], questions: [{ keyword: '다낭 여행', question: '출발일은?', sourceIds: ['missing'] }] }), /출처/);
});

test('product registration stores a normalized product and preserves issued link bytes', () => {
  let saved;
  const service = require('../../src/connect/service').createConnectService({
    catalogFile: 'fixture',
    readCatalog: () => ({ version: 1, products: [], sources: [] }),
    writeCatalog: (_file, value) => { saved = value; },
  });
  const affiliateUrlRaw = 'https://naver.me/A%2Fb?x=1&x=2';
  const result = service.saveProduct({
    product: {
      connectKind: 'travel', name: '다낭', provider: '예시', detailUrl: 'https://example.com/danang', affiliateUrlRaw,
      profileKey: 'travel-a', eligibility: 'unknown', travelDetails: { destination: '다낭', travelType: 'package' },
      variants: [], facts: [], images: [],
    },
    sources: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.product.affiliateUrlRaw, affiliateUrlRaw);
  assert.equal(saved.products[0].affiliateUrlRaw, affiliateUrlRaw);
});
