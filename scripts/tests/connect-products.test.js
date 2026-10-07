'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getConnectDisclosure, validateAffiliateUrl } = require('../../src/connect/policy');
const { normalizeConnectProduct, buildConnectContext, readConnectCatalog, writeConnectCatalog } = require('../../src/connect/products');

const NOW = () => new Date('2026-10-07T03:00:00.000Z');
const SOURCE = {
  id: 's1',
  url: 'https://example.com/danang',
  accessLevel: 'user-excerpt',
  publishedAt: null,
  collectedAt: '2026-10-07T01:00:00.000Z',
  excerpt: '다낭 3박4일 패키지 129,000원 11월 3일 출발 성인 2명 디럭스룸 포함: 항공 불포함: 가이드 팁',
};

function travelInput(overrides = {}) {
  return {
    connectKind: 'travel',
    name: '다낭 3박4일 패키지',
    provider: '예시여행사',
    detailUrl: 'https://example.com/danang?item=1',
    affiliateUrl: 'https://naver.me/AbCd123',
    profileKey: 'travel-a',
    eligibility: 'unknown',
    travelDetails: { destination: '다낭', travelType: 'package', nights: 3, days: 4, inclusions: ['항공'], exclusions: ['가이드 팁'], cancellationPolicy: '' },
    variants: [],
    facts: [],
    ...overrides,
  };
}

function variant(extra = {}) {
  return { currency: 'KRW', amountMinor: 129000, priceCheckedAt: '2026-10-07T01:00:00.000Z', options: [], departureDate: '2026-11-03', adults: 2, children: 0, roomBasis: '디럭스룸', ...extra };
}

test('explicit_kind_selects_disclosure', () => {
  const shoppingTent = normalizeConnectProduct({
    connectKind: 'shopping', name: '여행 캠핑 텐트', provider: '아웃도어몰',
    detailUrl: 'https://example.com/tent', affiliateUrl: 'https://naver.me/tent1', shoppingDetails: null,
  }, { sources: [], now: NOW });
  assert.equal(getConnectDisclosure(shoppingTent.connectKind), '이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 판매 발생 시 수수료를 제공받습니다.');
  assert.equal(getConnectDisclosure('travel'), '이 포스팅은 네이버 여행 커넥트 활동의 일환으로, 예약 발생 시 수수료를 제공받습니다.');
  assert.throws(() => getConnectDisclosure('unknown'), /connectKind/);
  assert.throws(() => normalizeConnectProduct(travelInput({ connectKind: 'unknown' }), { sources: [], now: NOW }), /connectKind/);
  // 쇼핑 상품에 여행 전용 필드를 섞지 않는다.
  assert.throws(() => normalizeConnectProduct({ ...travelInput(), connectKind: 'shopping' }, { sources: [], now: NOW }));
  const ctx = buildConnectContext({ products: [shoppingTent], variantIds: [], sources: [], experience: '', policyVersion: undefined, now: NOW });
  assert.equal(ctx.connectKind, 'shopping');
  assert.equal(ctx.disclosureLine, getConnectDisclosure('shopping'));
});

test('preserves_affiliate_bytes', () => {
  const raws = [
    'https://naver.me/AbCd123',
    'https://brand.example.com/p?a=1&a=2&utm_source=x&b=%2Fpath%2F%2e%2e&A=3',
    'https://shop.example.com/go?u=https%3A%2F%2Fexample.com%2Fa%2Fb#frag',
  ];
  for (const raw of raws) {
    const r = validateAffiliateUrl('  ' + raw + '\n');
    assert.deepEqual(r, { valid: true, raw, reason: '' });
    const p = normalizeConnectProduct(travelInput({ affiliateUrl: raw, detailUrl: 'https://example.com/good' }), { sources: [], now: NOW });
    assert.equal(p.affiliateUrlRaw, raw);
    assert.equal(p.affiliateStatus, 'issued');
  }
  for (const bad of ['javascript:alert(1)', 'file:///C:/secret.txt', 'data:text/html,x', 'ftp://example.com/a', 'https://exa mple.com/', 'not a url', '', 'https://user:pw@example.com/a', 'https:///nohost']) {
    const r = validateAffiliateUrl(bad);
    assert.equal(r.valid, false, bad);
    assert.ok(r.reason);
    const p = normalizeConnectProduct(travelInput({ affiliateUrl: bad }), { sources: [], now: NOW });
    assert.equal(p.affiliateUrlRaw, '');
    assert.notEqual(p.affiliateStatus, 'issued');
  }
  assert.throws(() => normalizeConnectProduct(travelInput({ detailUrl: 'javascript:alert(1)' }), { sources: [], now: NOW }), /detailUrl/);
});

test('detail_url_is_not_issued_affiliate_url', () => {
  const onlyDetail = normalizeConnectProduct(travelInput({ affiliateUrl: undefined }), { sources: [], now: NOW });
  assert.equal(onlyDetail.affiliateStatus, 'not-issued');
  assert.equal(onlyDetail.affiliateUrlRaw, '');
  const sameAsDetail = normalizeConnectProduct(travelInput({ affiliateUrl: 'https://example.com/danang?item=1' }), { sources: [], now: NOW });
  assert.equal(sameAsDetail.affiliateStatus, 'not-issued');
  assert.equal(sameAsDetail.affiliateUrlRaw, '');
  const ctx = buildConnectContext({ products: [onlyDetail], variantIds: [], sources: [], experience: '', now: NOW });
  assert.deepEqual(ctx.links, []);
  assert.ok(ctx.uncertainFields.includes(onlyDetail.id + '.affiliateUrl'));
});

test('variants_keep_departure_and_room_identity', () => {
  const p = normalizeConnectProduct(travelInput({
    variants: [
      variant(),
      variant({ departureDate: '2026-11-10', amountMinor: 149000 }),
      variant({ roomBasis: '스위트룸', amountMinor: 199000 }),
      variant({ adults: 3, amountMinor: 350000 }),
    ],
  }), { sources: [], now: NOW });
  assert.equal(p.variants.length, 4);
  assert.equal(new Set(p.variants.map((v) => v.id)).size, 4);
  // 같은 정체성의 가격이 서로 다르면 섞지 않고 거부한다.
  assert.throws(() => normalizeConnectProduct(travelInput({ variants: [variant(), variant({ amountMinor: 99000 })] }), { sources: [], now: NOW }), /variant/);
  // 다른 통화는 금액이 같아도 별개 옵션이다.
  const usd = normalizeConnectProduct(travelInput({ variants: [variant(), variant({ currency: 'USD', amountMinor: 129000 })] }), { sources: [], now: NOW });
  assert.equal(usd.variants.length, 2);
  assert.throws(() => normalizeConnectProduct(travelInput({ variants: [variant({ amountMinor: 1290.5 })] }), { sources: [], now: NOW }));

  const pick = p.variants[1].id;
  const ctx = buildConnectContext({ products: [p], variantIds: [pick], sources: [], experience: '', now: NOW });
  const snap = ctx.productSnapshots[0];
  assert.deepEqual(snap.variants.map((v) => v.id), [pick]);
  assert.equal(snap.variants[0].departureDate, '2026-11-10');
  assert.equal(snap.variants[0].amountMinor, 149000);
  assert.ok(!ctx.promptBlock.includes('129000') && !ctx.promptBlock.includes('199000'));
  assert.throws(() => buildConnectContext({ products: [p], variantIds: ['nope'], sources: [], experience: '', now: NOW }), /variant/);
  // 선택하지 않으면 가격을 임의로 고르지 않고 선택 필요로 표시한다.
  const none = buildConnectContext({ products: [p], variantIds: [], sources: [], experience: '', now: NOW });
  assert.deepEqual(none.productSnapshots[0].variants, []);
  assert.ok(none.uncertainFields.includes(p.id + '.variant'));
  // 출발일·인원·객실이 비어 있으면 필수 질문으로 남는다.
  const loose = normalizeConnectProduct(travelInput({ variants: [variant({ departureDate: null, adults: null, roomBasis: null })] }), { sources: [], now: NOW });
  const lctx = buildConnectContext({ products: [loose], variantIds: [loose.variants[0].id], sources: [], experience: '', now: NOW });
  const ids = lctx.requiredAnswers.map((a) => a.id);
  for (const id of ['departureDate', 'travelers', 'roomBasis']) assert.ok(ids.includes(id), id);
});

test('source_review_is_required', () => {
  const vId = 'v1';
  const priceField = 'variant:' + vId + ':price';
  const facts = [
    { field: priceField, value: 129000, sourceId: 's1', excerpt: '패키지 129,000원', status: 'verified', checkedAt: '2026-10-07T02:00:00.000Z' },
    { field: 'detailUrl', value: 'https://example.com/danang?item=1', sourceId: null, excerpt: '', status: 'verified', checkedAt: '2026-10-07T02:00:00.000Z' },
    { field: 'departureDate', value: '2026-11-03', sourceId: 'ghost', excerpt: '11월 3일 출발', status: 'verified', checkedAt: '2026-10-07T02:00:00.000Z' },
    { field: 'roomBasis', value: '오션뷰', sourceId: 's1', excerpt: '오션뷰 객실', status: 'verified', checkedAt: '2026-10-07T02:00:00.000Z' },
    { field: 'adults', value: 2, sourceId: 's1', excerpt: '성인 2명', status: 'verified', checkedAt: null },
    { field: 'note', value: '메모', sourceId: 's1', excerpt: '성인 2명', status: 'unverified', checkedAt: null },
  ];
  const p = normalizeConnectProduct(travelInput({ eligibility: 'verified', variants: [variant({ id: vId })], facts }), { sources: [SOURCE], now: NOW });
  const by = Object.fromEntries(p.facts.map((f) => [f.field, f.status]));
  assert.equal(by[priceField], 'verified');
  assert.equal(by.detailUrl, 'unverified');
  assert.equal(by.departureDate, 'unverified');
  assert.equal(by.roomBasis, 'unverified');
  assert.equal(by.adults, 'unverified');
  assert.equal(by.note, 'unverified');
  // 검토된 eligibility 근거가 없으면 verified로 승격하지 않는다.
  assert.equal(p.eligibility, 'unknown');
  const ok = normalizeConnectProduct(travelInput({
    eligibility: 'verified', facts: [{ field: 'eligibility', value: '다낭 3박4일 패키지', sourceId: 's1', excerpt: '다낭 3박4일 패키지', status: 'verified', checkedAt: '2026-10-07T02:00:00.000Z' }],
  }), { sources: [SOURCE], now: NOW });
  assert.equal(ok.eligibility, 'verified');
  // 출처가 없는 가격은 컨텍스트에서도 확정 사실이 아니다.
  const noSource = normalizeConnectProduct(travelInput({ variants: [variant({ id: vId })] }), { sources: [], now: NOW });
  const ctx = buildConnectContext({ products: [noSource], variantIds: [vId], sources: [], experience: '', now: NOW });
  assert.ok(ctx.uncertainFields.includes(noSource.id + '.' + priceField));
  assert.deepEqual(ctx.verifiedFacts, []);
  // URL 파라미터에서 가격을 추정하지 않는다.
  const urlPrice = normalizeConnectProduct(travelInput({ detailUrl: 'https://example.com/d?price=99000' }), { sources: [], now: NOW });
  assert.deepEqual(urlPrice.variants, []);
  // 출처 접근 수준은 허용 값만 받는다.
  assert.throws(() => normalizeConnectProduct(travelInput(), { sources: [{ ...SOURCE, accessLevel: 'official' }], now: NOW }));
  // 검토된 가격은 확정 사실로, 나머지는 불확실 필드로 컨텍스트에 전달된다.
  const reviewed = buildConnectContext({ products: [p], variantIds: [vId], sources: [SOURCE], experience: '', now: NOW });
  assert.deepEqual(reviewed.verifiedFacts.map((f) => f.field), [priceField]);
  assert.ok(reviewed.uncertainFields.includes(p.id + '.departureDate'));
  assert.deepEqual(reviewed.sources.map((s) => s.id), ['s1']);
});

test('context_is_deterministic_and_single_kind', () => {
  const a = normalizeConnectProduct(travelInput({ variants: [variant({ id: 'v1' })] }), { sources: [], now: NOW });
  const shop = normalizeConnectProduct({ connectKind: 'shopping', name: 't', provider: 'p', detailUrl: 'https://example.com/t', affiliateUrl: 'https://naver.me/t' }, { sources: [], now: NOW });
  assert.throws(() => buildConnectContext({ products: [a, shop], variantIds: [], sources: [], experience: '', now: NOW }), /connectKind/);
  assert.throws(() => buildConnectContext({ products: [], variantIds: [], sources: [], experience: '', now: NOW }));
  const c1 = buildConnectContext({ products: [a], variantIds: ['v1'], sources: [], experience: '직접 다녀옴', now: NOW });
  const c2 = buildConnectContext({ products: [JSON.parse(JSON.stringify(a))], variantIds: ['v1'], sources: [], experience: '직접 다녀옴', now: () => new Date('2030-01-01T00:00:00.000Z') });
  assert.equal(c1.snapshotHash, c2.snapshotHash);
  assert.match(c1.snapshotHash, /^[0-9a-f]{64}$/);
  assert.equal(c1.links[0].affiliateUrlRaw, a.affiliateUrlRaw);
  assert.ok(c1.promptBlock.includes(a.affiliateUrlRaw));
  assert.ok(c1.promptBlock.includes(c1.disclosureLine));
});

test('catalog_write_is_atomic_and_refuses_corrupt_file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-catalog-'));
  try {
    const file = path.join(dir, 'connect', 'catalog.json');
    assert.deepEqual(readConnectCatalog(file, { fs }), { version: 1, products: [], sources: [] });
    const p = normalizeConnectProduct(travelInput({ variants: [variant()] }), { sources: [], now: NOW });
    writeConnectCatalog(file, { version: 1, products: [p], sources: [SOURCE] }, { fs });
    const back = readConnectCatalog(file, { fs });
    assert.deepEqual(back.products, [p]);
    assert.deepEqual(back.sources, [SOURCE]);
    assert.equal(back.products[0].affiliateUrlRaw, 'https://naver.me/AbCd123');

    // 쓰기 도중 실패해도 기존 파일은 그대로다.
    const before = fs.readFileSync(file, 'utf8');
    const failing = { ...fs, renameSync() { throw new Error('rename failed'); } };
    assert.throws(() => writeConnectCatalog(file, { version: 1, products: [], sources: [] }, { fs: failing }), /rename failed/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['catalog.json']);

    // 잘못된 값은 거부한다.
    assert.throws(() => writeConnectCatalog(file, { version: 2, products: [], sources: [] }, { fs }));
    assert.equal(fs.readFileSync(file, 'utf8'), before);

    // 손상 파일은 읽기도 덮어쓰기도 거부한다.
    fs.writeFileSync(file, '{broken', 'utf8');
    assert.throws(() => readConnectCatalog(file, { fs }), /catalog/i);
    assert.throws(() => writeConnectCatalog(file, { version: 1, products: [], sources: [] }, { fs }), /catalog/i);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    fs.writeFileSync(file, JSON.stringify({ version: 1, products: [{ id: 1 }], sources: [] }), 'utf8');
    assert.throws(() => readConnectCatalog(file, { fs }), /catalog/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


const T0 = '2026-10-07T02:00:00.000Z';
const fact = (field, value, excerpt, extra = {}) => ({ field, value, sourceId: 's1', excerpt, status: 'verified', checkedAt: T0, ...extra });
const SNIPPET = { ...SOURCE, id: 'snip', accessLevel: 'search-snippet' };
const FULL = { ...SOURCE, id: 'full', accessLevel: 'full-page' };

test('search_snippet_never_verified', () => {
  const p = normalizeConnectProduct(travelInput({
    variants: [variant({ id: 'v1' })],
    facts: [
      fact('variant:v1:price', 129000, '129,000원', { sourceId: 'snip' }),
      fact('note-full', '디럭스룸', '디럭스룸', { sourceId: 'full' }),
      fact('note-user', '디럭스룸', '디럭스룸'),
    ],
  }), { sources: [SNIPPET, FULL, SOURCE], now: NOW });
  const by = Object.fromEntries(p.facts.map((f) => [f.field, f]));
  assert.equal(by['variant:v1:price'].status, 'unverified');
  assert.equal(by['variant:v1:price'].reason, 'snippet-not-verifiable');
  assert.equal(by['note-full'].status, 'verified');
  assert.equal(by['note-full'].verificationBasis, 'full-page');
  assert.equal(by['note-user'].verificationBasis, 'user-excerpt');
});

test('verified_price_matches_variant_amount_and_number_tokens', () => {
  const mk = (amountMinor, value, excerpt) => normalizeConnectProduct(travelInput({
    variants: [variant({ id: 'v1', amountMinor })],
    facts: [fact('variant:v1:price', value, excerpt)],
  }), { sources: [SOURCE], now: NOW }).facts[0];
  assert.equal(mk(129000, 129000, '129,000원').status, 'verified');
  const mismatch = mk(999000, 129000, '129,000원');
  assert.equal(mismatch.status, 'unverified');
  assert.equal(mismatch.reason, 'price-mismatch');
  // 부분 문자열(1290 in 129,000)은 근거가 아니다.
  assert.equal(mk(1290, 1290, '129,000원').status, 'unverified');
  assert.equal(mk(129000, 129000, '129,0001원').status, 'unverified');
  const ghost = normalizeConnectProduct(travelInput({ variants: [variant({ id: 'v1' })], facts: [fact('variant:vX:price', 129000, '129,000원')] }), { sources: [SOURCE], now: NOW });
  assert.equal(ghost.facts[0].status, 'unverified');
  // 숫자 사실도 토큰 경계로 확인한다.
  const adults = (excerpt) => normalizeConnectProduct(travelInput({ facts: [fact('adults', 2, excerpt)] }), { sources: [{ ...SOURCE, excerpt }], now: NOW }).facts[0].status;
  assert.equal(adults('성인 2명'), 'verified');
  assert.equal(adults('성인 12명'), 'unverified');
});

test('context_facts_carry_product_identity_and_variant_ids_are_unique', () => {
  const a = normalizeConnectProduct(travelInput({ detailUrl: 'https://example.com/a', variants: [variant({ id: 'va' })], facts: [fact('roomBasis', '디럭스룸', '디럭스룸')] }), { sources: [SOURCE], now: NOW });
  const b = normalizeConnectProduct(travelInput({ name: '나트랑 패키지', detailUrl: 'https://example.com/b', variants: [variant({ id: 'vb' })], facts: [{ ...fact('roomBasis', '오션뷰', '오션뷰'), status: 'unverified' }] }), { sources: [SOURCE], now: NOW });
  assert.notEqual(a.id, b.id);
  const ctx = buildConnectContext({ products: [a, b], variantIds: ['va', 'vb'], sources: [SOURCE], experience: '', now: NOW });
  assert.deepEqual(ctx.verifiedFacts.map((f) => [f.productId, f.field]), [[a.id, 'roomBasis']]);
  assert.ok(ctx.uncertainFields.includes(b.id + '.roomBasis'));
  assert.ok(!ctx.uncertainFields.includes(a.id + '.roomBasis'));
  assert.ok(ctx.promptBlock.includes(a.name + ' roomBasis') || ctx.promptBlock.includes(a.name + ' / roomBasis') || /다낭 3박4일 패키지.*roomBasis/.test(ctx.promptBlock));
  const dup = normalizeConnectProduct(travelInput({ name: '다른 상품', detailUrl: 'https://example.com/c', variants: [variant({ id: 'va' })] }), { sources: [], now: NOW });
  assert.throws(() => buildConnectContext({ products: [a, dup], variantIds: ['va'], sources: [SOURCE], experience: '', now: NOW }), /variant/);
  assert.throws(() => buildConnectContext({ products: [a, a], variantIds: [], sources: [SOURCE], experience: '', now: NOW }), /product/);
});

test('context_and_catalog_renormalize_untrusted_input', () => {
  const forged = {
    ...normalizeConnectProduct(travelInput({ variants: [variant({ id: 'v1' })] }), { sources: [], now: NOW }),
    affiliateUrlRaw: 'javascript:alert(1)', affiliateStatus: 'issued', eligibility: 'verified',
    facts: [fact('variant:v1:price', 129000, '129,000원', { sourceId: 'ghost' })],
  };
  const ctx = buildConnectContext({ products: [forged], variantIds: ['v1'], sources: [SOURCE], experience: '', now: NOW });
  assert.deepEqual(ctx.links, []);
  assert.deepEqual(ctx.verifiedFacts, []);
  assert.ok(!ctx.promptBlock.includes('javascript:'));
  assert.equal(ctx.productSnapshots[0].eligibility, 'unknown');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-catalog-'));
  try {
    const file = path.join(dir, 'catalog.json');
    const raw = 'https://brand.example.com/p?a=1&a=2&b=%2Fx%2F';
    const good = normalizeConnectProduct(travelInput({ affiliateUrl: raw, detailUrl: 'https://example.com/good' }), { sources: [], now: NOW });
    const handEdited = { version: 1, products: [forged], sources: [SOURCE] };
    fs.writeFileSync(file, JSON.stringify(handEdited), 'utf8');
    const loaded = readConnectCatalog(file, { fs });
    assert.equal(loaded.version, 1);
    assert.equal(loaded.products[0].affiliateStatus, 'not-issued');
    assert.equal(loaded.products[0].affiliateUrlRaw, '');
    assert.equal(loaded.products[0].facts[0].status, 'unverified');
    // 쓰기에서도 같은 재검증을 하고 원문 링크는 그대로 둔다.
    fs.rmSync(file);
    writeConnectCatalog(file, { version: 1, products: [good, forged], sources: [SOURCE] }, { fs });
    const back = readConnectCatalog(file, { fs });
    assert.equal(back.products[0].affiliateUrlRaw, raw);
    assert.equal(back.products[1].affiliateStatus, 'not-issued');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).products[1].facts[0].status, 'unverified');
    // 중복 ID와 위험한 출처는 거부하고 기존 파일은 보존한다.
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => writeConnectCatalog(file, { version: 1, products: [good, good], sources: [] }, { fs }), /product/);
    assert.throws(() => writeConnectCatalog(file, { version: 1, products: [], sources: [SOURCE, SOURCE] }, { fs }), /source/);
    assert.throws(() => writeConnectCatalog(file, { version: 1, products: [], sources: [{ ...SOURCE, url: 'javascript:alert(1)' }] }, { fs }));
    const other = normalizeConnectProduct(travelInput({ detailUrl: 'https://example.com/other', variants: [variant({ id: 'v1' })] }), { sources: [], now: NOW });
    const one = normalizeConnectProduct(travelInput({ variants: [variant({ id: 'v1' })] }), { sources: [], now: NOW });
    assert.throws(() => writeConnectCatalog(file, { version: 1, products: [one, other], sources: [] }, { fs }), /variant/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    // 손상(중복 ID) 파일은 읽기를 거부하고 덮어쓰지 않는다.
    fs.writeFileSync(file, JSON.stringify({ version: 1, products: [good, good], sources: [] }), 'utf8');
    assert.throws(() => readConnectCatalog(file, { fs }), /product/);
    assert.throws(() => writeConnectCatalog(file, { version: 1, products: [], sources: [] }, { fs }), /product/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conflicting_reviewed_values_are_not_both_endorsed', () => {
  const p = normalizeConnectProduct(travelInput({
    facts: [
      fact('departureDate', '2026-11-03', '2026-11-03'),
      fact('departureDate', '2026-11-10', '2026-11-10'),
      fact('roomBasis', '디럭스룸', '디럭스룸'),
      fact('roomBasis', '디럭스룸', '디럭스룸'),
    ],
  }), { sources: [{ ...SOURCE, excerpt: '2026-11-03 2026-11-10 디럭스룸' }], now: NOW });
  const dates = p.facts.filter((f) => f.field === 'departureDate');
  assert.deepEqual(dates.map((f) => f.status), ['conflict', 'conflict']);
  assert.equal(p.facts.filter((f) => f.field === 'roomBasis').every((f) => f.status === 'verified'), true);
  const ctx = buildConnectContext({ products: [p], variantIds: [], sources: [{ ...SOURCE, excerpt: '2026-11-03 2026-11-10 디럭스룸' }], experience: '', now: NOW });
  assert.ok(!ctx.verifiedFacts.some((f) => f.field === 'departureDate'));
  assert.ok(ctx.uncertainFields.includes(p.id + '.departureDate'));
  // 이미 conflict로 표시된 필드가 있으면 같은 필드의 verified도 인정하지 않는다.
  const q = normalizeConnectProduct(travelInput({
    facts: [fact('roomBasis', '디럭스룸', '디럭스룸'), { ...fact('roomBasis', '스위트룸', '스위트룸'), status: 'conflict' }],
  }), { sources: [SOURCE], now: NOW });
  assert.ok(q.facts.every((f) => f.status !== 'verified'));
});
