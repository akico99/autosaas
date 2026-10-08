'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const {
  extractTravelProduct,
  createTravelProductImporter,
  fetchPublicHtml,
  validateTravelProductUrl,
} = require('../../src/connect/productImport');

const COLLECTED_AT = '2026-10-08T03:04:05.000Z';

function naverHtml(product, { includePageText = true } = {}) {
  const nextData = {
    props: { pageProps: { initialApolloState: { ROOT_QUERY: {
      'overseasProductById({"agtCode":"ybtour","bookingId":null,"device":"mo","productId":"JCP40960000-20261101"})': product,
    } } } },
  };
  const body = includePageText ? `
    <main>
      <h1>${product.productName}</h1><p>${product.agtName}</p>
      <p>일본 대마도</p><p>1박 2일</p>
      <section><h2>상품 금액</h2>
        <div class="DetailPrice_deleted">229,000원</div><div class="DetailPrice_final">222,130원</div>
        <p>성인 (만 12세 이상) : 229,000원</p>
        <p>소아 (만 12세 미만) : 229,000원</p>
        <p>유아 (만 24개월 미만) : 50,000원</p>
        <p>※ 연령 기준 및 혜택이 적용된 최종 결제금액은 예약 페이지에서 확인 부탁드립니다.</p>
        <p>네이버 여행핫딜 쿠폰 3% 할인 222,130원 포인트 적립 11,106원</p>
      </section>
      <section><h2>포함 · 불포함</h2><h3>포함사항</h3>
        <p>왕복 선박료, 유류할증료, 제세공과금</p><p>호텔 숙박비 (더블룸 기준)</p>
      </section>
      <section><h2>취소 및 환불 규정</h2><p>여행개시 30일 전까지 취소 통보 시 계약금 환급</p></section>
    </main>` : '<main></main>';
  return `<!doctype html><html lang="ko"><head><title>${product.productName}</title>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData).replace(/</g, '\\u003c')}</script>
    </head><body>${body}</body></html>`;
}

function naverProduct(overrides = {}) {
  return {
    __typename: 'OverseasProductByIdResponse',
    productId: 'JCP40960000-20261101',
    productName: '부산출발 대마도 2일 이즈하라 도요코인 온천욕',
    agtName: '노랑풍선',
    nightPeriod: 1,
    dayPeriod: 2,
    prices: { adult: 229000, child: 229000, infant: 50000 },
    priceAgeRanges: { adult: '만 12세 이상', child: '만 12세 미만', infant: '만 24개월 미만' },
    tourCategory: { name: '투어텔' },
    visitAreas: [{ countryName: '일본', cityName: '대마도' }],
    beginDate: '2026-11-01',
    endDate: '2026-11-02',
    beginCityName: '부산항',
    includeOptions: ['왕복 선박료, 유류할증료, 제세공과금', '호텔 숙박비 (더블룸 기준)'],
    excludeOptions: ['1인당 가이드기사 경비 20,000원'],
    refundPolicy: { editors: [{ contents: ['여행개시 30일 전까지 취소 통보 시 계약금 환급'] }] },
    ...overrides,
  };
}

function mockHttpsRoutes(t, routes, { lookupAddresses = () => [{ address: '93.184.216.34', family: 4 }] } = {}) {
  const requests = [];
  t.mock.method(https, 'request', (url, options, onResponse) => {
    const href = url instanceof URL ? url.href : String(url);
    const parsed = new URL(href);
    let pinnedAddress = '';
    options.lookup(parsed.hostname, { all: true }, (error, addresses) => {
      if (error) throw error;
      pinnedAddress = addresses[0].address;
    });
    const requestInfo = { url: href, hostname: parsed.hostname, pinnedAddress, timeoutMs: null };
    requests.push(requestInfo);
    const request = new EventEmitter();
    request.setTimeout = (timeoutMs) => { requestInfo.timeoutMs = timeoutMs; };
    request.destroy = (error) => { if (error) queueMicrotask(() => request.emit('error', error)); };
    request.end = () => {
      queueMicrotask(() => {
        const route = typeof routes === 'function' ? routes(href, requestInfo) : routes.get(href);
        if (!route) {
          request.emit('error', new Error(`Unexpected request: ${href}`));
          return;
        }
        const response = new EventEmitter();
        response.statusCode = route.status;
        response.headers = route.location ? { location: route.location } : { 'content-type': 'text/html; charset=utf-8' };
        response.destroy = () => {};
        onResponse(response);
        if (route.html !== undefined) queueMicrotask(() => {
          response.emit('data', Buffer.from(route.html));
          response.emit('end');
        });
      });
    };
    return request;
  });
  return requests;
}

function publicLookup() {
  return async () => [{ address: '93.184.216.34', family: 4 }];
}

test('extracts one KRW Product Offer and keeps its source evidence unverified', () => {
  const url = 'https://travel.example.test/products/jeju';
  const html = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: '제주 3일 패키지',
    url,
    brand: { name: '좋은여행' },
    description: '2박 3일 제주 패키지',
    offers: { '@type': 'Offer', price: '340000', priceCurrency: 'KRW', availability: 'https://schema.org/InStock' },
  })}</script></head><body><h1>제주 3일 패키지</h1><p>좋은여행</p>
    <p>여행지: 제주</p><p>제주 2박 3일</p><p>성인 1인 340,000원</p><p>포함: 왕복 항공권</p>
    <p>불포함: 개인 경비</p><p>취소 수수료는 약관을 확인해 주세요.</p></body></html>`;

  const imported = extractTravelProduct({ html, url, collectedAt: COLLECTED_AT });

  assert.equal(imported.product.name, '제주 3일 패키지');
  assert.equal(imported.product.provider, '좋은여행');
  assert.equal(imported.product.travelDetails.destination, '제주');
  assert.equal(imported.product.travelDetails.days, 3);
  assert.equal(imported.product.variants.length, 1);
  assert.equal(imported.product.variants[0].amountMinor, 340000);
  assert.equal(imported.product.variants[0].currency, 'KRW');
  assert.equal(imported.product.variants[0].priceCheckedAt, COLLECTED_AT);
  assert.equal(imported.sources[0].url, url);
  assert.equal(imported.sources[0].collectedAt, COLLECTED_AT);
  assert.equal(imported.product.facts.every((fact) => fact.status === 'unverified'), true);
  assert.ok(imported.fieldEvidence.some((entry) => entry.field === `variant:${imported.product.variants[0].id}:price` && entry.excerpt.includes('340,000')));
});

test('extracts Naver package SSR product data and age-specific prices from the matching departure page', () => {
  const url = 'https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101';
  const imported = extractTravelProduct({ html: naverHtml(naverProduct()), url, collectedAt: COLLECTED_AT });

  assert.equal(imported.product.name, '부산출발 대마도 2일 이즈하라 도요코인 온천욕');
  assert.equal(imported.product.provider, '노랑풍선');
  assert.equal(imported.product.travelDetails.destination, '일본 대마도');
  assert.equal(imported.product.travelDetails.travelType, 'package');
  assert.equal(imported.product.travelDetails.nights, 1);
  assert.equal(imported.product.travelDetails.days, 2);
  assert.deepEqual(imported.product.variants.map(({ amountMinor, departureDate, options }) => ({ amountMinor, departureDate, option: options[0] })), [
    { amountMinor: 229000, departureDate: '2026-11-01', option: '성인 (만 12세 이상)' },
    { amountMinor: 229000, departureDate: '2026-11-01', option: '소아 (만 12세 미만)' },
    { amountMinor: 50000, departureDate: '2026-11-01', option: '유아 (만 24개월 미만)' },
  ]);
  assert.equal(imported.product.variants.every((variant) => variant.priceCheckedAt === COLLECTED_AT), true);
  assert.deepEqual(imported.product.travelDetails.inclusions, ['왕복 선박료, 유류할증료, 제세공과금', '호텔 숙박비 (더블룸 기준)']);
  assert.match(imported.product.travelDetails.cancellationPolicy, /30일 전까지 취소 통보/);
  assert.ok(imported.sources[0].excerpt.includes('상품 금액'));
  assert.ok(imported.fieldEvidence.every((entry) => entry.sourceId === imported.sources[0].id && entry.excerpt));
  assert.equal(imported.product.eligibility, 'unknown');
  assert.equal(imported.product.affiliateUrlRaw, '');
  assert.ok(imported.warnings.some((warning) => warning.includes('최종')));
});

test('imports the Verygoodtour departure base fares without its coupon price or points', () => {
  const url = 'https://pkgtour.naver.com/products/verygoodtour/APP7579%7CWE35-20261103';
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'travel-product-import', 'naver-verygoodtour-product.html'), 'utf8');
  const imported = extractTravelProduct({ html, url, collectedAt: COLLECTED_AT });

  assert.equal(imported.product.name, '[여행핫딜]선착순 특가 [노옵션하노이/하롱베이] 5성 월드체인 38만원 상당 혜택 비경투어 미슐랭 맛집 5일');
  assert.equal(imported.product.provider, '참좋은여행');
  assert.deepEqual(imported.product.variants.map((variant) => [variant.departureDate, variant.amountMinor]), [
    ['2026-11-03', 499000], ['2026-11-03', 499000], ['2026-11-03', 100000],
  ]);
  assert.deepEqual(imported.product.variants.map((variant) => variant.options[0]), [
    '성인 (만 12세 이상)', '소아 (만 12세 미만)', '유아 (만 24개월 미만)',
  ]);
  assert.ok(!imported.product.variants.some((variant) => [474050, 23702, 18962].includes(variant.amountMinor)));
  assert.equal(imported.product.travelDetails.nights, 3);
  assert.equal(imported.product.travelDetails.days, 5);
  assert.equal(imported.product.variants[0].roomBasis, '2인1실 기준');
  assert.ok(imported.warnings.some((warning) => warning.includes('최종 결제 금액')));
  assert.ok(imported.fieldEvidence.some((entry) => entry.field.endsWith(':price') && entry.value === 499000 && entry.excerpt.includes('499,000')));
});

test('imports the YBTour departure base fares and destination from its matching page record', () => {
  const url = 'https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101';
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'travel-product-import', 'naver-ybtour-product.html'), 'utf8');
  const imported = extractTravelProduct({ html, url, collectedAt: COLLECTED_AT });

  assert.equal(imported.product.name, '부산출발 대마도 2일 1명부터출발확정 이즈하라 도요코인 온천욕 BBQ특식 이즈하라');
  assert.equal(imported.product.provider, '노랑풍선');
  assert.equal(imported.product.travelDetails.destination, '일본 대마도');
  assert.deepEqual(imported.product.variants.map((variant) => [variant.departureDate, variant.amountMinor]), [
    ['2026-11-01', 229000], ['2026-11-01', 229000], ['2026-11-01', 50000],
  ]);
  assert.deepEqual(imported.product.variants.map((variant) => variant.options[0]), [
    '성인 (만 12세 이상)', '소아 (만 12세 미만)', '유아 (만 24개월 미만)',
  ]);
  assert.ok(!imported.product.variants.some((variant) => variant.amountMinor === 222130));
  assert.equal(imported.product.travelDetails.nights, 1);
  assert.equal(imported.product.travelDetails.days, 2);
  assert.equal(imported.product.variants[0].roomBasis, '더블룸기준');
});

test('does not borrow a recommendation Product or turn aggregate, foreign, or conflicting prices into KRW options', () => {
  const url = 'https://travel.example.test/products/current';
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify([
      { '@type': 'Product', name: '추천 상품', url: 'https://travel.example.test/products/other', offers: { '@type': 'Offer', price: 10000, priceCurrency: 'KRW' } },
      { '@type': 'Product', name: '현재 상품', url, brand: { name: '현재 여행사' }, offers: [
        { '@type': 'AggregateOffer', lowPrice: 10000, highPrice: 50000, priceCurrency: 'KRW' },
        { '@type': 'Offer', price: 40, priceCurrency: 'USD' },
        { '@type': 'Offer', price: 20000, priceCurrency: 'KRW', name: '출발 A' },
        { '@type': 'Offer', price: 30000, priceCurrency: 'KRW', name: '출발 A' },
      ] },
    ])}</script></head><body><h1>현재 상품</h1><p>현재 여행사</p><p>추천 상품 10,000원</p></body></html>`;

  const imported = extractTravelProduct({ html, url, collectedAt: COLLECTED_AT });

  assert.equal(imported.product.name, '현재 상품');
  assert.equal(imported.product.provider, '현재 여행사');
  assert.deepEqual(imported.product.variants, []);
  assert.ok(imported.warnings.some((warning) => warning.includes('AggregateOffer')));
  assert.ok(imported.warnings.some((warning) => warning.includes('USD')));
  assert.ok(imported.warnings.some((warning) => warning.includes('서로 다른 원화 가격')));
  assert.ok(!imported.fieldEvidence.some((entry) => entry.field.startsWith('variant:') && entry.field.endsWith(':price')));
});

test('does not import a sole JSON-LD Product whose explicit URL points to another page', () => {
  const url = 'https://travel.example.test/products/current';
  const html = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: '다른 페이지 상품', url: 'https://travel.example.test/products/unrelated',
    brand: { name: '다른 페이지 여행사' },
    offers: { '@type': 'Offer', price: 88000, priceCurrency: 'KRW' },
  })}</script></head><body><h1>현재 페이지 상품명</h1></body></html>`;

  const imported = extractTravelProduct({ html, url, collectedAt: COLLECTED_AT });

  assert.equal(imported.product.name, '현재 페이지 상품명');
  assert.equal(imported.product.provider, '');
  assert.deepEqual(imported.product.variants, []);
  assert.ok(imported.warnings.some((warning) => warning.includes('특정하지 못했습니다')));
});

test('allows the only JSON-LD Product when it has no explicit URL', () => {
  const url = 'https://travel.example.test/products/current';
  const html = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: '페이지 URL 없는 단일 상품', brand: { name: '여행사' },
    offers: { '@type': 'Offer', price: 88000, priceCurrency: 'KRW' },
  })}</script></head><body><h1>페이지 URL 없는 단일 상품</h1><p>88,000원</p></body></html>`;

  const imported = extractTravelProduct({ html, url, collectedAt: COLLECTED_AT });

  assert.equal(imported.product.name, '페이지 URL 없는 단일 상품');
  assert.equal(imported.product.provider, '여행사');
  assert.equal(imported.product.variants.length, 1);
  assert.equal(imported.product.variants[0].amountMinor, 88000);
});

test('parses a matching JSON-LD Product embedded in the body without including script text as evidence', () => {
  const url = 'https://travel.example.test/products/body-embedded';
  const html = `<!doctype html><html><head></head><body>
    <h1>화면 상품 제목</h1>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Product', name: '구조화 상품명', url, brand: { name: '본문 JSON-LD 여행사' },
      offers: { '@type': 'Offer', price: 76000, priceCurrency: 'KRW' },
    })}</script>
    <p>76,000원</p>
  </body></html>`;

  const imported = extractTravelProduct({ html, url, collectedAt: COLLECTED_AT });

  assert.equal(imported.product.name, '구조화 상품명');
  assert.equal(imported.product.provider, '본문 JSON-LD 여행사');
  assert.equal(imported.product.variants.length, 1);
  assert.equal(imported.product.variants[0].amountMinor, 76000);
  assert.ok(!imported.sources[0].excerpt.includes('application/ld+json'));
});

test('does not pair an embedded age fare with a different visible price row', () => {
  const url = 'https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101';
  const record = naverProduct({ prices: { adult: 222130, child: 229000, infant: 50000 } });
  const imported = extractTravelProduct({ html: naverHtml(record), url, collectedAt: COLLECTED_AT });

  assert.deepEqual(imported.product.variants.map((variant) => [variant.options[0], variant.amountMinor]), [
    ['소아 (만 12세 미만)', 229000], ['유아 (만 24개월 미만)', 50000],
  ]);
  assert.ok(imported.warnings.some((warning) => warning.includes('성인') && warning.includes('공개 페이지')));
});

test('keeps missing fields blank and reports them instead of inventing product details', () => {
  const imported = extractTravelProduct({
    html: '<!doctype html><html><body><h1>제목만 있는 여행</h1></body></html>',
    url: 'https://travel.example.test/sparse',
    collectedAt: COLLECTED_AT,
  });

  assert.equal(imported.product.name, '제목만 있는 여행');
  assert.equal(imported.product.provider, '');
  assert.deepEqual(imported.product.variants, []);
  assert.ok(imported.missingFields.includes('provider'));
  assert.ok(imported.missingFields.includes('price'));
  assert.equal(imported.product.travelDetails.destination, '');
});

test('validates public URLs and returns typed errors for redirects without changing collectedAt', async () => {
  for (const url of [
    'file:///C:/private.txt',
    'javascript:alert(1)',
    'https://user:secret@example.com/product',
    'http://localhost/product',
    'https://127.0.0.1/product',
    'https://192.168.1.5/product',
    'https://example.com:8443/product',
    'http://example.com:443/product',
    'https://example.com:80/product',
  ]) assert.equal(validateTravelProductUrl(url).valid, false, url);
  assert.equal(validateTravelProductUrl('https://example.com/product').valid, true);

  await assert.rejects(
    fetchPublicHtml('https://example.com/product', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
    (error) => error.kind === 'private_target',
  );

  const failedImporter = createTravelProductImporter({
    fetchHtml: async () => ({ status: 302, location: 'https://example.com/next' }),
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  });
  const failed = await failedImporter({ url: 'https://example.com/product' });
  assert.equal(failed.ok, false);
  assert.equal(failed.kind, 'redirect');

  for (const [status, kind] of [[403, 'blocked'], [429, 'blocked'], [503, 'http_error']]) {
    const importer = createTravelProductImporter({ fetchHtml: async () => ({ status }) });
    const result = await importer({ url: 'https://example.com/product' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, kind);
  }

  const timedOut = new Error('페이지 수집 시간이 초과되었습니다.');
  timedOut.kind = 'timeout';
  const timeoutImporter = createTravelProductImporter({ fetchHtml: async () => { throw timedOut; } });
  assert.equal((await timeoutImporter({ url: 'https://example.com/product' })).kind, 'timeout');

  const successImporter = createTravelProductImporter({
    fetchHtml: async () => ({ status: 200, html: '<html><body><h1>여행</h1></body></html>' }),
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  });
  const originalCollectedAt = '2026-10-01T10:20:30.000Z';
  const success = await successImporter({ url: 'https://example.com/product', collectedAt: originalCollectedAt });
  assert.equal(success.ok, true);
  assert.equal(success.imported.collectedAt, originalCollectedAt);
  assert.equal(success.imported.sources[0].collectedAt, originalCollectedAt);
});

test('a resolved Naver shortlink fetches the canonical product URL and keeps the issued link as the affiliate URL', async () => {
  const issuedUrl = 'https://naver.me/GdTuMXPg';
  const canonicalUrl = 'https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101';
  let fetchedUrl = null;
  const importer = createTravelProductImporter({
    resolveUrl: async (url) => { assert.equal(url, issuedUrl); return canonicalUrl; },
    fetchHtml: async (url) => { fetchedUrl = url; return { status: 200, html: '<html><body><h1>대마도 패키지</h1></body></html>' }; },
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  });
  const result = await importer({ url: issuedUrl });
  assert.equal(result.ok, true);
  assert.equal(fetchedUrl, canonicalUrl);
  assert.equal(result.imported.product.detailUrl, canonicalUrl);
  assert.equal(result.imported.product.affiliateUrlRaw, issuedUrl);
  assert.equal(result.imported.sources[0].url, canonicalUrl);
  assert.deepEqual(result.imported.resolution, { issuedUrl, finalUrl: canonicalUrl, chain: [issuedUrl, canonicalUrl] });
});

test('a shortlink resolver that returns an object keeps its visited-address chain on imported.resolution', async () => {
  const issuedUrl = 'https://naver.me/GdTuMXPg';
  const bridgeUrl = 'https://brandconnect.naver.com/connect/abc123';
  const canonicalUrl = 'https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101';
  const chain = [issuedUrl, bridgeUrl, canonicalUrl];
  const importer = createTravelProductImporter({
    resolveUrl: async (url) => { assert.equal(url, issuedUrl); return { finalUrl: canonicalUrl, chain }; },
    fetchHtml: async (url) => ({ status: 200, html: '<html><body><h1>대마도 패키지</h1></body></html>' }),
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  });
  const result = await importer({ url: issuedUrl });
  assert.equal(result.ok, true);
  assert.equal(result.imported.product.detailUrl, canonicalUrl);
  assert.equal(result.imported.product.affiliateUrlRaw, issuedUrl);
  assert.deepEqual(result.imported.resolution, { issuedUrl, finalUrl: canonicalUrl, chain });
  assert.deepEqual(result.imported.resolution.chain, chain);
});

test('a shortlink without an injected resolver fails clearly instead of hanging', async () => {
  const importer = createTravelProductImporter({ fetchHtml: async () => ({ status: 200, html: '<html></html>' }) });
  const result = await importer({ url: 'https://naver.me/GdTuMXPg' });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'shortlink_unsupported');
});

test('a shortlink resolver that points to a private address is rejected', async () => {
  const importer = createTravelProductImporter({
    resolveUrl: async () => 'http://127.0.0.1/internal',
    fetchHtml: async () => ({ status: 200, html: '<html></html>' }),
  });
  const result = await importer({ url: 'https://naver.me/GdTuMXPg' });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'redirect');
});
