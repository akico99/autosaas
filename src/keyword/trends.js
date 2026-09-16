// 실시간 트렌드 씨앗 수집(다중 소스) — "지금 뜨는 것"을 자동 키워드 생성의 씨앗으로.
//
// ★배포 안전: 무키·무로그인·무료(공개 HTTP). Node 기본 모듈만 사용.
//   소스 3종을 병렬 수집 → 병합·중복제거 → 통합 리스트.
//     1) signal.bz  : 실시간 검색어 집계 JSON (api.signal.bz/news/realtime)
//     2) 네이트     : 실시간 검색어 JSON (EUC-KR, TextDecoder로 디코딩)
//     3) 줌         : AI 이슈트렌드 (zum.com HTML에 임베드된 JSON — 키워드+질문+요약까지 풍부)
//   ★다음/네이버 크리에이터 어드바이저는 JS렌더/로그인 필요 → 렌더러(웹뷰)에서 수집해
//     generatePost({ trends })로 주입(호출측이 trends 주면 그걸 우선 사용).
//   각 소스는 독립 try/catch — 하나 죽어도 나머지로 굴러가고, 전부 실패하면 [] (Claude 자가선택 폴백).

const https = require('https');

// 원시 바이트로 받기(인코딩이 EUC-KR일 수 있어 문자열 concat 금지).
function fetchBuffer(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Accept: '*/*' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('요청 시간초과')));
  });
}

// HTML/문자열에서 startIdx('{' 또는 '[')부터 짝이 맞는 닫힘까지의 JSON 덩어리를 뽑는다.
function extractBalanced(str, startIdx) {
  const open = str[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return str.slice(startIdx, i + 1); }
  }
  return null;
}

// ① signal.bz 실시간 검색어
async function fetchSignal() {
  const buf = await fetchBuffer('https://api.signal.bz/news/realtime');
  const j = JSON.parse(buf.toString('utf8'));
  return ((j && j.top10) || [])
    .map((x) => ({ keyword: String(x.keyword || '').trim(), rising: x.state === '+' || x.state === 'n', source: 'signal' }))
    .filter((x) => x.keyword);
}

// ② 네이트 실시간 검색어 (EUC-KR)
async function fetchNate() {
  const buf = await fetchBuffer('https://www.nate.com/js/data/jsonLiveKeywordDataV1.js');
  const text = new TextDecoder('euc-kr').decode(buf);
  const arr = JSON.parse(text); // [[rank, keyword, state, change, related], ...]
  return arr
    .map((row) => ({ keyword: String(row[1] || '').trim(), rising: row[2] === '+' || row[2] === 'n', source: 'nate' }))
    .filter((x) => x.keyword);
}

// ④ 구글 트렌드 실시간(새 trending RSS) — 키워드 + approx_traffic(근사 검색량 볼륨).
//    옛 daily RSS는 죽었고(404), 이 trending RSS는 살아있음. 볼륨 신호라 점수화에 유용.
async function fetchGoogleTrends() {
  const buf = await fetchBuffer('https://trends.google.com/trending/rss?geo=KR');
  const xml = buf.toString('utf8');
  const items = xml.split('<item>').slice(1);
  const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  const out = [];
  for (const it of items) {
    const tm = it.match(/<title>([\s\S]*?)<\/title>/);
    if (!tm) continue;
    const kw = decode(tm[1]);
    if (!kw) continue;
    const trm = it.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/);
    out.push({ keyword: kw, rising: true, traffic: trm ? trm[1].trim() : '', source: 'google' });
  }
  return out;
}

// ③ 줌 AI 이슈트렌드 (HTML 임베드 JSON — 키워드 + questions(글감 각도) + data(요약))
async function fetchZum() {
  const buf = await fetchBuffer('https://zum.com');
  const html = buf.toString('utf8');
  const key = '"issueRankingList":';
  const p = html.indexOf(key);
  if (p < 0) return [];
  const braceIdx = html.indexOf('{', p + key.length);
  const jsonStr = extractBalanced(html, braceIdx);
  if (!jsonStr) return [];
  const obj = JSON.parse(jsonStr);
  return ((obj && obj.items) || [])
    .map((it) => ({
      keyword: String(it.keyword || '').trim(),
      rising: true,
      question: String(it.questions || '').trim(), // "SK하이닉스 역대급 실적, HBM 효과 얼마나 갈까?" 같은 글감 각도
      summary: String(it.data || '').trim(),        // 요약(사실)
      facts: (it.news || []).map((n) => String((n && n.title) || '').trim()).filter(Boolean).slice(0, 4), // 실제 뉴스 제목
      source: 'zum',
    }))
    .filter((x) => x.keyword);
}

// ★팩트 그라운딩 — 키워드의 "실제 최신 뉴스 제목"을 네이버 뉴스 검색(최신순)에서 가져온다.
//   이걸 생성기에 주면 인물·사건을 지어내지 않고 실제 사실만 쓰게 된다. 무키(공개 검색).
async function fetchNewsHeadlines(keyword) {
  try {
    const url = 'https://search.naver.com/search.naver?where=news&sort=1&query=' + encodeURIComponent(keyword);
    const buf = await fetchBuffer(url);
    const html = buf.toString('utf8');
    const decode = (s) => s.replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const grab = (type, max) => {
      const re = new RegExp('<span[^>]*sds-comps-text-type-' + type + '[^>]*>([\\s\\S]*?)</span>', 'g');
      const out = []; let m;
      while ((m = re.exec(html)) && out.length < max) { const t = decode(m[1]); if (t) out.push(t); }
      return out;
    };
    // ★헤드라인(제목) + body1(기사 요약 스니펫)을 짝지어 "풍부한 사실"로 만든다.
    //   헤드라인만 주면 모델이 살을 지어냄(가짜 발언·틀린 별명) → 스니펫에 실제 내용이 있어 날조를 막는다.
    const heads = grab('headline1', 8);
    const bodies = grab('body1', 8);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      if (!h || seen.has(h)) continue;
      seen.add(h);
      const b = bodies[i];
      out.push(b && b.length > 20 ? `${h} — ${b.slice(0, 180)}` : h);
    }
    return out.slice(0, 8);
  } catch (e) {
    return [];
  }
}

// ★장소 실제 리뷰(네이버 블로그 검색) — 리뷰형에서 "그 장소가 어땠는지·좋은 점" 참고용(뉴스 아님).
//   제목+요약 스니펫을 모아 분위기·강점을 파악하게 한다. 그대로 베끼지 말고 참고(프롬프트에서 강제).
async function fetchPlaceReviews(placeName) {
  try {
    const q = (placeName || '').trim() + ' 후기';
    const url = 'https://search.naver.com/search.naver?where=blog&query=' + encodeURIComponent(q);
    const buf = await fetchBuffer(url);
    const html = buf.toString('utf8');
    const decode = (s) => s.replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const grab = (type, max) => {
      const re = new RegExp('<span[^>]*sds-comps-text-type-' + type + '[^>]*>([\\s\\S]*?)</span>', 'g');
      const out = []; let m;
      while ((m = re.exec(html)) && out.length < max) { const t = decode(m[1]); if (t) out.push(t); }
      return out;
    };
    const heads = grab('headline1', 8);
    const bodies = grab('body1', 8);
    const out = []; const seen = new Set();
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i]; if (!h || seen.has(h)) continue; seen.add(h);
      const b = bodies[i];
      out.push(b && b.length > 20 ? `${h} — ${b.slice(0, 160)}` : h);
    }
    return out.slice(0, 8);
  } catch (e) {
    return [];
  }
}

// ★근처 실제 관광지/명소 — 리뷰형에서 "근처 가볼만한 곳"에 진짜 명소(안성팜랜드 등)를 추천하기 위한 소스.
//   네이버 통합검색("○○ 가볼만한곳")의 장소 블록에 실제 명소가 순서대로 들어있다(키·로그인 불필요, 스크래핑).
//   장소명만 뽑아 리스트로 반환 → 프롬프트에 "이 목록의 실제 명소만 추천, 지어내기 금지"로 넣는다.
const _NEARBY_BAD = new Set(['전체', '자연명소', '체험관광', '문화유적', '역사관광', '레저스포츠', '아이와함께', '아이와', '데이트', '피크닉', '캠핑', '대형카페', '드라이브', '포토존', '일몰', '브런치', '카페', '디저트', '공연', '전시', '실내', '실외', '근처', '주변', '가볼만한곳', '가볼만한', '맛집', '더보기', '길찾기', '저장', '예약', '전화', '리뷰', '관광지', '여행', '명소', '코스', '물놀이']);
// ★식당·카페 이름은 제외 — "근처 가볼만한 곳"은 관광지·명소만(사용자 확정: 먹을데 말고 관광지로만).
const _NEARBY_FOOD = /(맛집|식당|국밥|해장|부대찌개|삼겹|고깃집|고기집|치킨|피자|버거|햄버거|파스타|카페|커피|베이커리|제과|분식|김밥|떡볶이|횟집|회집|초밥|스시|짬뽕|짜장|중화|족발|보쌈|곱창|막창|닭발|칼국수|국수|우동|라멘|쌀국수|샤브|뷔페|고로케|도넛|빙수|와인|호프|포차|주점|식육|정육|밥집|분식집)/;
async function fetchNearbyAttractions(region) {
  try {
    const reg = (region || '').trim();
    if (!reg) return [];
    const url = 'https://search.naver.com/search.naver?where=nexearch&query=' + encodeURIComponent(reg + ' 가볼만한곳');
    const html = (await fetchBuffer(url)).toString('utf8');
    const names = [...html.matchAll(/"name":"([^"]{2,30})"/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    // 앞머리 기관어 정리(농협경제지주 안성팜랜드 → 안성팜랜드)
    const clean = (n) => n.replace(/^(농협경제지주|주식회사|재단법인|사단법인|\(주\)|\(재\)|주\)|재\))\s*/, '').trim();
    const out = []; const seen = new Set();
    for (let raw of names) {
      let n = clean(raw);
      if (!n) continue;
      if (n.includes(',') || n.includes('・') || n.includes('·')) continue; // 주소경로·테마칩
      if (_NEARBY_BAD.has(n)) continue;
      if (_NEARBY_FOOD.test(n)) continue; // 식당·카페 제외(관광지만)
      if (n === reg || n.replace(/\s/g, '') === reg) continue;
      if (seen.has(n)) continue; seen.add(n);
      out.push(n);
      if (out.length >= 6) break;
    }
    return out;
  } catch (e) {
    return [];
  }
}

// ★블로그 본문 사실(제목+스니펫) — 뉴스에 안 나오는 "틈새 제도·서비스의 실제 정보"(신청자격·지원내용·비용 등)를
//   블로그 검색에서 가져온다. 정책·지원금·바우처·시험·절차처럼 "뉴스 헤드라인만으론 내용이 부족한" 주제에 필수.
//   ★그대로 베끼지 말고 "사실 근거"로만 쓰게 프롬프트가 강제(재작성). 부정확한 개인 블로그가 섞일 수 있으니 여러 개를 모아 교차.
async function fetchBlogFacts(keyword) {
  try {
    const url = 'https://search.naver.com/search.naver?where=blog&query=' + encodeURIComponent((keyword || '').trim());
    const buf = await fetchBuffer(url);
    const html = buf.toString('utf8');
    const decode = (s) => s.replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const grab = (type, max) => {
      const re = new RegExp('<span[^>]*sds-comps-text-type-' + type + '[^>]*>([\\s\\S]*?)</span>', 'g');
      const out = []; let m;
      while ((m = re.exec(html)) && out.length < max) { const t = decode(m[1]); if (t) out.push(t); }
      return out;
    };
    const heads = grab('headline1', 10);
    const bodies = grab('body1', 10);
    const out = []; const seen = new Set();
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i]; if (!h || seen.has(h)) continue; seen.add(h);
      const b = bodies[i];
      out.push(b && b.length > 20 ? `${h} — ${b.slice(0, 200)}` : h);
    }
    return out.slice(0, 8);
  } catch (e) {
    return [];
  }
}

// ★★뉴스 기사 "본문 전체"를 읽어온다 — 제목·스니펫(180자)만으론 경기 세부(누가 무슨 챔피언·몇 세트·라인업)를
//   알 수 없어 모델이 지어낸다(치명적 오류). 실제 기사 본문을 넘겨야 정확히 쓴다.
//   네이버 뉴스(n.news.naver.com)는 본문이 #dic_area에 있어 plain fetch로 읽힌다. 반환: [{title, body}]
function _stripHtml(s) {
  return String(s || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\[[^\]]{0,40}(기자|특파원)\]|\bⓒ[^ ]*|무단[ ]?전재[\s\S]*$|▶[\s\S]*$/g, ' ').replace(/\s+/g, ' ').trim();
}
// oid/aid로 기사 본문을 읽는다. ①스포츠/e스포츠/연예=api-gw JSON API(본문·인터뷰 Q&A까지) ②일반뉴스=n.news 모바일 #dic_area.
async function _fetchArticleBody(oid, aid, kind) {
  // 1) api-gw JSON (sports/esports/entertain)
  try {
    const host = kind === 'entertain' ? 'https://api-gw.entertain.naver.com/news/article/' : 'https://api-gw.sports.naver.com/news/article/';
    const j = JSON.parse((await fetchBuffer(host + oid + '/' + aid)).toString('utf8'));
    const a = j && j.result && j.result.articleInfo && j.result.articleInfo.article;
    if (a && (a.content || a.refinedContent)) {
      return { title: _stripHtml(a.title), body: _stripHtml(a.refinedContent || a.content) };
    }
  } catch (e) {}
  // 2) 일반뉴스 n.news 모바일 #dic_area
  try {
    const ah = (await fetchBuffer('https://n.news.naver.com/mnews/article/' + oid + '/' + aid)).toString('utf8');
    const bm = ah.match(/<article[^>]*id=["']dic_area["'][^>]*>([\s\S]*?)<\/article>/i);
    const tm = ah.match(/<h2[^>]*id=["']title_area["'][^>]*>([\s\S]*?)<\/h2>/i);
    if (bm) { const body = _stripHtml(bm[1]); if (body.length > 120) return { title: tm ? _stripHtml(tm[1]) : '', body }; }
  } catch (e) {}
  return null;
}
// oid/aid로 "기사 자체 이미지 + 사진별 캡션"을 읽는다(스포츠/e스포츠/연예 API). 캡션 = 그 사진에 누가/뭐가 있는지 = 관련성 판별 최고 근거.
async function _fetchArticleImageFiles(oid, aid, kind) {
  try {
    const host = kind === 'entertain' ? 'https://api-gw.entertain.naver.com/news/article/' : 'https://api-gw.sports.naver.com/news/article/';
    const j = JSON.parse((await fetchBuffer(host + oid + '/' + aid)).toString('utf8'));
    const a = j && j.result && j.result.articleInfo && j.result.articleInfo.article;
    const title = a ? _stripHtml(a.title) : '';
    const imf = (a && a.imageFiles) || [];
    return imf.map((im) => ({
      url: im.imageUrl || im.url || '',
      caption: _stripHtml(im.description || im.caption || '').replace(/\s*라이엇 게임즈 제공|\s*제공$|\s*=.*$/g, '').trim(),
      articleTitle: title,
    })).filter((x) => x.url && /^https?:\/\//.test(x.url));
  } catch (e) { return []; }
}
// ★기사 자체 이미지(+캡션) 수집 — 그 키워드 기사의 사진이라 무조건 관련됨 + 사진별 캡션으로 정밀 관련성.
//   반환: [{url, title}] (title = 캡션 있으면 캡션, 없으면 기사 제목 → 비전/제목 필터가 사용)
async function fetchArticleImages(keyword, { limit = 8 } = {}) {
  try {
    const kw = (keyword || '').trim();
    if (!kw) return [];
    const html = (await fetchBuffer('https://search.naver.com/search.naver?where=news&sort=1&query=' + encodeURIComponent(kw))).toString('utf8');
    const re = /https?:\/\/(?:m\.)?(sports|entertain|n)\.(?:news\.)?naver\.com\/[a-z]*\/?(?:mnews\/)?article\/(\d{2,4})\/(\d{6,})/gi;
    const seen = new Set(); const items = []; let m;
    while ((m = re.exec(html)) && items.length < 6) {
      const kind = m[1] === 'sports' ? 'sports' : m[1] === 'entertain' ? 'entertain' : 'news';
      const key = m[2] + '/' + m[3]; if (seen.has(key)) continue; seen.add(key);
      items.push({ oid: m[2], aid: m[3], kind });
    }
    const out = []; const seenUrl = new Set();
    for (const it of items) {
      if (out.length >= limit) break;
      const files = await _fetchArticleImageFiles(it.oid, it.aid, it.kind);
      for (const f of files) {
        if (out.length >= limit) break;
        const u = f.url.split('?')[0]; if (seenUrl.has(u)) continue; seenUrl.add(u);
        out.push({ url: f.url, title: f.caption || f.articleTitle || '' }); // 캡션 우선, 없으면 기사 제목
      }
    }
    return out;
  } catch (e) { return []; }
}
async function fetchNewsArticles(keyword, { limit = 3, maxLen = 1800 } = {}) {
  try {
    const kw = (keyword || '').trim();
    if (!kw) return [];
    const url = 'https://search.naver.com/search.naver?where=news&sort=1&query=' + encodeURIComponent(kw);
    const html = (await fetchBuffer(url)).toString('utf8');
    // 네이버 기사 링크(스포츠·연예·일반)에서 oid/aid + 종류 추출. 중복 제거.
    const re = /https?:\/\/(?:m\.)?(sports|entertain|n)\.(?:news\.)?naver\.com\/[a-z]*\/?(?:mnews\/)?article\/(\d{2,4})\/(\d{6,})/gi;
    const seen = new Set(); const items = []; let m;
    while ((m = re.exec(html)) && items.length < limit + 5) {
      const kind = m[1] === 'sports' ? 'sports' : m[1] === 'entertain' ? 'entertain' : 'news';
      const key = m[2] + '/' + m[3];
      if (seen.has(key)) continue; seen.add(key);
      items.push({ oid: m[2], aid: m[3], kind });
    }
    const out = [];
    for (const it of items) {
      if (out.length >= limit) break;
      const r = await _fetchArticleBody(it.oid, it.aid, it.kind);
      if (r && r.body && r.body.length > 120) out.push({ title: r.title, body: r.body.slice(0, maxLen) });
    }
    return out;
  } catch (e) { return []; }
}

// ★이 주제로 "지금 네이버 상단에 뜬 실제 제목들" — 제목 작성 시 톤·각도 참고용(그대로 베끼지 말 것, 프롬프트에서 강제).
//   블로그 검색 상위 "제목"만 모은다(스니펫 제외). 모델에 홈판 제목의 실전 감을 준다.
async function fetchTopTitles(keyword) {
  try {
    const kw = (keyword || '').trim();
    if (!kw) return [];
    const url = 'https://search.naver.com/search.naver?where=blog&query=' + encodeURIComponent(kw);
    const buf = await fetchBuffer(url);
    const html = buf.toString('utf8');
    const decode = (s) => s.replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const re = /<span[^>]*sds-comps-text-type-headline1[^>]*>([\s\S]*?)<\/span>/g;
    // 블로그 제목이 아닌 노이즈(지식백과·채널·위키 등) 제외.
    const isNoise = (t) =>
      /(?:^|[\-·|])\s*(?:나무위키|위키백과|namu\.?wiki|wikipedia|youtube|유튜브|블로그|포스트|네이버 지식|지식백과)\s*$/i.test(t) ||
      /\|\s*(?:tiktok|instagram|facebook|twitter|threads|x)\b/i.test(t) || // 소셜 프로필
      /\(@[\w.]+\)/.test(t) ||                                            // @핸들
      /^(?:연예|스포츠|정치|경제|사회|생활\/?문화|문화|국제|세계|IT\/?과학|IT)\s*[-·|]\s*\S{2,10}$/.test(t) || // 언론사 섹션 라벨
      /^https?:/i.test(t);
    const out = []; const seen = new Set(); let m;
    while ((m = re.exec(html)) && out.length < 16) {
      const t = decode(m[1]);
      if (t && t.length >= 6 && !seen.has(t) && !isNoise(t)) { seen.add(t); out.push(t); }
    }
    return out.slice(0, 10);
  } catch (e) {
    return [];
  }
}

// ⑤ 네이버 뉴스 섹션 헤드라인 — 사건/이슈 씨앗(홈판 자극 소재). 서버렌더라 무키로 됨.
//    section: 100=정치 101=경제 102=사회 103=생활/문화 104=세계 105=IT/과학
async function fetchNaverNews(section = '102', limit = 8) {
  const buf = await fetchBuffer('https://news.naver.com/section/' + section);
  const html = buf.toString('utf8');
  const decode = (s) => s
    .replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const out = [];
  const re = /<strong class="sa_text_strong">([\s\S]*?)<\/strong>/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const t = decode(m[1]);
    if (t) out.push({ keyword: t, rising: true, source: 'naver-news' });
  }
  return out;
}

/**
 * 다중 소스 실시간 트렌드 수집 → 병합·중복제거.
 * @returns {Promise<Array<{keyword:string, rising:boolean, source:string, question?:string}>>} 실패 시 []
 */
async function fetchRealtimeTrends() {
  const [signal, nate, zum, google, news] = await Promise.allSettled([
    fetchSignal(), fetchNate(), fetchZum(), fetchGoogleTrends(), fetchNaverNews('102'),
  ]);
  const norm = (s) => s.replace(/\s+/g, '').replace(/[^가-힣a-zA-Z0-9]/g, '');
  const seen = new Set();
  const merged = [];
  // 우선순위: 줌(질문·요약) → 구글(검색량) → signal → 네이트 → 네이버뉴스(사건/이슈)
  for (const r of [zum, google, signal, nate, news]) {
    if (r && r.status === 'fulfilled') {
      for (const t of r.value || []) {
        const k = norm(t.keyword);
        if (k && !seen.has(k)) { seen.add(k); merged.push(t); }
      }
    }
  }
  return merged;
}

module.exports = { fetchRealtimeTrends, fetchSignal, fetchNate, fetchZum, fetchGoogleTrends, fetchNaverNews, fetchNewsHeadlines, fetchNewsArticles, fetchArticleImages, fetchBlogFacts, fetchPlaceReviews, fetchNearbyAttractions, fetchTopTitles };
