const { familyOf, TONES_WITH_NOTE } = require('./searchTopics');

const STANDARD_VERSION = 'search-standard-v1-2026-10-04';

const INTENTS = Object.freeze({
  definition: Object.freeze({
    label: '뜻·개념', minChars: 700, targetChars: [900, 1600], minHeadings: 2,
    requiredAnswers: [
      { id: 'meaning', label: '핵심 의미를 앞부분에서 정의' },
      { id: 'example', label: '구체적인 예시' },
      { id: 'distinction', label: '헷갈리는 개념과의 차이' },
    ],
  }),
  howto: Object.freeze({
    label: '방법·절차', minChars: 1200, targetChars: [1500, 2500], minHeadings: 3,
    requiredAnswers: [
      { id: 'who', label: '대상·자격·조건' },
      { id: 'prep', label: '준비물·필요 정보' },
      { id: 'steps', label: '실제 진행 순서' },
      { id: 'costTime', label: '비용·소요 시간(해당 시)' },
      { id: 'exception', label: '예외·실패 시 대처' },
    ],
  }),
  compare: Object.freeze({
    label: '비교·추천', minChars: 1200, targetChars: [1500, 2500], minHeadings: 3,
    requiredAnswers: [
      { id: 'criteria', label: '비교 기준' },
      { id: 'differences', label: '기준별 차이' },
      { id: 'choice', label: '상황별 선택 안내' },
      { id: 'limits', label: '한계·주의점' },
    ],
  }),
  experience: Object.freeze({
    label: '경험·후기', minChars: 1000, targetChars: [1300, 2200], minHeadings: 3,
    requiredAnswers: [
      { id: 'when', label: '언제 무엇을 경험했는지' },
      { id: 'pros', label: '좋았던 점' },
      { id: 'cons', label: '아쉬운 점' },
      { id: 'fit', label: '누구에게 맞는지' },
    ],
  }),
  place: Object.freeze({
    label: '장소·방문', minChars: 1000, targetChars: [1300, 2200], minHeadings: 3,
    requiredAnswers: [
      { id: 'location', label: '위치·가는 방법' },
      { id: 'hours', label: '운영 정보(시간·휴무)' },
      { id: 'cost', label: '비용' },
      { id: 'tips', label: '방문 팁(예약·주차·대기 등 해당 시)' },
    ],
  }),
  news: Object.freeze({
    label: '최신 이슈', minChars: 900, targetChars: [1200, 2000], minHeadings: 3,
    requiredAnswers: [
      { id: 'what', label: '무슨 일이 언제 있었는지' },
      { id: 'confirmed', label: '확인된 사실과 미확인 내용 구분' },
      { id: 'background', label: '관련 배경' },
      { id: 'status', label: '현재 상태·다음 일정' },
    ],
  }),
  service: Object.freeze({
    label: '서비스·사이트 찾기', minChars: 900, targetChars: [1200, 2000], minHeadings: 3,
    requiredAnswers: [
      { id: 'operator', label: '운영 주체·정체' },
      { id: 'access', label: '이용·접속 방법' },
      { id: 'pricing', label: '무료·유료 범위' },
      { id: 'caution', label: '이용 전 확인할 점' },
    ],
  }),
  general: Object.freeze({
    label: '일반 정보', minChars: 1000, targetChars: [1300, 2200], minHeadings: 3,
    requiredAnswers: [
      { id: 'answer', label: '검색자의 핵심 질문에 대한 직접 답' },
      { id: 'details', label: '근거 있는 세부 정보' },
      { id: 'next', label: '독자가 다음에 할 일' },
    ],
  }),
});

const KEYWORD_PATTERNS = [
  ['experience', /후기|리뷰|내돈내산|사용기|솔직|써본|가본/],
  ['howto', /방법|하는법|보는법|신청|발급|조회|등록|설정|해지|가입|계산|준비물|절차|순서|만들기|레시피|사용법|설치|가는법/],
  ['compare', /비교|vs|추천|순위|장단점|뭐가 좋|어떤게|차이점|차이/i],
  ['definition', /뜻|의미|^(?!이란\??$).+란\??$|란 무엇|개념|정의(?:$|\s|란)|유래/],
  ['service', /사이트|어플|앱|홈페이지|바로가기|공식/],
  ['place', /맛집|카페|가볼만한곳|여행|코스|주차|숙소|명소|위치/],
];

const INTENT_LABELS = {
  experience: '후기 키워드 패턴', howto: '방법 키워드 패턴', compare: '비교 키워드 패턴',
  definition: '개념 키워드 패턴', service: '서비스 키워드 패턴', place: '장소 키워드 패턴',
};

function keywordIntent(keyword) {
  const raw = String(keyword || '');
  const compact = raw.replace(/\s+/g, '');
  for (const [intent, pattern] of KEYWORD_PATTERNS) {
    if (pattern.test(raw) || pattern.test(compact)) return intent;
  }
  return null;
}

function hasReviewPlaces(review) {
  return !!(review && Array.isArray(review.places) && review.places.length);
}

function hasLinkSource(source) {
  if (typeof source === 'string') return /^https?:\/\//i.test(source.trim());
  return !!(source && typeof source === 'object' && typeof source.url === 'string' && /^https?:\/\//i.test(source.url.trim()));
}

function classifyIntent({ keyword, topic, review, source, paid, newsCount, factCount } = {}) {
  if (hasReviewPlaces(review) || paid === 'mine') {
    return { intent: 'experience', ambiguous: false, reason: '리뷰 장소 또는 내돈내산 입력이 있어 경험 의도로 분류' };
  }

  const matched = keywordIntent(keyword);
  if (matched) {
    return { intent: matched, ambiguous: false, reason: INTENT_LABELS[matched] };
  }

  if (['restaurant', 'domestictravel', 'worldtravel'].includes(topic)) {
    return { intent: 'place', ambiguous: false, reason: '장소·여행 주제로 분류' };
  }

  if (hasLinkSource(source)) {
    return { intent: 'news', ambiguous: false, reason: '링크 자료가 있어 최신 이슈 의도로 분류' };
  }

  const evidenceCount = (Number(newsCount) || 0) + (Number(factCount) || 0);
  if (familyOf(topic) === 'A' || (['society', 'business', 'sports', 'game'].includes(topic) && evidenceCount > 0)) {
    return { intent: 'news', ambiguous: false, reason: '주제 또는 조사 자료가 있어 최신 이슈 의도로 분류' };
  }

  return { intent: 'general', ambiguous: true, reason: '검색 의도를 키워드에서 특정하지 못함' };
}

function filterAutocomplete(keyword, list, intent, topic) {
  const main = String(keyword || '').trim();
  const normalize = (value) => String(value || '').replace(/\s+/g, '').toLocaleLowerCase();
  const selected = [];
  const excluded = [];
  const seen = new Set();

  for (const value of Array.isArray(list) ? list : []) {
    const candidate = String(value || '').trim();
    if (!candidate || normalize(candidate) === normalize(main)) continue;
    if (seen.has(normalize(candidate))) continue;
    seen.add(normalize(candidate));

    const candidateIntent = keywordIntent(candidate);
    if (candidateIntent && candidateIntent !== intent) {
      excluded.push(candidate);
      continue;
    }
    if (selected.length < 3) selected.push(candidate);
    else excluded.push(candidate);
  }
  return { selected, excluded };
}

function hasExperienceInput({ review, paid, memo } = {}) {
  return hasReviewPlaces(review) || paid === 'mine' || paid === 'sponsored' || !!String(memo || '').trim();
}

function countEvidence(value) {
  return Array.isArray(value) ? value.length : 0;
}

function sectionForIntent(serp, intent, fallback) {
  const sections = Array.isArray(serp && serp.sections) ? serp.sections : [];
  const rules = {
    definition: /국어사전|어학사전|영어사전|지식백과|백과사전/,
    place: /플레이스|지도/,
    news: /뉴스/,
    service: /상담|엑스퍼트/,
    compare: /가격비교|플러스 스토어|쇼핑/,
  };
  return sections.find((section) => rules[intent] && rules[intent].test(section)) || fallback;
}

function calibrateIntentWithSerp(classified, serp) {
  const next = { ...classified };
  if (!serp || serp.measured !== true) {
    return {
      classified: next,
      briefSerp: {
        measured: false,
        blocked: !!(serp && serp.blocked),
        reason: serp && serp.reason ? String(serp.reason) : '검색 결과 관찰 결과가 없음',
      },
      warnings: ['검색 결과 관찰 실패 — 의도 보정 없이 작성'],
    };
  }

  const flags = serp.flags || {};
  const firstSections = Array.isArray(serp.firstSections) ? serp.firstSections : [];
  let intent = null;
  let fallback = '';
  if (next.ambiguous) {
    if (firstSections.includes('dictionary')) { intent = 'definition'; fallback = '사전'; }
    else if (flags.place) { intent = 'place'; fallback = '플레이스/지도'; }
    else if (firstSections.includes('news')) { intent = 'news'; fallback = '뉴스'; }
    else if (flags.expertService) { intent = 'service'; fallback = '상담'; }
    else if (flags.shopping) { intent = 'compare'; fallback = '쇼핑'; }
  }
  if (intent && intent !== next.intent) {
    next.intent = intent;
    next.ambiguous = false;
    next.reason = '검색 결과 보정: ' + sectionForIntent(serp, intent, fallback);
  }

  const notes = [];
  if (flags.aiBriefing) notes.push('검색 결과에 AI 브리핑이 있어 단순 요약만으로는 클릭할 이유가 약함 — 조건별 설명·예시·비교처럼 요약에 없는 내용을 더하세요');
  if (flags.dictionary) notes.push('사전 결과가 상단에 있음 — 뜻 풀이는 짧게, 쓰임·예시·헷갈리는 점에 비중을 두세요');
  if (flags.ads || flags.brandContent) notes.push('광고·브랜드 콘텐츠가 경쟁하는 상업 키워드 — 판매 문구와 구분되는 객관적 정보가 필요해요');
  if (flags.expertService) notes.push('유료 상담 서비스가 노출되는 키워드 — 서비스 홍보처럼 보이지 않게 쓰세요');

  return {
    classified: next,
    briefSerp: {
      measured: true,
      observedAt: serp.observedAt || '',
      sections: (Array.isArray(serp.sections) ? serp.sections : []).slice(0, 8),
      flags: { ...flags },
      notes,
      topDocs: (Array.isArray(serp.topDocs) ? serp.topDocs : []).slice(0, 6),
    },
    warnings: [],
  };
}

function hasOfficialEvidence(value) {
  if (!value || typeof value !== 'object') return false;
  return !!(String(value.brief || '').trim() || (Array.isArray(value.pages) && value.pages.length));
}

function buildSearchBrief({
  keyword, topic, review, source, memo, paid, style, autocomplete,
  newsArticles, keywordFacts, officialFacts, placeReviews, searchBlocked, serp,
} = {}) {
  const evidence = {
    news: countEvidence(newsArticles),
    facts: countEvidence(keywordFacts),
    official: hasOfficialEvidence(officialFacts),
    reviews: countEvidence(placeReviews),
    experienceInput: hasExperienceInput({ review, paid, memo }),
    searchBlocked: searchBlocked === true,
  };
  const baseClassified = classifyIntent({
    keyword, topic, review, source, paid,
    newsCount: evidence.news, factCount: evidence.facts,
  });
  const calibration = calibrateIntentWithSerp(baseClassified, serp);
  const classified = calibration.classified;
  const intent = INTENTS[classified.intent] ? classified.intent : 'general';
  const definition = INTENTS[intent];
  const autocompleteResult = filterAutocomplete(keyword, autocomplete, intent, topic);
  const preHoldReasons = [];
  const warnings = [...calibration.warnings];

  if (evidence.searchBlocked) preHoldReasons.push('네이버 검색 제한으로 근거 자료를 가져오지 못함');

  if (intent === 'news' && evidence.news === 0 && evidence.facts === 0 && !hasLinkSource(source)) {
    preHoldReasons.push('최신 이슈 글인데 확인한 기사·뉴스 자료가 없음');
  }
  if (intent === 'experience' && !evidence.experienceInput) {
    preHoldReasons.push('후기 글인데 직접 경험 입력(리뷰 장소·내돈내산·경험 메모)이 없음');
  }
  if (classified.ambiguous) warnings.push('검색 의도가 하나로 정해지지 않음 — 원고 범위를 검수하세요');
  if (TONES_WITH_NOTE.includes(style) && !evidence.experienceInput) {
    warnings.push('경험형 말투지만 경험 입력이 없어 정보 전달 문체로 작성함');
  }

  return {
    version: STANDARD_VERSION,
    intent,
    intentLabel: definition.label,
    ambiguous: classified.ambiguous,
    reason: classified.reason,
    requiredAnswers: definition.requiredAnswers.map((item) => ({ ...item })),
    minChars: definition.minChars,
    targetChars: [...definition.targetChars],
    minHeadings: definition.minHeadings,
    autocomplete: autocompleteResult,
    evidence,
    serp: calibration.briefSerp,
    preHoldReasons,
    warnings,
  };
}

module.exports = {
  INTENTS,
  classifyIntent,
  calibrateIntentWithSerp,
  buildSearchBrief,
  filterAutocomplete,
  hasExperienceInput,
  STANDARD_VERSION,
};
