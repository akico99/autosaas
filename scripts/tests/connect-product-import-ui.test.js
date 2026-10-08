'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTravelProductImportPayload,
  describeTravelProductImportEvidence,
  formatTravelProductImportEvidenceValue,
  resolveTravelProductImportCollectedAt,
  createTravelProductImportGuard,
  withTravelProductImportTimeout,
} = require('../../src/topics/travelConnect');

const PRODUCT_URL = 'https://pkgtour.naver.com/products/verygoodtour/APP7579%7CWE35-20261103';
const COLLECTED_AT = '2026-10-08T02:30:00.000Z';

function importedOfferFixture() {
  return {
    product: {
      connectKind: 'travel',
      name: '오사카 출발별 패키지',
      provider: '좋은여행',
      detailUrl: PRODUCT_URL,
      affiliateUrlRaw: '',
      eligibility: 'unknown',
      variants: [
        { id: 'nov03', currency: 'KRW', amountMinor: 1290000, priceCheckedAt: COLLECTED_AT, options: ['2026-11-03 출발'], departureDate: '2026-11-03', adults: 2, children: 0, roomBasis: '성인 2명 1실' },
        { id: 'nov10', currency: 'KRW', amountMinor: 1490000, options: ['2026-11-10 출발'], departureDate: '2026-11-10', adults: 2, children: 0, roomBasis: '성인 2명 1실' },
      ],
      travelDetails: { destination: '일본 오사카', travelType: 'package', nights: 3, days: 4, inclusions: [], exclusions: [], cancellationPolicy: '' },
      facts: [],
    },
    sources: [{ id: 'source-import', url: PRODUCT_URL, accessLevel: 'full-page', publishedAt: null, collectedAt: COLLECTED_AT, excerpt: '2026년 11월 3일 출발 1,290,000원. 2026년 11월 10일 출발 1,490,000원.' }],
    fieldEvidence: [
      { field: 'variant:nov03:price', value: 1290000, sourceId: 'source-import', excerpt: '2026년 11월 3일 출발 1,290,000원.' },
      { field: 'variant:nov10:price', value: 1490000, sourceId: 'source-import', excerpt: '2026년 11월 10일 출발 1,490,000원.' },
    ],
    missingFields: ['inclusions', 'exclusions', 'cancellationPolicy'],
    warnings: ['포함·불포함 사항은 원문에서 확인하지 못했습니다.'],
    collectedAt: COLLECTED_AT,
  };
}

test('saving selected imported departure options keeps their separate prices, evidence, source, and observation time unverified', () => {
  const payload = buildTravelProductImportPayload({
    imported: importedOfferFixture(),
    selectedVariantIds: ['nov03', 'nov10'],
    formValues: { name: '오사카 가족 패키지', detailUrl: PRODUCT_URL, destination: '일본 오사카', travelType: 'package' },
    profileKey: 'travel-profile',
  });

  assert.deepEqual(payload.product.variants.map(({ id, amountMinor, departureDate, priceCheckedAt }) => ({ id, amountMinor, departureDate, priceCheckedAt })), [
    { id: 'nov03', amountMinor: 1290000, departureDate: '2026-11-03', priceCheckedAt: COLLECTED_AT },
    { id: 'nov10', amountMinor: 1490000, departureDate: '2026-11-10', priceCheckedAt: COLLECTED_AT },
  ]);
  assert.deepEqual(payload.product.facts.map(({ field, value, sourceId, excerpt, status, checkedAt }) => ({ field, value, sourceId, excerpt, status, checkedAt })), [
    { field: 'variant:nov03:price', value: 1290000, sourceId: 'source-import', excerpt: '2026년 11월 3일 출발 1,290,000원.', status: 'unverified', checkedAt: null },
    { field: 'variant:nov10:price', value: 1490000, sourceId: 'source-import', excerpt: '2026년 11월 10일 출발 1,490,000원.', status: 'unverified', checkedAt: null },
  ]);
  assert.equal(payload.product.travelDetails.destination, '일본 오사카');
  assert.equal(payload.product.eligibility, 'unknown');
  assert.equal(payload.product.affiliateUrlRaw, '');
  assert.equal(payload.sources[0].collectedAt, COLLECTED_AT);
  assert.equal(payload.sources[0].excerpt, importedOfferFixture().sources[0].excerpt);
});

test('one source confirmation promotes checked imported facts and preserves existing options and issued affiliate link', () => {
  const imported = importedOfferFixture();
  const existing = {
    id: 'existing-product', connectKind: 'travel', name: '기존 이름', provider: '기존 제공사', detailUrl: PRODUCT_URL,
    affiliateUrlRaw: 'https://affiliate.example.test/issued?x=1', eligibility: 'unknown', profileKey: 'old-profile',
    variants: [{ id: 'old-variant', currency: 'KRW', amountMinor: 1100000, priceCheckedAt: '2026-10-01T00:00:00.000Z', options: ['2026-10-01 출발'], departureDate: '2026-10-01', adults: 2, children: 0, roomBasis: '성인 2명 1실' }],
    facts: [], travelDetails: { destination: '일본 오사카', travelType: 'package', nights: 3, days: 4, inclusions: [], exclusions: [], cancellationPolicy: '' }, images: [], shoppingDetails: null,
  };
  const payload = buildTravelProductImportPayload({
    imported,
    existingProduct: existing,
    selectedVariantIds: ['nov03'],
    formValues: { name: '새 이름', detailUrl: PRODUCT_URL },
    sourceConfirmed: true,
    checkedAt: '2026-10-08T03:00:00.000Z',
  });

  assert.equal(payload.product.id, 'existing-product');
  assert.equal(payload.product.name, '새 이름');
  assert.equal(payload.product.affiliateUrlRaw, 'https://affiliate.example.test/issued?x=1');
  assert.deepEqual(payload.product.variants.map((variant) => variant.id), ['old-variant', 'nov03']);
  assert.deepEqual(payload.product.facts.map(({ field, status, checkedAt }) => ({ field, status, checkedAt })), [
    { field: 'variant:nov03:price', status: 'verified', checkedAt: '2026-10-08T03:00:00.000Z' },
  ]);
  assert.equal(payload.sources[0].collectedAt, COLLECTED_AT);
});

test('import cannot merge a different detail URL into an existing product', () => {
  const existing = {
    id: 'existing-product', connectKind: 'travel', name: '기존 상품', detailUrl: 'https://pkgtour.naver.com/products/ybtour/another-date',
    affiliateUrlRaw: 'https://affiliate.example.test/issued', eligibility: 'unknown', variants: [], facts: [],
    travelDetails: { destination: '일본 대마도', travelType: 'package' },
  };

  assert.throws(() => buildTravelProductImportPayload({
    imported: importedOfferFixture(), existingProduct: existing, selectedVariantIds: ['nov03'],
    formValues: { detailUrl: PRODUCT_URL },
  }), /다른 상품 URL은 새 상품으로 등록/);
});

test('import cannot be saved under a detail URL manually changed after import', () => {
  assert.throws(() => buildTravelProductImportPayload({
    imported: importedOfferFixture(), selectedVariantIds: ['nov03'],
    formValues: { detailUrl: 'https://pkgtour.naver.com/products/other-product' },
  }), /가져온 상품 URL과 등록할 상세 URL이 다릅니다/);
});

test('a resolved issued shortlink saves as the canonical detail URL and preserves the raw issued URL', () => {
  const imported = importedOfferFixture();
  const detailUrl = 'https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101';
  const issuedUrl = 'https://naver.me/GdTuMXPg';
  imported.product.detailUrl = detailUrl;
  imported.product.affiliateUrlRaw = issuedUrl;
  imported.sources[0].url = detailUrl;

  const newProduct = buildTravelProductImportPayload({
    imported,
    selectedVariantIds: ['nov03'],
    formValues: { name: '대마도 여행', detailUrl },
  });
  assert.equal(newProduct.product.detailUrl, detailUrl);
  assert.equal(newProduct.product.affiliateUrlRaw, issuedUrl);
  assert.equal(newProduct.product.eligibility, 'unknown');

  const existing = {
    id: 'existing-tsushima', connectKind: 'travel', name: '대마도 기존 상품', provider: '노랑풍선',
    detailUrl, affiliateUrlRaw: '', eligibility: 'unknown', variants: [], facts: [],
    travelDetails: { destination: '일본 대마도', travelType: 'package' },
  };
  const sameProduct = buildTravelProductImportPayload({
    imported,
    existingProduct: existing,
    selectedVariantIds: ['nov03'],
    formValues: { name: '대마도 기존 상품', detailUrl },
  });
  assert.equal(sameProduct.product.id, 'existing-tsushima');
  assert.equal(sameProduct.product.detailUrl, detailUrl);
  assert.equal(sameProduct.product.affiliateUrlRaw, issuedUrl);

  const alreadyIssued = { ...existing, affiliateUrlRaw: 'https://affiliate.example.test/existing?x=%2f' };
  const preserveExisting = buildTravelProductImportPayload({
    imported,
    existingProduct: alreadyIssued,
    selectedVariantIds: ['nov03'],
    formValues: { detailUrl },
  });
  assert.equal(preserveExisting.product.affiliateUrlRaw, 'https://affiliate.example.test/existing?x=%2f');
});

test('evidence for an unselected imported option cannot attach to an existing option with a colliding id', () => {
  const existing = {
    id: 'existing-product', connectKind: 'travel', name: '기존 상품', detailUrl: PRODUCT_URL,
    affiliateUrlRaw: 'https://affiliate.example.test/issued', eligibility: 'unknown',
    variants: [{ id: 'nov10', currency: 'KRW', amountMinor: 800000, departureDate: '2026-12-01', adults: 2, children: 0, roomBasis: '성인 2명 1실', options: ['12월 1일 출발'] }],
    facts: [{ field: 'variant:nov10:price', value: 800000, sourceId: 'existing-source', excerpt: '기존 옵션 800,000원', status: 'verified', checkedAt: '2026-10-01T00:00:00.000Z' }],
    travelDetails: { destination: '일본 오사카', travelType: 'package', nights: 3, days: 4, inclusions: [], exclusions: [], cancellationPolicy: '' },
  };
  const payload = buildTravelProductImportPayload({
    imported: importedOfferFixture(),
    existingProduct: existing,
    selectedVariantIds: ['nov03'],
    formValues: { name: '기존 상품', detailUrl: PRODUCT_URL },
    existingSources: [{ id: 'existing-source', url: 'https://old.example.test', collectedAt: '2026-10-01T00:00:00.000Z', excerpt: '기존 옵션' }],
  });

  assert.deepEqual(payload.product.facts.filter((fact) => fact.field === 'variant:nov10:price'), [existing.facts[0]]);
});

test('a response for an old URL cannot be applied after the URL changes or a newer request starts', () => {
  const guard = createTravelProductImportGuard();
  const oldRequest = guard.begin(PRODUCT_URL);
  assert.equal(guard.isCurrent(oldRequest, PRODUCT_URL), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(oldRequest, 'https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101'), false);
  const currentRequest = guard.begin('https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101');
  assert.equal(guard.isCurrent(oldRequest, currentRequest.url), false);
  assert.equal(guard.isCurrent(currentRequest, currentRequest.url), true);
});

test('an import timeout rejects with a recoverable timeout error', async () => {
  await assert.rejects(
    withTravelProductImportTimeout(new Promise(() => {}), 5),
    (error) => error && error.name === 'TimeoutError' && /시간/.test(error.message),
  );
  assert.equal(await withTravelProductImportTimeout(Promise.resolve('ok'), 50), 'ok');
});

test('a matching manual import keeps its collection time ahead of an existing source time', () => {
  assert.equal(resolveTravelProductImportCollectedAt({
    manualSource: { url: PRODUCT_URL, collectedAt: COLLECTED_AT },
    sourceUrl: PRODUCT_URL,
    existingSource: { url: PRODUCT_URL, collectedAt: '2026-10-09T02:30:00.000Z' },
    fallback: '2026-10-10T02:30:00.000Z',
  }), COLLECTED_AT);
  assert.equal(resolveTravelProductImportCollectedAt({
    manualSource: { url: 'https://other.example.test', collectedAt: COLLECTED_AT },
    sourceUrl: PRODUCT_URL,
    existingSource: { url: PRODUCT_URL, collectedAt: '2026-10-09T02:30:00.000Z' },
    fallback: '2026-10-10T02:30:00.000Z',
  }), '2026-10-09T02:30:00.000Z');
  assert.equal(resolveTravelProductImportCollectedAt({
    refreshTime: true,
    manualSource: { url: PRODUCT_URL, collectedAt: COLLECTED_AT },
    sourceUrl: PRODUCT_URL,
    fallback: '2026-10-10T02:30:00.000Z',
  }), '2026-10-10T02:30:00.000Z');
});

test('base fares, coupon fares, and points remain separately labeled observations', () => {
  const rows = describeTravelProductImportEvidence({
    fieldEvidence: [
      { field: 'variant:base:price', value: 499000, sourceId: 'source-import', excerpt: '성인 기본가 499,000원' },
      { field: 'variant:base:childPrice', value: 499000, sourceId: 'source-import', excerpt: '아동 기본가 499,000원' },
      { field: 'variant:base:infantPrice', value: 100000, sourceId: 'source-import', excerpt: '유아 기본가 100,000원' },
      { field: 'variant:base:couponPrice', value: 474050, sourceId: 'source-import', excerpt: '5% 쿠폰 적용 시 474,050원' },
      { field: 'variant:base:points', value: 23702, sourceId: 'source-import', excerpt: '적립 예정 포인트 23,702P' },
    ],
  });

  assert.deepEqual(rows.map(({ label, value, excerpt }) => ({ label, value, excerpt })), [
    { label: '기본 성인 요금', value: 499000, excerpt: '성인 기본가 499,000원' },
    { label: '기본 아동 요금', value: 499000, excerpt: '아동 기본가 499,000원' },
    { label: '기본 유아 요금', value: 100000, excerpt: '유아 기본가 100,000원' },
    { label: '쿠폰 적용가', value: 474050, excerpt: '5% 쿠폰 적용 시 474,050원' },
    { label: '적립 포인트', value: 23702, excerpt: '적립 예정 포인트 23,702P' },
  ]);
});

test('import evidence values use the units implied by each field', () => {
  assert.deepEqual([
    formatTravelProductImportEvidenceValue({ field: 'variant:base:price', value: 499000 }),
    formatTravelProductImportEvidenceValue({ field: 'variant:base:couponPrice', value: 474050 }),
    formatTravelProductImportEvidenceValue({ field: 'variant:base:points', value: 23702 }),
    formatTravelProductImportEvidenceValue({ field: 'variant:base:fee', value: 3 }),
    formatTravelProductImportEvidenceValue({ field: 'nights', value: 3 }),
    formatTravelProductImportEvidenceValue({ field: 'days', value: 5 }),
  ], ['499,000원', '474,050원', '23,702P', '3%', '3박', '5일']);
});
