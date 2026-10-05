// 네이버 크리에이터 어드바이저 트렌드 키워드 수집.
//
// 특징: ①네이버 로그인 세션 필요(앱의 persist:naver 파티션으로 scrapeRendered) ②SPA라 렌더 후 DOM에서 뽑음.
//   → 셀렉터를 debug 덤프로 찾는 방식. 첫 로그인 실행이 구조를 파일로 남긴다.
//
// 데이터 2종(메모리 naver-search-tab-requirements / homefeed-operation-logic):
//   - 검색유입 트렌드(설정순): 주제별 뜨는 검색어(+▲급상승)
//   - 메인유입 트렌드: 홈판 인기글 top1~20 (발견형 제목 소재)
// 로그인만 하면 무료 티어도 접근 가능(네이버 로그인은 어차피 함).

// 로그인 시 최종적으로 트렌드가 뜨는 경로 후보(첫 실행이 실제로 되는 URL을 debug로 확인해 확정).
const ADVISOR_CANDIDATE_URLS = [
  'https://creator-advisor.naver.com/naver_blog/trends',
  'https://creator-advisor.naver.com/',
];

// 데스크톱 UA(어드바이저는 데스크톱 화면 기준).
const ADVISOR_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 페이지 안에서 실행 → 로그인 여부 + 랭킹/트렌드 리스트 구조 덤프(+후보 키워드).
const ADVISOR_EXTRACT = `(function(){
  function T(el){return (el&&el.textContent||'').replace(/\\s+/g,' ').trim();}
  var href=location.href;
  var body=(document.body.innerText||'').replace(/\\s+/g,' ');
  // 로그아웃 시 어드바이저는 /introduction("'로그인'하고 서비스 이용하기") 랜딩으로 튕긴다.
  var loginNeeded = /nid\\.naver\\.com|nidlogin|\\/login|\\/introduction/i.test(href)
    || !!document.querySelector('input[type=password]')
    || /로그인['’\\" ]?하고\\s*서비스\\s*이용/.test(body);
  var lists=[], seenNode=[];
  var nodes=document.querySelectorAll('ol,ul,table tbody,[class*="list"],[class*="rank"],[class*="trend"]');
  [].slice.call(nodes).forEach(function(l){
    if(seenNode.indexOf(l)>=0) return; seenNode.push(l);
    var items=l.querySelectorAll(':scope > li, :scope > tr, :scope > div');
    if(items.length>=5 && items.length<=60){
      var s=[].slice.call(items).slice(0,12).map(function(it){return T(it).slice(0,40);}).filter(function(x){return x&&x.length>=1;});
      if(s.length>=5) lists.push({cls:(l.className||'').toString().slice(0,60),tag:l.tagName,count:items.length,sample:s});
    }
  });
  // ★실제 트렌드 키워드 = /trend-stats?...query={키워드} 앵커에서 추출(리스트 아님, 링크에 있음).
  var trendKeywords=[];
  [].slice.call(document.querySelectorAll('a[href]')).forEach(function(a){
    var h=a.getAttribute('href')||'';
    if(!/trend-stats|[?&]query=/.test(h)) return;
    var m=h.match(/[?&]query=([^&]+)/); if(!m) return;
    var kw=''; try{ kw=decodeURIComponent(m[1]); }catch(e){ kw=m[1]; }
    kw=kw.replace(/\\s+/g,' ').trim();
    if(kw.length>=2 && kw.length<=30 && trendKeywords.indexOf(kw)<0) trendKeywords.push(kw);
  });
  // 내비게이션 탭·링크(트렌드 탭 URL 찾기용) — 짧은 텍스트 앵커의 text+href.
  var navLinks=[];
  [].slice.call(document.querySelectorAll('a[href]')).slice(0,150).forEach(function(a){
    var t=(a.textContent||'').replace(/\\s+/g,' ').trim();
    var h=a.getAttribute('href')||'';
    if(t.length>=1 && t.length<=16 && navLinks.length<50) navLinks.push({t:t,h:h.slice(0,160)});
  });
  // (개발용) 주제별 구조 파악을 위해 트렌드 페이지 전체 텍스트를 넉넉히 덤프.
  var bodyFull = body.slice(0,4000);
  // 주제 라벨 후보: 짧은 제목/탭 요소 텍스트(주제별 영역의 국내여행·맛집 등).
  var topics=[];
  document.querySelectorAll('h1,h2,h3,h4,strong,button,[class*="tab"],[class*="title"],[class*="category"],[class*="subject"],[class*="theme"]').forEach(function(el){
    var t=(el.textContent||'').replace(/\\s+/g,' ').trim();
    if(t.length>=2 && t.length<=12 && topics.indexOf(t)<0) topics.push(t);
  });
  return JSON.stringify({
    href:href, title:document.title, loginNeeded:loginNeeded,
    bodyLen:body.length,
    bodyHead:body.slice(0,900),
    bodyFull:bodyFull,
    topics:topics.slice(0,60),
    lists:lists.slice(0,25),
    navLinks:navLinks,
    trendKeywords:trendKeywords.slice(0,50)
  });
})()`;

// 덤프(여러 URL 시도)에서 "키워드처럼 보이는" 항목을 뽑는다. 정확 분류는 debug로 튜닝하되, 일단 후보를 넉넉히.
function pickAdvisorKeywords(dumps) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const k = String(raw).replace(/\s+/g, ' ').trim();
    if (k.length < 2 || k.length > 40 || /^[\d\s.,%]+$/.test(k) || seen.has(k)) return;
    seen.add(k); out.push(k);
  };
  // ★1순위: trend-stats 앵커의 query= 에서 뽑은 "실제 트렌드 검색어"(주제별 인기유입검색어 등).
  for (const d of dumps || []) for (const kw of (d && d.trendKeywords) || []) add(kw);
  if (out.length) return out.slice(0, 40);
  // 폴백: 리스트에서(내비·메뉴·푸터 제외). 트렌드 앵커를 못 잡았을 때만.
  for (const d of dumps || []) {
    for (const lst of (d && d.lists) || []) {
      if (/menu|gnb|lnb|snb|nav|footer|header|tab/i.test(lst.cls || '')) continue;
      for (const raw of lst.sample || []) {
        add(String(raw).replace(/^\d+\s*[.위)]?\s*/, '').replace(/▲|△|▼|▽|NEW|급상승|신규/g, ''));
      }
    }
  }
  return out.slice(0, 40);
}

// ★어드바이저 "주제별 인기유입검색어"의 32개 주제(실측). 유형 매핑·주제별 묶기에 사용.
const ADVISOR_TOPICS = ['국내여행', '맛집', '세계여행', '패션·미용', '상품리뷰', '일상·생각', '육아·결혼', '요리·레시피', '비즈니스·경제', '건강·의학', 'IT·컴퓨터', '인테리어·DIY', '교육·학문', '영화', '자동차', '스타·연예인', '취미', '스포츠', '방송', '게임', '드라마', '공연·전시', '반려동물', '문학·책', '사회·정치', '음악', '어학·외국어', '만화·애니', '원예·재배', '사진', '좋은글·이미지', '미술·디자인'];

// 페이지 안에서 실행 → 문서 순서대로 "주제 라벨"을 따라가며 그 아래 키워드(앵커 query=)를 주제별로 묶는다.
//   (스크롤로 lazy-load 다 불러온 뒤 실행해야 32개 주제가 다 채워짐.)
const ADVISOR_BYTOPIC_EXTRACT = `(function(){
  var TOPICS=${JSON.stringify(ADVISOR_TOPICS)};
  var tset={}; TOPICS.forEach(function(t){tset[t]=1;});
  var byTopic={}; var cur='';
  var w=document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
  var n;
  while(n=w.nextNode()){
    var tx=(n.textContent||'').replace(/\\s+/g,' ').trim();
    if(/\\d+-\\d+\\s*세|성별,?\\s*연령별/.test(tx) && tx.length<14){ cur=''; continue; } // 성별·연령별 섹션 진입 → 주제 할당 중단
    if(tset[tx] && n.querySelectorAll('a[href*="query="]').length===0){ cur=tx; continue; } // 주제 라벨
    if(n.tagName==='A'){
      var h=n.getAttribute('href')||'';
      var m=h.match(/[?&]query=([^&]+)/);
      if(m && cur){
        var kw=''; try{kw=decodeURIComponent(m[1]);}catch(e){kw=m[1];}
        kw=kw.replace(/\\s+/g,' ').trim();
        if(kw.length>=2 && kw.length<=30){ if(!byTopic[cur])byTopic[cur]=[]; if(byTopic[cur].indexOf(kw)<0)byTopic[cur].push(kw); }
      }
    }
  }
  // (진단) 특정 주제 라벨이 DOM에 있는지 + 그 부모 텍스트(데이터 로딩 여부 확인)
  var probe={};
  ['스타·연예인','방송','드라마','영화','자동차','스포츠'].forEach(function(t){
    var els=[].slice.call(document.querySelectorAll('*')).filter(function(e){return e.children.length===0&&(e.textContent||'').replace(/\\s+/g,' ').trim()===t;});
    probe[t]= els.length? {found:true, parent:((els[0].parentElement&&els[0].parentElement.textContent)||'').replace(/\\s+/g,' ').trim().slice(0,70)} : {found:false};
  });
  return JSON.stringify({href:location.href, loginNeeded:/nid\\.naver\\.com|introduction/i.test(location.href), byTopic:byTopic, probe:probe});
})()`;

// byTopic + 유형의 advisorTopics → 키워드 병합.
//  ★사용자 규칙: 여러 주제면 "각 주제 상위 N개씩"(예: 연예=4주제 → 각 5개). 겹치면 그 주제의 "하위 다른 것"으로 채움.
//  그래도 모자라면 각 주제의 나머지에서 라운드로빈 백필.
//  ★NEW(rankChange===null) 우선 + 상단(rank) 우선. perTopic=주제별 상위 몇 개까지 볼지(연예=상위 5).
function keywordsForTopics(byTopic, topics, limit = 20, opts = {}) {
  topics = (topics || []).filter((t) => (byTopic && byTopic[t] || []).length);
  if (!topics.length) return [];
  const clean = (kw) => String(kw).replace(/\s+/g, ' ').trim();
  const valid = (k) => k.length >= 2 && k.length <= 30;
  // 항목 정규화: {kw,rank,isNew} 객체 또는 문자열 → {kw,rank,isNew}. topicOrder=주제 등장순(안정 정렬용).
  const norm = (raw, topicOrder, within) => {
    if (raw && typeof raw === 'object') return { kw: clean(raw.kw), rank: (typeof raw.rank === 'number' ? raw.rank : within + 1), isNew: !!raw.isNew, topicOrder };
    return { kw: clean(raw), rank: within + 1, isNew: false, topicOrder };
  };
  const perTopic = opts.perTopic || (topics.length > 1 ? Math.max(5, Math.ceil((limit * 1.4) / topics.length)) : limit);
  const perTopicMap = opts.perTopicMap || {}; // 특정 주제만 개수 제한(예: 패션·미용 = 2)
  // 1) 각 주제에서 "NEW 우선 → 상단" 정렬 후 상위 cap개 수집.
  const cand = [];
  const seen = new Set();
  topics.forEach((tp, ti) => {
    const cap = perTopicMap[tp] || perTopic;
    const items = (byTopic[tp] || [])
      .map((raw, wi) => norm(raw, ti, wi))
      .filter((o) => valid(o.kw));
    // ★최상단(rank 최소) 1개는 NEW 여부와 무관하게 "무조건" 포함(사용자 요청: 맨 위 키워드는 꼭 가져와라).
    //   NEW가 cap을 다 채워 top이 밀려나는 걸 막는다.
    if (opts.alwaysTop && items.length) {
      const top = items.reduce((a, b) => (b.rank < a.rank ? b : a), items[0]);
      if (top && !seen.has(top.kw)) { seen.add(top.kw); cand.push(top); }
    }
    items.sort((a, b) => (b.isNew - a.isNew) || (a.rank - b.rank)); // ★그 주제 안에서 NEW 먼저, 그다음 상단
    let cnt = 0;
    for (const o of items) {
      if (cnt >= cap) break;
      if (seen.has(o.kw)) continue; // 정확 중복 제거
      seen.add(o.kw); cand.push(o); cnt++;
    }
  });
  // 2) ★정렬 우선순위: NEW 먼저 → 상단(rank 작을수록) → 주제 등장순.
  cand.sort((a, b) => (b.isNew - a.isNew) || (a.rank - b.rank) || (a.topicOrder - b.topicOrder));
  return cand.slice(0, limit).map((o) => o.kw);
}

// ★/api/v6/trend/category 응답 → { 주제: [키워드...] }. 응답 키가 버전마다 달라 방어적으로 파싱.
function parseCategoryApi(parsed) {
  const bt = {};
  if (!parsed) return bt;
  const arr = parsed.data || parsed.result || parsed.list || parsed.categories || (Array.isArray(parsed) ? parsed : []);
  for (const item of arr || []) {
    if (!item) continue;
    const cat = item.category || item.categoryName || item.name || item.title;
    const queries = item.queryList || item.queries || item.data || item.ranks || item.items || item.list || item.trends || item.keywords || [];
    if (!cat) continue;
    // ★rank·rankChange까지 담는다. rankChange===null = NEW(새 진입). rank=상단순.
    const kws = (queries || [])
      .map((q) => {
        if (typeof q === 'string') return { kw: String(q).replace(/\s+/g, ' ').trim(), rank: Infinity, isNew: false };
        const kw = String((q && (q.query || q.keyword || q.name || q.title || q.value || q.text)) || '').replace(/\s+/g, ' ').trim();
        const rank = (q && typeof q.rank === 'number') ? q.rank : Infinity;
        const isNew = !!(q && Object.prototype.hasOwnProperty.call(q, 'rankChange') && q.rankChange === null); // NEW 마커
        return { kw, rank, isNew };
      })
      .filter((o) => o.kw.length >= 2 && o.kw.length <= 30);
    if (kws.length) bt[cat] = kws;
  }
  return bt;
}

// ★실시간 트렌드(일반 급상승) 키워드를 우리 유형으로 분류 — 유형별로 걸러 붙이기 위함(휴리스틱, 신호어 매칭).
//   순서 중요(더 구체적인 것 먼저). 매칭 없으면 null(그 유형에 안 붙임).
const TREND_SIGNALS = [
  ['sportsnews', /승리|패배|무승부|우승|준우승|KLPGA|PGA|MLB|KBO|리그|감독|구단|손흥민|이강인|김민재|류현진|김하성|야구|축구|농구|배구|골프|올림픽|월드컵|아시안게임|국가대표|선발|이적|챔피언스리그|프리미어리그|분데스리가|뮌헨|바르셀로나|레알|두산|트윈스|한화|자이언츠|타이거즈|라이온즈|SSG|키움|다이노스|위즈|토트넘|맨시티|맨유|아스날|연속골|홈런/],
  ['celebrity', /콘서트|페스티벌|공연|티켓|취소표|내한|뮤지컬|드라마|영화|배우|가수|아이돌|컴백|앨범|데뷔|펜타포트|워터밤|쿠키|열애|결혼|이혼|스캔들|근황|팬미팅|OTT|넷플릭스|디즈니|티빙|웨이브|출연진|주연|시상식|어워즈|예능/],
  ['policy', /지원금|보조금|급여|수당|신청|공고|정책|환급|연말정산|재난지원|바우처|국민연금|기초연금|경선|선거|국회|대통령|의원|장관|정부|법안|개헌|부울경/],
  ['it', /갤럭시|아이폰|아이패드|맥북|갤럭시워치|에어팟|챗지피티|사전예약|스펙|유출|안드로이드|윈도우|오픈AI|엔비디아/],
  ['car', /신차|전기차|하이브리드|현대차|기아차|테슬라|제네시스|아반떼|쏘나타|그랜저|카니발|스포티지|투싼|싼타페|리콜/],
  ['invest', /주가|코스피|코스닥|환율|금리|배당|비트코인|이더리움|증시|상한가|하한가|공모주|나스닥/],
  ['travel', /여행|가볼만한곳|여행지|항공권|호텔|리조트|펜션|글램핑|캠핑|관광|해수욕장/],
  ['restaurant', /맛집|카페|디저트|먹방|신메뉴|팝업스토어|베이커리|빵집/],
  ['life', /폭염|한파|태풍|장마|미세먼지|황사|열대야|폭우|호우|지진|날씨|기온|증상|감기|독감|코로나|백신|다이어트|레시피|요리|반찬|육아|임신|출산|건강|병원|명절|추석|설날|김장|화재|여객선|사고|팝업|마트|이마트|코스트코|홈플러스|롯데마트|전시회|박물관|미술관|굿즈|행사|고래잇|나들이/],
];
function classifyTrendKeyword(kw) {
  const s = String(kw || '');
  for (const [type, re] of TREND_SIGNALS) if (re.test(s)) return type;
  return null;
}

// ── 유사 중복 제거 + 이미 쓴 것 제외 ──────────────────────────────
const _norm = (s) => String(s || '').replace(/\s+/g, '');
function _commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
// 두 키워드가 "같은 소재"인가 = 공백제거 후 3자 이상 공통 접두(스파이더맨쿠키 vs 스파이더맨프랭크 → 스파이더맨).
function isSimilar(a, b) {
  const an = _norm(a), bn = _norm(b);
  if (!an || !bn) return false;
  if (an === bn) return true; // ★완전 동일(AG/AG, 알림/알림)은 병합
  const c = _commonPrefix(an, bn);
  return c >= 3 && c >= Math.min(an.length, bn.length, 4);
}
// ★핵심어(첫 단어)별로 "최대 max개"만 남긴다 — "투싼 하이브리드/전기차"처럼 의미있는 변형은 보여주되(왜 뜨는지),
//   "투싼×9"처럼 너무 많으면 앞 3개만. 반환: { list, coreCount } (coreCount=핵심어별 변형 수 = "핫한 정도" 신호, 자동발행 우선순위용).
function capPerCore(keywords, max) {
  const cap = max || 3;
  const core = (k) => String(k || '').trim().split(/\s+/)[0] || '';
  const cnt = {}, out = [], coreCount = {};
  for (const k of keywords || []) {
    const c = _norm(core(k)); if (!c) continue;
    coreCount[c] = (coreCount[c] || 0) + 1;         // 전체 변형 수(핫 신호)
    if ((cnt[c] || 0) >= cap) continue;             // 표시는 핵심어당 cap개까지
    cnt[c] = (cnt[c] || 0) + 1; out.push(k);
  }
  return { list: out, coreCount };
}
// 유사한 것들은 하나만 남긴다(먼저 온=상위 순위 유지).
function dedupeSimilar(keywords) {
  const kept = [];
  for (const kw of keywords || []) { if (kw && !kept.some((k) => isSimilar(k, kw))) kept.push(kw); }
  return kept;
}
// 이미 쓴 키워드/제목과 겹치는(같은 소재) 것 제외.
function excludeUsed(keywords, usedKeywords, usedTitles) {
  const uk = (usedKeywords || []).filter(Boolean);
  const ut = (usedTitles || []).map(_norm).filter((t) => t.length >= 2);
  return (keywords || []).filter((kw) => {
    if (uk.some((u) => isSimilar(kw, u))) return false; // 같은 소재를 이미 씀
    const n = _norm(kw);
    if (n.length >= 3 && ut.some((t) => t.includes(n))) return false; // 그 키워드가 이미 쓴 글 제목에 들어감
    return true;
  });
}

module.exports = {
  ADVISOR_CANDIDATE_URLS, ADVISOR_UA, ADVISOR_EXTRACT, pickAdvisorKeywords,
  ADVISOR_TOPICS, ADVISOR_BYTOPIC_EXTRACT, keywordsForTopics, parseCategoryApi,
  classifyTrendKeyword, dedupeSimilar, excludeUsed, isSimilar, capPerCore,
};
