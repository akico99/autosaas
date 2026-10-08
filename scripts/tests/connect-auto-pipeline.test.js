'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isBrandConnectChain,
  buildAutoImportSave,
  deriveSeedKeywords,
  needsPriceRefresh,
} = require('../../src/connect/autoPipeline');
const { extractTravelProduct } = require('../../src/connect/productImport');
const { normalizeConnectProduct } = require('../../src/connect/products');

const COLLECTED_AT = '2026-10-08T03:04:05.000Z';
const ISSUED_URL = 'https://naver.me/GdTuMXPg';
const BRANDCONNECT_URL = 'https://brandconnect.naver.com/connect/abc123';
const CANONICAL_URL = 'https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101';

function emptyCatalog() {
  return { version: 1, products: [], sources: [] };
}

function loadYbtourImported(overrides = {}) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'travel-product-import', 'naver-ybtour-product.html'), 'utf8');
  const imported = extractTravelProduct({ html, url: CANONICAL_URL, collectedAt: COLLECTED_AT });
  return {
    ...imported,
    resolution: { issuedUrl: ISSUED_URL, finalUrl: CANONICAL_URL, chain: [ISSUED_URL, BRANDCONNECT_URL, CANONICAL_URL] },
    ...overrides,
  };
}

test('isBrandConnectChain requires a brandconnect hop and a pkgtour ending', () => {
  assert.equal(isBrandConnectChain([ISSUED_URL, BRANDCONNECT_URL, CANONICAL_URL]), true);
  assert.equal(isBrandConnectChain([ISSUED_URL, CANONICAL_URL]), false, '브랜드커넥트 중계가 없으면 거부');
  assert.equal(isBrandConnectChain([ISSUED_URL, BRANDCONNECT_URL, 'https://pkgtour.naver.com/other/path']), false, 'pkgtour 상품 경로가 아니면 거부');
  assert.equal(isBrandConnectChain([CANONICAL_URL]), false, '경로가 하나뿐이면 거부');
  assert.equal(isBrandConnectChain(null), false);
  assert.equal(isBrandConnectChain('not-an-array'), false);
  assert.equal(isBrandConnectChain([ISSUED_URL, 'http://brandconnect.naver.com/connect/abc123', CANONICAL_URL]), false);
  assert.equal(isBrandConnectChain([ISSUED_URL, 'https://brandconnect.naver.com/connect/', CANONICAL_URL]), false);
});

test('auto import rejects a redirect chain that belongs to a different product or issued link', () => {
  const imported = loadYbtourImported();
  imported.resolution.finalUrl = 'https://pkgtour.naver.com/products/other/id';
  assert.equal(buildAutoImportSave({ imported, catalog: emptyCatalog() }).kind, 'not_issued_link');
  imported.resolution.finalUrl = CANONICAL_URL;
  imported.resolution.chain[0] = 'https://naver.me/other';
  assert.equal(buildAutoImportSave({ imported, catalog: emptyCatalog() }).kind, 'not_issued_link');
});

test('buildAutoImportSave rejects malformed imported payloads as invalid', () => {
  const catalog = emptyCatalog();
  assert.equal(buildAutoImportSave({ imported: null, catalog }).kind, 'invalid');
  assert.equal(buildAutoImportSave({ imported: {}, catalog }).kind, 'invalid');
  assert.equal(buildAutoImportSave({ imported: { product: {} }, catalog }).kind, 'invalid');
  assert.equal(buildAutoImportSave({ imported: { product: { connectKind: 'shopping' }, sources: [{ id: 's' }], collectedAt: COLLECTED_AT }, catalog }).kind, 'invalid');
  assert.equal(buildAutoImportSave({ imported: { product: { connectKind: 'travel' }, sources: [], collectedAt: COLLECTED_AT }, catalog }).kind, 'invalid');
  assert.equal(buildAutoImportSave({ imported: { product: { connectKind: 'travel' }, sources: [{ id: 's' }], collectedAt: 'not-a-date' }, catalog }).kind, 'invalid');
});

test('buildAutoImportSave stops with not_issued_link when the chain never shows a brandconnect hop', () => {
  const catalog = emptyCatalog();
  const imported = loadYbtourImported({
    resolution: { issuedUrl: CANONICAL_URL, finalUrl: CANONICAL_URL, chain: [CANONICAL_URL, CANONICAL_URL] },
  });
  const result = buildAutoImportSave({ imported, catalog, now: () => new Date(COLLECTED_AT) });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'not_issued_link');
  assert.match(result.error, /브랜드커넥트/);
});

test('buildAutoImportSave stops with not_issued_link when resolution is missing entirely', () => {
  const catalog = emptyCatalog();
  const imported = loadYbtourImported();
  delete imported.resolution;
  const result = buildAutoImportSave({ imported, catalog });
  assert.equal(result.kind, 'not_issued_link');
});

test('buildAutoImportSave stops with no_price when there are no KRW variants', () => {
  const catalog = emptyCatalog();
  const imported = loadYbtourImported();
  imported.product = { ...imported.product, variants: [] };
  const result = buildAutoImportSave({ imported, catalog });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'no_price');
});

test('buildAutoImportSave saves a verified-eligibility product from a real extracted fixture and it stays verified through normalizeConnectProduct', () => {
  const catalog = emptyCatalog();
  const imported = loadYbtourImported();
  const result = buildAutoImportSave({ imported, catalog, now: () => new Date(COLLECTED_AT) });

  assert.equal(result.ok, true);
  assert.equal(result.product.eligibility, 'verified');
  assert.equal(result.product.connectKind, 'travel');
  assert.equal(result.variantIds.length, 3, '연령별 원화 옵션 3개(성인/소아/유아) 모두 선택');

  const eligibilityFact = result.product.facts.find((fact) => fact.field === 'eligibility');
  assert.ok(eligibilityFact, 'eligibility 사실이 있어야 한다');
  assert.equal(eligibilityFact.status, 'verified');
  assert.equal(eligibilityFact.checkedAt, imported.collectedAt);
  assert.ok(eligibilityFact.sourceId.startsWith('src_chain_'));

  const chainSource = result.sources.find((source) => source.id === eligibilityFact.sourceId);
  assert.ok(chainSource, '경로 출처가 함께 반환되어야 한다');
  assert.equal(chainSource.accessLevel, 'full-page');
  assert.ok(chainSource.excerpt.includes(BRANDCONNECT_URL));
  assert.ok(chainSource.excerpt.includes(CANONICAL_URL));

  // 계약의 핵심 요구: normalizeConnectProduct·reviewFact를 실제로 통과해야 verified가 유지된다.
  const normalized = normalizeConnectProduct(result.product, { sources: result.sources });
  assert.equal(normalized.eligibility, 'verified', 'normalizeConnectProduct를 통과한 뒤에도 verified여야 한다');
  const normalizedEligibility = normalized.facts.find((fact) => fact.field === 'eligibility');
  assert.equal(normalizedEligibility.status, 'verified');
  const pricesVerified = normalized.facts.filter((fact) => fact.field.endsWith(':price') && fact.status === 'verified');
  assert.ok(pricesVerified.length > 0, '실제 상품 페이지 발췌로 검토된 가격 사실도 verified여야 한다');
});

test('buildAutoImportSave updates an existing product by detailUrl, keeping its images and reusing matching variant ids', () => {
  const imported = loadYbtourImported();
  const importedVariants = imported.product.variants;
  const adultVariant = importedVariants.find((variant) => variant.options[0].startsWith('성인'));
  const existingProduct = {
    id: imported.product.id,
    connectKind: 'travel',
    name: '기존 상품명',
    provider: '기존 판매사',
    detailUrl: CANONICAL_URL,
    affiliateUrlRaw: ISSUED_URL,
    affiliateStatus: 'issued',
    profileKey: 'existing-profile',
    eligibility: 'verified',
    variants: [{
      id: 'v_existing_adult',
      currency: 'KRW',
      amountMinor: adultVariant.amountMinor,
      priceCheckedAt: '2026-10-01T00:00:00.000Z',
      options: adultVariant.options,
      departureDate: adultVariant.departureDate,
      adults: adultVariant.adults,
      children: adultVariant.children,
      roomBasis: adultVariant.roomBasis,
    }],
    facts: [],
    travelDetails: {
      destination: '기존 목적지', travelType: 'package', nights: 1, days: 2,
      inclusions: ['기존 포함'], exclusions: ['기존 불포함'], cancellationPolicy: '기존 취소 규정',
    },
    shoppingDetails: null,
    images: [{ url: 'https://img.example.test/kept.jpg', sourceId: null }],
  };
  const catalog = { version: 1, products: [existingProduct], sources: [] };

  const result = buildAutoImportSave({ imported, catalog, now: () => new Date(COLLECTED_AT) });

  assert.equal(result.ok, true);
  assert.equal(result.product.id, existingProduct.id);
  assert.deepEqual(result.product.images, existingProduct.images, '기존 이미지를 보존해야 한다');
  assert.ok(result.product.variants.some((variant) => variant.id === 'v_existing_adult'), '같은 조건의 기존 variant id를 재사용해야 한다');
  assert.ok(result.variantIds.includes('v_existing_adult'), '반환된 variantIds도 재사용된 id를 가리켜야 한다');
  assert.equal(result.product.profileKey, 'existing-profile');

  const normalized = normalizeConnectProduct(result.product, { sources: result.sources });
  assert.equal(normalized.eligibility, 'verified');
});

test('deriveSeedKeywords builds destination seeds, adds a departure-city seed when present, dedupes, and caps at 3', () => {
  assert.deepEqual(
    deriveSeedKeywords({ travelDetails: { destination: '일본 대마도' } }),
    ['일본 대마도 여행', '일본 대마도 패키지'],
  );
  assert.deepEqual(
    deriveSeedKeywords({ travelDetails: { destination: '대마도', departureCity: '부산' } }),
    ['대마도 여행', '대마도 패키지', '부산출발 대마도'],
  );
  assert.deepEqual(deriveSeedKeywords({ travelDetails: { destination: '' } }), []);
  assert.deepEqual(deriveSeedKeywords({}), []);
  assert.deepEqual(deriveSeedKeywords(null), []);
  // 중복 제거 + 최대 3개 보장(가짓수가 늘어도 넘치지 않음을 확인).
  const seeds = deriveSeedKeywords({ travelDetails: { destination: '제주', departureCity: '서울' } });
  assert.equal(seeds.length, 3);
  assert.equal(new Set(seeds).size, 3);
});

test('needsPriceRefresh flags missing or stale checks past the 6h default and respects a custom maxAgeMs', () => {
  const now = () => new Date('2026-10-08T12:00:00.000Z');
  const fresh = { id: 'v1', priceCheckedAt: '2026-10-08T10:00:00.000Z' }; // 2h ago
  const stale = { id: 'v2', priceCheckedAt: '2026-10-08T04:00:00.000Z' }; // 8h ago
  const missing = { id: 'v3', priceCheckedAt: '' };
  const product = { variants: [fresh, stale, missing] };

  assert.equal(needsPriceRefresh({ variants: [fresh] }, ['v1'], now), false);
  assert.equal(needsPriceRefresh({ variants: [stale] }, ['v2'], now), true);
  assert.equal(needsPriceRefresh({ variants: [missing] }, ['v3'], now), true);
  assert.equal(needsPriceRefresh(product, ['v1', 'v2'], now), true, '하나라도 오래되면 전체를 새로고침해야 한다');
  assert.equal(needsPriceRefresh(product, ['unknown-id'], now), true, '선택한 variant를 찾지 못하면 안전하게 새로고침해야 한다');
  assert.equal(needsPriceRefresh(product, ['v1', 'unknown-id'], now), true);
  assert.equal(needsPriceRefresh({ variants: [{ id: 'v1', priceCheckedAt: '2026-10-09T10:00:00Z' }] }, ['v1'], now), true);
  assert.equal(needsPriceRefresh({ variants: [fresh] }, ['v1'], now, 1 * 60 * 60 * 1000), true, '더 짧은 maxAgeMs를 존중해야 한다');
});
