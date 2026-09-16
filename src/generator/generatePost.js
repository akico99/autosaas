// 글 생성 엔진 — 홈판 노출용 글 한 편을 만든다.
//
// AI 비용 모델(결정됨, 2026-07-06 최종): 앤트로피 API 키 사용 금지.
// 생성은 runClaude()가 사용자의 클로드 구독 로그인으로 처리한다(배포자 비용 0원).

const { runClaude } = require('./runClaude');
const { checkHomefeedWords } = require('./homefeedWords');
const { getPostType, MAX_QUOTES } = require('./postTypes');
const { buildSystemPrompt, buildUserPrompt, buildTitleRefinePrompt, TITLE_REFINE_SYSTEM } = require('./buildPrompt');
const { fetchRealtimeTrends, fetchNewsHeadlines, fetchBlogFacts, fetchPlaceReviews, fetchTopTitles } = require('../keyword/trends');
const { fetchAutocomplete } = require('../keyword/expand');
const { findNicheAngles } = require('../keyword/niche');
const { fetchNamuBackground } = require('../keyword/background');
const { lookupPlace, fetchPlaceInfo } = require('../place/placeLookup');

// ★인물형(연예·스포츠) = "배경(과거 이력) + 최근 이슈"를 함께 자동 조사하는 유형.
const PERSON_TYPES = ['celebrity', 'sportsnews'];
// 인물 배경(과거 이력)을 캐는 검색 모디파이어. 코어 이름 뒤에 붙여 뉴스 검색한다.
//   (검증: "고현정 이혼"→재벌혼·위자료, "고현정 프로필"→생년·소속사 등 과거 사실이 실제로 나옴)
const BACKGROUND_MODIFIERS = ['프로필', '과거', '데뷔', '결혼', '이혼', '열애'];
// 키워드에서 수식어를 떼어 "핵심 인물/대상"만 남긴다("고현정 근황"→"고현정").
const KW_MODIFIERS = ['근황', '화보', '결혼', '이혼', '열애', '연인', '여자친구', '남자친구', '다이어트', '감량', '나이', '키', '프로필', '사망', '별세', '논란', '복귀', '재혼', '인스타', '과거', '리즈', '자녀', '몸매', '스캔들', '열애설', '이적설'];
function coreEntity(kw) {
  const parts = (kw || '').trim().split(/\s+/);
  while (parts.length > 1 && KW_MODIFIERS.includes(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

// ★뉴스 검색용 키워드 변형 — "티원"(한글)처럼 쓴 팀/브랜드가 기사엔 "T1"로 나와 최신 뉴스를 못 찾는 문제 해결.
//   한↔영 흔한 e스포츠·브랜드 치환 + 여러 단어면 각 단어 단독(각 주체의 오늘 기사 확보).
const NEWS_TERM_MAP = {
  '티원': 'T1', '티1': 'T1', '젠지': 'Gen.G', '디플러스기아': 'DK', '디플러스': 'DK',
  '케이티롤스터': 'KT', '광동프릭스': '광동', '피어엑스': 'FearX', '비엘지': 'BLG', '농심': '농심 레드포스',
};
function newsQueryVariants(keyword) {
  const kw = (keyword || '').trim();
  const out = new Set([kw]);
  for (const [ko, en] of Object.entries(NEWS_TERM_MAP)) {
    if (kw.includes(ko)) out.add(kw.split(ko).join(en));
    if (kw.includes(en)) out.add(kw.split(en).join(ko));
  }
  // 여러 단어(공백)면 각 단어 단독도 검색 — "한화생명 티원"이면 "한화생명"·"티원"(→"T1") 각각의 오늘 기사가 잡힌다.
  const toks = kw.split(/\s+/).filter((t) => t.length >= 2);
  if (toks.length >= 2) toks.forEach((t) => { out.add(t); if (NEWS_TERM_MAP[t]) out.add(NEWS_TERM_MAP[t]); });
  return [...out].filter(Boolean);
}

/**
 * 홈판 노출용 글 한 편을 생성한다.
 *
 * @param {object} opts
 * @param {string} opts.type      - 유형 키 (celebrity, restaurant, ... 12종 중 하나)
 * @param {string} [opts.keyword] - 글감 키워드. 비우면 클로드가 이슈에서 자동으로 잡는다.
 * @param {string} [opts.extra]   - 추가 요청사항(선택)
 * @param {string} [opts.model]       - 모델 지정(선택). 비우면 로그인 계정 기본 모델.
 * @param {number} [opts.maxAttempts] - 규칙 위반 시 자동 재생성 최대 횟수(기본 3).
 * @returns {Promise<{ post, validation, meta, attempts }>}
 */
async function generatePost({ type, keyword, extra, tone, style, persona, fan, places, reviews, coupangLinks, reviewInfo, reviewOpts, trends, extraTrends, avoidKeywords, headingTarget, cardMode, contentForm, model, maxAttempts = 3 } = {}) {
  const postType = getPostType(type); // 잘못된 유형이면 여기서 예외
  const system = buildSystemPrompt(type, { tone });
  const _tGenStart = Date.now(); // ★[타이밍] 생성 속도 진단
  const _tlog = (m) => { try { console.log('[TIMING] ' + m + '  (+' + Math.round((Date.now() - _tGenStart) / 1000) + 's)'); } catch (e) {} };

  // ★맛집 후기 — 넘어온 리뷰(별점·메뉴·장단점)에 "실제 가게 정보"를 붙인다(환각 방지).
  //   조회가 막히면 info=null → 사용자 입력만으로 진행(글은 그대로 정확).
  let reviewList = Array.isArray(reviews) ? reviews.filter((r) => r && r.place) : [];
  if (reviewList.length) {
    reviewList = await Promise.all(
      reviewList.map(async (r) => {
        try { return { ...r, info: await fetchPlaceInfo(r.place) }; }
        catch (e) { return { ...r, info: null }; }
      }),
    );
  }

  // ★지도 검색 정확도용 — 장소명→"지역(시)" 저장(프랜차이즈 오지점 방지: "미식회관"만이 아니라 "용인 미식회관"으로 검색).
  const _placeRegions = {};
  const _regionOf = (addr) => {
    if (!addr) return '';
    const m = String(addr).match(/([가-힣]+시)\s+[가-힣]+구/) || String(addr).match(/([가-힣]+(?:시|군|구))/);
    return m ? m[1].replace(/시$/, '') : '';
  };
  reviewList.forEach((r) => { if (r && r.place && r.info) { const rg = _regionOf(r.info.roadAddress || r.info.address); if (rg) _placeRegions[r.place] = rg; } });

  // ★여행 = 이제 "한 곳"만(사용자 확정) → 맛집과 동일하게 "○○ 정보" 소제목 + 기본정보 블록을 서론 뒤에 고정한다.
  //   (예전 다중장소 방식[injectTravelPlaceInfo]은 소제목을 일부러 빼고 장소명 매칭에 의존해, 매칭 실패 시 기본정보가 맨 아래로 갔음.)
  let travelReviewList = [];
  if (type === 'travel' && reviewOpts && Array.isArray(reviewOpts.placeDetails) && reviewOpts.placeDetails.length) {
    const fetched = await Promise.all(reviewOpts.placeDetails.slice(0, 6).map(async (d) => {
      try { return { place: d.place, menu: d.menu || '', info: await fetchPlaceInfo(d.place) }; } catch (e) { return null; }
    }));
    travelReviewList = fetched.filter((x) => x && x.info && (x.info.roadAddress || x.info.address));
    travelReviewList.forEach((r) => { const rg = _regionOf(r.info.roadAddress || r.info.address); if (rg) { if (r.info.name) _placeRegions[r.info.name] = rg; if (r.place) _placeRegions[r.place] = rg; } });
  }

  // ★자동 모드(키워드 없음) = 실시간 트렌드 씨앗을 가져와 Claude가 유형에 맞는 걸 고르게.
  //   호출측이 trends를 주면 그걸 쓰고, 없으면 여기서 수집(장애 시 빈 배열 → Claude 자가선택 폴백).
  let trendList = Array.isArray(trends) ? trends : null;
  if (!keyword && !trendList) {
    try { trendList = await fetchRealtimeTrends(); } catch (e) { trendList = []; }
  }
  // ★엔터/스포츠 랭킹(웹뷰 스크랩) 병합 — 연예·스포츠 유형에 정합적인 씨앗.
  if (!keyword && Array.isArray(extraTrends) && extraTrends.length && trendList) {
    const norm = (s) => (s || '').replace(/\s+/g, '').replace(/[^가-힣a-zA-Z0-9]/g, '');
    const seen = new Set(trendList.map((t) => norm(t.keyword)));
    const add = extraTrends.filter((t) => t && t.keyword && !seen.has(norm(t.keyword)));
    trendList = [...add, ...trendList];
  }

  // ★유형에 맞는 소스를 "앞으로" surface — 연예 유형인데 경제 이슈가 앞에 오면 Claude가 연예를 못 고른다.
  //   그리고 헤드라인 소스(엔터·스포츠·뉴스)는 키워드 자체가 실제 기사 = 사실이므로 facts로 표시.
  if (!keyword && trendList && trendList.length) {
    trendList.forEach((t) => {
      if (['naver-ent', 'naver-sports', 'naver-news'].includes(t.source) && (!t.facts || !t.facts.length)) {
        t.facts = [t.keyword]; // 헤드라인 = 사실
      }
    });
    const TYPE_SOURCES = { celebrity: ['naver-ent'], sports: ['naver-sports'] };
    const pref = TYPE_SOURCES[type] || [];
    if (pref.length) {
      const head = trendList.filter((t) => pref.includes(t.source));
      const tail = trendList.filter((t) => !pref.includes(t.source));
      if (head.length) trendList = [...head, ...tail];
    }
  }

  // ★수동 키워드 재료(다양한 소스 조합 = "우리화"의 핵심, 단일 기사 요약 방지):
  //   - keywordAngles = 자동완성 롱테일(사람들이 실제 함께 찾는 것) → 본문이 다뤄야 할 독자 의도 각도.
  //   - keywordFacts  = 키워드 + 상위 롱테일 여러 각도로 뉴스를 "여러 번" 검색해 모은 다양한 기사 제목(중복 제거).
  let keywordFacts = null, keywordAngles = null, nicheAngles = null, keywordBackground = null;
  // ★리뷰 유형 = 뉴스·인물 조사 안 함(내 경험 기반). 장소면 실제 리뷰만 참고로 긁는다(아래).
  if (keyword && type !== 'review') {
    const core = coreEntity(keyword);            // "고현정 근황" → "고현정"
    const isPerson = PERSON_TYPES.includes(type); // 연예·스포츠 = 인물(배경 조사 대상)
    // ★자동완성: 원 키워드 + 코어 이름 둘 다 확장(코어가 롱테일 훨씬 풍부: 이혼·자녀·리즈 등).
    const [acKw, acCore] = await Promise.all([
      fetchAutocomplete(keyword).catch(() => []),
      core && core !== keyword ? fetchAutocomplete(core).catch(() => []) : Promise.resolve([]),
    ]);
    const aSeen = new Set();
    keywordAngles = [...(acKw || []), ...(acCore || [])]
      .filter((a) => a && a !== keyword && a !== core && !aSeen.has(a) && aSeen.add(a))
      .slice(0, 12);
    // ★틈새 발견 — 자동완성+인텐트 조합을 "빈틈(경쟁 낮음)" 점수로 골라 선점 각도를 찾는다.
    try {
      const niche = await findNicheAngles(keyword, { type, limit: 5 });
      nicheAngles = (niche || []).filter((n) => n && n.gap >= 30).map((n) => `${n.keyword} (빈틈 ${n.gap})`);
    } catch (e) { nicheAngles = null; }
    const seen = new Set();
    const collect = (groups, max) => {
      const out = [];
      for (const arr of groups) for (const h of arr || []) {
        const k = (h || '').trim();
        if (k && !seen.has(k)) { seen.add(k); out.push(k); if (out.length >= max) return out; }
      }
      return out;
    };
    // ★① 최근 이슈(왜 떴는지) = 키워드 + 상위 롱테일로 최신 뉴스. 먼저 모은다(동명이인 판별 문맥으로도 씀).
    // ★자료 풍부하게 — 각도 더 넓게(5개) + 팩트 더 많이(24개) 수집해 모델이 쓸 재료를 넉넉히 준다(→ 1500자+ 술술).
    const recentQ = [keyword, ...keywordAngles.slice(0, 5)];
    const recentArr = await Promise.all(recentQ.map((q) => fetchNewsHeadlines(q).catch(() => [])));
    keywordFacts = collect(recentArr, 24);
    // ★② 인물 배경(과거 이력) = 나무위키 1순위. 최신 뉴스를 "문맥"으로 넘겨 동명이인 판별.
    //   ★직업어(배우·가수 등)를 앞에 붙이면 나무위키가 못 찾는다("배우 하영" 실패 → "하영" 성공). 이름만으로 조회.
    const personName = String(core).replace(/^(배우|가수|감독|모델|개그맨|개그우먼|아나운서|방송인|유튜버|트로트\s*가수|인플루언서|셀럽|프로게이머|코미디언)\s+/, '').trim() || core;
    let bg = [];
    if (isPerson && core) {
      bg = await fetchNamuBackground(personName, { limit: 20, context: keywordFacts, hints: keywordAngles }).catch(() => []); // ★배경 더 풍부하게(12→20)
      // 나무위키가 비었으면(차단·동명이인 판별 실패) 뉴스 배경검색으로 폴백(뉴스는 실제 화제 인물 기준이라 안전).
      if (bg.length < 6) {
        const bgQ = [core, ...BACKGROUND_MODIFIERS.map((m) => `${core} ${m}`)];
        const bgArr = await Promise.all(bgQ.map((q) => fetchNewsHeadlines(q).catch(() => [])));
        bg = collect(bgArr, 16); // recentFacts와 중복 제거됨 (10→16)
      }
    }
    keywordBackground = bg.length ? bg : null;
  }

  // ★C(제작 재료) — 짧은 인물/엔티티 트렌드에 자동완성 각도 + 실제 뉴스(팩트)를 붙인다.
  //   줌은 이미 질문·뉴스(facts)가 있으니, 질문 없는 짧은 엔티티(signal/네이트/구글)를 우선 확장·팩트화.
  if (trendList && trendList.length) {
    const toExpand = trendList
      .filter((t) => t.keyword && t.keyword.length <= 10 && t.source !== 'naver-news' && !t.question)
      .slice(0, 8);
    await Promise.all(
      toExpand.map(async (t) => {
        try {
          const [ac, news] = await Promise.all([
            fetchAutocomplete(t.keyword),
            fetchNewsHeadlines(t.keyword), // 실제 사실
          ]);
          t.angles = (ac || []).filter((a) => a && a !== t.keyword).slice(0, 5);
          if (news && news.length) t.facts = news.slice(0, 5);
        } catch (e) { /* 재료 없어도 진행 */ }
      }),
    );
  }

  // ★후기 참고(네이버 블로그 검색) — 맛집·여행=장소명 / 쿠파스=제품명으로 실제 후기를 읽어 "강점·용도·불만"을 파악한다.
  //   ★그대로 베끼지 않고(원본 작성) 이해용. 쿠팡/커머스 API는 막혀서 못 읽으므로, 안 막히는 블로그 검색으로 우회.
  let placeReviews = null;
  try {
    const queries = [];
    if (type === 'restaurant' && reviewList.length) {
      queries.push(reviewList[0].place);
    } else if (type === 'travel' && reviewOpts && Array.isArray(reviewOpts.placeDetails)) {
      // ★여행 = 장소마다 후기를 각각 긁어온다(부실한 장소 내용 보강용). place=검색어.
      reviewOpts.placeDetails.forEach((d) => { if (d && d.place) queries.push(d.place); });
    } else if (type === 'coupang') {
      const links = Array.isArray(coupangLinks) ? coupangLinks : [];
      links.forEach((c) => {
        if (c && c.label) { queries.push(c.label); return; }
        try { const q = new URL(c.url).searchParams.get('q'); if (q) queries.push(q); } catch (e) {}
      });
    } else if (type === 'celebrity') {
      // ★연예·영화·방송 = "실제 반응/후기/기대평"을 네이버 블로그에서 검색해 근거로(허수 금지). 개봉전이면 기대평이 잡힘.
      const core = coreEntity(keyword) || keyword;
      queries.push(core + ' 반응', core + ' 후기', core + ' 기대평');
    } else if (type === 'car') {
      // ★자동차도 실제 반응(허수 금지) — 반응·후기·시승기 검색해 근거로.
      const core = coreEntity(keyword) || keyword;
      queries.push(core + ' 반응', core + ' 후기', core + ' 시승기');
    }
    // ★여행은 장소가 여러 개 → 최대 6곳까지 각각 검색(그 외 유형은 3개).
    const qCap = (type === 'travel') ? 6 : 3;
    const uniq = [...new Set(queries.filter(Boolean))].slice(0, qCap);
    if (uniq.length) {
      const all = [];
      for (const q of uniq) {
        const r = await fetchPlaceReviews(q).catch(() => null);
        if (r && r.length) {
          if (uniq.length > 1) r.slice(0, 4).forEach((s) => all.push(`[${q}] ${s}`)); // 장소/제품별 라벨(어느 곳 후기인지)
          else r.forEach((s) => all.push(s));
        }
      }
      if (all.length) placeReviews = all.slice(0, type === 'travel' ? 24 : 12); // 여행은 장소 많으니 넉넉히
    }
  } catch (e) { placeReviews = null; }

  // ★제목 참고 — 이 주제로 "지금 네이버 상단에 뜬 실제 제목들"을 긁어 제목 감을 준다(리뷰형 제외, 그대로 베끼지 않게 프롬프트에서 강제).
  let refTitles = null;
  if (type !== 'review') {
    const titleSeed = (keyword && keyword.trim()) || (trendList && trendList[0] && trendList[0].keyword) || '';
    if (titleSeed) {
      try { refTitles = await fetchTopTitles(titleSeed); } catch (e) { refTitles = null; }
      if (refTitles && !refTitles.length) refTitles = null;
    }
  }

  let best = null; // 전부 실패해도 그나마 가장 긴 결과를 반환

  _tlog('리서치 완료 → 생성 시작');
  _tlog('  ▶모은 팩트(최신뉴스): ' + ((keywordFacts || []).slice(0, 10).join('  |  ') || '(없음)'));
  _tlog('  ▶모은 배경: ' + ((keywordBackground || []).slice(0, 6).join('  |  ') || '(없음)'));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 재시도부터는 직전 실패 이유(특히 길이 부족)를 프롬프트에 붙인다.
    const retry =
      best && !best.validation.ok
        ? {
            issues: best.validation.issues,
            prevLength: best.validation.bodyLength,
            min: postType.length.min,
          }
        : null;

    const user = buildUserPrompt({ keyword, keywordFacts, keywordBackground, keywordAngles, nicheAngles, extra, style, persona, fan, places, reviews: reviewList, coupangLinks, reviewInfo, reviewOpts, placeReviews, refTitles, retry, trends: trendList, typeLabel: postType.label, avoidKeywords, headingTarget, cardMode, contentForm });
    const _tq = Date.now();
    const { text, meta } = await runClaude({ system, user, model });
    _tlog('★runClaude 생성 attempt' + attempt + ' = ' + Math.round((Date.now() - _tq) / 1000) + 's');
    // ★JSON 파싱 실패(모델이 가끔 순수 JSON 아닌 걸 뱉음)도 "재시도" 대상 — 마지막 시도가 아니면 다시 생성한다.
    let post;
    try {
      post = parseJsonLoose(text);
    } catch (e) {
      _tlog('★JSON 파싱 실패 attempt' + attempt + ' → 재시도: ' + e.message);
      if (attempt < maxAttempts) continue;
      throw e;
    }
    // ★제목은 "한 줄"만. 모델이 제목에 \n(두 줄)을 넣으면 에디터 붙여넣기 때 줄바꿈이 사라져 "…솔직후기장바구니에…"처럼 두 문장이 붙는다. 첫 줄만 쓴다.
    if (post && post.title) post.title = String(post.title).split(/\n/)[0].trim();
    if (post && Array.isArray(post.blocks)) {
      post.blocks = sanitizeBlocks(post.blocks);
      // ★지도 중복 제거 — 같은 가게가 여러 소제목에 나와도 지도는 "딱 1개(기본정보 하단)"만 남긴다(사용자 확정 2026-08-25).
      {
        let _seenMap = false;
        post.blocks = post.blocks.filter((b) => {
          if (b && b.kind === 'map') { if (_seenMap) return false; _seenMap = true; }
          return true;
        });
      }
      // ★가게정보 정리블록 = 네이버 플레이스 실데이터로 "코드가 직접" 조립해 주입(환각 0%). 없는 필드는 안 넣음.
      //   맛집=reviewList / 여행=travelReviewList(한 곳). 둘 다 "○○ 정보" 소제목 + 기본정보 블록을 서론 뒤에 고정(injectPlaceInfo).
      const infoBlocks = buildPlaceInfoBlocks(type === 'travel' ? travelReviewList : reviewList);
      if (infoBlocks.length) post.blocks = injectPlaceInfo(post.blocks, infoBlocks);
      // ★★지도(map)를 "기본정보 블록 바로 뒤"로 이동(사용자 확정 2026-08-27: 지도는 기본정보 하단, 못 찾으면 맨 끝). 한 곳이라 map 1개.
      {
        const mapIdx = post.blocks.findIndex((b) => b && b.kind === 'map');
        if (mapIdx >= 0) {
          const mapBlk = post.blocks.splice(mapIdx, 1)[0];
          // ★지도 검색어에 지역 붙이기(프랜차이즈 오지점 방지) — 후보 없으면 "지역 상호"를 먼저 시도.
          if (mapBlk && !(Array.isArray(mapBlk.mapCandidates) && mapBlk.mapCandidates.length)) {
            const _mp = (mapBlk.place || '').trim();
            let _reg = _placeRegions[_mp] || '';
            if (!_reg) { const _k = Object.keys(_placeRegions).find((k) => k && (_mp.includes(k) || k.includes(_mp))); if (_k) _reg = _placeRegions[_k]; }
            if (_reg && _mp && !_mp.startsWith(_reg)) mapBlk.mapCandidates = [`${_reg} ${_mp}`, _mp];
          }
          let infoIdx = post.blocks.findIndex((b) => b && b._placeInfo);
          if (infoIdx < 0) infoIdx = post.blocks.findIndex((b) => b && b.kind === 'text' && /📍\s*주소|영업시간/.test(b.text || ''));
          if (infoIdx >= 0) post.blocks.splice(infoIdx + 1, 0, mapBlk); // 기본정보 바로 뒤
          else post.blocks.push(mapBlk); // 못 찾으면 맨 끝
        }
      }
      // ★CTA(댓글·이웃 유도)를 마지막 문단으로 자동 주입.
      // ★내돈내산(내 사진) 후기 = CTA를 "전국"으로 넓게. 모델이 지역·가게로 좁게 냈으면 전국형으로 교체(이웃 유입 손해 방지).
      let _cta = (post.commentCta || '').trim();
      {
        // ★커머스(쿠파스)는 "장소 후기"가 아니다 → 맛집/카페 CTA로 바꾸면 안 됨(섬유탈취제 글에 "전국 내돈내산 맛집" 붙던 버그). 제외.
        const _isPlaceReview = type !== 'coupang' && ((Array.isArray(reviewList) && reviewList.some((r) => r && r.place)) || (reviewOpts && Array.isArray(reviewOpts.placeDetails) && reviewOpts.placeDetails.length) || /내돈내산/.test(style || ''));
        if (_isPlaceReview) {
          const _narrow = !_cta || /처인구|[가-힣]{2,}(시|구|동|읍|면)\s|후기 계속|이 가게|이 집/.test(_cta) || (!/전국/.test(_cta) && /맛집|여행|카페|후기/.test(_cta) && _cta.length < 40);
          if (_narrow) {
            const _isTravelReview = /여행|여행지|숙소|펜션|호텔|리조트|관광/.test(String(keyword || '') + ' ' + String(style || ''));
            const _rpool = _isTravelReview
              ? ['전국 내돈내산 여행지가 궁금하시다면 이웃추가 꼭 해주세요~!!', '전국 여행·숙소 솔직후기 계속 올릴게요, 이웃추가 환영이에요~!!']
              : ['전국 내돈내산 맛집이 궁금하시다면 이웃추가 꼭 해주세요~!!', '전국 맛집·카페 솔직후기 계속 올릴게요, 이웃추가 환영이에요~!!'];
            _cta = _rpool[Math.floor(Math.random() * _rpool.length)];
          }
        }
      }
      post.blocks = appendCtaBlock(post.blocks, _cta);
      // ★커머스·제휴형(쿠팡): 제휴 고지문이 본문 중간·끝에 여러 번 나오는 문제 → 다 제거하고 "맨 마지막(CTA보다도 뒤)에 딱 1번"만.
      if (postType.links === 'affiliate') post.blocks = normalizeAffiliateDisclosure(post.blocks);
    }
    const validation = validatePost(post, postType);
    const candidate = { post, validation, meta, attempts: attempt, trends: trendList || [] };
    // ★★프로 요금제 = 호출 아껴야 함(글당 최소화, 300개/월). "완성된 글"이면 분량·소제목이 살짝 미달이어도
    //   재생성하지 않고 채택한다. 재생성은 "잘림/미완성"(truncation·빈 본문·빈 소제목) 같은 치명적 문제일 때만.
    //   치명적 = ①잘림/미완성(빈 본문·빈 소제목·마지막이 소제목) ②소제목 4개 미만(구조 깨짐) ③분량이 최소(1500자) 미달.
    //   ★사용자 확정: 공백제외 1500자는 "무조건 최소" — 미달이면 무조건 재생성(관용 없음). 완성·구조 정상이면 채택.
    const _severe =
      (validation.issues || []).some((s) => /미완성|잘림|빈\s*본문|빈\s*소제목|소제목\s*\d+개\s*—\s*최소\s*4개/.test(s)) ||
      validation.bodyLength < postType.length.min; // 1500자 하드 플로어
    _tlog('attempt' + attempt + ' 검증 ' + (validation.ok ? 'OK ✓' : (_severe ? '치명적→재생성' : '경미(채택)') + ' 사유:' + (validation.issues || []).join(' / ')));
    if (validation.ok || !_severe) return await finalizeTitle(candidate, { type, keyword, keywordFacts, refTitles, model }); // 통과 또는 완성글(경미 미달) → 채택

    // 치명적(잘림)이면 더 긴 쪽을 보관하고 재시도
    if (!best || validation.bodyLength > best.validation.bodyLength) {
      best = candidate;
    }
    best.attempts = attempt;
  }

  return await finalizeTitle(best, { type, keyword, keywordFacts, refTitles, model }); // 마지막까지 미달이면 가장 나은 결과 + 제목 벼림
}

/**
 * ★제목 자기검증(2-패스) — 완성된 글의 제목만 "가장 강한 홈판 제목"으로 다시 벼린다.
 * 제목이 제1 순위라 본문과 별개로 집중해서 재작성. 실패해도 원래 제목 유지(안전).
 * 리뷰형은 제목 규칙이 담백해 스킵.
 */
async function finalizeTitle(candidate, { type, keyword, keywordFacts, refTitles, model } = {}) {
  try {
    if (!candidate || !candidate.post || !candidate.post.title) return candidate;
    if (type === 'review') return candidate;
    // ★쿠팡(커머스)은 제목에 "[[제품명]]" 토큰이 있어 refine이 토큰을 지울 수 있고, 커머스 제목은 간단해 refine 불필요 → 건너뛴다(속도↑·토큰 보존).
    if (type === 'coupang') return candidate;
    const postType = getPostType(type);
    const draft = {
      title: candidate.post.title,
      thumbnailText: candidate.post.thumbnailText,
      description: candidate.post.description,
    };
    // 제목 근거 사실 = 뉴스 팩트 + 본문 앞부분(제목↔본문 일치·날조 방지).
    const bodyFacts = (candidate.post.blocks || [])
      .filter((b) => b && (b.kind === 'text' || b.kind === 'quote') && (b.text || '').trim())
      .slice(0, 4)
      .map((b) => (b.text || '').replace(/\n/g, ' ').slice(0, 140));
    const facts = [...(keywordFacts || []).slice(0, 5), ...bodyFacts];
    const user = buildTitleRefinePrompt({ typeKey: type, draft, facts, refTitles });
    const _tr = Date.now();
    const { text } = await runClaude({ system: TITLE_REFINE_SYSTEM, user, model });
    try { console.log('[TIMING] ★제목 다듬기 runClaude = ' + Math.round((Date.now() - _tr) / 1000) + 's'); } catch (e) {}
    const parsed = parseJsonLoose(text);
    // 자극 단어가 살아 있을 때만 교체(제목 하드 규칙 유지). 아니면 원래 제목 보존.
    if (parsed && parsed.title && checkHomefeedWords(parsed.title).ok) {
      candidate.post.title = String(parsed.title).trim();
      if (parsed.thumbnailText) candidate.post.thumbnailText = String(parsed.thumbnailText).trim();
      candidate.titleRefined = true;
    }
  } catch (e) { /* 벼리기 실패해도 원래 제목으로 진행 */ }
  return candidate;
}

/**
 * 생성된 블록 배열을 다듬는다 — 빈 블록·끝맺음·구분선 문제를 코드로 정리.
 * (모델이 실수해도 렌더 전에 확실히 걸러내려는 안전망)
 *  - 빈 text/heading/quote 블록 제거
 *  - hr(구분선): 연속 2개+ → 1개로, 맨 앞/맨 끝 hr 제거. "섹션 끝마다 하나"만 남긴다(사용자 요청).
 *  - 맨 끝이 heading으로 끝나면(=마무리 문단 없음) 그 꼬리를 잘라 text로 끝나게
 */
function sanitizeBlocks(blocks) {
  let out = [];
  for (const b of blocks) {
    if (!b || !b.kind) continue;
    // ★hr(구분선)은 전부 제거 — 주입 단계에서 소제목마다 "정확히 1개"를 툴바로 넣는다(모델 hr은 위치·개수가 들쭉날쭉).
    if (b.kind === 'hr') continue;
    // 내용이 있어야 하는 블록인데 비었으면 버린다.
    if ((b.kind === 'text' || b.kind === 'heading' || b.kind === 'quote') && !(b.text || '').trim()) continue;
    out.push(b);
  }
  // ★인용구(quote) 하드 캡 = 글당 최대 MAX_QUOTES개. 모델이 소제목·구분용으로 quote를 남발하면(66/99 따옴표 도배)
  //   초과분은 일반 문단(text)으로 강등한다. 프롬프트만으로는 안 지켜져서(재생성 3회 다 실패 사례) 후처리로 못박음.
  let qseen = 0;
  out = out.map((b) => {
    if (b.kind === 'quote') { qseen += 1; if (qseen > MAX_QUOTES) return { ...b, kind: 'text' }; }
    return b;
  });
  // ★홈판은 Q&A(qna) 형식 금지 = 검색용 전용(사용자 확정). 모델이 홈판에 qna를 내면 질문+답변을 일반 문단으로 합친다.
  out = out.map((b) => {
    if (b && b.kind === 'qna') {
      const q = (b.question || '').replace(/^Q\s*[.:]?\s*/i, '').trim();
      const a = (b.answer || '').replace(/^A\s*[.:]?\s*/i, '').trim();
      const txt = (q ? q + ' ' : '') + a;
      return txt ? { kind: 'text', text: txt } : null;
    }
    return b;
  }).filter(Boolean);
  // ★홈판은 표(table) 금지(사용자 재확정) → 표가 오면 셀을 일반 문단(text)으로 풀어 넣는다(정보 유지, 표 렌더 안 함).
  out = out.map((b) => {
    if (b && b.kind === 'table') {
      const cols = b.columns || [];
      const rows = b.rows || [];
      const lines = (rows || []).map((r) => (r || []).map((c, i) => (cols[i] ? cols[i] + ' ' : '') + c).join(', ')).filter((s) => s.trim());
      const txt = lines.join('\n');
      return txt ? { kind: 'text', text: txt } : null;
    }
    return b;
  }).filter(Boolean);
  // ★소제목(heading) 정리 (#2 커머스 등에서 소제목 오류):
  //   ① 본문 길이(40자 초과)인데 heading으로 온 건 실제로 문단 → text로 강등.
  //   ② 소제목이 연달아 2번(heading 바로 뒤 heading)이면 앞의 빈 소제목을 버린다(내용 없는 섹션).
  out = out.map((b) => (b.kind === 'heading' && (b.text || '').trim().length > 40 ? { ...b, kind: 'text' } : b));
  out = out.filter((b, i) => !(b.kind === 'heading' && out[i + 1] && out[i + 1].kind === 'heading'));
  // 맨 끝이 heading으로 끝나면(마무리 문단 없음) 잘라낸다. image로 끝나는 건 허용.
  while (out.length && out[out.length - 1].kind === 'heading') out.pop();
  return out;
}

/**
 * ★가게정보 정리블록 — 네이버 플레이스 실데이터(fetchPlaceInfo)로 코드가 직접 조립한다.
 *   사용자 못박음: "상상으로 만들면 안 됨" → 등록 안 된 필드(영업시간·휴무 등)는 넣지 않는다.
 *   렌더는 heading("○○ 정보") + text(이모지 줄들). 홈판이라 표(table)는 안 쓰고 이모지 텍스트로.
 */
function buildPlaceInfoBlocks(reviewList) {
  const blocks = [];
  for (const r of (reviewList || [])) {
    const p = r && r.info;
    if (!p || !(p.roadAddress || p.address)) continue; // 최소한 주소는 있어야 블록을 만든다
    const lines = [];
    lines.push('📍 주소 : ' + (p.roadAddress || p.address));
    if (p.hasHours && Array.isArray(p.hoursLines) && p.hoursLines.length) {
      lines.push('🕒 영업시간 : ' + p.hoursLines[0]);
      for (let i = 1; i < p.hoursLines.length; i++) lines.push('            ' + p.hoursLines[i]);
    }
    if (p.holiday) lines.push('🔴 정기휴무 : ' + p.holiday);
    if (p.tel) lines.push('📞 전화 : ' + p.tel);
    if (p.conveniences && p.conveniences.length) lines.push('✅ 편의 : ' + p.conveniences.slice(0, 8).join(', '));
    const menu = (r.menu || '').trim();
    if (menu) lines.push('🍽 메뉴 : ' + menu);
    if (!p.hasHours) lines.push('※ 영업시간·휴무는 네이버에 미등록 — 방문 전 확인 권장.');
    blocks.push({ kind: 'heading', text: (p.name || '가게') + ' 정보' });
    blocks.push({ kind: 'text', text: lines.join('\n'), _placeInfo: true });
  }
  return blocks;
}

/**
 * ★독자 행동 유도(CTA) — 모델이 만든 commentCta를 "글의 맨 마지막 문단"으로 자동 주입한다.
 *   (지금까지 commentCta는 생성만 되고 글에 안 들어가 버려졌음 = CTA가 안 보이던 원인.)
 *   렌더는 일반 text 블록. 이미 같은 문장이 마지막이면 중복 추가 안 함.
 */
function appendCtaBlock(blocks, commentCta) {
  const cta = (commentCta || '').trim();
  if (!cta) return blocks;
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const last = blocks[blocks.length - 1];
  if (last && (last.kind === 'text' || last.kind === 'quote') && norm(last.text).includes(norm(cta).slice(0, 20))) return blocks;
  return [...blocks, { kind: 'text', text: cta, _cta: true }];
}

/**
 * ★제휴(쿠팡) 고지문 정규화 — 본문 곳곳/여러 번 박힌 고지문을 전부 제거하고 "맨 마지막에 딱 1번"만 남긴다.
 *   모델이 고지문을 본문 문단 첫 문장에 섞거나(제거) 끝에 또 넣는(중복) 문제를 코드로 못박음.
 */
function normalizeAffiliateDisclosure(blocks) {
  const DISC = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
  // "이 (포스팅|글)은 쿠팡 파트너스 …(수수료를 제공받|받을 수 있)…." 한 문장을 텍스트에서 도려낸다.
  const re = /이\s*(?:포스팅|글)은\s*쿠팡\s*파트너스[^.]*?(?:수수료를?\s*(?:제공받|받을\s*수\s*있))[^.]*\.?/g;
  const out = [];
  for (const b of blocks) {
    if (b && (b.kind === 'text' || b.kind === 'quote') && b.text && /쿠팡\s*파트너스/.test(b.text)) {
      const stripped = b.text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
      if (stripped) out.push({ ...b, text: stripped }); // 고지문만 지우고 나머지 본문은 유지
      continue; // 고지문만 있던 블록이면 통째로 제거
    }
    out.push(b);
  }
  // ★고지문은 이제 앱이 "카드 바로 아래"에 자동 삽입한다(app.html affiliateDisclosure, 플랫폼별 문구).
  //   → 여기서 맨 끝에 또 넣으면 중복이므로 append 안 함. (본문에 모델이 쓴 쿠팡 고지문은 위 루프에서 이미 제거)
  void DISC;
  return out;
}

/**
 * ★여행: 장소마다 "그 장소 소제목 바로 뒤"에 가게정보 줄을 끼운다. 소제목 텍스트와 장소명(네이버 플레이스명)을 매칭.
 *   travelInfo = [{name, block}]. 매칭 안 된 건 맨 뒤에 붙인다.
 */
function injectTravelPlaceInfo(blocks, travelInfo) {
  const norm = (s) => (s || '').replace(/\s+/g, '');
  // ★map 블록을 장소명으로 뽑아 제거해두고(원래 위치 무시), "그 장소 기본정보(주소·영업시간) 바로 뒤"에 다시 붙인다(사용자 확정).
  const mapByPlace = {};
  const rest = [];
  for (const b of blocks) {
    if (b && b.kind === 'map' && b.place) { mapByPlace[norm(b.place)] = b; continue; }
    rest.push(b);
  }
  const takeMap = (nm) => {
    const key = Object.keys(mapByPlace).find((k) => k && (k.includes(norm(nm)) || (norm(nm).length >= 2 && norm(nm).includes(k) && k.length >= 2)));
    if (key) { const m = mapByPlace[key]; delete mapByPlace[key]; return m; }
    return null;
  };
  const used = new Set();
  const out = [];
  for (const b of rest) {
    out.push(b);
    if (b.kind === 'heading') {
      const h = norm(b.text);
      const idx = travelInfo.findIndex((x, i) => !used.has(i) && x.name && (h.includes(norm(x.name)) || (norm(x.name).length >= 2 && norm(x.name).includes(h) && h.length >= 2)));
      if (idx >= 0) {
        used.add(idx);
        out.push(travelInfo[idx].block);        // ①기본정보(주소·영업시간) = 소제목 바로 뒤(섹션 처음)
        const m = takeMap(travelInfo[idx].name); if (m) out.push(m); // ②그 바로 뒤에 지도
      }
    }
  }
  // ★끝내 매칭 안 된 장소 정보·지도 = "첫 Q&A(또는 CTA) 앞"에 넣는다 → 절대 Q&A 뒤로 가지 않게(글은 Q&A→CTA로 끝나야 함).
  const leftover = [];
  travelInfo.forEach((x, i) => { if (!used.has(i)) { leftover.push(x.block); const m = takeMap(x.name); if (m) leftover.push(m); } });
  Object.keys(mapByPlace).forEach((k) => leftover.push(mapByPlace[k]));
  if (leftover.length) {
    const qi = out.findIndex((b) => b && (b.kind === 'qna' || (b.kind === 'text' && b._cta)));
    if (qi >= 0) out.splice(qi, 0, ...leftover); else out.push(...leftover);
  }
  return out;
}

/** 가게정보 블록을 대표사진(첫 image) 뒤에 넣는다. 없으면 첫 소제목 앞, 없으면 맨 앞. */
function injectPlaceInfo(blocks, infoBlocks) {
  if (!infoBlocks || !infoBlocks.length) return blocks;
  // ★기본정보는 "서론 다음 = 첫 소제목(heading) 바로 앞"에 고정한다(사용자 확정 2026-08-27).
  //   서론은 보통 소제목 없이 시작하므로 "첫 소제목 앞" = "도입부 바로 뒤"가 된다.
  //   (예전엔 "첫 사진 뒤"였는데, 모델이 사진을 도입부에 안 넣으면 기본정보가 한 섹션 밀리는 문제가 있었음.)
  const headIdx = blocks.findIndex((b) => b.kind === 'heading');
  if (headIdx >= 0) return [...blocks.slice(0, headIdx), ...infoBlocks, ...blocks.slice(headIdx)];
  // 소제목이 아예 없으면(드묾) 첫 사진 뒤, 그것도 없으면 맨 앞.
  const imgIdx = blocks.findIndex((b) => b.kind === 'image');
  if (imgIdx >= 0) return [...blocks.slice(0, imgIdx + 1), ...infoBlocks, ...blocks.slice(imgIdx + 1)];
  return [...infoBlocks, ...blocks];
}

/**
 * 모델이 코드블록이나 앞뒤 잡말을 붙여도 JSON만 안전하게 뽑아 파싱한다.
 */
function parseJsonLoose(raw) {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start === -1) throw new Error(`생성 결과 JSON 파싱 실패: '{' 없음`);
  // ★첫 '{'부터 "짝이 맞는 '}'"까지만 정확히 잘라낸다(문자열·이스케이프 고려) → 뒤에 부스러기·두 번째 객체·설명문이 붙어도 안전(기존 lastIndexOf('}')는 "완성된 JSON 뒤에 또 뭔가"에서 실패했음).
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = end !== -1 ? t.slice(start, end + 1) : t.slice(start, t.lastIndexOf('}') + 1);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`생성 결과 JSON 파싱 실패: ${e.message}`);
  }
}

/**
 * 블록 하나에 담긴 "본문 글자수"를 센다. 표·Q&A도 실제 텍스트를 합산.
 */
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
 * 하드 규칙 검증. 홈판 자극 단어 포함·인용구 개수 등 사용자가 못박은 규칙을 확인한다.
 * 위반은 던지지 않고 결과에 담아 호출부(UI)가 재생성 여부를 결정하게 한다.
 */
function validatePost(post, postType) {
  const issues = [];

  const wordCheck = checkHomefeedWords(post.title);
  if (!wordCheck.ok) {
    issues.push('제목에 홈판 자극 단어가 없음 (최소 1개 필수).');
  }

  const blocks = post.blocks || [];
  const quoteCount = blocks.filter((b) => b.kind === 'quote').length;
  if (quoteCount > MAX_QUOTES) {
    issues.push(`인용구 ${quoteCount}개 — 최대 ${MAX_QUOTES}개 초과.`);
  }

  // ★본문 글자수(사용자 확정): "소제목(heading) 제외 + 띄어쓰기 제외"한 본문(text·인용구)만 센다. 표·Q&A는 홈판에 없음.
  const bodyLen = blocks
    .filter((b) => b.kind === 'text' || b.kind === 'quote')
    .reduce((sum, b) => sum + (b.text || '').replace(/\s+/g, '').length, 0);

  const minLen = postType.length.min;
  if (bodyLen < minLen) {
    issues.push(`본문 ${bodyLen}자 — 최소 ${minLen}자 미달(너무 짧음).`);
  }

  // ★미완성(잘림) 방지 — 소제목으로 끝나거나 빈 본문 블록이 있으면 재생성한다.
  const lastBlk = blocks[blocks.length - 1];
  if (lastBlk && lastBlk.kind === 'heading') issues.push('마지막 블록이 소제목 — 미완성/잘림 의심.');
  if (blocks.some((b) => b.kind === 'text' && !(b.text || '').trim())) issues.push('빈 본문(text) 블록 있음 — 미완성/잘림 의심.');
  // ★★빈 소제목(내용 없는 섹션) 방지 — 소제목 뒤에 "다음 소제목 전까지" 실제 문단(text)이 하나도 없으면 미완성/잘림.
  //   (모델이 소제목만 나열하고 본문을 안 채운 경우 = 사용자가 본 "소제목만 있고 내용 없음")
  let bareHeads = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind !== 'heading') continue;
    let hasText = false;
    for (let j = i + 1; j < blocks.length && blocks[j].kind !== 'heading'; j++) {
      if (blocks[j].kind === 'text' && (blocks[j].text || '').trim().length >= 15) { hasText = true; break; }
    }
    if (!hasText) bareHeads++;
  }
  if (bareHeads > 0) issues.push(`내용 없는 빈 소제목 ${bareHeads}개 — 소제목만 있고 문단이 없음(미완성).`);

  // ★소제목 최소 4개(섹션 4개 이상으로 스캔·가독성) — 미달이면 재생성.
  const headingCount = blocks.filter((b) => b.kind === 'heading').length;
  if (headingCount < 4) issues.push(`소제목 ${headingCount}개 — 최소 4개 미만(섹션 부족).`);

  const count = (k) => blocks.filter((b) => b.kind === k).length;

  return {
    ok: issues.length === 0,
    issues,
    matchedWords: wordCheck.matched,
    quoteCount,
    imageCount: count('image'),
    tableCount: count('table'),
    mapCount: count('map'),
    qnaCount: count('qna'),
    bodyLength: bodyLen,
    minLength: minLen,
    styleUsed: postType.style,
  };
}

// ★키워드 배경 조사(뉴스 팩트 + 인물이면 나무위키) — 홈판 파이프라인을 검색용도 쓰게 함수로 분리.
//   "왜 이 키워드를 검색하는지"(증조부 논란 등)를 파악하려면 최신 뉴스·나무위키 배경이 반드시 필요하다.
async function gatherKeywordContext(keyword, { isPerson = false } = {}) {
  if (!keyword) return { keywordFacts: null, keywordBackground: null, keywordAngles: null };
  const core = coreEntity(keyword);
  const [acKw, acCore] = await Promise.all([
    fetchAutocomplete(keyword).catch(() => []),
    core && core !== keyword ? fetchAutocomplete(core).catch(() => []) : Promise.resolve([]),
  ]);
  const aSeen = new Set();
  const keywordAngles = [...(acKw || []), ...(acCore || [])].filter((a) => a && a !== keyword && a !== core && !aSeen.has(a) && aSeen.add(a)).slice(0, 12);
  const seen = new Set();
  const collect = (groups, max) => { const out = []; for (const arr of groups) for (const h of arr || []) { const k = (h || '').trim(); if (k && !seen.has(k)) { seen.add(k); out.push(k); if (out.length >= max) return out; } } return out; };
  // ★★뉴스 검색어 변형 — "티원"처럼 한글로 쓴 팀/브랜드가 기사엔 "T1"로 나와 "오늘 경기" 뉴스를 통째로 놓치는 문제 해결.
  //   ①흔한 e스포츠·브랜드 한↔영 치환 ②여러 단어면 각 단어 단독 검색(각 주체의 최신 기사 확보) → 최신순(sort=1)이라 오늘 결과가 잡힘.
  // ★★★[맥락으로 동명이인·다른 뜻 구분] 키워드가 "지금 뜨는 이유" = 함께 뜨는 단어(맥락)에 있다.
  //   예: "양수진"은 "김승원·구스타·브로커"와 함께 뜬다 → "양수진 김승원"으로 검색해야 그 사람만(치어리더 동명이인 안 섞임).
  //   자동완성 조합("김승원 양수진","구스타 양수진")에서 키워드 아닌 "함께 나오는 핵심어"를 앵커로 뽑아, "키워드 + 앵커"로 배경조사한다.
  const _ANCHOR_STOP = new Set(['대표', '프로필', '누구', '나이', '뜻', '논란', '사건', '뉴스', '최근', '오늘', '정보', '총정리', '이유', '방법', '후기', '가격', '근황', '결말', '관련', '그것', '관계', '의혹', '사퇴', '나무위키', '위키']);
  const _anchorFreq = {};
  keywordAngles.forEach((a) => String(a || '').split(/[\s,·]+/).forEach((w) => {
    w = w.replace(/[^가-힣A-Za-z0-9]/g, '').trim();
    if (w && w.length >= 2 && w !== core && core.indexOf(w) < 0 && w.indexOf(core) < 0 && !_ANCHOR_STOP.has(w)) _anchorFreq[w] = (_anchorFreq[w] || 0) + 1;
  }));
  const contextAnchors = Object.entries(_anchorFreq).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]); // ["김승원","구스타","브로커"]
  const anchorQ = contextAnchors.slice(0, 3).map((a) => `${core} ${a}`); // "양수진 김승원", "양수진 구스타"
  // ★★뉴스 검색어 변형 + 맥락 앵커 결합 → 최신순(sort=1)이라 오늘 결과가, 앵커 결합이라 그 맥락의 그 대상만 잡힌다.
  const _variants = newsQueryVariants(keyword);
  const recentQ = [..._variants, ...anchorQ, ...keywordAngles.slice(0, 2)].filter((q, i, a) => q && a.indexOf(q) === i).slice(0, 7);
  // ★★뉴스(최신 사실) + 블로그(제도 실제내용·인물 기본신상). 블로그도 "키워드+앵커"로 검색해 동명이인·다른 뜻이 안 섞이게.
  const blogQ = [keyword, core, ...anchorQ, ...keywordAngles.slice(0, 3)].filter((q, i, a) => q && a.indexOf(q) === i).slice(0, 9);
  const [recentArr, blogArr] = await Promise.all([
    Promise.all(recentQ.map((q) => fetchNewsHeadlines(q).catch(() => []))),
    Promise.all(blogQ.map((q) => fetchBlogFacts(q).catch(() => []))),
  ]);
  // ★뉴스(최신 사실)와 블로그(제도 내용)를 "번갈아" 섞는다 → 둘 다 상위에 들어가게(뉴스만 20개로 블로그가 잘리는 것 방지).
  //   블로그를 각 라운드 먼저 넣어 "신청자격·지원내용" 같은 실제 제도 근거가 확실히 포함되게 한다.
  const _flatBlog = blogArr.flat(), _flatNews = recentArr.flat();
  const keywordFacts = (function () {
    const out = [], seen = new Set();
    for (let i = 0; out.length < 20 && (i < _flatBlog.length || i < _flatNews.length); i++) {
      for (const src of [_flatBlog, _flatNews]) {
        const h = (src[i] || '').trim();
        if (h && !seen.has(h)) { seen.add(h); out.push(h); if (out.length >= 20) break; }
      }
    }
    return out;
  })();
  let bg = [];
  if (core) {
    // ★나무위키 배경은 "모든 주제"에서 시도(인물·게임·제품·정책·시험 등 나무위키에 있으면 유용). 없으면 빈 배열(뉴스가 배경 역할).
    //   인물(직업어 붙은 것)만 직업어를 떼고 조회(나무위키가 "배우 하영"은 못 찾고 "하영"으로 찾음).
    const personName = isPerson
      ? (String(core).replace(/^(배우|가수|감독|모델|개그맨|개그우먼|아나운서|방송인|유튜버|트로트\s*가수|인플루언서|셀럽|프로게이머|코미디언)\s+/, '').trim() || core)
      : core;
    bg = await fetchNamuBackground(personName, { limit: 12, context: keywordFacts, hints: keywordAngles }).catch(() => []);
    // 인물인데 나무위키가 빈약하면 "인물 배경 뉴스"(프로필·과거·이혼 등)로 보강. (비인물은 뉴스 팩트가 배경이라 폴백 불필요)
    if (isPerson && bg.length < 4) {
      const bgQ = [core, ...BACKGROUND_MODIFIERS.map((m) => `${core} ${m}`)];
      const bgArr = await Promise.all(bgQ.map((q) => fetchNewsHeadlines(q).catch(() => [])));
      bg = collect(bgArr, 10);
    }
  }
  return { keywordFacts: keywordFacts.length ? keywordFacts : null, keywordBackground: bg.length ? bg : null, keywordAngles, contextAnchors };
}

module.exports = { generatePost, validatePost, parseJsonLoose, appendCtaBlock, buildPlaceInfoBlocks, injectPlaceInfo, injectTravelPlaceInfo, gatherKeywordContext };
