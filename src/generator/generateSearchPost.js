// 검색용(검색 상위노출) 글 생성 엔진.
//
// 홈판용(generatePost.js)과의 차이:
//  - 홈판 자극 단어 검증 없음(검색은 자극단어 강제하면 낚시=퀵백 위험).
//  - 네이버 공식 주제(searchTopics.js) 기준.
//  - 검증: 본문 최소 글자수 + 인용구 개수 + 주제별 필수 구성요소 존재 여부(소프트).
//
// 생성은 홈판과 동일하게 runClaude()가 사용자의 클로드 구독 로그인으로 처리(배포자 비용 0원).

const { runClaude } = require('./runClaude');
const { getSearchTopic } = require('./searchTopics');
const { MAX_QUOTES } = require('./postTypes');
const { parseJsonLoose, appendCtaBlock, buildPlaceInfoBlocks, injectTravelPlaceInfo, gatherKeywordContext } = require('./generatePost');
const { fetchPlaceInfo } = require('../place/placeLookup');
const { familyOf } = require('./searchTopics');
const {
  buildSearchSystemPrompt,
  buildSearchUserPrompt,
} = require('./buildSearchPrompt');
const { fetchAutocomplete } = require('../keyword/expand');
const { fetchNewsArticles, fetchBlogFacts, fetchPlaceReviews, fetchNearbyAttractions } = require('../keyword/trends');
const { observeSerp } = require('../keyword/serpObserve');
const scrapeHealth = require('../scrape/health');
const { isSearchBlocked, getBlockState } = require('../scrape/naverSearchGuard');
const { factCheckPost } = require('./factCheck');
const { buildSearchBrief, collectOriginalSources, collectSourceMetadata, summarizeConnectContext } = require('./searchBrief');
const { checkRequiredAnswers, detectExperienceClaims } = require('./searchContentCheck');
const { topicEvidenceForIntent } = require('../topics/topicContext');

// 수집기는 테스트·호출자가 주입할 수 있다. 주입하지 않으면 기존 수집 함수를 그대로 쓴다.
const DEFAULT_COLLECTORS = Object.freeze({
  fetchAutocomplete: (...args) => fetchAutocomplete(...args),
  observeSerp: (...args) => observeSerp(...args),
  gatherKeywordContext: (...args) => gatherKeywordContext(...args),
  fetchNewsArticles: (...args) => fetchNewsArticles(...args),
  fetchBlogFacts: (...args) => fetchBlogFacts(...args),
  fetchPlaceReviews: (...args) => fetchPlaceReviews(...args),
  fetchNearbyAttractions: (...args) => fetchNearbyAttractions(...args),
  fetchPlaceInfo: (...args) => fetchPlaceInfo(...args),
});

// 여행 제휴 연결 원고는 국내/해외 여행 주제에서만 쓴다. 주제는 호출자가 고르고 여기서 추정하지 않는다.
const CONNECT_TRAVEL_TOPICS = ['domestictravel', 'worldtravel'];
const CONNECT_TRAVEL_MODEL = 'opus';

// result.connect = 입력 ConnectContext 전체의 깊은 복사본(링크 원문 그대로) + 이번 생성에서 계산한 값(generation).
// 원본 출처·사실·스냅샷·경험·promptBlock은 그대로 두고, 근거로 인정된 출처·사실은 generation 아래에만 둔다.
function buildConnectMeta(connectContext, connect, { topic, generationModel, ignoredInputs }) {
  const clone = (value) => JSON.parse(JSON.stringify(value == null ? null : value));
  const { generation: _previous, ...context } = clone(connectContext);
  void _previous;
  return {
    ...context,
    generation: {
      topic,
      generationModel,
      experienceProvided: !!connect.experience,
      ignoredInputs: [...ignoredInputs],
      evidenceSources: clone(connect.sources),
      evidenceFacts: clone(connect.verifiedFacts),
    },
  };
}

// ★네이버 지도 검색어 = "지역 상호명"으로만(사용자 확정 2026-08-26). 프랜차이즈 지점 구분은 사용자가 가게 이름에 지점까지 적어줌(UI 안내).
//   플레이스 조회로 얻은 공식 이름(지점명 포함) 앞에 지역(시/군)만 붙인다. 지역 못 뽑으면 상호명만.
//   ※검색용 전용 함수(홈판 generatePost는 이 함수를 호출하지 않음 → 홈판 동작 불변).
function buildMapQueries(name, addr) {
  const nm = (name || '').replace(/\s+/g, ' ').trim();
  const a = addr || '';
  const cityShort = ((a.match(/([가-힣]{2,})(?:시|군)/) || [])[1] || '').trim();   // 안성시→안성
  const out = [];
  if (cityShort && nm) out.push(cityShort + ' ' + nm);   // "안성 세컨드코너 (공도점)" ← 지역+공식이름
  if (nm) out.push(nm);                                   // 지역 못 뽑으면 상호명만(폴백)
  return out;
}

/**
 * 검색 상위노출용 글 한 편을 생성한다.
 *
 * @param {object} opts
 * @param {string} opts.topic       - 네이버 주제 키 (searchTopics.js의 key 32종 중 하나)
 * @param {string} [opts.keyword]   - 검색 키워드(글감). 비우면 클로드가 세부 키워드를 스스로 잡는다.
 * @param {string} [opts.extra]     - 추가 요청(선택)
 * @param {string} [opts.model]     - 모델 지정(선택)
 * @param {number} [opts.maxAttempts] - 규칙 위반 시 자동 재생성 최대 횟수(기본 3)
 * @returns {Promise<{ post, validation, meta, attempts }>}
 */
// ★링크 제목에서 네이버 검색용 "메인 키워드" 1개 뽑기 — 가벼운 하이쿠(토큰 절약).
async function extractMainKeyword(title, text, model, run = runClaude) {
  const system =
    '너는 네이버 검색 키워드 추출기다. 주어진 글 제목(과 앞부분)에서 "사람들이 네이버에 실제로 검색할 만한 메인 키워드" 1개만 뽑아라. 2~10글자 핵심 명사구, 사이트명·기자명·군더더기 제외. 설명·따옴표 없이 키워드만 한 줄로 출력.';
  const user = `제목: ${title || ''}\n${text ? '앞부분: ' + String(text).slice(0, 300) : ''}\n\n메인 키워드 1개만:`;
  const { text: out } = await run({ system, user, model: model || 'claude-haiku-4-5-20251001' });
  return String(out || '').trim().split('\n')[0].replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 30);
}

async function generateSearchPost({ topic, keyword, extra, style, memo, paid, commerce, source, linkNote, persona, avoidKeywords, officialFacts, review, model, maxAttempts = 3, strictEvidence = false, keywordSources, run, factCheckRun, contentCheckRun, topicContext, connectContext, collectors } = {}) {
  const searchTopic = getSearchTopic(topic); // 잘못된 주제면 여기서 예외
  const connect = summarizeConnectContext(connectContext);
  const ignoredInputs = [];
  if (connect) {
    if (connect.connectKind !== 'travel') throw new Error('제휴 연결 원고 생성은 여행(travel) 상품만 지원합니다.');
    if (!CONNECT_TRAVEL_TOPICS.includes(topic)) throw new Error('여행 제휴 연결 원고의 주제는 domestictravel 또는 worldtravel 이어야 합니다.');
    // 연결 원고의 경험은 connectContext.experience로만 받는다. 기존 메모·내돈내산·리뷰 입력은 무시하고
    // 그에 딸린 프롬프트 지시와 리뷰 수집(블로그·후기·근처 명소)도 실행하지 않는다.
    if (String(memo || '').trim()) ignoredInputs.push('memo');
    if (String(paid || '').trim()) ignoredInputs.push('paid');
    if (review != null) ignoredInputs.push('review');
    memo = '';
    paid = '';
    review = null;
  }
  const io = { ...DEFAULT_COLLECTORS, ...(collectors && typeof collectors === 'object' ? collectors : {}) };
  // 생성 모델: 호출자가 지정하면 그대로, 여행 연결 원고만 기본 opus. 검수(팩트 대조·필수 답변)는 기존 Haiku 그대로.
  const generationModel = model || (connect ? CONNECT_TRAVEL_MODEL : model);
  const connectMeta = connect ? buildConnectMeta(connectContext, connect, { topic, generationModel, ignoredInputs }) : null;
  scrapeHealth.reset(); // 이번 생성의 수집 진단만 담기게 초기화
  if (officialFacts && officialFacts.error) {
    const error = officialFacts.error;
    const kind = String(error.kind || 'collection_error');
    const code = String(error.code || '');
    const parsedStatus = Number(error.status);
    const status = Number.isFinite(parsedStatus) && parsedStatus > 0 ? parsedStatus : undefined;
    const blocked = ['blocked', 'rate_limited'].includes(kind)
      || code === 'NAVER_SEARCH_BLOCKED' || code === 'NAVER_SEARCH_RATE_LIMITED'
      || status === 403 || status === 429;
    scrapeHealth.record('official-facts', 0, {
      query: keyword,
      blocked,
      status,
      errorKind: kind,
      errorCode: code,
      resultKind: 'error',
    });
  }
  const system = connect ? buildSearchSystemPrompt(topic, { connectContext }) : buildSearchSystemPrompt(topic);
  const modelRunner = typeof run === 'function' ? run : (args) => runClaude(args);

  // ★링크형 — 키워드 없이 링크만 준 경우, 링크 제목에서 "네이버 검색용 메인 키워드" 1개를 뽑는다(가벼운 하이쿠).
  let kw = keyword;
  const initialSources = collectOriginalSources({ source, officialFacts, keywordSources });
  const canExtractKeyword = !strictEvidence || initialSources.length > 0;
  if (source && source.title && !kw && canExtractKeyword) {
    try { kw = await extractMainKeyword(source.title, source.text, model, modelRunner); } catch (e) { kw = ''; }
  }

  // 같은 검색 목적의 자동완성 후보를 모아 기획 단계에서 걸러 사용한다.
  let autocomplete = [];
  if (kw) { try { autocomplete = (await io.fetchAutocomplete(kw)) || []; } catch (e) { autocomplete = []; } }

  let serp = null;
  if (kw && !review && !source) {
    try { serp = await io.observeSerp(kw); } catch (e) { serp = { measured: false, blocked: false, reason: e.message }; }
  }

  // ★★검색 의도 파악의 핵심 = 배경 조사(홈판과 동일). "왜 이 키워드를 검색하는지"(예: 하영=증조부 친일 논란·노윤서와 그림 비교)를
  //   최신 뉴스 + 인물이면 나무위키로 가져와, 프롬프트가 실제 맥락을 알고 쓰게 한다. (엔터형=인물 배경조사)
  let keywordFacts = null, keywordBackground = null, newsArticles = null;
  // 제휴 연결 원고는 등록 상품 근거가 우선이라 일반 뉴스·배경 조사를 상품 근거로 수집하지 않는다.
  if (kw && !review && topic !== 'review' && !connect) { // ★리뷰형(장소 내돈내산 + 상품리뷰)은 내 경험·실제후기가 근거 → 뉴스·나무위키 조사 안 함(소비자원 비교표·경쟁사 점수 같은 엉뚱한 사실 유입 방지)
    try {
      const isPerson = familyOf(topic) === 'A'; // 엔터형(방송·연예·드라마·영화·스타 등) = 인물 배경조사
      const ctx = await io.gatherKeywordContext(kw, { isPerson });
      keywordFacts = ctx.keywordFacts; keywordBackground = ctx.keywordBackground;
      if (!keywordSources && Array.isArray(ctx.keywordSources)) keywordSources = ctx.keywordSources;
    } catch (e) { /* 조사 실패해도 글은 나온다 */ }
    // ★★뉴스 기사 "본문 전체"를 읽어온다 — 제목·스니펫만으론 경기 세부(라인업·챔피언·세트별)를 몰라 모델이 지어냄(치명적).
    //   실제 본문(인터뷰 발언 포함)을 넘겨야 정확히 쓴다. 스포츠·e스포츠·연예·일반뉴스 모두 대응.
    try { newsArticles = await io.fetchNewsArticles(kw, { limit: 3 }); } catch (e) { newsArticles = null; }
  }
  // ★★리뷰형에서 "방송에 나왔다"고 한 장소 → 그 방송의 "몇 회·언제 방영" 등 구체 정보를 블로그·뉴스에서 검색해 채운다.
  //   (사용자 확정: 유명인이 왔다가 아니라 "무슨 방송에 나왔다"면 검색해서 회차·방영일을 알려주면 검색용 궁금증이 해결된다.)
  if (review && Array.isArray(review.places)) {
    for (const p of review.places) {
      const tv = (p.tv || '').trim();
      if (!tv) continue;
      try {
        const q = ((p.biz || p.place || '') + ' ' + tv).trim();
        const facts = await io.fetchBlogFacts(q); // 상호명+방송명으로 블로그 검색(회차·방영일이 블로그 후기에 자주 있음)
        if (Array.isArray(facts) && facts.length) p.tvFacts = facts.slice(0, 4);
      } catch (e) { /* 실패해도 글은 나온다 */ }
    }
  }

  // ★★검색용 리뷰 Q&A용 — 그 장소의 "네이버 블로그 실제 후기"를 가져온다. Q&A는 이 실제 후기에서 "방문자들이 진짜 궁금해하고 반복적으로 언급하는 것"(웨이팅·예약·주차·아이동반·포장·재료소진·혼밥 등)을 뽑아 만든다(본문에 이미 쓴 내용 반복 금지 — 사용자 확정 2026-08-26).
  let placeReviews = [];
  if (review && Array.isArray(review.places) && review.places.length) {
    try {
      const _seenR = new Set();
      for (const p of review.places.slice(0, 3)) {
        const nm = (p.mapQuery || p.biz || p.place || '').trim();
        if (!nm) continue;
        const revs = await io.fetchPlaceReviews(nm);
        (revs || []).forEach((r) => { const t = (r || '').trim(); if (t && !_seenR.has(t)) { _seenR.add(t); placeReviews.push(t); } });
      }
      placeReviews = placeReviews.slice(0, 10);
    } catch (e) { /* 실패해도 글은 나온다 */ }
  } else if (topic === 'review' && kw) {
    // ★상품 리뷰 = 제품명으로 "실제 사용 후기"(네이버 블로그)를 가져와 스펙·사용감을 실제 후기에서 채운다(지어냄 방지 — 맛집/여행과 동일 방식).
    try {
      const revs = await io.fetchPlaceReviews(kw); // "제품명 후기"로 검색
      const _seen = new Set();
      (revs || []).forEach((r) => { const t = (r || '').trim(); if (t && !_seen.has(t)) { _seen.add(t); placeReviews.push(t); } });
      placeReviews = placeReviews.slice(0, 10);
    } catch (e) { /* 실패해도 글은 나온다 */ }
  }

  // ★근처 실제 관광지 — 맛집·여행 리뷰의 "근처 가볼만한 곳"에 진짜 명소(안성팜랜드 등)를 추천하기 위해
  //   장소의 지역(시/군)으로 네이버에서 실제 명소를 긁어온다(키·로그인 불필요). 지어내지 말고 이 목록에서만 추천하게 프롬프트가 강제.
  let nearbyAttractions = [];
  if (['restaurant', 'domestictravel'].includes(topic) && review && Array.isArray(review.places) && review.places.length) {
    try {
      // mapQuery("안성 세컨드코너")의 첫 토큰 = 지역. 지점명 등 빼고 시/군만.
      const _mq = (review.places[0].mapQuery || review.places[0].region || '').trim();
      const region = (_mq.split(/\s+/)[0] || '').replace(/(시|군|구)$/, '') || _mq.split(/\s+/)[0];
      if (region) {
        const near = await io.fetchNearbyAttractions(region);
        const bizNames = review.places.map((p) => (p.biz || p.place || '').replace(/\s+/g, ''));
        // 리뷰 대상 가게 자신은 근처추천에서 제외
        nearbyAttractions = (near || []).filter((n) => !bizNames.some((b) => b && n.replace(/\s+/g, '').includes(b))).slice(0, 5);
      }
    } catch (e) { /* 실패해도 글은 나온다 */ }
  }

  const searchBlocked = isSearchBlocked();
  if (searchBlocked) {
    const blockState = getBlockState();
    scrapeHealth.record('serp', 0, {
      query: kw,
      blocked: true,
      status: blockState.status,
      errorKind: blockState.kind,
      errorCode: blockState.code,
    });
  }
  const baseBrief = buildSearchBrief({
    keyword: kw, topic, review, source, memo, paid, style, autocomplete,
    newsArticles, keywordFacts, keywordSources, officialFacts, placeReviews,
    searchBlocked, serp, ...(connect ? { connectContext } : {}),
  });
  // 서비스 사실은 서비스 안내에 한해 원문 근거로 인정한다. 최신 이슈로 분류된 원고에는 넣지 않는다.
  const topicEvidence = topicEvidenceForIntent(topicContext && topicContext.evidenceSource, baseBrief.intent);
  const generationKeywordSources = topicEvidence.length
    ? [...(Array.isArray(keywordSources) ? keywordSources : []), ...topicEvidence]
    : keywordSources;
  const legacyOriginalSources = collectOriginalSources({ source, officialFacts, newsArticles, keywordFacts, keywordSources: generationKeywordSources });
  // 상품 근거는 전용 출처 유형으로 앞에 둔다. 기존 원문 판별은 그대로 유지된다.
  const originalSources = connect ? [...connect.sources, ...legacyOriginalSources] : legacyOriginalSources;
  const sourceMetadata = collectSourceMetadata({ source, officialFacts, newsArticles, keywordFacts, keywordSources: generationKeywordSources });
  const brief = topicEvidence.length ? buildSearchBrief({
    keyword: kw, topic, review, source, memo, paid, style, autocomplete,
    newsArticles, keywordFacts, keywordSources: generationKeywordSources, officialFacts, placeReviews,
    searchBlocked, serp, ...(connect ? { connectContext } : {}),
  }) : baseBrief;
  // 연결 원고는 근거가 부족하면 strictEvidence와 무관하게 생성 전에 보류하고 맥락을 그대로 돌려준다.
  if ((strictEvidence || connect) && brief.preHoldReasons.length) {
    const held = {
      post: null,
      status: 'hold',
      holdReasons: brief.preHoldReasons,
      reviewReasons: [],
      brief,
      contentCheck: { ran: false, items: [], missing: [], reason: '근거 사전 확인에서 보류' },
      validation: null,
      attempts: 0,
      factCheck: null,
      meta: { sources: sourceMetadata },
      scrapeHealth: scrapeHealth.report(),
    };
    if (connectMeta) held.connect = connectMeta;
    return held;
  }

  let best = null;
  const candidates = [];

  // 팩트 대조와 수집 진단을 결과에 실어 최종 상태를 계산한다.
  const _finish = async (cand) => {
    if (!cand) return cand;
    try {
      cand.factCheck = await factCheckPost({
        post: cand.post, facts: keywordFacts, articles: newsArticles,
        background: keywordBackground, placeReviews, officialFacts, originalSources,
        ...(connect ? { includeStructured: true } : {}),
        run: typeof factCheckRun === 'function' ? factCheckRun : modelRunner,
      });
    } catch (e) { cand.factCheck = { ran: false, issues: [], highCount: 0, reason: e.message }; }
    try { cand.scrapeHealth = scrapeHealth.report(); } catch (e) {}
    const status = computeSearchStatus({
      brief,
      validation: cand.validation,
      contentCheck: cand.contentCheck,
      factCheck: cand.factCheck,
    });
    cand.status = status.status;
    cand.holdReasons = status.holdReasons;
    cand.reviewReasons = status.reviewReasons;
    cand.brief = brief;
    if (connectMeta) cand.connect = connectMeta;
    return cand;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retry =
      best && !best.validation.ok
        ? {
            severe: best.validation.severe,
            missing: best.contentCheck && best.contentCheck.missing || [],
            min: brief.minChars,
          }
        : null;

    const user = buildSearchUserPrompt({ topicKey: topic, keyword: kw, extra, retry, autocomplete: brief.autocomplete.selected, style, memo, paid, commerce, source, linkNote, persona, keywordFacts, keywordBackground, keywordSources: generationKeywordSources, avoidKeywords, officialFacts, newsArticles, review, placeReviews, nearbyAttractions, originalSources, brief, topicContext, ...(connect ? { connectContext } : {}) });
    const { text, meta: generatedMeta } = await modelRunner({ system, user, model: generationModel });
    const meta = { ...(generatedMeta || {}), sources: sourceMetadata };
    // ★JSON 파싱 실패도 재시도 대상 — 마지막 시도가 아니면 다시 생성.
    let post;
    try {
      post = parseJsonLoose(text);
    } catch (e) {
      if (attempt < maxAttempts) continue;
      throw e;
    }
    // ★앱(렌더러)의 이미지 5장 보강이 "키워드+자동완성" 단계에서 쓰도록 자동완성을 post에 실어 보낸다.
    if (post) { try { post._autocomplete = (autocomplete || []).slice(0, 10); } catch (e) {} }
    // ★문장형 소제목 → 인용구(따옴표)로 강등 (사용자 확정: "리뷰 쓰면 주는 감자전, 이게 진짜 크더라고요" 같은 문장은 소제목이 아니라 "" 용).
    //   소제목은 "○○ 기본정보 / 메뉴와 맛" 같은 짧은 명사형 라벨만. 문장(쉼표 있고 길거나 서술형 종결)이면 본문 인용구로 내린다.
    if (post && Array.isArray(post.blocks)) {
      const isSentenceHeading = (t) => {
        const s = (t || '').trim();
        if (!s) return false;
        if (/기본정보$/.test(s)) return false; // "○○ 기본정보"는 라벨이므로 예외
        const long = s.length > 14;
        const hasComma = /[,，]/.test(s);
        const narrative = /(요|다|죠|네요|더라고요|더라구요|습니다|했어요|이에요|예요)$/.test(s);
        return (hasComma && long) || (narrative && long) || (hasComma && narrative);
      };
      post.blocks.forEach((b) => {
        if (b && b.kind === 'heading' && isSentenceHeading(b.text)) {
          b.kind = 'quote'; // 문장형 소제목 → 따옴표 인용구로
        }
      });
    }
    // ★★★인용구(따옴표 quote) 연속 방지 + 총 개수 상한(2~3개). (사용자 확정: ""는 2개 정도만·연달아 금지.)
    if (post && Array.isArray(post.blocks)) {
      const MAX_QUOTES = 2; // ★인용구(따옴표)는 글당 최대 2개 (사용자 확정)
      let prevQuote = false;
      let quoteCount = 0;
      post.blocks.forEach((b) => {
        if (!b) return;
        if (b.kind === 'quote') {
          if (prevQuote) { b.kind = 'text'; b.text = (b.text || '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim(); prevQuote = false; return; } // 연속 인용구 → 본문으로
          quoteCount += 1;
          if (quoteCount > MAX_QUOTES) { b.kind = 'text'; b.text = (b.text || '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim(); prevQuote = false; return; } // 개수 초과 → 본문으로
          prevQuote = true;
        } else if (b.kind === 'text' || b.kind === 'heading') {
          prevQuote = false; // 본문·소제목이 사이에 오면 리셋
        }
        // image·map·hr 은 인용구 연속 판정에 영향 안 줌
      });
    }
    // ★★비장소 주제(게임·스포츠·연예·제품·정책 등)는 map 블록 금지 — 모델이 "○○ 경기장" 같은 엉뚱한 지도를 넣는 것 방지.
    //   실제 방문 장소가 핵심인 맛집·여행에서만 map을 남긴다.
    if (post && Array.isArray(post.blocks) && !['restaurant', 'domestictravel', 'worldtravel'].includes(topic)) {
      post.blocks = post.blocks.filter((b) => !(b && b.kind === 'map'));
    }
    // ★지도 중복 제거 — 같은 가게가 여러 소제목에 나와도 지도는 "딱 1개(기본정보 하단)"만(사용자 확정 2026-08-25).
    if (post && Array.isArray(post.blocks)) {
      let _seenMap = false;
      post.blocks = post.blocks.filter((b) => {
        if (b && b.kind === 'map') { if (_seenMap) return false; _seenMap = true; }
        return true;
      });
    }
    // ★★검색용 리뷰 지도 검색어 = 사용자 입력 "지역+상호(지점)"(mapQuery)로 강제. 플레이스 조회 성공 여부와 무관하게 "항상" 적용
    //   (동네를 빼야 지도가 잘 찾음 — "안성 공도 세컨드코너"는 실패, "안성 세컨드코너"는 성공. 사용자 확정 2026-08-26).
    if (post && Array.isArray(post.blocks) && review && Array.isArray(review.places) && review.places.length) {
      const _nrm = (s) => (s || '').replace(/\s+/g, '');
      const _rps = review.places;
      post.blocks.forEach((b) => {
        if (b && b.kind === 'map' && b.place) {
          let rp = null;
          if (_rps.length === 1) rp = _rps[0];
          else rp = _rps.find((p) => p && p.biz && (_nrm(b.place).includes(_nrm(p.biz)) || _nrm(p.biz).includes(_nrm(b.place))));
          if (rp && rp.mapQuery) { b.mapCandidates = [rp.mapQuery, rp.biz].filter(Boolean); b.place = rp.mapQuery; }
        }
      });
    }
    // ★맛집/여행 = 생성된 map 블록의 "장소명"으로 네이버 플레이스 실데이터(주소·영업시간·휴무·전화)를 뽑아
    //   그 장소 소제목 뒤에 "가게정보 줄"을 끼운다(환각 0% — 없는 필드는 안 넣음, 조회 실패해도 글은 그대로).
    if (post && Array.isArray(post.blocks) && ['restaurant', 'domestictravel', 'worldtravel'].includes(topic)) {
      try {
        const names = [];
        post.blocks.forEach((b) => {
          if (b && b.kind === 'map') {
            if (b.place) names.push(b.place);
            if (Array.isArray(b.places)) b.places.forEach((p) => { const n = (p && (p.place || p.name)) || ''; if (n) names.push(n); });
          }
        });
        const uniq = [...new Set(names.map((n) => (n || '').trim()).filter(Boolean))].slice(0, 6);
        if (uniq.length) {
          const fetched = await Promise.all(uniq.map(async (nm) => {
            try { return await io.fetchPlaceInfo(nm); } catch (e) { return null; }
          }));
          const travelInfo = fetched
            .filter((info) => info && (info.roadAddress || info.address))
            .map((info) => {
              const bl = buildPlaceInfoBlocks([{ info }]);
              const textBlock = bl.find((b) => b.kind === 'text');
              return { name: info.name || '', block: textBlock, addr: (info.roadAddress || info.address || '') };
            })
            .filter((x) => x.block && x.name);
          if (travelInfo.length) {
            // ★홈판과 동일 방식(injectTravelPlaceInfo)으로 통일 — 지도는 "그 장소 기본정보 바로 뒤"(본문 중간)에,
            //   매칭 안 된 지도·정보도 반드시 "Q&A/CTA 앞"에 넣어 절대 CTA 뒤로 밀리지 않게(사용자 확정: 홈판처럼).
            //   + ★지도 검색어를 "여러 변형"으로 만들어 하나씩 시도(모델이 '안성 공도 세컨드코너 버거'처럼 너무 구체적이면 지도가 못 찾음 → 지역+공식이름 조합으로 반드시 찾게, 사용자 확정 2026-08-26).
            const _norm = (s) => (s || '').replace(/\s+/g, '');
            post.blocks.forEach((b) => {
              if (b && b.kind === 'map' && b.place) {
                const hit = travelInfo.find((x) => x.name && (_norm(x.name).includes(_norm(b.place)) || (_norm(b.place).length >= 2 && _norm(b.place).includes(_norm(x.name)))));
                if (hit) {
                  // ★위에서 이미 "지역+상호"(mapQuery)를 넣었으면 그걸 최우선으로 두고, 플레이스 공식이름 후보는 "뒤에 추가"만 한다(덮어쓰기 금지).
                  const extra = buildMapQueries(hit.name, hit.addr);
                  const cur = Array.isArray(b.mapCandidates) ? b.mapCandidates : [];
                  b.mapCandidates = [...new Set([...cur, ...extra].map((q) => (q || '').trim()).filter(Boolean))];
                  if (!cur.length) b.place = b.mapCandidates[0] || hit.name;
                }
              }
            });
            // ★검색용 리뷰: 기본정보를 "도입부 바로 다음(첫 소제목 자리)"에 고정 삽입 — [○○ 기본정보] 소제목 + 주소·영업시간 + 지도.
            //   (홈판 injectTravelPlaceInfo는 매칭 안 되면 Q&A 앞으로 밀려 위치가 들쭉날쭉 → 검색용은 고정배치. 사용자 확정 2026-08-26. 홈판 함수는 그대로 두고 검색용만 분기.)
            const _isRev = !!(review && Array.isArray(review.places) && review.places.length);
            if (_isRev) {
              // 모델이 만든 "○○ 기본정보" 소제목은 제거(중복 방지) — 앱이 아래에서 고정으로 넣는다.
              post.blocks = post.blocks.filter((b) => !(b && b.kind === 'heading' && /기본\s*정보/.test(b.text || '')));
              // 지도 블록을 장소명으로 뽑아둔다(원위치 제거 → 기본정보 바로 뒤에 재배치)
              const mapByPlace = {};
              post.blocks = post.blocks.filter((b) => { if (b && b.kind === 'map' && b.place) { mapByPlace[_norm(b.place)] = b; return false; } return true; });
              const groups = [];
              travelInfo.forEach((x) => {
                groups.push({ kind: 'heading', text: (x.name || '가게') + ' 기본정보' });
                groups.push(x.block);
                const mk = Object.keys(mapByPlace).find((k) => k && (k.includes(_norm(x.name)) || (_norm(x.name).length >= 2 && _norm(x.name).includes(k))));
                if (mk) { groups.push(mapByPlace[mk]); delete mapByPlace[mk]; }
              });
              Object.keys(mapByPlace).forEach((k) => groups.push(mapByPlace[k])); // 매칭 안 된 지도도 기본정보 뒤에
              let insAt = post.blocks.findIndex((b) => b && b.kind === 'heading'); // 도입부 다음 = 첫 소제목 앞
              if (insAt < 0) insAt = post.blocks.length;
              post.blocks = [...post.blocks.slice(0, insAt), ...groups, ...post.blocks.slice(insAt)];
            } else {
              post.blocks = injectTravelPlaceInfo(post.blocks, travelInfo);
            }
          }
        }
      } catch (e) { /* 조회 실패해도 글은 그대로 진행 */ }
    }
    // ★CTA(댓글·이웃 유도)를 맨 마지막 문단(Q&A 다음)으로 자동 주입. 모델이 commentCta를 빠뜨려도 항상 나오게 폴백(이웃추가 + 주제 맞춤 댓글).
    if (post && Array.isArray(post.blocks)) {
      let cta = (post.commentCta || '').trim();
      // ★내돈내산 리뷰 = CTA를 "전국" 범위로 넓게(지역·가게로 좁히면 이웃 유입이 안 됨). 모델이 좁게 냈거나 빠뜨렸으면 전국형으로 교체.
      const _isReview = !!(review && Array.isArray(review.places) && review.places.length);
      if (_isReview) {
        const _isTravel = review.target === 'travel';
        const _narrow = !cta || /처인구|[가-힣]+동\b|후기 계속|이 가게|이 집/.test(cta) || (!/전국/.test(cta) && /맛집|여행|카페|후기/.test(cta) && cta.length < 40);
        if (_narrow) {
          const rpool = _isTravel
            ? ['전국 내돈내산 여행지가 궁금하시다면 이웃추가 꼭 해주세요~!!', '전국 여행·숙소 솔직후기 계속 올릴게요, 이웃추가 환영이에요~!!']
            : ['전국 내돈내산 맛집이 궁금하시다면 이웃추가 꼭 해주세요~!!', '전국 맛집·카페 솔직후기 계속 올릴게요, 이웃추가 환영이에요~!!'];
          cta = rpool[Math.floor(Math.random() * rpool.length)];
        }
      }
      if (!cta) {
        // ★모델이 빠뜨렸을 때 폴백 — 매번 같은 문구 반복 안 되게 여러 톤 중 랜덤(이웃추가/공유/의견/공감/응원).
        const topic = (kw || (post.title || '')).trim();
        const t = topic ? `'${topic}'` : '이 주제';
        const pool = [
          `도움이 되셨다면 이웃추가 해두세요. ${t} 관련 새 소식이 생기면 정리해서 올릴게요.`,
          `도움이 되셨다면 주변에도 공유해 주세요. ${t}에 대한 궁금한 점은 댓글로 남겨주세요.`,
          `여러분은 ${t}에 대해 어떻게 생각하시나요? 댓글로 의견 남겨 주세요.`,
          `오늘 정리가 어떠셨나요? 공감 눌러주시면 더 좋은 정보로 찾아올게요.`,
          `${t} 준비하신다면 댓글로 경험을 나눠주세요. 함께 정리해볼게요.`,
        ];
        cta = pool[Math.floor(Math.random() * pool.length)];
      }
      post.blocks = appendCtaBlock(post.blocks, cta);
    }
    const validation = validateSearchPost(post, searchTopic, brief, {
      keyword: kw,
      experienceInput: brief.evidence.experienceInput,
    });
    let contentCheck = { ran: false, items: [], missing: [], reason: '형식 검사에서 심각한 문제가 있어 생략' };
    if (!validation.severe.length) {
      contentCheck = await checkRequiredAnswers({ post, brief, run: typeof contentCheckRun === 'function' ? contentCheckRun : modelRunner });
      if (contentCheck.missing.length) {
        const labels = contentCheck.missing.map((item) => item.label).join(', ');
        validation.severe.push(`필수 답변 누락: ${labels}`);
        validation.issues = validation.severe.concat(validation.warnings);
        validation.ok = false;
      }
    }

    const candidate = { post, validation, contentCheck, meta, attempts: attempt };
    candidates.push(candidate);
    best = pickBestCandidate(candidates);
    if (!validation.severe.length && !contentCheck.missing.length) return await _finish(candidate);
    best.attempts = attempt;
  }

  return await _finish(best);
}

/** 블록 하나의 "본문 글자수"를 센다. 표·Q&A도 실제 텍스트를 합산. */
function blockTextLength(b) {
  if (!b) return 0;
  switch (b.kind) {
    case 'text':
    case 'heading':
    case 'quote':
      return (b.text || '').length;
    case 'qna':
      return (b.question || '').length + (b.answer || '').length;
    case 'table': {
      const cells = [...(b.columns || []), ...((b.rows || []).flat())];
      return cells.join('').length;
    }
    default:
      return 0; // image, hr, map 은 본문 글자수에 안 셈
  }
}

/**
 * 검색용 원고의 구조·분량·직접 경험 표현을 검사한다.
 */
function validateSearchPost(post, searchTopic, brief, ctx = {}) {
  const issues = [];
  const severe = [];
  const warnings = [];
  const blocks = Array.isArray(post && post.blocks) ? post.blocks : [];
  const minChars = Number(brief && brief.minChars) || 1000;
  const minHeadings = Number(brief && brief.minHeadings) || 3;
  const targetMax = Number(brief && Array.isArray(brief.targetChars) && brief.targetChars[1]) || 2200;
  const keyword = String(ctx.keyword || '').trim();

  const quoteCount = blocks.filter((b) => b && b.kind === 'quote').length;
  if (quoteCount > MAX_QUOTES) severe.push(`인용구 ${quoteCount}개 — 최대 ${MAX_QUOTES}개 초과.`);

  const headingCount = blocks.filter((b) => b && b.kind === 'heading').length;
  if (headingCount < minHeadings) severe.push(`소제목 ${headingCount}개 — 최소 ${minHeadings}개 미달.`);

  const bodyLen = blocks.reduce((sum, block) => sum + blockTextLength(block), 0);
  if (bodyLen < minChars) severe.push(`본문 ${bodyLen}자 — 최소 ${minChars}자 미달.`);
  if (bodyLen > targetMax * 1.6) warnings.push('불필요하게 긴 원고일 수 있음');

  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock && lastBlock.kind === 'heading') severe.push('마지막 블록이 소제목 — 미완성/잘림 의심.');
  if (blocks.some((block) => block && block.kind === 'text' && !String(block.text || '').trim())) {
    severe.push('빈 본문(text) 블록 있음 — 미완성/잘림 의심.');
  }
  let bareHeadings = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i] || blocks[i].kind !== 'heading') continue;
    let hasText = false;
    for (let j = i + 1; j < blocks.length && blocks[j] && blocks[j].kind !== 'heading'; j++) {
      if (blocks[j].kind === 'text' && String(blocks[j].text || '').trim().length >= 15) {
        hasText = true;
        break;
      }
    }
    if (!hasText) bareHeadings++;
  }
  if (bareHeadings) severe.push(`내용 없는 빈 소제목 ${bareHeadings}개 — 소제목만 있고 문단이 없음.`);

  if (!String(post && post.description || '').trim()) {
    severe.push('디스크립션(description)이 비어 있음.');
  }

  if (keyword) {
    const titleNormalized = String(post && post.title || '').replace(/\s+/g, '').toLocaleLowerCase();
    const keywordNormalized = keyword.replace(/\s+/g, '').toLocaleLowerCase();
    const allKeywordPartsPresent = keyword.split(/\s+/).filter(Boolean)
      .every((part) => titleNormalized.includes(part.replace(/\s+/g, '').toLocaleLowerCase()));
    if (!titleNormalized.includes(keywordNormalized) && !allKeywordPartsPresent) {
      severe.push(`제목에 메인 키워드 "${keyword}"가 없음.`);
    }
  }

  if (ctx.experienceInput === false) {
    const claims = detectExperienceClaims(post);
    if (claims.length) severe.push(`직접 경험 근거 없는 1인칭 경험 표현 ${claims.length}건`);
  }

  const count = (kind) => blocks.filter((block) => block && block.kind === kind).length;
  issues.push(...severe, ...warnings);
  return {
    ok: severe.length === 0,
    issues,
    severe,
    warnings,
    quoteCount,
    headingCount,
    imageCount: count('image'),
    tableCount: count('table'),
    mapCount: count('map'),
    qnaCount: count('qna'),
    bodyLength: bodyLen,
    minLength: minChars,
    intent: brief && brief.intent || 'general',
    topic: searchTopic && searchTopic.label || '',
  };
}

function candidateScore(candidate) {
  const validation = candidate && candidate.validation || {};
  const contentCheck = candidate && candidate.contentCheck || {};
  const severeCount = Array.isArray(validation.severe) ? validation.severe.length : 0;
  const missingCount = Array.isArray(contentCheck.missing) ? contentCheck.missing.length : 0;
  const warningCount = Array.isArray(validation.warnings) ? validation.warnings.length : 0;
  return severeCount * 100 + missingCount * 10 + warningCount;
}

function pickBestCandidate(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  return candidates.reduce((best, candidate) => candidateScore(candidate) < candidateScore(best) ? candidate : best);
}

function computeSearchStatus({ brief, validation, contentCheck, factCheck } = {}) {
  const holdReasons = [];
  const reviewReasons = [];
  const severe = Array.isArray(validation && validation.severe) ? validation.severe : [];
  const warnings = Array.isArray(validation && validation.warnings) ? validation.warnings : [];
  const missing = Array.isArray(contentCheck && contentCheck.missing) ? contentCheck.missing : [];

  if (brief && Array.isArray(brief.preHoldReasons)) holdReasons.push(...brief.preHoldReasons);
  if (severe.some((issue) => /직접 경험 근거 없는 1인칭 경험 표현/.test(issue))) {
    holdReasons.push(severe.find((issue) => /직접 경험 근거 없는 1인칭 경험 표현/.test(issue)));
  }
  if (Number(factCheck && factCheck.highCount) >= 1) {
    holdReasons.push(`중요 사실 근거 확인 필요 ${Number(factCheck.highCount)}건`);
  }
  reviewReasons.push(...severe);
  if (missing.length) reviewReasons.push(`필수 답변 누락: ${missing.map((item) => item.label || item.id).join(', ')}`);
  if (!contentCheck || contentCheck.ran === false) reviewReasons.push('필수 답변 내용 검사를 완료하지 못함');
  if (!factCheck || factCheck.ran === false) reviewReasons.push('근거 대조를 완료하지 못함');
  else if (Array.isArray(factCheck.issues) && factCheck.issues.length) reviewReasons.push(`사실 확인 항목 ${factCheck.issues.length}건 검토 필요`);
  reviewReasons.push(...warnings);
  if (brief && brief.ambiguous) reviewReasons.push('검색 의도가 불명확함');
  if (brief && Array.isArray(brief.warnings)) reviewReasons.push(...brief.warnings);

  const uniqueReviewReasons = [...new Set(reviewReasons)];
  if (holdReasons.length) return { status: 'hold', holdReasons, reviewReasons: uniqueReviewReasons };
  return uniqueReviewReasons.length
    ? { status: 'review', holdReasons: [], reviewReasons: uniqueReviewReasons }
    : { status: 'ready', holdReasons: [], reviewReasons: [] };
}

module.exports = {
  generateSearchPost,
  validateSearchPost,
  pickBestCandidate,
  computeSearchStatus,
};
