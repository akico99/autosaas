'use strict';

// 제휴 연결(connectContext)을 기존 검색 생성기에 붙이는 테스트. 모든 수집·모델 호출은 주입으로 대신하고,
// 실제 네트워크 모듈은 호출되면 기록 후 실패하도록 막는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const liveCalls = [];
const LIVE_MODULES = new Set(['../keyword/expand', '../keyword/trends', '../keyword/serpObserve', '../place/placeLookup', '../keyword/niche', '../keyword/background', './runClaude']);
const originalLoad = Module._load;
Module._load = function loadOffline(request, parent, isMain) {
  if (LIVE_MODULES.has(request) && parent && /[\\/]src[\\/]/.test(parent.filename)) {
    return new Proxy({}, {
      get(_, name) {
        if (typeof name !== 'string') return undefined;
        return async () => { liveCalls.push(request + ':' + name); throw new Error('live call blocked: ' + request + ':' + name); };
      },
    });
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { generateSearchPost } = require('../../src/generator/generateSearchPost');
const { buildSearchBrief } = require('../../src/generator/searchBrief');
const { buildSearchSystemPrompt, buildSearchUserPrompt } = require('../../src/generator/buildSearchPrompt');
const { buildConnectContext } = require('../../src/connect/products');
Module._load = originalLoad;

const HAIKU = 'claude-haiku-4-5-20251001';
const NOW = () => new Date('2026-10-07T03:00:00.000Z');
const CHECKED = '2026-10-07T02:00:00.000Z';
const RAW_LINK = 'https://naver.me/Ab%2Fcd?x=1&x=2&utm_source=blog#Frag';
const PAGE = {
  id: 'src-page', url: 'https://travel.example.com/products/danang-1', accessLevel: 'full-page', publishedAt: null,
  collectedAt: '2026-10-07T01:00:00.000Z',
  excerpt: '다낭 3박4일 패키지 성인 2명 디럭스룸 기준 1인 129,000원. 포함: 왕복 항공, 호텔 조식. 불포함: 가이드 팁. 출발 7일 전까지 전액 환불.',
};
const USER_NOTE = {
  id: 'src-user', url: 'https://travel.example.com/products/danang-1/notice', accessLevel: 'user-excerpt', publishedAt: null,
  collectedAt: '2026-10-07T01:00:00.000Z', excerpt: '예약 확정 후 출발일 변경 불가',
};
const SNIPPET = {
  id: 'src-snippet', url: 'https://search.example.com/result?q=danang', accessLevel: 'search-snippet', publishedAt: null,
  collectedAt: '2026-10-07T01:00:00.000Z', excerpt: '다낭 패키지 99,000원 특가 취소 수수료 없음',
};

function danangProduct(overrides = {}) {
  return {
    id: 'p-danang', connectKind: 'travel', name: '다낭 3박4일 패키지', provider: '예시여행사',
    detailUrl: 'https://travel.example.com/products/danang-1', affiliateUrl: RAW_LINK, profileKey: 'travel-a', eligibility: 'unknown',
    travelDetails: { destination: '다낭', travelType: 'package', nights: 3, days: 4, inclusions: ['왕복 항공', '호텔 조식'], exclusions: ['가이드 팁'], cancellationPolicy: '출발 7일 전까지 전액 환불' },
    variants: [{ id: 'v1', currency: 'KRW', amountMinor: 129000, priceCheckedAt: CHECKED, options: [], departureDate: '2026-11-03', adults: 2, children: 0, roomBasis: '디럭스룸' }],
    facts: [
      { field: 'variant:v1:price', value: 129000, sourceId: 'src-page', excerpt: '1인 129,000원', status: 'verified', checkedAt: CHECKED },
      { field: 'cancellationPolicy', value: '출발 7일 전까지 전액 환불', sourceId: 'src-page', excerpt: '출발 7일 전까지 전액 환불', status: 'verified', checkedAt: CHECKED },
      { field: 'changePolicy', value: '출발일 변경 불가', sourceId: 'src-user', excerpt: '예약 확정 후 출발일 변경 불가', status: 'verified', checkedAt: CHECKED },
      { field: 'promoPrice', value: 99000, sourceId: 'src-snippet', excerpt: '99,000원', status: 'verified', checkedAt: CHECKED },
    ],
    ...overrides,
  };
}
function nhaProduct() {
  return {
    id: 'p-nha', connectKind: 'travel', name: '나트랑 4박5일 자유여행', provider: '예시여행사',
    detailUrl: 'https://travel.example.com/products/nha-2', affiliateUrl: 'https://naver.me/Nha2', profileKey: 'travel-a', eligibility: 'unknown',
    travelDetails: { destination: '나트랑', travelType: 'package', nights: 4, days: 5, inclusions: [], exclusions: [], cancellationPolicy: '' },
    variants: [], facts: [],
  };
}
function connectCtx({ products = [danangProduct()], experience = '', variantIds = ['v1'] } = {}) {
  return buildConnectContext({ products, variantIds, sources: [PAGE, USER_NOTE, SNIPPET], experience, now: NOW });
}

// 기존 검증의 최소 분량(정보형 1000자)을 넘기도록 본문 문단을 충분히 둔다.
const LONG = '이 상품은 성인 2명이 디럭스룸을 함께 쓰는 기준으로 구성되어 있어 일정과 인원 조건을 먼저 맞춰 보는 것이 좋습니다. 왕복 항공과 호텔 조식이 포함되고 가이드 팁은 별도라서 현지 경비를 따로 챙겨야 합니다. 출발일과 객실 조건이 바뀌면 가격도 달라질 수 있으니 예약 화면에서 같은 조건인지 확인하세요. ';
function samplePost({ title = '다낭 패키지 여행 상품 조건과 예약 전 확인할 점', extraText = '' } = {}) {
  return {
    title, description: '다낭 3박4일 패키지의 가격 기준, 포함·불포함 항목, 취소 조건을 정리했습니다.', thumbnailText: '다낭 패키지 조건',
    blocks: [
      { kind: 'text', text: LONG + extraText },
      { kind: 'heading', text: '다낭 패키지 가격 기준' },
      { kind: 'text', text: LONG + LONG },
      { kind: 'table', columns: ['항목', '내용'], rows: [['가격', '1인 129,000원 (성인 2명 디럭스룸)'], ['불포함', '가이드 팁']] },
      { kind: 'heading', text: '포함 항목과 불포함 항목' },
      { kind: 'text', text: LONG + LONG },
      { kind: 'heading', text: '취소와 변경 조건' },
      { kind: 'text', text: LONG + LONG },
      { kind: 'qna', question: '취소하면 환불되나요?', answer: '출발 7일 전까지 취소하면 전액 환불돼요.' },
    ],
  };
}

function harness({ postText, generationTexts } = {}) {
  const calls = { generation: [], factCheck: [], contentCheck: [], collectors: [] };
  const texts = generationTexts ? [...generationTexts] : null;
  const run = async (args) => {
    calls.generation.push(args);
    const text = texts && texts.length ? texts.shift() : (postText || JSON.stringify(samplePost()));
    return { text, meta: { usage: 'test' } };
  };
  const factCheckRun = async (args) => { calls.factCheck.push(args); return { text: '{"claims":[]}' }; };
  const contentCheckRun = async (args) => {
    calls.contentCheck.push(args);
    const ids = [...String(args.user).matchAll(/id=(\S+) \//g)].map((m) => m[1]);
    return { text: JSON.stringify({ items: ids.map((id) => ({ id, covered: true, blocks: [1], note: 'ok' })) }) };
  };
  const NEWS = [{ url: 'https://news.example.com/article/1', title: '다낭 여행 특가 소식', body: '여행업계에 따르면 다낭 패키지가 79,000원 특가로 나왔고 취소 수수료가 없다고 전해졌습니다. 업계는 연말 수요가 늘 것으로 봅니다.', sourceType: 'news-article', kind: 'article-body', contentKind: 'body' }];
  const collectors = {
    fetchAutocomplete: async (kw) => { calls.collectors.push('fetchAutocomplete'); return [kw + ' 가격', kw + ' 후기']; },
    observeSerp: async () => { calls.collectors.push('observeSerp'); return { measured: false, blocked: false, reason: 'offline test' }; },
    gatherKeywordContext: async () => { calls.collectors.push('gatherKeywordContext'); return { keywordFacts: ['다낭 패키지 79,000원 특가 검색 발췌'], keywordBackground: [], keywordSources: [] }; },
    fetchNewsArticles: async () => { calls.collectors.push('fetchNewsArticles'); return NEWS; },
    fetchBlogFacts: async () => { calls.collectors.push('fetchBlogFacts'); return []; },
    fetchPlaceReviews: async () => { calls.collectors.push('fetchPlaceReviews'); return []; },
    fetchNearbyAttractions: async () => { calls.collectors.push('fetchNearbyAttractions'); return []; },
    fetchPlaceInfo: async () => { calls.collectors.push('fetchPlaceInfo'); return null; },
  };
  return { calls, run, factCheckRun, contentCheckRun, collectors };
}

function withFixedRandom(fn) {
  const original = Math.random;
  Math.random = () => 0;
  try { return fn(); } finally { Math.random = original; }
}

test('no_context_preserves_legacy_generation', async () => {
  liveCalls.length = 0;
  const h = harness({ postText: JSON.stringify(samplePost({ title: '강릉 여행 코스 정리' })) });
  const result = await generateSearchPost({
    topic: 'domestictravel', keyword: '강릉 여행 코스',
    run: h.run, factCheckRun: h.factCheckRun, contentCheckRun: h.contentCheckRun, collectors: h.collectors,
  });
  assert.deepEqual(liveCalls, []);
  for (const name of ['fetchAutocomplete', 'observeSerp', 'gatherKeywordContext', 'fetchNewsArticles']) {
    assert.ok(h.calls.collectors.includes(name), name + ' 수집이 기존처럼 실행되어야 함');
  }
  assert.equal(h.calls.generation[0].model, undefined, '기존 요청의 기본 모델은 바뀌지 않음');
  assert.equal(h.calls.generation[0].system, buildSearchSystemPrompt('domestictravel'));
  assert.match(h.calls.generation[0].system, /실제 방문 경험/);
  assert.doesNotMatch(h.calls.generation[0].user, /제휴 연결 정보|등록 상품 근거/);
  assert.equal(h.calls.factCheck[0].model, HAIKU);
  assert.equal(h.calls.contentCheck[0].model, HAIKU);
  assert.equal(result.connect, undefined);
  assert.equal(result.brief.intent, 'place');
  assert.deepEqual(result.brief.requiredAnswers.map((a) => a.id), ['location', 'hours', 'cost', 'tips']);
  // 기사 본문은 기존처럼 원문 근거로 팩트 대조에 들어간다.
  assert.match(h.calls.factCheck[0].user, /news\.example\.com\/article\/1/);

  const briefArgs = { keyword: '강릉 여행 코스', topic: 'domestictravel', autocomplete: ['강릉 여행 코스 1박2일'] };
  assert.deepEqual(buildSearchBrief({ ...briefArgs, connectContext: undefined }), buildSearchBrief(briefArgs));
  const legacyPrompt = withFixedRandom(() => buildSearchUserPrompt({ topicKey: 'domestictravel', keyword: '강릉 여행 코스' }));
  assert.equal(withFixedRandom(() => buildSearchUserPrompt({ topicKey: 'domestictravel', keyword: '강릉 여행 코스', connectContext: null })), legacyPrompt);
  assert.match(legacyPrompt, /커뮤니티에서는/);
  assert.equal(buildSearchSystemPrompt('worldtravel', { connectContext: null }), buildSearchSystemPrompt('worldtravel'));
});

test('uses_existing_search_generation_and_runner', async () => {
  liveCalls.length = 0;
  const ctx = connectCtx();
  const fenced = '\u0060\u0060\u0060json\n' + JSON.stringify(samplePost()) + '\n\u0060\u0060\u0060';
  const h = harness({ generationTexts: ['{ 잘린 JSON', fenced] });
  const result = await generateSearchPost({
    topic: 'worldtravel', keyword: '다낭 패키지 여행', connectContext: ctx,
    run: h.run, factCheckRun: h.factCheckRun, contentCheckRun: h.contentCheckRun, collectors: h.collectors,
  });
  assert.deepEqual(liveCalls, []);
  assert.equal(h.calls.generation.length, 2, 'JSON 파싱 실패는 기존 재시도 경로를 탄다');
  assert.equal(result.attempts, 2);
  assert.deepEqual(h.calls.generation.map((c) => c.model), ['opus', 'opus'], '여행 연결 원고 생성 기본 모델은 opus');
  assert.equal(h.calls.generation[0].system, buildSearchSystemPrompt('worldtravel', { connectContext: ctx }));
  assert.match(h.calls.generation[0].system, /^너는 검색자의 질문과 확인된 근거를 중심으로/);
  assert.match(h.calls.generation[0].user, /\[제휴 연결 정보\]/);
  assert.ok(h.calls.generation[0].user.includes(RAW_LINK));
  assert.equal(h.calls.factCheck.length, 1);
  assert.equal(h.calls.factCheck[0].model, HAIKU, '팩트 대조는 기존 Haiku 유지');
  assert.ok(h.calls.contentCheck.length >= 1);
  assert.ok(h.calls.contentCheck.every((c) => c.model === HAIKU), '필수 답변 검사는 기존 Haiku 유지');
  assert.equal(result.post.title, '다낭 패키지 여행 상품 조건과 예약 전 확인할 점');
  assert.ok(['ready', 'review'].includes(result.status), result.status + ' ' + JSON.stringify(result.holdReasons));
  assert.equal(result.meta.usage, 'test');
  assert.equal(result.connect.snapshotHash, ctx.snapshotHash);
  assert.equal(result.connect.generation.generationModel, 'opus');
  assert.equal(result.connect.generation.topic, 'worldtravel');
  assert.deepEqual(result.connect.links, ctx.links);
  assert.equal(result.connect.links[0].affiliateUrlRaw, RAW_LINK);
  assert.equal(result.connect.disclosureLine, ctx.disclosureLine);
  assert.deepEqual(result.connect.uncertainFields, ctx.uncertainFields);

  const h2 = harness();
  await generateSearchPost({
    topic: 'worldtravel', keyword: '다낭 패키지 여행', connectContext: ctx, model: 'sonnet',
    run: h2.run, factCheckRun: h2.factCheckRun, contentCheckRun: h2.contentCheckRun, collectors: h2.collectors,
  });
  assert.equal(h2.calls.generation[0].model, 'sonnet', '호출자가 지정한 모델은 그대로');
  assert.equal(h2.calls.factCheck[0].model, HAIKU);
});

test('product_body_keeps_provenance', async () => {
  liveCalls.length = 0;
  const ctx = connectCtx();
  assert.deepEqual(ctx.sources.map((s) => s.id).sort(), ['src-page', 'src-user']);
  const brief = buildSearchBrief({ keyword: '다낭 패키지 여행', topic: 'worldtravel', connectContext: ctx });
  assert.equal(brief.evidence.connectSources, 2);
  assert.equal(brief.evidence.official, false);
  assert.equal(brief.evidence.institutionOriginals, 0);

  const h = harness();
  const result = await generateSearchPost({
    topic: 'worldtravel', keyword: '다낭 패키지 여행', connectContext: ctx,
    run: h.run, factCheckRun: h.factCheckRun, contentCheckRun: h.contentCheckRun, collectors: h.collectors,
  });
  const fc = h.calls.factCheck[0].user;
  assert.match(fc, /상품 상세 원문에서 검토한 발췌[^\n]*travel\.example\.com\/products\/danang-1\)/);
  assert.match(fc, /사용자가 제공한 상품 발췌[^\n]*danang-1\/notice/);
  assert.doesNotMatch(fc, /기관 원문|공식/);
  assert.doesNotMatch(fc, /99,000원 특가/);
  // 표와 Q&A의 가격·환불 문장도 대조 대상이다.
  const manuscript = fc.slice(fc.indexOf('[검사할 원고]'));
  assert.match(manuscript, /1인 129,000원 \(성인 2명 디럭스룸\)/);
  assert.match(manuscript, /출발 7일 전까지 취소하면 전액 환불돼요/);

  const productSources = result.connect.generation.evidenceSources;
  assert.deepEqual(productSources.map((s) => [s.sourceId, s.sourceType, s.provenance]), [
    ['src-page', 'connect-product-page', 'connect-full-page'],
    ['src-user', 'connect-user-excerpt', 'connect-user-excerpt'],
  ]);
  assert.ok(productSources.every((s) => s.official === false && s.contentKind === 'reviewed-excerpt'));
  const page = productSources[0];
  assert.equal(page.text, PAGE.excerpt, '저장된 검토 발췌만 쓰고 전체 본문이라고 주장하지 않음');
  assert.deepEqual(page.productIds, ['p-danang']);

  const prompt = h.calls.generation[0].user;
  const section = prompt.slice(prompt.indexOf('[등록 상품 근거'));
  assert.ok(prompt.includes('[등록 상품 근거'), '상품 근거 구획이 있어야 함');
  assert.match(section, /상품 상세 원문에서 검토한 발췌/);
  assert.match(section, /사용자가 제공한 상품 발췌/);
  assert.doesNotMatch(section, /99,000/);

  // 위조된 맥락: 검색 발췌를 full-page로 꾸민 출처, 인용되지 않은 출처, 근거 유형이 어긋난 사실은 승격되지 않는다.
  const forged = {
    ...ctx,
    sources: [
      ...ctx.sources,
      { ...SNIPPET, accessLevel: 'full-page', id: 'src-forged' },
      { ...SNIPPET, accessLevel: 'search-snippet' },
      { ...PAGE, id: 'src-uncited', url: 'https://travel.example.com/uncited' },
      { ...USER_NOTE, id: 'src-mismatch', url: 'https://travel.example.com/mismatch' },
    ],
    verifiedFacts: [
      ...ctx.verifiedFacts,
      { productId: 'p-danang', field: 'promoPrice', value: 99000, sourceId: 'src-snippet', excerpt: '99,000원', status: 'verified', checkedAt: CHECKED, verificationBasis: 'full-page' },
      { productId: 'p-danang', field: 'promo', value: '특가', sourceId: 'src-mismatch', excerpt: '출발일 변경 불가', status: 'verified', checkedAt: CHECKED, verificationBasis: 'full-page' },
      { productId: 'p-danang', field: 'forged', value: '특가', sourceId: 'src-forged', excerpt: '특가', status: 'unverified', checkedAt: CHECKED },
    ],
  };
  const forgedBrief = buildSearchBrief({ keyword: '다낭 패키지 여행', topic: 'worldtravel', connectContext: forged });
  assert.equal(forgedBrief.evidence.connectSources, 2);
  const h3 = harness();
  const forgedResult = await generateSearchPost({
    topic: 'worldtravel', keyword: '다낭 패키지 여행', connectContext: forged,
    run: h3.run, factCheckRun: h3.factCheckRun, contentCheckRun: h3.contentCheckRun, collectors: h3.collectors,
  });
  assert.deepEqual(forgedResult.connect.generation.evidenceSources.map((s) => s.sourceId), ['src-page', 'src-user']);
  assert.doesNotMatch(h3.calls.factCheck[0].user, /99,000원 특가|uncited|mismatch/);
});

test('connect_facts_override_experience_requirement', async () => {
  liveCalls.length = 0;
  const noExp = connectCtx();
  for (const topic of ['domestictravel', 'worldtravel']) {
    assert.match(buildSearchSystemPrompt(topic), /실제 방문 경험|직접 해본 경험/);
    const sys = buildSearchSystemPrompt(topic, { connectContext: noExp });
    assert.doesNotMatch(sys, /실제 방문 경험|직접 해본 경험|실제 블로그 후기·리뷰에서 사람들의 경험/);
    assert.match(sys, /여행 상품 정보·비교/);
  }
  const withExp = connectCtx({ experience: '2025년 11월에 이 상품으로 다낭에 다녀왔고 조식이 만족스러웠다' });
  assert.match(buildSearchSystemPrompt('worldtravel', { connectContext: withExp }), /작성자 경험/);

  const single = buildSearchBrief({ keyword: '다낭 패키지 후기', topic: 'worldtravel', connectContext: noExp });
  assert.notEqual(single.intent, 'experience');
  assert.equal(single.evidence.experienceInput, false);
  assert.deepEqual(single.preHoldReasons, []);
  const ids = single.requiredAnswers.map((a) => a.id);
  assert.ok(ids.includes('connect-choice') && ids.includes('connect-before-booking'), ids.join(','));
  assert.ok(!ids.includes('hours'), '장소 영업시간 같은 방문형 필수 답변을 강제하지 않음');

  const pair = buildSearchBrief({ keyword: '다낭 나트랑 패키지', topic: 'worldtravel', connectContext: connectCtx({ products: [danangProduct(), nhaProduct()] }) });
  assert.equal(pair.intent, 'compare');
  const pairIds = pair.requiredAnswers.map((a) => a.id);
  for (const q of ['departureDate', 'inclusions', 'exclusions', 'cancellationPolicy']) assert.ok(pairIds.includes('connect-' + q), q);
  assert.match(pair.requiredAnswers.find((a) => a.id === 'connect-cancellationPolicy').label, /나트랑 4박5일 자유여행/);

  const experienced = buildSearchBrief({ keyword: '다낭 패키지 후기', topic: 'worldtravel', connectContext: withExp });
  assert.equal(experienced.intent, 'experience');
  assert.equal(experienced.evidence.experienceInput, true);
  assert.deepEqual(experienced.preHoldReasons, []);

  const userPrompt = buildSearchUserPrompt({ topicKey: 'domestictravel', keyword: '다낭 패키지', connectContext: noExp });
  assert.doesNotMatch(userPrompt, /커뮤니티에서는 ~라는 얘기가 많더라고요/);
  assert.match(userPrompt, /정보·비교형/);

  // 경험 입력 없이 1인칭 방문 표현을 쓰면 기존 검사로 보류된다.
  const h = harness({ postText: JSON.stringify(samplePost({ extraText: '제가 직접 다녀와 보니 조식이 정말 좋았어요.' })) });
  const result = await generateSearchPost({
    topic: 'worldtravel', keyword: '다낭 패키지 여행', connectContext: noExp, maxAttempts: 1,
    run: h.run, factCheckRun: h.factCheckRun, contentCheckRun: h.contentCheckRun, collectors: h.collectors,
  });
  assert.equal(result.status, 'hold');
  assert.ok(result.holdReasons.some((r) => /1인칭 경험 표현/.test(r)));

  await assert.rejects(() => generateSearchPost({
    topic: 'restaurant', keyword: '다낭 패키지', connectContext: noExp,
    run: h.run, factCheckRun: h.factCheckRun, contentCheckRun: h.contentCheckRun, collectors: h.collectors,
  }), /domestictravel|worldtravel/);
});

test('unrelated_news_does_not_become_product_evidence', async () => {
  liveCalls.length = 0;
  const ctx = connectCtx();
  const h = harness();
  const result = await generateSearchPost({
    topic: 'worldtravel', keyword: '다낭 패키지 여행', connectContext: ctx,
    run: h.run, factCheckRun: h.factCheckRun, contentCheckRun: h.contentCheckRun, collectors: h.collectors,
  });
  assert.deepEqual(liveCalls, []);
  assert.ok(!h.calls.collectors.includes('fetchNewsArticles'), '연결 원고는 일반 뉴스를 상품 근거로 수집하지 않음');
  assert.ok(!h.calls.collectors.includes('gatherKeywordContext'));
  assert.ok(h.calls.collectors.includes('fetchAutocomplete'), '검색 의도 파악용 자동완성은 유지');
  assert.doesNotMatch(h.calls.generation[0].user, /79,000/);
  assert.doesNotMatch(h.calls.factCheck[0].user, /79,000|news\.example\.com/);
  assert.match(h.calls.factCheck[0].user, /등록 상품 근거로만/);
  assert.match(h.calls.generation[0].user, /가격·출발일·포함\/불포함·취소/);
  assert.ok(result.post);

  // 검토된 상품 근거가 없으면 생성하지 않고 맥락을 보존한 채 보류한다.
  const empty = buildConnectContext({ products: [nhaProduct()], variantIds: [], sources: [], experience: '', now: NOW });
  const h2 = harness();
  const held = await generateSearchPost({
    topic: 'worldtravel', keyword: '나트랑 자유여행', connectContext: empty,
    run: h2.run, factCheckRun: h2.factCheckRun, contentCheckRun: h2.contentCheckRun, collectors: h2.collectors,
  });
  assert.equal(held.status, 'hold');
  assert.equal(held.post, null);
  assert.equal(held.attempts, 0);
  assert.equal(h2.calls.generation.length, 0);
  assert.ok(held.holdReasons.some((r) => /검토된 상품 근거/.test(r)), held.holdReasons.join(' / '));
  assert.equal(held.connect.snapshotHash, empty.snapshotHash);
  assert.deepEqual(held.connect.uncertainFields, empty.uncertainFields);
  assert.deepEqual(held.connect.productIds, ['p-nha']);
});

const CONTEXT_KEYS = ['connectKind', 'productIds', 'variantIds', 'productSnapshots', 'snapshotHash', 'sources', 'verifiedFacts', 'uncertainFields', 'requiredAnswers', 'experience', 'disclosureLine', 'links', 'policyVersion', 'promptBlock'];

test('result_connect_is_full_context_clone', async () => {
  liveCalls.length = 0;
  const ctx = connectCtx({ experience: '2025년 11월에 이 상품으로 다낭에 다녀왔고 조식이 만족스러웠다' });
  const before = JSON.parse(JSON.stringify(ctx));
  const h = harness();
  const result = await generateSearchPost({
    topic: 'worldtravel', keyword: '다낭 패키지 여행', connectContext: ctx,
    run: h.run, factCheckRun: h.factCheckRun, contentCheckRun: h.contentCheckRun, collectors: h.collectors,
  });
  for (const key of CONTEXT_KEYS) assert.deepEqual(result.connect[key], ctx[key], key + ' 보존');
  assert.deepEqual(Object.keys(result.connect).filter((k) => k !== 'generation').sort(), Object.keys(ctx).sort());
  assert.notEqual(result.connect, ctx);
  assert.notEqual(result.connect.links, ctx.links);
  result.connect.links[0].affiliateUrlRaw = 'mutated';
  result.connect.productSnapshots[0].name = 'mutated';
  assert.deepEqual(ctx, before, '원본 맥락은 바뀌지 않음');
  assert.equal(before.links[0].affiliateUrlRaw, RAW_LINK);

  const gen = result.connect.generation;
  assert.equal(gen.topic, 'worldtravel');
  assert.equal(gen.generationModel, 'opus');
  assert.equal(gen.experienceProvided, true);
  assert.deepEqual(gen.ignoredInputs, []);
  assert.deepEqual(gen.evidenceSources.map((s) => s.sourceId), ['src-page', 'src-user']);
  assert.equal(gen.evidenceFacts.length, 3);

  // 결과의 connect는 다시 맥락으로 넘겨도 같은 기획이 나온다.
  const again = JSON.parse(JSON.stringify(result.connect));
  again.links[0].affiliateUrlRaw = RAW_LINK;
  again.productSnapshots[0].name = before.productSnapshots[0].name;
  assert.deepEqual(
    buildSearchBrief({ keyword: '다낭 패키지 여행', topic: 'worldtravel', connectContext: again }),
    buildSearchBrief({ keyword: '다낭 패키지 여행', topic: 'worldtravel', connectContext: ctx }),
  );

  const empty = buildConnectContext({ products: [nhaProduct()], variantIds: [], sources: [], experience: '', now: NOW });
  const h2 = harness();
  const held = await generateSearchPost({
    topic: 'worldtravel', keyword: '나트랑 자유여행', connectContext: empty,
    run: h2.run, factCheckRun: h2.factCheckRun, contentCheckRun: h2.contentCheckRun, collectors: h2.collectors,
  });
  for (const key of CONTEXT_KEYS) assert.deepEqual(held.connect[key], empty[key], 'hold ' + key + ' 보존');
  assert.deepEqual(held.connect.generation.evidenceSources, []);
});

test('connect_experience_comes_only_from_context', async () => {
  liveCalls.length = 0;
  const noExp = connectCtx();
  const legacyExperience = {
    memo: '지난달 다낭에 다녀와서 호텔 조식을 먹어봤다',
    paid: 'mine',
    review: { target: 'travel', places: [{ biz: '다낭 리조트', place: '다낭 리조트', mapQuery: '다낭 리조트', tv: '여행 방송' }] },
  };
  const brief = buildSearchBrief({ keyword: '다낭 패키지 여행', topic: 'worldtravel', ...legacyExperience, connectContext: noExp });
  assert.notEqual(brief.intent, 'experience');
  assert.equal(brief.evidence.experienceInput, false);
  const prompt = buildSearchUserPrompt({ topicKey: 'worldtravel', keyword: '다낭 패키지 여행', ...legacyExperience, connectContext: noExp });
  assert.doesNotMatch(prompt, /\[글쓴이가 실제로 겪은 것\]|이 글은 "내돈내산"|내돈내산 리뷰 —|다녀와서 호텔 조식/);
  assert.match(prompt, /정보·비교형/);

  const h = harness({ postText: JSON.stringify(samplePost({ extraText: '제가 직접 다녀와 보니 조식이 정말 좋았어요.' })) });
  const result = await generateSearchPost({
    topic: 'worldtravel', keyword: '다낭 패키지 여행', connectContext: noExp, maxAttempts: 1, ...legacyExperience,
    run: h.run, factCheckRun: h.factCheckRun, contentCheckRun: h.contentCheckRun, collectors: h.collectors,
  });
  assert.equal(result.status, 'hold');
  assert.ok(result.holdReasons.some((r) => /1인칭 경험 표현/.test(r)), result.holdReasons.join(' / '));
  for (const name of ['fetchBlogFacts', 'fetchPlaceReviews', 'fetchNearbyAttractions']) {
    assert.ok(!h.calls.collectors.includes(name), name + ' 리뷰 수집 경로는 연결 원고에서 실행되지 않음');
  }
  assert.ok(h.calls.collectors.includes('observeSerp'), '리뷰 입력이 무시되므로 검색 결과 관찰은 실행');
  assert.doesNotMatch(h.calls.generation[0].user, /\[글쓴이가 실제로 겪은 것\]|내돈내산 리뷰 —/);
  assert.deepEqual(result.connect.generation.ignoredInputs, ['memo', 'paid', 'review']);
  assert.equal(result.connect.generation.experienceProvided, false);

  // 경험은 ctx.experience로만 들어오고, 메모 줄은 여전히 쓰지 않는다.
  const withExp = connectCtx({ experience: '2025년 11월에 이 상품으로 다낭에 다녀왔다' });
  const expBrief = buildSearchBrief({ keyword: '다낭 패키지 여행', topic: 'worldtravel', memo: legacyExperience.memo, connectContext: withExp });
  assert.equal(expBrief.intent, 'experience');
  const expPrompt = buildSearchUserPrompt({ topicKey: 'worldtravel', keyword: '다낭 패키지 여행', memo: legacyExperience.memo, connectContext: withExp });
  assert.doesNotMatch(expPrompt, /\[글쓴이가 실제로 겪은 것\]/);
  assert.match(expPrompt, /작성자 경험: 2025년 11월에 이 상품으로 다낭에 다녀왔다/);

  // 연결 맥락이 없으면 기존 메모·내돈내산은 그대로 경험 입력이다.
  assert.equal(buildSearchBrief({ keyword: '다낭 여행', topic: 'worldtravel', memo: legacyExperience.memo }).evidence.experienceInput, true);
  assert.match(buildSearchUserPrompt({ topicKey: 'worldtravel', keyword: '다낭 여행', memo: legacyExperience.memo, paid: 'mine' }), /\[글쓴이가 실제로 겪은 것\][\s\S]*이 글은 "내돈내산"/);
});

test('connect_evidence_facts_match_source_basis_and_product', async () => {
  liveCalls.length = 0;
  const ctx = connectCtx();
  const GHOST_SOURCE = { id: 'src-ghost', url: 'https://travel.example.com/ghost', accessLevel: 'full-page', publishedAt: null, collectedAt: '2026-10-07T01:00:00.000Z', excerpt: '유령 상품 1인 59,000원' };
  const forged = {
    ...ctx,
    sources: [...ctx.sources, GHOST_SOURCE],
    verifiedFacts: [
      ...ctx.verifiedFacts,
      { productId: 'p-danang', field: 'cheap', value: 9000, sourceId: 'src-page', excerpt: '9,000원', status: 'verified', checkedAt: CHECKED, verificationBasis: 'full-page' },
      { productId: 'p-ghost', field: 'change', value: '출발일 변경 불가', sourceId: 'src-user', excerpt: '출발일 변경 불가', status: 'verified', checkedAt: CHECKED, verificationBasis: 'user-excerpt' },
      { productId: 'p-danang', field: 'refund', value: '전액 환불', sourceId: 'src-page', excerpt: '전액 환불', status: 'verified', checkedAt: CHECKED, verificationBasis: 'user-excerpt' },
      { productId: 'p-ghost', field: 'price', value: 59000, sourceId: 'src-ghost', excerpt: '1인 59,000원', status: 'verified', checkedAt: CHECKED, verificationBasis: 'full-page' },
    ],
  };
  const brief = buildSearchBrief({ keyword: '다낭 패키지 여행', topic: 'worldtravel', connectContext: forged });
  assert.equal(brief.evidence.connectFacts, 3, '근거 유형·발췌 경계·상품이 맞는 사실만 센다');
  assert.equal(brief.evidence.connectSources, 2);
  const h = harness();
  const result = await generateSearchPost({
    topic: 'worldtravel', keyword: '다낭 패키지 여행', connectContext: forged,
    run: h.run, factCheckRun: h.factCheckRun, contentCheckRun: h.contentCheckRun, collectors: h.collectors,
  });
  const gen = result.connect.generation;
  assert.deepEqual(gen.evidenceFacts.map((f) => f.field).sort(), ['cancellationPolicy', 'changePolicy', 'variant:v1:price']);
  assert.deepEqual(gen.evidenceSources.map((s) => [s.sourceId, s.productIds]), [['src-page', ['p-danang']], ['src-user', ['p-danang']]]);
  assert.doesNotMatch(h.calls.factCheck[0].user, /travel\.example\.com\/ghost|59,000/);
  // 원본 사실·출처는 그대로 보존된다.
  assert.deepEqual(result.connect.verifiedFacts, forged.verifiedFacts);
  assert.deepEqual(result.connect.sources, forged.sources);
});
