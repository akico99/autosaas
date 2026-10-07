'use strict';

// 여행 키워드 매칭 테스트. 순수 매처이므로 네트워크·모델 호출 없이 입력만으로 검증한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseSearchAdsRows } = require('../../src/keyword/report');
const { normalizeConnectProduct } = require('../../src/connect/products');
const { matchConnectKeywords } = require('../../src/connect/keywords');

const CHECKED = '2026-10-07T02:00:00.000Z';
const PAGE = {
  id: 'src-page', url: 'https://travel.example.com/products/danang-1', accessLevel: 'full-page', publishedAt: null,
  collectedAt: '2026-10-07T01:00:00.000Z',
  excerpt: '다낭 3박4일 패키지 1인 129,000원. 부모님 동반 가능. 노쇼핑 일정. 출발 7일 전까지 전액 환불. 쇼핑 2회 포함 일정.',
};
const SOURCES = [PAGE];
const fact = (field, value, excerpt, extra = {}) => ({ field, value, sourceId: 'src-page', excerpt: excerpt || String(value), status: 'verified', checkedAt: CHECKED, ...extra });

function travel(id, name, destination, { travelType = 'package', eligibility = 'unknown', facts = [], variants = [] } = {}) {
  return normalizeConnectProduct({
    id, connectKind: 'travel', name, provider: '예시여행사',
    detailUrl: 'https://travel.example.com/p/' + id, affiliateUrl: 'https://naver.me/' + id, profileKey: 'travel-a', eligibility,
    travelDetails: { destination, travelType, nights: 3, days: 4, inclusions: [], exclusions: [], cancellationPolicy: '' },
    variants, facts,
  }, { sources: SOURCES });
}
const danang = () => travel('p-danang', '다낭 3박4일 패키지', '다낭', {
  facts: [
    fact('audience', '부모님 동반 가능', '부모님 동반 가능'),
    fact('shopping', '노쇼핑', '노쇼핑 일정'),
    fact('cancellationPolicy', '출발 7일 전까지 전액 환불', '출발 7일 전까지 전액 환불'),
  ],
  variants: [{ id: 'v1', currency: 'KRW', amountMinor: 129000, priceCheckedAt: CHECKED, options: [], departureDate: '2026-11-03', adults: 2, children: 0, roomBasis: '디럭스룸' }],
});
const nha = () => travel('p-nha', '나트랑 4박5일 자유여행', '나트랑');
const osakaExcluded = () => travel('p-osaka', '오사카 비밀상품', '오사카', { eligibility: 'excluded' });
const byKeyword = (rows, keyword) => rows.find((r) => r.keyword === keyword);

test('preserves_volume_uncertainty: <10, 결측, 자동완성 미제공을 유지하고 합산하지 않는다', () => {
  const parsed = parseSearchAdsRows([
    ['연관키워드', '월간검색수(PC)', '월간검색수(모바일)'],
    ['다낭 패키지', '1,200', '3,400'],
    ['다낭 패키지 후기', '< 10', '50'],
    ['다낭 패키지 취소', '', ''],
    ['다낭 패키지', '9,999', '9,999'],
    ['다낭패키지', '7', '7'],
  ]);
  const rows = matchConnectKeywords({
    seed: '다낭 패키지', adsRows: parsed.rows, autocomplete: ['다낭 패키지', '다낭 패키지 부모님', '다낭 패키지 후기'],
    questions: [], products: [danang()], observations: [],
  });
  const main = byKeyword(rows, '다낭 패키지');
  assert.equal(main.monthlyPc, 1200);
  assert.equal(main.monthlyMobile, 3400);
  assert.equal(main.monthlyTotal, 4600, '반복 행은 합산하지 않고 첫 행만 사용');
  assert.equal(rows.filter((r) => r.keyword.replace(/\s/g, '') === '다낭패키지').length, 1, '띄어쓰기만 다른 행은 하나로 본다');
  const review = byKeyword(rows, '다낭 패키지 후기');
  assert.equal(review.monthlyPc, '<10');
  assert.equal(review.monthlyMobile, 50);
  assert.equal(review.monthlyTotal, null);
  const blank = byKeyword(rows, '다낭 패키지 취소');
  assert.equal(blank.monthlyPc, null);
  assert.equal(blank.monthlyMobile, null);
  assert.equal(blank.monthlyTotal, null);
  const autoOnly = byKeyword(rows, '다낭 패키지 부모님');
  assert.equal(autoOnly.monthlyPc, null);
  assert.equal(autoOnly.monthlyTotal, null);
  assert.deepEqual(autoOnly.sources, ['naver-autocomplete']);
  assert.equal(autoOnly.volumeStatus, 'not-provided');
  assert.equal(review.volumeStatus, 'under-10');
  assert.equal(blank.volumeStatus, 'missing');
  assert.equal(main.volumeStatus, 'confirmed');
});

test('preserves_volume_uncertainty: 표기만 다른 키워드에 검색량을 옮기지 않는다', () => {
  const rows = matchConnectKeywords({
    seed: '다낭', adsRows: [{ keyword: '다낭 패키지', monthlyPc: 100, monthlyMobile: 200 }],
    autocomplete: ['다낭 패키지여행'], questions: [], products: [danang()], observations: [],
  });
  const variant = byKeyword(rows, '다낭 패키지여행');
  assert.equal(variant.monthlyTotal, null);
  assert.equal(variant.monthlyPc, null);
});

test('matches_region_audience_and_product: 지역·대상·확인 조건으로만 상품을 연결한다', () => {
  const products = [danang(), nha(), osakaExcluded()];
  const rows = matchConnectKeywords({
    seed: '패키지',
    adsRows: [],
    autocomplete: [
      '다낭 패키지', '다낭 부모님 패키지', '다낭 노쇼핑 패키지', '다낭 아이 동반 패키지', '나트랑 노쇼핑 패키지',
      '나트랑 패키지', '도쿄 패키지', '오사카 패키지', '패키지 여행 추천', '다낭 호텔', '다낭 취소 환불', '다낭 선택관광',
    ],
    questions: [], products, observations: [],
  });
  const expectRow = (keyword, fit, ids) => {
    const row = byKeyword(rows, keyword);
    assert.ok(row, keyword);
    assert.equal(row.fit, fit, keyword + ' fit');
    assert.deepEqual(row.productIds, ids, keyword + ' productIds');
    assert.ok(Array.isArray(row.reasons) && row.reasons.length > 0, keyword + ' reasons');
    return row;
  };
  expectRow('다낭 패키지', 'fit', ['p-danang']);
  expectRow('다낭 부모님 패키지', 'fit', ['p-danang']);
  expectRow('다낭 노쇼핑 패키지', 'fit', ['p-danang']);
  expectRow('다낭 취소 환불', 'fit', ['p-danang']);
  // 검토된 근거가 없는 대상·선택관광은 조건부로 남긴다.
  expectRow('다낭 아이 동반 패키지', 'conditional', ['p-danang']);
  expectRow('다낭 선택관광', 'conditional', ['p-danang']);
  expectRow('나트랑 패키지', 'fit', ['p-nha']);
  const nhaShopping = expectRow('나트랑 노쇼핑 패키지', 'conditional', ['p-nha']);
  assert.ok(nhaShopping.reasons.some((r) => /쇼핑/.test(r)));
  // 상품 유형이 다르면 적합으로 단정하지 않는다.
  expectRow('다낭 호텔', 'conditional', ['p-danang']);
  // 지원하지 않는 지역, 제외 상품 지역, 지역 없는 키워드는 상품에 연결하지 않는다.
  expectRow('도쿄 패키지', 'unfit', []);
  expectRow('패키지 여행 추천', 'unfit', []);
  const excluded = expectRow('오사카 패키지', 'unfit', []);
  assert.ok(!JSON.stringify(excluded).includes('p-osaka'));
  assert.ok(!JSON.stringify(excluded).includes('비밀상품'));
});

test('matches_region_audience_and_product: 상품 이름만으로 노쇼핑·대상을 추정하지 않고 검토되지 않은 근거는 인정하지 않는다', () => {
  const named = travel('p-named', '다낭 노쇼핑 부모님 효도 패키지', '다낭', {
    facts: [
      fact('shopping', '노쇼핑', '노쇼핑 일정', { status: 'unverified' }),
      fact('audience', '부모님 동반 가능', '부모님 동반 가능', { status: 'conflict' }),
    ],
  });
  const rows = matchConnectKeywords({
    seed: '다낭', adsRows: [], autocomplete: ['다낭 노쇼핑 패키지', '다낭 부모님 패키지'],
    questions: [], products: [named], observations: [],
  });
  const noShopping = byKeyword(rows, '다낭 노쇼핑 패키지');
  const parents = byKeyword(rows, '다낭 부모님 패키지');
  assert.equal(noShopping.fit, 'conditional');
  assert.deepEqual(noShopping.productIds, ['p-named']);
  assert.equal(parents.fit, 'conditional');
});

test('matches_region_audience_and_product: 검토된 쇼핑 사실이 노쇼핑과 모순되면 그 상품에 연결하지 않는다', () => {
  const contradicted = travel('p-shop', '다낭 쇼핑 패키지', '다낭', {
    facts: [fact('shopping', '쇼핑 2회', '쇼핑 2회 포함 일정')],
  });
  assert.equal(contradicted.facts[0].status, 'verified');
  const rows = matchConnectKeywords({
    seed: '다낭', adsRows: [], autocomplete: ['다낭 노쇼핑 패키지'], questions: [], products: [contradicted], observations: [],
  });
  const row = byKeyword(rows, '다낭 노쇼핑 패키지');
  assert.equal(row.fit, 'unfit');
  assert.deepEqual(row.productIds, []);
});

test('blocked_serp_is_not_low_competition: 차단·실패는 관찰 실패이고 광고 경쟁지수는 SEO 난이도가 아니다', () => {
  const rows = matchConnectKeywords({
    seed: '다낭',
    adsRows: [
      { keyword: '다낭 패키지 차단', monthlyPc: 100, monthlyMobile: 100, competition: 0.01, compIdx: '낮음' },
      { keyword: '다낭 패키지 미관찰', monthlyPc: 100, monthlyMobile: 100, competition: 0.99, compIdx: '높음' },
      { keyword: '다낭 패키지 실패', monthlyPc: 100, monthlyMobile: 100 },
      { keyword: '다낭 패키지 블로그', monthlyPc: 10, monthlyMobile: 10 },
    ],
    autocomplete: [], questions: [], products: [danang()],
    observations: [
      { keyword: '다낭 패키지 차단', measured: false, blocked: true, reason: '검색 제한' },
      { keyword: '다낭 패키지 실패', measured: false, blocked: false, reason: '렌더 실패', blocks: [] },
      { keyword: '다낭 패키지 블로그', measured: true, blocked: false, blocks: [{ blockOrder: 2, blockName: '블로그', blockKind: 'blog', itemCount: 5, blogCount: 5 }] },
    ],
  });
  const blocked = byKeyword(rows, '다낭 패키지 차단');
  const unobserved = byKeyword(rows, '다낭 패키지 미관찰');
  const failed = byKeyword(rows, '다낭 패키지 실패');
  const blog = byKeyword(rows, '다낭 패키지 블로그');
  assert.equal(blocked.observation.status, 'blocked');
  assert.equal(failed.observation.status, 'failed');
  assert.equal(unobserved.observation.status, 'none');
  assert.equal(blog.observation.status, 'blog-area');
  // 블로그 영역이 관찰된 행은 검색량이 작아도 앞서고, 차단·실패·미관찰은 같은 단계로 검색량·표기 순서만 따른다.
  const order = rows.map((r) => r.keyword);
  assert.equal(order[0], '다낭 패키지 블로그');
  assert.deepEqual(order.slice(1).sort(), ['다낭 패키지 미관찰', '다낭 패키지 실패', '다낭 패키지 차단'].sort());
  assert.ok(blocked.reasons.some((r) => /차단/.test(r)));
  assert.ok(!blocked.reasons.some((r) => /낮은 경쟁|경쟁이 낮|쉬움|유리/.test(r)));
  for (const row of rows) {
    for (const key of Object.keys(row)) assert.ok(!/seo|difficulty|competition|score|난이도/i.test(key), 'unexpected key ' + key);
  }
});

test('ordering: 적합성 → 근거 → 질문 구체성 → 검색 관찰 → 시기 → 검색량 순서로 정렬한다', () => {
  const rows = matchConnectKeywords({
    seed: '패키지',
    adsRows: [
      { keyword: '도쿄 패키지', monthlyPc: 100000, monthlyMobile: 100000 },
      { keyword: '나트랑 패키지', monthlyPc: 90000, monthlyMobile: 90000 },
      { keyword: '다낭 아이 동반 패키지', monthlyPc: 80000, monthlyMobile: 80000 },
      { keyword: '다낭 패키지', monthlyPc: 10, monthlyMobile: 10 },
      { keyword: '다낭 패키지 질문', monthlyPc: 10, monthlyMobile: 10 },
      { keyword: '다낭 패키지 관찰', monthlyPc: 10, monthlyMobile: 10 },
      { keyword: '다낭 11월 패키지', monthlyPc: 10, monthlyMobile: 10 },
      { keyword: '다낭 패키지 검색량', monthlyPc: 500, monthlyMobile: 500 },
      { keyword: '다낭 패키지 미제공', monthlyPc: '<10', monthlyMobile: 500 },
    ],
    autocomplete: [],
    questions: [{ id: 'q1', question: '부모님이 걷기 힘들면 일정이 괜찮을까요?', keyword: '다낭 패키지 질문', audience: '부모님', region: '다낭' }],
    products: [danang(), nha()],
    observations: [{ keyword: '다낭 패키지 관찰', measured: true, blocked: false, blocks: [{ blockOrder: 1, blockName: '블로그', blockKind: 'blog', itemCount: 3, blogCount: 3 }] }],
    now: new Date('2026-10-08T00:00:00.000Z'),
  });
  const order = rows.map((r) => r.keyword);
  const idx = (k) => order.indexOf(k);
  assert.ok(idx('다낭 패키지 질문') < idx('다낭 패키지 관찰'), '질문 구체성이 검색 관찰보다 앞');
  assert.ok(idx('다낭 패키지 관찰') < idx('다낭 11월 패키지'), '검색 관찰이 시기보다 앞');
  assert.ok(idx('다낭 11월 패키지') < idx('다낭 패키지 검색량'), '시기가 검색량보다 앞');
  assert.ok(idx('다낭 패키지 검색량') < idx('다낭 패키지'), '확인된 검색량이 작은 값보다 앞');
  assert.ok(idx('다낭 패키지') < idx('다낭 패키지 미제공'), '검색량 미확인은 확인된 값 뒤');
  assert.ok(idx('다낭 패키지 미제공') < idx('나트랑 패키지'), '근거가 많은 상품의 키워드가 앞');
  assert.ok(idx('나트랑 패키지') < idx('다낭 아이 동반 패키지'), '적합이 조건부보다 앞');
  assert.ok(idx('다낭 아이 동반 패키지') < idx('도쿄 패키지'), '조건부가 부적합보다 앞(검색량이 커도)');
  const q = byKeyword(rows, '다낭 패키지 질문');
  assert.deepEqual(q.questions.map((x) => x.id), ['q1']);
});

test('matchConnectKeywords는 네트워크 수집 엔진을 불러오지 않는 순수 함수다', () => {
  const loaded = Object.keys(require.cache).map((file) => file.split(path.sep).join('/'));
  assert.ok(!loaded.some((file) => /src\/keyword\/(expand|integratedSerp|serpObserve|trends)\.js$/.test(file)));
  assert.deepEqual(matchConnectKeywords({ seed: '', adsRows: [], autocomplete: [], questions: [], products: [], observations: [] }), []);
  assert.throws(() => matchConnectKeywords(), /입력/);
});

// ---- 리뷰 반영: 부정 표현·범위가 있는 검토 사실 ----
function withFact(field, value) {
  const source = { ...PAGE, id: 'src-own', excerpt: String(value) };
  return normalizeConnectProduct({
    id: 'p-fact', connectKind: 'travel', name: '다낭 확인 상품', provider: '예시여행사',
    detailUrl: 'https://travel.example.com/p/fact', affiliateUrl: 'https://naver.me/fact', profileKey: 'travel-a', eligibility: 'unknown',
    travelDetails: { destination: '다낭', travelType: 'package', nights: 3, days: 4, inclusions: [], exclusions: [], cancellationPolicy: '' },
    variants: [],
    facts: [{ field, value, sourceId: 'src-own', excerpt: String(value), status: 'verified', checkedAt: CHECKED }],
  }, { sources: [source] });
}
function matchOne(keyword, product) {
  const rows = matchConnectKeywords({ seed: '다낭', adsRows: [], autocomplete: [keyword], questions: [], products: [product], observations: [] });
  return byKeyword(rows, keyword);
}

test('negated_shopping: 쇼핑센터 방문 없음 같은 부정 표현은 노쇼핑 근거다', () => {
  for (const value of ['쇼핑센터 방문 없음', '쇼핑 일정 없음', '쇼핑센터 방문하지 않음', '쇼핑 0회', '쇼핑 없음', '쇼핑은 없습니다', '노쇼핑']) {
    const product = withFact('shopping', value);
    assert.equal(product.facts[0].status, 'verified', value);
    const row = matchOne('다낭 노쇼핑 패키지', product);
    assert.equal(row.fit, 'fit', value);
    assert.deepEqual(row.productIds, ['p-fact'], value);
  }
  assert.equal(matchOne('다낭 노쇼핑 패키지', withFact('shopping', '없음')).fit, 'fit');
});

test('negated_shopping: 쇼핑 횟수 근거는 쇼핑에 묶인 숫자만 모순으로 본다', () => {
  for (const value of ['쇼핑 2회', '쇼핑센터 2회 방문', '2회 쇼핑', '쇼핑 1회, 자유시간 2회', '쇼핑 일정 있음']) {
    const row = matchOne('다낭 노쇼핑 패키지', withFact('shopping', value));
    assert.equal(row.fit, 'unfit', value);
    assert.deepEqual(row.productIds, [], value);
  }
  // 쇼핑과 무관한 숫자·0·모호한 표현은 확인도 모순도 아니다.
  for (const value of ['자유시간 2회', '쇼핑 쿠폰 0원', '쇼핑0원 쿠폰', '가이드 팁 0원', '쇼핑 강요 없음', '쇼핑 정보 확인 필요']) {
    const row = matchOne('다낭 노쇼핑 패키지', withFact('shopping', value));
    assert.equal(row.fit, 'conditional', value);
    assert.deepEqual(row.productIds, ['p-fact'], value);
  }
});

test('negated_shopping: 노쇼핑 표현과 쇼핑 횟수가 한 근거 안에서 어긋나면 적합으로도 제외로도 단정하지 않는다', () => {
  for (const value of ['노쇼핑, 쇼핑 2회', '쇼핑센터 방문 없음 / 쇼핑 1회']) {
    const row = matchOne('다낭 노쇼핑 패키지', withFact('shopping', value));
    assert.equal(row.fit, 'conditional', value);
    assert.deepEqual(row.productIds, ['p-fact'], value);
    assert.ok(row.reasons.some((r) => /어긋|충돌/.test(r)), value);
  }
});

test('negated_shopping: 선택관광도 같은 규칙을 따른다', () => {
  assert.equal(matchOne('다낭 노옵션 패키지', withFact('optionalTours', '선택관광 없음')).fit, 'fit');
  assert.equal(matchOne('다낭 노옵션 패키지', withFact('optionalTours', '노옵션')).fit, 'fit');
  assert.equal(matchOne('다낭 노옵션 패키지', withFact('optionalTours', '선택관광 3회')).fit, 'unfit');
  for (const value of ['자유시간 2회', '선택관광 안내 확인 필요']) {
    assert.equal(matchOne('다낭 노옵션 패키지', withFact('optionalTours', value)).fit, 'conditional', value);
  }
});

test('audience_negation: 불가·제한·비추천 표현은 대상 확인으로 세지 않는다', () => {
  for (const value of ['아이 동반 불가', '아이 동반 제한', '아이 동반 비추천', '만 7세 미만 아동 불가', '아이 동반이 어려움']) {
    const row = matchOne('다낭 아이 동반 패키지', withFact('audience', value));
    assert.equal(row.fit, 'conditional', value);
    assert.deepEqual(row.productIds, ['p-fact'], value);
    assert.ok(row.reasons.some((r) => /불가|제한|비추천|부정/.test(r)), value);
  }
  // 어느 대상인지 밝히지 않은 제한 표현도 확인으로 보지 않는다.
  assert.equal(matchOne('다낭 부모님 패키지', withFact('audience', '동반 불가')).fit, 'conditional');
  assert.equal(matchOne('다낭 부모님 패키지', withFact('audience', '부모님 동반 비추천')).fit, 'conditional');
});

test('audience_negation: 대상별 문장 범위를 나눠 읽는다', () => {
  const both = withFact('audience', '부모님 동반 가능, 아이 동반 불가');
  assert.equal(matchOne('다낭 부모님 패키지', both).fit, 'fit');
  assert.equal(matchOne('다낭 아이 동반 패키지', both).fit, 'conditional');
  assert.equal(matchOne('다낭 아이 동반 패키지', withFact('audience', '아이 동반 가능')).fit, 'fit');
  // 같은 대상에 가능·불가가 함께 있으면 어긋남으로 조건부.
  assert.equal(matchOne('다낭 아이 동반 패키지', withFact('audience', '아이 동반 가능, 아이 동반 불가')).fit, 'conditional');
});

test('audience_negation: 슬래시·가운뎃점으로 묶인 불가 대상은 모두 조건부로 둔다', () => {
  for (const value of ['부모님·아이 동반 불가', '부모님/아이 동반 불가']) {
    assert.equal(matchOne('다낭 부모님 패키지', withFact('audience', value)).fit, 'conditional', value);
    assert.equal(matchOne('다낭 아이 동반 패키지', withFact('audience', value)).fit, 'conditional', value);
  }
  const independentlyScoped = withFact('audience', '부모님 동반 가능, 아이 동반 불가');
  assert.equal(matchOne('다낭 부모님 패키지', independentlyScoped).fit, 'fit');
  assert.equal(matchOne('다낭 아이 동반 패키지', independentlyScoped).fit, 'conditional');
});

test('잘못된 now는 오류 없이 시기 비교만 생략하고, 제외 상품은 존재 자체를 암시하지 않는다', () => {
  const rows = matchConnectKeywords({
    seed: '다낭', adsRows: [], autocomplete: ['다낭 11월 패키지', '오사카 패키지'], questions: [],
    products: [danang(), osakaExcluded()], observations: [], now: 'not-a-date',
  });
  assert.equal(byKeyword(rows, '다낭 11월 패키지').timingMatch, true);
  const hidden = byKeyword(rows, '오사카 패키지');
  const none = matchConnectKeywords({ seed: '', adsRows: [], autocomplete: ['도쿄 패키지'], questions: [], products: [danang()], observations: [] })[0];
  assert.deepEqual(hidden.reasons.filter((r) => /지역/.test(r)), none.reasons.filter((r) => /지역/.test(r)));
});
