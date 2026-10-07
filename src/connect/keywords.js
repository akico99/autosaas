'use strict';

// 기존 키워드 조사 결과(검색광고 행·자동완성·질문·검색 관찰)를 등록된 여행 상품에 매칭하는 순수 함수.
// XLSX 읽기, 자동완성 호출, 통합검색 관찰은 이 모듈이 하지 않는다(호출 쪽이 기존 모듈로 수집해 넘긴다).
// 사주용 분류·선별 규칙(classifyKeyword·selectKeywordReportRows)은 쓰지 않고, 여행 전용 규칙만 둔다.
const { mergeKeywordCandidates } = require('../keyword/report');

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
const squash = (value) => clean(value).normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko-KR');

// 지역 별칭 사전. 같은 묶음의 이름만 같은 지역으로 본다. 의미가 비슷하다는 이유로 검색량을 옮기지 않는다.
const REGION_LEXICON = Object.freeze([
  ['오사카'], ['교토'], ['도쿄'], ['후쿠오카'], ['삿포로'], ['오키나와'], ['나고야'], ['벳푸'], ['유후인'],
  ['다낭'], ['호이안'], ['나트랑', '나짱', '냐짱'], ['푸꾸옥'], ['하노이'], ['호치민', '사이공'], ['달랏'],
  ['방콕'], ['파타야'], ['치앙마이'], ['푸켓'], ['보라카이'], ['마닐라'], ['코타키나발루'], ['싱가포르'], ['발리'],
  ['괌'], ['사이판'], ['하와이'], ['홍콩'], ['마카오'], ['대만', '타이완', '타이베이', '타이페이'],
  ['상하이'], ['베이징'], ['장가계'], ['파리'], ['로마'], ['런던'], ['스위스'],
  ['제주', '제주도'], ['부산'], ['강릉'], ['여수'], ['경주'], ['속초'],
]);

const AUDIENCE_GROUPS = Object.freeze({
  parents: ['부모님', '어르신', '시니어', '효도', '엄마', '아빠'],
  kids: ['아이동반', '아이와', '아이랑', '아이들', '아기', '어린이', '유아', '아동', '키즈', '초등'],
  family: ['가족'],
  couple: ['커플', '신혼', '허니문', '연인', '부부'],
  solo: ['혼자', '혼행', '나홀로', '1인여행'],
  friends: ['친구'],
});
const AUDIENCE_LABEL = Object.freeze({ parents: '부모님', kids: '아이 동반', family: '가족', couple: '커플·신혼', solo: '혼자', friends: '친구' });

// 키워드가 요구하는 확인 조건. 검토된(verified) 사실이 있어야 충족으로 본다.
const TOPICS = Object.freeze({
  noShopping: { label: '노쇼핑', test: /노쇼핑|쇼핑없|쇼핑0회/ },
  shopping: { label: '쇼핑 조건', test: /쇼핑/, not: /노쇼핑|쇼핑없|쇼핑0회/ },
  noOption: { label: '노옵션', test: /노옵션|선택관광없/ },
  optionalTours: { label: '선택관광', test: /선택관광|옵션투어/, not: /노옵션|선택관광없/ },
  cancellation: { label: '취소·환불', test: /취소|환불|위약/ },
  change: { label: '변경 조건', test: /변경/ },
  exclusions: { label: '불포함', test: /불포함/ },
  inclusions: { label: '포함', test: /포함/, not: /불포함/ },
  price: { label: '가격', test: /가격|비용|요금|경비|얼마/ },
});
const TOPIC_FACTS = Object.freeze({
  noShopping: { fields: ['shopping'], negation: 'shopping' },
  shopping: { fields: ['shopping'] },
  noOption: { fields: ['optionalTours'], negation: 'option' },
  optionalTours: { fields: ['optionalTours'] },
  cancellation: { fields: ['cancellationPolicy'] },
  change: { fields: ['changePolicy'] },
  exclusions: { fields: ['exclusions'] },
  inclusions: { fields: ['inclusions'] },
  price: { pattern: /^variant:.+:price$/ },
});

const TYPE_TERMS = Object.freeze([
  ['package', /패키지|자유여행|에어텔|여행상품/], ['hotel', /호텔|리조트|숙소|숙박|풀빌라/],
  ['flight', /항공|비행기/], ['activity', /액티비티|체험|입장권|티켓/], ['tour', /투어/],
]);
const TYPE_ALLOWED = Object.freeze({ package: ['package'], hotel: ['hotel'], flight: ['flight'], activity: ['activity'], tour: ['activity', 'package'] });
const TYPE_LABEL = Object.freeze({ package: '패키지', hotel: '호텔', flight: '항공', activity: '액티비티', other: '기타' });

const FIT_RANK = Object.freeze({ fit: 2, conditional: 1, unfit: 0 });
const NOT_BLOG_BLOCKS = new Set(['ad', 'brand-content']);

function detectAudience(text) {
  const key = squash(text);
  return Object.keys(AUDIENCE_GROUPS).filter((id) => AUDIENCE_GROUPS[id].some((term) => key.includes(squash(term))));
}
function detectTopics(text) {
  const key = squash(text);
  return Object.keys(TOPICS).filter((id) => TOPICS[id].test.test(key) && !(TOPICS[id].not && TOPICS[id].not.test(key)));
}
function detectTypes(text) {
  const key = squash(text);
  return TYPE_TERMS.filter(([, re]) => re.test(key)).map(([id]) => id);
}

function buildRegionGroups(products) {
  const groups = REGION_LEXICON.map((names) => ({ names: names.map(squash) }));
  const find = (name) => groups.findIndex((g) => g.names.includes(name));
  const groupsFor = (destination) => {
    const ids = new Set();
    for (const part of clean(destination).split(/[,\/·&+]|및|\s+/).map(squash).filter(Boolean)) {
      let index = find(part);
      if (index < 0) { groups.push({ names: [part] }); index = groups.length - 1; }
      ids.add(index);
    }
    return ids;
  };
  const productGroups = new Map();
  for (const product of products) productGroups.set(product, groupsFor(product.travelDetails && product.travelDetails.destination));
  return { groups, productGroups };
}
const mentionedGroups = (groups, key) => new Set(groups.map((g, i) => (g.names.some((n) => key.includes(n)) ? i : -1)).filter((i) => i >= 0));

function normalizeQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map((raw, index) => {
    const src = typeof raw === 'string' ? { question: raw } : (raw && typeof raw === 'object' ? raw : {});
    const question = clean(src.question != null ? src.question : src.text);
    if (!question) return null;
    return {
      id: clean(src.id) || 'q' + (index + 1),
      question,
      keywordKey: squash(src.keyword),
      text: [question, clean(src.audience), clean(src.region)].join(' '),
      sourceIds: Array.isArray(src.sourceIds) ? src.sourceIds.map(clean).filter(Boolean) : [],
    };
  }).filter(Boolean);
}

function observationFor(raw) {
  if (!raw) return { status: 'none', reason: '' };
  if (raw.blocked === true) return { status: 'blocked', reason: clean(raw.reason) };
  if (!raw.measured) return { status: 'failed', reason: clean(raw.reason) };
  const blogArea = (raw.blocks || []).some((b) => !NOT_BLOG_BLOCKS.has(b.blockKind) && Number(b.blogCount != null ? b.blogCount : (b.items || []).filter((i) => i.sourceType === '블로그').length) > 0);
  return { status: blogArea ? 'blog-area' : 'no-blog-area', reason: clean(raw.reason) };
}

function volumeStatus(row) {
  if (typeof row.monthlyTotal === 'number') return 'confirmed';
  if (row.monthlyPc === '<10' || row.monthlyMobile === '<10') return 'under-10';
  if (!row.sources.includes('search-ads-xlsx')) return 'not-provided';
  return 'missing';
}

// 부정 표현(없음·0회·방문하지 않음)과 횟수(N회)는 쇼핑·선택관광에 직접 묶인 표현만 읽는다.
// 공백을 없앤 문자열 기준이며, "자유시간 2회"나 "쇼핑 쿠폰 0원"처럼 다른 숫자는 어느 쪽 근거도 아니다.
const NEGATION_PATTERNS = Object.freeze({
  shopping: {
    no: /노쇼핑|noshopping|쇼핑(?:센터|점|샵)?(?:은|는|이|가)?(?:일정(?:은|이)?)?(?:방문(?:은|을|이)?)?(?:없|0회|안함|안가|미방문|하지않)/,
    yes: /쇼핑(?:센터|점|샵)?(?:방문)?(?:은|는)?[1-9]\d*(?:회|곳|번|차례)|[1-9]\d*(?:회|곳|번)(?:의)?쇼핑|쇼핑(?:센터)?(?:방문)?(?:일정)?(?:이|가|은|는)?있/,
    exactNo: /^(?:없음|없습니다|0|0회)$/,
    exactYes: /^(?:있음|있습니다)$/,
  },
  option: {
    no: /노옵션|(?:선택관광|옵션투어|옵션)(?:은|이)?(?:일정(?:은|이)?)?(?:없|0회|안함|미포함|하지않)/,
    yes: /(?:선택관광|옵션투어)(?:은|이)?[1-9]\d*(?:회|개|곳|종)|[1-9]\d*(?:회|개)(?:의)?(?:선택관광|옵션투어)|(?:선택관광|옵션투어)(?:이|은)?있/,
    exactNo: /^(?:없음|없습니다|0|0회)$/,
    exactYes: /^(?:있음|있습니다)$/,
  },
});
const classifyNegation = (value, kind) => {
  const patterns = NEGATION_PATTERNS[kind];
  const text = squash(value);
  const no = patterns.no.test(text) || patterns.exactNo.test(text);
  const yes = patterns.yes.test(text) || patterns.exactYes.test(text);
  if (no && yes) return 'both';
  return no ? 'no' : (yes ? 'yes' : 'none');
};

// 대상 확인: 문장 단위로 나눠 같은 대상에 붙은 불가·제한·비추천 표현을 찾는다.
const AUDIENCE_NEGATIVE = /불가|제한|비추천|추천하지|권장하지|제외|금지|미만|어려|곤란|부적합|안됨|안돼|못함|불편|힘듦|힘들/;
function audienceClauses(value) {
  return String(value == null ? '' : value).split(/[,，;；\n]|\.(?=\s|$)|。|\s(?:단|다만|하지만|그러나)\s/).map(clean).filter(Boolean);
}
function checkAudience(product, id) {
  const given = (product.facts || []).filter((f) => f.field === 'audience' || f.field === 'targetAudience');
  const verified = given.filter((f) => f.status === 'verified');
  let positive = 0;
  let negative = 0;
  let unscoped = 0;
  for (const f of verified) {
    for (const clause of audienceClauses(f.value)) {
      const negated = AUDIENCE_NEGATIVE.test(squash(clause));
      if (detectAudience(clause).includes(id)) { if (negated) negative += 1; else positive += 1; }
      else if (negated && !detectAudience(clause).length) unscoped += 1;
    }
  }
  const label = AUDIENCE_LABEL[id];
  if (negative || unscoped) return { state: 'unconfirmed', note: '검토된 근거에 대상(' + label + ') 불가·제한·비추천 표현이 ' + (positive ? '함께 있어 서로 어긋남' : '있어 확인으로 보지 않음') };
  if (positive) return { state: 'ok', note: '' };
  return { state: 'unconfirmed', note: verified.length ? '검토된 대상 정보에 없음' : (given.length ? '대상 근거가 검토 전이거나 충돌' : '대상 근거 자료 없음') };
}

// 검토된(verified) 사실만 근거로 본다. 충돌·미검토·없음은 모두 "확인 안 됨"이다.
function checkFact(product, spec) {
  const matches = (f) => (spec.pattern ? spec.pattern.test(f.field) : spec.fields.includes(f.field));
  const facts = (product.facts || []).filter(matches);
  const verified = facts.filter((f) => f.status === 'verified');
  if (!verified.length) return { state: 'unconfirmed', note: facts.some((f) => f.status === 'conflict') ? '근거가 서로 충돌' : (facts.length ? '검토 전' : '자료 없음') };
  if (spec.negation) {
    const kinds = verified.map((f) => classifyNegation(f.value, spec.negation));
    const no = kinds.some((k) => k === 'no' || k === 'both');
    const yes = kinds.some((k) => k === 'yes' || k === 'both');
    if (no && yes) return { state: 'unconfirmed', note: '검토된 근거의 표현이 서로 어긋남' };
    if (yes) return { state: 'contradict', note: '검토된 근거가 키워드 조건과 다름' };
    if (no) return { state: 'ok', note: '' };
    return { state: 'unconfirmed', note: '검토된 값이 조건을 확인해 주지 않음' };
  }
  return { state: 'ok', note: '' };
}

function evaluateProduct(product, kw) {
  const reasons = [];
  let fit = 'fit';
  const downgrade = () => { if (fit === 'fit') fit = 'conditional'; };
  const details = product.travelDetails || {};
  reasons.push(clean(details.destination) + ' 지역 상품과 일치');

  if (kw.types.length) {
    const allowed = new Set(kw.types.flatMap((t) => TYPE_ALLOWED[t]));
    if (allowed.has(details.travelType)) reasons.push('상품 유형(' + TYPE_LABEL[details.travelType] + ')이 키워드와 맞음');
    else { downgrade(); reasons.push('상품 유형(' + (TYPE_LABEL[details.travelType] || '기타') + ')이 키워드 유형과 달라 조건부'); }
  }
  for (const id of kw.audience) {
    const result = checkAudience(product, id);
    if (result.state === 'ok') reasons.push('검토된 근거에서 대상(' + AUDIENCE_LABEL[id] + ') 확인');
    else { downgrade(); reasons.push('대상(' + AUDIENCE_LABEL[id] + ') 적합성 미확인 — ' + result.note); }
  }
  for (const id of kw.topics) {
    const result = checkFact(product, TOPIC_FACTS[id]);
    if (result.state === 'ok') reasons.push('검토된 근거에서 ' + TOPICS[id].label + ' 확인');
    else if (result.state === 'contradict') { fit = 'unfit'; reasons.push(TOPICS[id].label + ' 조건과 검토된 근거가 맞지 않음'); }
    else { downgrade(); reasons.push(TOPICS[id].label + ' 미확인 — ' + result.note); }
  }
  if (kw.extraRegion) { downgrade(); reasons.push('상품 지역 밖의 다른 지역도 함께 언급되어 조건부'); }
  const evidence = new Set((product.facts || []).filter((f) => f.status === 'verified').map((f) => f.field)).size;
  return { productId: product.id, name: clean(product.name), fit, reasons, evidence };
}

function departureMonths(product, now) {
  const parsed = now ? new Date(now) : null;
  const today = parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
  return (product.variants || []).filter((v) => v.departureDate && (!today || v.departureDate >= today)).map((v) => Number(v.departureDate.slice(5, 7)));
}

function volumeNote(row, status) {
  if (status === 'confirmed') return '검색광고 월간 검색수 ' + row.monthlyTotal + ' (PC ' + row.monthlyPc + ' + 모바일 ' + row.monthlyMobile + ')';
  if (status === 'under-10') return '검색광고 월간 검색수에 <10이 있어 합계를 만들지 않음';
  if (status === 'not-provided') return '자동완성 후보로 검색량 미제공';
  return '검색광고 월간 검색수 결측';
}

function matchConnectKeywords(input) {
  if (!input || typeof input !== 'object') throw new TypeError('키워드 매칭 입력이 필요합니다.');
  const { seed = '', adsRows = [], autocomplete = [], questions = [], products = [], observations = [], now } = input;

  // 같은 키워드의 검색광고 행은 첫 행만 쓴다. 합산하거나 행끼리 값을 섞지 않는다.
  const adsByKey = new Map();
  const duplicates = new Map();
  for (const raw of Array.isArray(adsRows) ? adsRows : []) {
    const key = squash(raw && raw.keyword);
    if (!key) continue;
    if (adsByKey.has(key)) duplicates.set(key, (duplicates.get(key) || 1) + 1);
    else adsByKey.set(key, raw);
  }
  const candidates = mergeKeywordCandidates(seed, [...adsByKey.values()], Array.isArray(autocomplete) ? autocomplete : []);

  const travelProducts = (Array.isArray(products) ? products : []).filter((p) => p && p.connectKind === 'travel' && p.travelDetails);
  const active = travelProducts.filter((p) => p.eligibility !== 'excluded');
  const { groups, productGroups } = buildRegionGroups(travelProducts);
  const questionList = normalizeQuestions(questions);
  const observationByKey = new Map();
  for (const raw of Array.isArray(observations) ? observations : []) if (raw && squash(raw.keyword)) observationByKey.set(squash(raw.keyword), raw);

  const rows = candidates.map((candidate) => {
    const key = candidate.keywordKey;
    const mentioned = mentionedGroups(groups, key);
    const kw = { audience: detectAudience(key), topics: detectTopics(key), types: detectTypes(key), extraRegion: false };
    const inRegion = (p) => [...productGroups.get(p)].some((g) => mentioned.has(g));
    const regional = active.filter(inRegion);
    const reasons = [];
    let matches = [];
    let fit = 'unfit';

    if (!mentioned.size) reasons.push('키워드에 등록 상품의 지역이 없어 상품에 연결하지 않음');
    else if (!regional.length) {
      reasons.push('등록된 상품에 해당 지역이 없음');
    } else {
      const covered = new Set(regional.flatMap((p) => [...productGroups.get(p)]));
      kw.extraRegion = [...mentioned].some((g) => !covered.has(g));
      const evaluated = regional.map((p) => evaluateProduct(p, kw));
      fit = evaluated.reduce((best, m) => (FIT_RANK[m.fit] > FIT_RANK[best] ? m.fit : best), 'unfit');
      matches = evaluated.filter((m) => m.fit !== 'unfit');
      if (fit === 'unfit') for (const m of evaluated) reasons.push(m.name + ': ' + m.reasons.join(' / '));
      else for (const m of matches.filter((x) => x.fit === fit)) reasons.push(m.name + ': ' + m.reasons.join(' / '));
    }
    const chosen = matches.filter((m) => m.fit === fit);
    const productIds = fit === 'unfit' ? [] : chosen.map((m) => m.productId);
    const evidenceCount = chosen.reduce((max, m) => Math.max(max, m.evidence), 0);

    const status = volumeStatus(candidate);
    const linked = questionList.filter((q) => {
      if (q.keywordKey) return q.keywordKey === key;
      const qGroups = mentionedGroups(groups, squash(q.text));
      if (![...qGroups].some((g) => mentioned.has(g))) return false;
      const qAudience = detectAudience(q.text);
      const qTopics = detectTopics(q.text);
      return kw.audience.some((a) => qAudience.includes(a)) || kw.topics.some((t) => qTopics.includes(t));
    });
    if (linked.length) reasons.push('연결된 독자 질문 ' + linked.length + '개');

    const observation = observationFor(observationByKey.get(key));
    if (observation.status === 'blog-area') reasons.push('통합검색에서 블로그 영역이 관찰됨');
    else if (observation.status === 'no-blog-area') reasons.push('통합검색을 관찰했으나 블로그 영역이 보이지 않음');
    else if (observation.status === 'blocked') reasons.push('검색 관찰이 차단되어 결과를 얻지 못함(경쟁 정도를 판단하지 않음)');
    else if (observation.status === 'failed') reasons.push('검색 관찰 실패(경쟁 정도를 판단하지 않음)');

    const monthMatch = /(\d{1,2})월/.exec(key);
    const month = monthMatch ? Number(monthMatch[1]) : null;
    const timingMatch = month != null && matches.some((m) => departureMonths(active.find((p) => p.id === m.productId), now).includes(month));
    if (timingMatch) reasons.push(month + '월 출발 일정이 상품에 등록되어 있음');
    else if (month != null && fit !== 'unfit') reasons.push(month + '월과 맞는 등록 출발일이 없음');

    reasons.push(volumeNote(candidate, status));
    if (duplicates.has(key)) reasons.push('검색광고 파일에 같은 키워드 행이 ' + duplicates.get(key) + '개 있어 첫 행만 사용(합산하지 않음)');

    return {
      keyword: candidate.keyword,
      monthlyPc: candidate.monthlyPc,
      monthlyMobile: candidate.monthlyMobile,
      monthlyTotal: candidate.monthlyTotal,
      productIds,
      fit,
      reasons,
      keywordKey: key,
      sources: candidate.sources,
      volumeStatus: status,
      evidenceCount,
      questions: linked.map((q) => ({ id: q.id, question: q.question, sourceIds: q.sourceIds })),
      observation,
      timingMatch,
      productMatches: matches.map((m) => ({ productId: m.productId, fit: m.fit, reasons: m.reasons })),
    };
  });

  const observationRank = (row) => (row.observation.status === 'blog-area' ? 1 : 0);
  const volumeRank = (row) => (typeof row.monthlyTotal === 'number' ? row.monthlyTotal : -1);
  return rows.sort((a, b) =>
    FIT_RANK[b.fit] - FIT_RANK[a.fit]
    || b.evidenceCount - a.evidenceCount
    || b.questions.length - a.questions.length
    || observationRank(b) - observationRank(a)
    || Number(b.timingMatch) - Number(a.timingMatch)
    || volumeRank(b) - volumeRank(a)
    || a.keyword.localeCompare(b.keyword, 'ko-KR'));
}

module.exports = { matchConnectKeywords, REGION_LEXICON };
