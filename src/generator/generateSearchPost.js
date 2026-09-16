// 검색용(검색 상위노출) 글 생성 엔진.
//
// 홈판용(generatePost.js)과의 차이:
//  - 홈판 자극 단어 검증 없음(검색은 자극단어 강제하면 낚시=퀵백 위험).
//  - 네이버 공식 주제(searchTopics.js) 기준.
//  - 검증: 본문 최소 글자수 + 인용구 개수 + 주제별 필수 구성요소 존재 여부(소프트).
//
// 생성은 홈판과 동일하게 runClaude()가 사용자의 클로드 구독 로그인으로 처리(배포자 비용 0원).

const { runClaude } = require('./runClaude');
const { getSearchTopic, SEARCH_MIN_LENGTH } = require('./searchTopics');
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
const scrapeHealth = require('../scrape/health');
const { factCheckPost } = require('./factCheck');

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
async function extractMainKeyword(title, text, model) {
  const system =
    '너는 네이버 검색 키워드 추출기다. 주어진 글 제목(과 앞부분)에서 "사람들이 네이버에 실제로 검색할 만한 메인 키워드" 1개만 뽑아라. 2~10글자 핵심 명사구, 사이트명·기자명·군더더기 제외. 설명·따옴표 없이 키워드만 한 줄로 출력.';
  const user = `제목: ${title || ''}\n${text ? '앞부분: ' + String(text).slice(0, 300) : ''}\n\n메인 키워드 1개만:`;
  const { text: out } = await runClaude({ system, user, model: model || 'claude-haiku-4-5-20251001' });
  return String(out || '').trim().split('\n')[0].replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 30);
}

async function generateSearchPost({ topic, keyword, extra, style, memo, paid, commerce, source, linkNote, persona, avoidKeywords, officialFacts, review, model, maxAttempts = 3 } = {}) {
  const searchTopic = getSearchTopic(topic); // 잘못된 주제면 여기서 예외
  scrapeHealth.reset(); // 이번 생성의 수집 진단만 담기게 초기화
  const system = buildSearchSystemPrompt(topic);

  // ★링크형 — 키워드 없이 링크만 준 경우, 링크 제목에서 "네이버 검색용 메인 키워드" 1개를 뽑는다(가벼운 하이쿠).
  let kw = keyword;
  if (source && source.title && !kw) {
    try { kw = await extractMainKeyword(source.title, source.text, model); } catch (e) { kw = ''; }
  }

  // ★검색용 제목의 핵심 — 키워드를 네이버 자동완성에 넣어 "실제로 함께 검색되는 세부 키워드"를 가져온다.
  //   이 세부 키워드를 제목에 반드시 넣어야 검색 노출·인텐트 정합(메인 단독 발행 금지).
  let autocomplete = [];
  if (kw) { try { autocomplete = (await fetchAutocomplete(kw)) || []; } catch (e) { autocomplete = []; } }

  // ★★검색 의도 파악의 핵심 = 배경 조사(홈판과 동일). "왜 이 키워드를 검색하는지"(예: 하영=증조부 친일 논란·노윤서와 그림 비교)를
  //   최신 뉴스 + 인물이면 나무위키로 가져와, 프롬프트가 실제 맥락을 알고 쓰게 한다. (엔터형=인물 배경조사)
  let keywordFacts = null, keywordBackground = null, newsArticles = null;
  if (kw && !review && topic !== 'review') { // ★리뷰형(장소 내돈내산 + 상품리뷰)은 내 경험·실제후기가 근거 → 뉴스·나무위키 조사 안 함(소비자원 비교표·경쟁사 점수 같은 엉뚱한 사실 유입 방지)
    try {
      const isPerson = familyOf(topic) === 'A'; // 엔터형(방송·연예·드라마·영화·스타 등) = 인물 배경조사
      const ctx = await gatherKeywordContext(kw, { isPerson });
      keywordFacts = ctx.keywordFacts; keywordBackground = ctx.keywordBackground;
    } catch (e) { /* 조사 실패해도 글은 나온다 */ }
    // ★★뉴스 기사 "본문 전체"를 읽어온다 — 제목·스니펫만으론 경기 세부(라인업·챔피언·세트별)를 몰라 모델이 지어냄(치명적).
    //   실제 본문(인터뷰 발언 포함)을 넘겨야 정확히 쓴다. 스포츠·e스포츠·연예·일반뉴스 모두 대응.
    try { newsArticles = await fetchNewsArticles(kw, { limit: 3 }); } catch (e) { newsArticles = null; }
  }
  // ★★리뷰형에서 "방송에 나왔다"고 한 장소 → 그 방송의 "몇 회·언제 방영" 등 구체 정보를 블로그·뉴스에서 검색해 채운다.
  //   (사용자 확정: 유명인이 왔다가 아니라 "무슨 방송에 나왔다"면 검색해서 회차·방영일을 알려주면 검색용 궁금증이 해결된다.)
  if (review && Array.isArray(review.places)) {
    for (const p of review.places) {
      const tv = (p.tv || '').trim();
      if (!tv) continue;
      try {
        const q = ((p.biz || p.place || '') + ' ' + tv).trim();
        const facts = await fetchBlogFacts(q); // 상호명+방송명으로 블로그 검색(회차·방영일이 블로그 후기에 자주 있음)
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
        const revs = await fetchPlaceReviews(nm);
        (revs || []).forEach((r) => { const t = (r || '').trim(); if (t && !_seenR.has(t)) { _seenR.add(t); placeReviews.push(t); } });
      }
      placeReviews = placeReviews.slice(0, 10);
    } catch (e) { /* 실패해도 글은 나온다 */ }
  } else if (topic === 'review' && kw) {
    // ★상품 리뷰 = 제품명으로 "실제 사용 후기"(네이버 블로그)를 가져와 스펙·사용감을 실제 후기에서 채운다(지어냄 방지 — 맛집/여행과 동일 방식).
    try {
      const revs = await fetchPlaceReviews(kw); // "제품명 후기"로 검색
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
        const near = await fetchNearbyAttractions(region);
        const bizNames = review.places.map((p) => (p.biz || p.place || '').replace(/\s+/g, ''));
        // 리뷰 대상 가게 자신은 근처추천에서 제외
        nearbyAttractions = (near || []).filter((n) => !bizNames.some((b) => b && n.replace(/\s+/g, '').includes(b))).slice(0, 5);
      }
    } catch (e) { /* 실패해도 글은 나온다 */ }
  }

  let best = null;

  // ★마무리 — 팩트 대조 + 수집 진단을 결과에 실어 보낸다(경고이지 차단이 아니다).
  const _finish = async (cand) => {
    if (!cand) return cand;
    try {
      cand.factCheck = await factCheckPost({
        post: cand.post, facts: keywordFacts, articles: newsArticles,
        background: keywordBackground, placeReviews,
      });
    } catch (e) { cand.factCheck = { ran: false, issues: [], highCount: 0, reason: e.message }; }
    try { cand.scrapeHealth = scrapeHealth.report(); } catch (e) {}
    return cand;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retry =
      best && !best.validation.ok
        ? {
            issues: best.validation.issues,
            prevLength: best.validation.bodyLength,
            min: SEARCH_MIN_LENGTH,
          }
        : null;

    const user = buildSearchUserPrompt({ topicKey: topic, keyword: kw, extra, retry, autocomplete, style, memo, paid, commerce, source, linkNote, persona, keywordFacts, keywordBackground, avoidKeywords, officialFacts, newsArticles, review, placeReviews, nearbyAttractions });
    const { text, meta } = await runClaude({ system, user, model });
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
            try { return await fetchPlaceInfo(nm); } catch (e) { return null; }
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
    const validation = validateSearchPost(post, searchTopic);

    const candidate = { post, validation, meta, attempts: attempt };
    if (validation.ok) return await _finish(candidate);

    if (!best || validation.bodyLength > best.validation.bodyLength) {
      best = candidate;
    }
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
 * 검색용 하드 규칙 검증. (자극 단어 검증 없음)
 */
function validateSearchPost(post, searchTopic) {
  const issues = [];
  const blocks = post.blocks || [];

  const quoteCount = blocks.filter((b) => b.kind === 'quote').length;
  if (quoteCount > MAX_QUOTES) {
    issues.push(`인용구 ${quoteCount}개 — 최대 ${MAX_QUOTES}개 초과.`);
  }

  // ★소제목(heading=버티컬라인) 최소 4개 — 홈판과 동일하게 검색용도 강제(4개 미만이면 재생성).
  const headingCount = blocks.filter((b) => b.kind === 'heading').length;
  if (headingCount < 4) {
    issues.push(`소제목 ${headingCount}개 — 최소 4개 미만(섹션 부족).`);
  }

  const bodyLen = blocks.reduce((sum, b) => sum + blockTextLength(b), 0);
  if (bodyLen < SEARCH_MIN_LENGTH) {
    issues.push(`본문 ${bodyLen}자 — 최소 ${SEARCH_MIN_LENGTH}자 미달(너무 짧음).`);
  }

  // description(검색 스니펫)은 검색용에서 필수.
  if (!post.description || !post.description.trim()) {
    issues.push('디스크립션(description)이 비어 있음 — 검색 스니펫용 필수.');
  }

  const count = (k) => blocks.filter((b) => b.kind === k).length;

  return {
    ok: issues.length === 0,
    issues,
    quoteCount,
    headingCount,
    imageCount: count('image'),
    tableCount: count('table'),
    mapCount: count('map'),
    qnaCount: count('qna'),
    bodyLength: bodyLen,
    minLength: SEARCH_MIN_LENGTH,
    topic: searchTopic.label,
    // 주제별 필수 구성요소가 있으면, 코드로는 강제 못 하니 참고용으로 표시(프롬프트에서 지시).
    hasMustInclude: !!searchTopic.mustInclude,
  };
}

module.exports = { generateSearchPost, validateSearchPost };
