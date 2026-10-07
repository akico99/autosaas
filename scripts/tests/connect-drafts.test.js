'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConnectProduct, buildConnectContext } = require('../../src/connect/products');
const { checkConnectPost } = require('../../src/connect/check');
const drafts = require('../../src/topics/drafts');

const NOW = '2026-10-08T03:00:00.000Z';
const LINK = 'https://naver.me/AbCd123?x=1';
const SOURCE = {
  id: 'page', url: 'https://travel.example.com/p', accessLevel: 'full-page',
  publishedAt: null, collectedAt: '2026-10-08T01:00:00.000Z',
  excerpt: '다낭 3박4일, 2026-11-03 출발, 디럭스룸, 129,000원, 왕복 항공권 포함, 예약 가능, 2026-11-10 출발, 오션뷰',
};

function fixture({ priceCheckedAt = '2026-10-08T02:00:00.000Z', affiliateUrl = LINK, products: many } = {}) {
  const raw = many || [{
    id: 'danang', connectKind: 'travel', name: '다낭 패키지', provider: '여행사',
    detailUrl: SOURCE.url, affiliateUrl, profileKey: 'travel-a', eligibility: 'verified',
    variants: [{ id: 'v1', currency: 'KRW', amountMinor: 129000, priceCheckedAt, options: [], departureDate: '2026-11-03', adults: 2, children: 0, roomBasis: '디럭스룸' }],
    facts: [
      { field: 'variant:v1:price', value: 129000, sourceId: 'page', excerpt: '129,000원', status: 'verified', checkedAt: priceCheckedAt },
      { field: 'departureDate', value: '2026-11-03', sourceId: 'page', excerpt: '2026-11-03 출발', status: 'verified', checkedAt: priceCheckedAt },
      { field: 'roomBasis', value: '디럭스룸', sourceId: 'page', excerpt: '디럭스룸', status: 'verified', checkedAt: priceCheckedAt },
      { field: 'inclusions', value: '왕복 항공권 포함', sourceId: 'page', excerpt: '왕복 항공권 포함', status: 'verified', checkedAt: priceCheckedAt },
      { field: 'eligibility', value: '예약 가능', sourceId: 'page', excerpt: '예약 가능', status: 'verified', checkedAt: priceCheckedAt },
    ],
  }];
  const products = raw.map((p) => normalizeConnectProduct(p, { sources: [SOURCE] }));
  const ctx = buildConnectContext({ products, variantIds: products.flatMap((p) => p.variants.slice(0, 1).map((v) => v.id)), sources: [SOURCE], now: () => new Date(NOW) });
  return { ctx, products };
}

function fixtureWithExtraFact(field, value, excerpt, status = 'verified') {
  const base = fixture();
  const source = { ...SOURCE, excerpt: SOURCE.excerpt + ', ' + excerpt };
  const products = [normalizeConnectProduct({
    ...base.products[0],
    facts: [...base.products[0].facts, { field, value, sourceId: source.id, excerpt, status, checkedAt: '2026-10-08T02:00:00.000Z' }],
  }, { sources: [source] })];
  const ctx = buildConnectContext({ products, variantIds: ['v1'], sources: [source], now: () => new Date(NOW) });
  return { ctx, products };
}

function post(blocks, extra = {}) {
  const { ctx } = fixture();
  return { ctx, post: { title: '여행 상품 안내', description: '', blocks, ...extra } };
}

const safeBlocks = () => [
  { kind: 'text', text: '다낭 패키지 상품 조건을 확인했습니다. ' + '여행 정보 안내입니다. '.repeat(10) },
  { kind: 'table', columns: ['상품', '옵션', '가격', '출발일', '객실', '포함'], rows: [['다낭 패키지', 'v1', '129,000원', '2026-11-03', '디럭스룸', '왕복 항공권 포함']] },
  { kind: 'qna', question: '가격은 얼마인가요?', answer: '다낭 패키지 v1은 129,000원입니다.' },
  { kind: 'text', text: '제휴 링크: ' + LINK + '\n' + fixture().ctx.disclosureLine },
];

test('checks structured table and FAQ values against the matching product and variant', () => {
  const { ctx, products } = fixture();
  const good = checkConnectPost({ title: '여행 상품 안내', blocks: safeBlocks() }, { connectContext: ctx, currentProducts: products, now: NOW });
  assert.equal(good.status, 'ready', JSON.stringify(ctx.verifiedFacts) + ' / ' + good.holdReasons.join('; ') + ' / review: ' + good.reviewReasons.join('; '));
  const swapped = safeBlocks();
  swapped[1].rows[0][2] = '999,000원';
  const result = checkConnectPost({ title: '여행 상품 안내', blocks: swapped }, { connectContext: ctx, currentProducts: products, now: NOW });
  assert.equal(result.status, 'hold');
  assert.match(result.holdReasons.join(' '), /가격/);
  const faq = safeBlocks();
  faq[2].answer = '다낭 패키지 v1은 119,000원입니다.';
  assert.equal(checkConnectPost({ title: '', blocks: faq }, { connectContext: ctx, currentProducts: products, now: NOW }).status, 'hold');
  const wrongColumns = safeBlocks();
  wrongColumns[1].rows[0][2] = '2026-11-03';
  wrongColumns[1].rows[0][3] = '129,000원';
  assert.equal(checkConnectPost({ blocks: wrongColumns }, { connectContext: ctx, currentProducts: products, now: NOW }).status, 'hold');
  const wrongRoom = safeBlocks();
  wrongRoom[1].rows[0][4] = '오션뷰';
  assert.equal(checkConnectPost({ blocks: wrongRoom }, { connectContext: ctx, currentProducts: products, now: NOW }).status, 'hold');
});

test('parses Korean money units and keeps verified extras separate from base price', () => {
  const base = fixture();
  const unsupportedBase = safeBlocks();
  unsupportedBase.push({ kind: 'text', text: '다낭 패키지 v1 가격은 99만원입니다.' });
  assert.equal(checkConnectPost({ blocks: unsupportedBase }, { connectContext: base.ctx, currentProducts: base.products, now: NOW }).status, 'hold');

  const supportedBase = safeBlocks();
  supportedBase.push({ kind: 'qna', question: '다낭 패키지 v1 가격은 얼마인가요?', answer: '12만9천원입니다.' });
  const parsed = checkConnectPost({ blocks: supportedBase }, { connectContext: base.ctx, currentProducts: base.products, now: NOW });
  assert.equal(parsed.status, 'ready', parsed.holdReasons.join('; '));

  const tip = fixtureWithExtraFact('tips', '가이드팁 50,000원', '가이드팁 50,000원');
  const tipBlocks = safeBlocks();
  tipBlocks.push({ kind: 'qna', question: '가이드팁은 얼마인가요?', answer: '50,000원입니다.' });
  const verifiedTip = checkConnectPost({ blocks: tipBlocks }, { connectContext: tip.ctx, currentProducts: tip.products, now: NOW });
  assert.equal(verifiedTip.status, 'ready', verifiedTip.holdReasons.join('; ') + ' ' + verifiedTip.reviewReasons.join('; '));

  const tipTable = safeBlocks();
  tipTable[1].columns.push('가이드팁');
  tipTable[1].rows[0].push('50,000원');
  assert.equal(checkConnectPost({ blocks: tipTable }, { connectContext: tip.ctx, currentProducts: tip.products, now: NOW }).status, 'ready');

  const extraCases = [
    ['variant:v1:tips', '가이드팁 50,000원', '가이드팁은 50,000원입니다.'],
    ['optionalTours', '선택관광 50,000원', '선택관광 비용은 50,000원입니다.'],
    ['taxes', '세금 50,000원', '세금은 50,000원입니다.'],
    ['fees', '수수료 50,000원', '수수료는 50,000원입니다.'],
    ['exclusions', '불포함 비용은 50,000원입니다.', '불포함 비용은 50,000원입니다.'],
  ];
  for (const [field, evidence, statement] of extraCases) {
    const registered = fixtureWithExtraFact(field, evidence, evidence);
    const content = safeBlocks();
    content.push({ kind: 'text', text: '다낭 패키지 v1 ' + statement });
    const checked = checkConnectPost({ blocks: content }, { connectContext: registered.ctx, currentProducts: registered.products, now: NOW });
    assert.equal(checked.status, 'ready', field + ': ' + checked.holdReasons.join('; ') + ' review=' + checked.reviewReasons.join('; '));
  }

  const misusedTip = safeBlocks();
  misusedTip.push({ kind: 'qna', question: '다낭 패키지 v1 가격은 얼마인가요?', answer: '50,000원입니다.' });
  assert.equal(checkConnectPost({ blocks: misusedTip }, { connectContext: tip.ctx, currentProducts: tip.products, now: NOW }).status, 'hold');

  const unverifiedTip = fixtureWithExtraFact('tips', '가이드팁 50,000원', '가이드팁 50,000원', 'unverified');
  const unverifiedBlocks = safeBlocks();
  unverifiedBlocks.push({ kind: 'text', text: '다낭 패키지 v1 가이드팁은 50,000원입니다.' });
  assert.equal(checkConnectPost({ blocks: unverifiedBlocks }, { connectContext: unverifiedTip.ctx, currentProducts: unverifiedTip.products, now: NOW }).status, 'hold');
});

test('binds table rows to their own product and variant instead of accepting the union of prices', () => {
  const p1 = fixture().products[0];
  const p2 = normalizeConnectProduct({ ...p1, id: 'nha', name: '나트랑 패키지', affiliateUrl: 'https://naver.me/Nha123', variants: [{ ...p1.variants[0], id: 'v2', amountMinor: 229000, departureDate: '2026-11-10' }], facts: [{ field: 'variant:v2:price', value: 229000, sourceId: 'page', excerpt: '229,000원', status: 'verified', checkedAt: '2026-10-08T02:00:00.000Z' }] }, { sources: [SOURCE] });
  const products = [p1, p2];
  const ctx = buildConnectContext({ products, variantIds: ['v1', 'v2'], sources: [SOURCE], now: () => new Date(NOW) });
  const blocks = [
    { kind: 'table', columns: ['상품', '옵션', '가격', '출발일'], rows: [['다낭 패키지', 'v1', '229,000원', '2026-11-10'], ['나트랑 패키지', 'v2', '129,000원', '2026-11-03']] },
    { kind: 'text', text: ctx.disclosureLine + ' ' + LINK + ' ' + '상품 안내입니다. '.repeat(10) },
  ];
  const result = checkConnectPost({ blocks }, { connectContext: ctx, currentProducts: products, now: NOW });
  assert.equal(result.status, 'hold');
  assert.match(result.holdReasons.join(' '), /가격|출발/);
});

test('checks departure dates and room bases against scoped variant facts on one product', () => {
  const base = fixture().products[0];
  const v1 = base.variants[0];
  const v2 = { ...v1, id: 'v2', departureDate: '2026-11-10', roomBasis: '오션뷰', options: ['오션뷰'] };
  const checkedAt = '2026-10-08T02:00:00.000Z';
  const product = normalizeConnectProduct({
    ...base, variants: [v1, v2],
    facts: [
      ...base.facts.filter((fact) => fact.field === 'eligibility' || fact.field === 'inclusions'),
      { field: 'variant:v1:price', value: 129000, sourceId: 'page', excerpt: '129,000원', status: 'verified', checkedAt },
      { field: 'variant:v1:departureDate', value: '2026-11-03', sourceId: 'page', excerpt: '2026-11-03 출발', status: 'verified', checkedAt },
      { field: 'variant:v1:roomBasis', value: '디럭스룸', sourceId: 'page', excerpt: '디럭스룸', status: 'verified', checkedAt },
      { field: 'variant:v2:price', value: 129000, sourceId: 'page', excerpt: '129,000원', status: 'verified', checkedAt },
      { field: 'variant:v2:departureDate', value: '2026-11-10', sourceId: 'page', excerpt: '2026-11-10 출발', status: 'verified', checkedAt },
      { field: 'variant:v2:roomBasis', value: '오션뷰', sourceId: 'page', excerpt: '오션뷰', status: 'verified', checkedAt },
    ],
  }, { sources: [SOURCE] });
  const ctx = buildConnectContext({ products: [product], variantIds: ['v1', 'v2'], sources: [SOURCE], now: () => new Date(NOW) });
  const rows = [
    ['다낭 패키지', 'v1', '129,000원', '2026년 11월 3일', '디럭스룸'],
    ['다낭 패키지', 'v2', '129,000원', '2026년 11월 10일', '오션뷰'],
  ];
  const blocks = [
    { kind: 'table', columns: ['상품', '옵션', '가격', '출발일', '객실'], rows },
    { kind: 'text', text: ctx.disclosureLine + ' ' + product.affiliateUrlRaw },
  ];
  const good = checkConnectPost({ blocks }, { connectContext: ctx, currentProducts: [product], now: NOW });
  assert.equal(good.status, 'ready', good.holdReasons.join('; '));
  const swapped = JSON.parse(JSON.stringify(blocks));
  swapped[0].rows[0][3] = '2026년 11월 10일';
  swapped[0].rows[0][4] = '오션뷰';
  const bad = checkConnectPost({ blocks: swapped }, { connectContext: ctx, currentProducts: [product], now: NOW });
  assert.equal(bad.status, 'hold');
  assert.match(bad.holdReasons.join(' '), /출발일|객실/);

  const unboundRows = [
    ['다낭 패키지', '', '99만원'],
    ['다낭 패키지', 'unknown-option', '99만원'],
  ];
  const unbound = checkConnectPost({ blocks: [
    { kind: 'table', columns: ['상품', '옵션', '가격'], rows: unboundRows },
    { kind: 'text', text: ctx.disclosureLine + ' ' + product.affiliateUrlRaw },
  ] }, { connectContext: ctx, currentProducts: [product], now: NOW });
  assert.equal(unbound.status, 'hold');
  assert.match(unbound.holdReasons.join(' '), /옵션|가격/);

  const explicitContradiction = checkConnectPost({ blocks: [
    { kind: 'table', columns: ['상품', '옵션', '가격', '출발일'], rows: [['다낭 패키지', 'unknown-option', '129,000원', '2026-11-03']] },
    { kind: 'text', text: ctx.disclosureLine + ' ' + product.affiliateUrlRaw },
  ] }, { connectContext: ctx, currentProducts: [product], now: NOW });
  assert.equal(explicitContradiction.status, 'hold');
  assert.match(explicitContradiction.holdReasons.join(' '), /옵션/);

  const matchingReviewedLabel = checkConnectPost({ blocks: [
    { kind: 'table', columns: ['상품', '옵션', '가격', '출발일', '객실'], rows: [['다낭 패키지', '오션뷰', '129,000원', '2026-11-10', '오션뷰']] },
    { kind: 'text', text: ctx.disclosureLine + ' ' + product.affiliateUrlRaw },
  ] }, { connectContext: ctx, currentProducts: [product], now: NOW });
  assert.equal(matchingReviewedLabel.status, 'ready', matchingReviewedLabel.holdReasons.join('; '));

  const blankOptionInference = checkConnectPost({ blocks: [
    { kind: 'table', columns: ['상품', '옵션', '가격', '출발일', '객실'], rows: [['다낭 패키지', '', '129,000원', '2026-11-03', '디럭스룸']] },
    { kind: 'text', text: ctx.disclosureLine + ' ' + product.affiliateUrlRaw },
  ] }, { connectContext: ctx, currentProducts: [product], now: NOW });
  assert.equal(blankOptionInference.status, 'ready', blankOptionInference.holdReasons.join('; '));
});

test('holds missing disclosure, altered raw affiliate link, unknown eligibility, and unsupported first person', () => {
  const { ctx, products } = fixture();
  const blocks = safeBlocks();
  blocks[3].text = blocks[3].text.replace(LINK, 'https://naver.me/AbCd123?x=2').replace(ctx.disclosureLine, '');
  const result = checkConnectPost({ blocks }, { connectContext: ctx, currentProducts: products, now: NOW });
  assert.equal(result.status, 'hold');
  assert.ok(result.holdReasons.length >= 2);
  const unsupported = checkConnectPost({ blocks: [...safeBlocks(), { kind: 'quote', text: '제가 직접 다녀온 내돈내산 후기입니다.' }] }, { connectContext: ctx, currentProducts: products, now: NOW });
  assert.equal(unsupported.status, 'hold');
});

test('rejects appended or additional destinations while preserving exact raw URLs in prose and href fields', () => {
  const { ctx, products } = fixture();
  const appended = safeBlocks();
  appended[3].text += ' ' + LINK + '&redirect=https://evil.example/';
  const changed = checkConnectPost({ blocks: appended }, { connectContext: ctx, currentProducts: products, now: NOW });
  assert.equal(changed.status, 'hold');
  assert.match(changed.holdReasons.join(' '), /URL|링크/);

  const extra = safeBlocks();
  extra.push({ kind: 'qna', question: '자세한 안내', answer: 'https://evil.example/deal' });
  assert.equal(checkConnectPost({ blocks: extra }, { connectContext: ctx, currentProducts: products, now: NOW }).status, 'hold');

  const raw = 'https://naver.me/x%2Fy?reserved=a%26b&sig=%2F';
  const fresh = fixture({ affiliateUrl: raw });
  const accepted = safeBlocks();
  accepted[3].text = accepted[3].text.replace(LINK, raw + '.');
  accepted.push({ kind: 'link', href: raw, text: '예약 링크' });
  accepted.push({ kind: 'text', text: fresh.products[0].detailUrl + ' ' + SOURCE.url });
  const exact = checkConnectPost({ blocks: accepted }, { connectContext: fresh.ctx, currentProducts: fresh.products, now: NOW });
  assert.equal(exact.status, 'ready', exact.holdReasons.join('; '));
});

test('holds mismatched Korean year-month-day and ambiguous date-like claims across prose and FAQ', () => {
  const { ctx, products } = fixture();
  const prose = safeBlocks();
  prose[0].text += ' 실제 출발은 2027년 1월 5일입니다.';
  const mismatch = checkConnectPost({ blocks: prose }, { connectContext: ctx, currentProducts: products, now: NOW });
  assert.equal(mismatch.status, 'hold');
  assert.match(mismatch.holdReasons.join(' '), /출발일/);

  const faq = safeBlocks();
  faq[2].answer = '다낭 패키지 v1의 출발은 2026년 11월입니다.';
  const ambiguous = checkConnectPost({ blocks: faq }, { connectContext: ctx, currentProducts: products, now: NOW });
  assert.equal(ambiguous.status, 'hold');
});

test('holds edited products and missing, invalid, future, or stale price checks', () => {
  const fresh = fixture();
  const edited = fresh.products.map((p) => ({ ...p, name: '수정된 상품명' }));
  assert.equal(checkConnectPost({ blocks: safeBlocks() }, { connectContext: fresh.ctx, currentProducts: edited, now: NOW }).status, 'hold');
  for (const checkedAt of [null, 'garbage', '2026-10-08T04:00:00.000Z', '2026-10-07T02:59:59.999Z']) {
    const { ctx, products } = fixture({ priceCheckedAt: checkedAt === '2026-10-08T04:00:00.000Z' || checkedAt === '2026-10-07T02:59:59.999Z' ? checkedAt : '2026-10-08T02:00:00.000Z' });
    if (checkedAt === null || checkedAt === 'garbage') {
      ctx.productSnapshots[0].variants[0].priceCheckedAt = checkedAt;
      products[0].variants[0].priceCheckedAt = checkedAt;
    }
    const result = checkConnectPost({ blocks: safeBlocks() }, { connectContext: ctx, currentProducts: products, now: NOW });
    assert.equal(result.status, 'hold', String(checkedAt));
  }
  const refreshed = fixture();
  refreshed.products[0].variants[0].priceCheckedAt = NOW;
  const recovery = checkConnectPost({ blocks: safeBlocks() }, { connectContext: refreshed.ctx, currentProducts: refreshed.products, now: NOW });
  assert.equal(recovery.status, 'ready', recovery.holdReasons.join('; '));
});

test('saves connect context and rejects full-capacity travel saves without evicting saju drafts', () => {
  let store = drafts.emptyStore();
  for (let i = 0; i < drafts.MAX_DRAFTS; i += 1) store = drafts.addDraft(store, { id: 's' + i, topicId: 'saju', keyword: 'k' + i }).store;
  assert.throws(() => drafts.addDraft(store, { topicId: 'travel-connect', keyword: '다낭', result: { connect: fixture().ctx } }), /용량/);
  assert.equal(store.drafts.length, drafts.MAX_DRAFTS);
  assert.equal(drafts.listDrafts(store, 'saju').length, drafts.MAX_DRAFTS);
  const saved = drafts.addDraft(drafts.emptyStore(), { topicId: 'travel-connect', keyword: '다낭', result: { connect: fixture().ctx } });
  assert.deepEqual(saved.draft.result.connect.productSnapshots, fixture().ctx.productSnapshots);
  assert.equal(drafts.updateDraft(saved.store, saved.draft.id, { keyword: '수정' }).draft.keyword, '수정');
});

test('keeps legacy draft shapes and capacity behavior intact', () => {
  let store = drafts.emptyStore();
  for (let i = 0; i < drafts.MAX_DRAFTS; i += 1) store = drafts.addDraft(store, { id: 'legacy' + i, topicId: 'saju', keyword: 'k' + i }).store;
  store = drafts.addDraft(store, { id: 'new-legacy', topicId: 'saju', keyword: 'new' }).store;
  assert.equal(store.drafts.length, drafts.MAX_DRAFTS);
  assert.equal(drafts.listDrafts(store, 'saju')[0].keyword, 'new');
  assert.deepEqual(Object.keys(drafts.listDrafts(store, 'saju')[0]).sort(), ['createdAt', 'holdReasons', 'id', 'injectedAt', 'keyword', 'productKey', 'profileKey', 'purpose', 'result', 'reviewReasons', 'source', 'status', 'topicId', 'updatedAt'].sort());
});
