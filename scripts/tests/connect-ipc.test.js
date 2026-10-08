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

test('product import IPC accepts only a valid public URL and rejects extra request data', () => {
  assert.equal(validateConnectRequest('connect:importProduct', { url: 'https://example.com/travel' }).ok, true);
  assert.equal(validateConnectRequest('connect:importProduct', { url: 'https://example.com/travel', html: '<h1>forged</h1>' }).ok, false);
  const privateTarget = validateConnectRequest('connect:importProduct', { url: 'http://127.0.0.1/private' });
  assert.equal(privateTarget.ok, false);
  assert.equal(privateTarget.kind, 'private_target');
});

test('product import service forwards the URL to its injected collector', async () => {
  let received;
  const service = require('../../src/connect/service').createConnectService({
    catalogFile: 'fixture',
    productImporter: async (request) => { received = request; return { ok: true, imported: { product: { name: '제주' } } }; },
  });
  const request = { url: 'https://example.com/jeju' };
  assert.deepEqual(await service.importProduct(request), { ok: true, imported: { product: { name: '제주' } } });
  assert.deepEqual(received, request);
});

test('product import IPC registers its channel and dispatches only for the trusted sender', async () => {
  const handlers = new Map();
  const requests = [];
  createConnectIpcHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    isTrustedSender: (event) => event.trusted === true,
    service: { importProduct: async (request) => { requests.push(request); return { ok: true, imported: {} }; } },
  });
  const handler = handlers.get('connect:importProduct');
  assert.equal(typeof handler, 'function');
  assert.equal((await handler({ trusted: false }, { url: 'https://example.com/travel' })).ok, false);
  assert.equal(requests.length, 0);
  const request = { url: 'https://example.com/travel' };
  assert.deepEqual(await handler({ trusted: true }, request), { ok: true, imported: {} });
  assert.deepEqual(requests, [request]);
});

test('auto-import IPC accepts only a valid URL and rejects extra request data', () => {
  assert.equal(validateConnectRequest('connect:autoImport', { url: 'https://naver.me/abc123' }).ok, true);
  assert.equal(validateConnectRequest('connect:autoImport', { url: 'https://naver.me/abc123', html: '<h1>forged</h1>' }).ok, false);
  const privateTarget = validateConnectRequest('connect:autoImport', { url: 'http://127.0.0.1/private' });
  assert.equal(privateTarget.ok, false);
  assert.equal(privateTarget.kind, 'private_target');
  assert.equal(validateConnectRequest('connect:autoImport', {}).ok, false);
});

test('refresh-product IPC accepts only a bounded product id string and rejects extra request data', () => {
  assert.equal(validateConnectRequest('connect:refreshProduct', { productId: 'cp_abc123' }).ok, true);
  assert.equal(validateConnectRequest('connect:refreshProduct', { productId: '' }).ok, false);
  assert.equal(validateConnectRequest('connect:refreshProduct', { productId: 'a'.repeat(81) }).ok, false);
  assert.equal(validateConnectRequest('connect:refreshProduct', { productId: 123 }).ok, false);
  assert.equal(validateConnectRequest('connect:refreshProduct', {}).ok, false);
  assert.equal(validateConnectRequest('connect:refreshProduct', { productId: 'cp_abc123', extra: true }).ok, false);
});

test('auto-import service forwards the URL to its injected autoImport dependency', async () => {
  let received;
  const service = require('../../src/connect/service').createConnectService({
    catalogFile: 'fixture',
    autoImport: async (request) => { received = request; return { ok: true, product: { id: 'cp_1' }, variantIds: ['v1'], seeds: ['다낭 여행'] }; },
  });
  const request = { url: 'https://naver.me/abc123' };
  assert.deepEqual(await service.autoImport(request), { ok: true, product: { id: 'cp_1' }, variantIds: ['v1'], seeds: ['다낭 여행'] });
  assert.deepEqual(received, request);
});

test("refresh-product service re-runs autoImport with the catalog product's stored affiliate link", async () => {
  let received;
  const service = require('../../src/connect/service').createConnectService({
    catalogFile: 'fixture',
    readCatalog: () => ({
      version: 1,
      products: [{ id: 'cp_1', connectKind: 'travel', affiliateUrlRaw: 'https://naver.me/stored-link' }],
      sources: [],
    }),
    autoImport: async (request) => { received = request; return { ok: true, product: { id: 'cp_1' }, variantIds: [], seeds: [] }; },
  });
  const result = await service.refreshProduct({ productId: 'cp_1' });
  assert.deepEqual(received, { url: 'https://naver.me/stored-link' });
  assert.equal(result.ok, true);
});

test('refresh-product service fails without calling autoImport when the product or its affiliate link is missing', async () => {
  let calls = 0;
  const service = require('../../src/connect/service').createConnectService({
    catalogFile: 'fixture',
    readCatalog: () => ({ version: 1, products: [{ id: 'cp_1', connectKind: 'travel', affiliateUrlRaw: '' }], sources: [] }),
    autoImport: async () => { calls += 1; return { ok: true }; },
  });
  const missingProduct = await service.refreshProduct({ productId: 'cp_missing' });
  assert.equal(missingProduct.ok, false);
  assert.equal(missingProduct.kind, 'not_found');
  const missingLink = await service.refreshProduct({ productId: 'cp_1' });
  assert.equal(missingLink.ok, false);
  assert.equal(missingLink.kind, 'not_found');
  assert.equal(calls, 0);
});

test('auto-import IPC rejects an untrusted sender before invoking the service', async () => {
  const handlers = new Map();
  let calls = 0;
  createConnectIpcHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    isTrustedSender: () => false,
    service: { autoImport: async () => { calls += 1; return { ok: true }; } },
  });
  const result = await handlers.get('connect:autoImport')({ sender: {} }, { url: 'https://naver.me/abc123' });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test('refresh-product IPC registers its channel and dispatches only for the trusted sender', async () => {
  const handlers = new Map();
  const requests = [];
  createConnectIpcHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    isTrustedSender: (event) => event.trusted === true,
    service: { refreshProduct: async (request) => { requests.push(request); return { ok: true, product: {} }; } },
  });
  const handler = handlers.get('connect:refreshProduct');
  assert.equal(typeof handler, 'function');
  assert.equal((await handler({ trusted: false }, { productId: 'cp_1' })).ok, false);
  assert.equal(requests.length, 0);
  const request = { productId: 'cp_1' };
  assert.deepEqual(await handler({ trusted: true }, request), { ok: true, product: {} });
  assert.deepEqual(requests, [request]);
});
