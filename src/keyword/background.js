// 인물 "배경(과거 이력)" 자동 조사 — 나무위키에서 프로필·데뷔·결혼·이혼·수상 등 사실을 뽑는다.
//
// 왜 필요한가: 최신 뉴스 검색은 "지금 왜 떴는지"는 잘 잡지만, 미스코리아 출신·재벌혼·과거작 같은
//   "과거 배경"은 안 나온다. 그 배경이 있어야 "예전엔 이랬는데 지금은…" 어그로가 사실 기반으로 산다.
//
// 소스 선택(검증 2026-08-02): 위키백과 ko 도입부는 한 줄뿐(빈약) → 부적합.
//   나무위키는 브라우저 UA로 무키·무로그인 fetch 시 200 + 미스코리아/정용진/이혼/데뷔 다 포함(확인).
//   ★단 CC BY-NC-SA이므로 "사실만 추출 → 재작성(우리화)"으로만 쓴다(원문 복붙 금지). 앱은 이 배열을
//   프롬프트의 "배경 사실" 재료로만 넘긴다.
//
// 저작권/안정성: 837KB로 무거움 → 호출측이 캐시할 것. 막히면 [] 반환 → generatePost가 뉴스 배경검색으로 폴백.

const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ★인물 배경 캐시(같은 인물 재조회 시 837KB 재다운 방지). 성공분만 24시간 보관.
//   디스크에 영속화 → 앱 재시작해도 유지. 저장 데이터=추출 문장(가벼움).
const _cache = new Map(); // key(이름+문맥서명) → { at:ms, data:string[] }
const CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 300; // 파일 비대화 방지(최신 300개만 보관)

// 저장 폴더: 명시 설정 > 환경변수 > Electron userData > 홈폴더(.naver-auto). CLI에서도 안전.
let _cacheDir = null;
function setCacheDir(dir) { if (dir) { _cacheDir = dir; _loaded = false; } }
function cacheDir() {
  if (_cacheDir) return _cacheDir;
  if (process.env.NAVER_AUTO_CACHE_DIR) return (_cacheDir = process.env.NAVER_AUTO_CACHE_DIR);
  try { const { app } = require('electron'); if (app && app.getPath) return (_cacheDir = app.getPath('userData')); } catch (e) { /* 비-Electron */ }
  return (_cacheDir = path.join(os.homedir(), '.naver-auto'));
}
function cacheFile() { return path.join(cacheDir(), 'person-bg-cache.json'); }

let _loaded = false;
function loadCache() {
  if (_loaded) return;
  _loaded = true;
  try {
    const obj = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (v && v.at && now - v.at < CACHE_TTL && Array.isArray(v.data)) _cache.set(k, v);
    }
  } catch (e) { /* 파일 없음/파손 → 빈 캐시로 시작 */ }
}
function saveCache() {
  try {
    const now = Date.now();
    // 만료 제거 + 최신순 상한 유지
    const entries = [..._cache.entries()]
      .filter(([, v]) => now - v.at < CACHE_TTL)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    _cache.clear(); entries.forEach(([k, v]) => _cache.set(k, v));
    const dir = cacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(Object.fromEntries(entries)));
  } catch (e) { /* 저장 실패 무시(다음 기회) */ }
}

function fetchHtml(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        },
      },
      (resp) => {
        // 리다이렉트(동명이인 대표문서 등) 1회 따라감
        if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
          const next = resp.headers.location.startsWith('http')
            ? resp.headers.location
            : 'https://namu.wiki' + resp.headers.location;
          resp.resume();
          return resolve(fetchHtml(next));
        }
        if (resp.statusCode !== 200) { resp.resume(); return resolve(''); }
        let d = '';
        resp.on('data', (c) => (d += c));
        resp.on('end', () => resolve(d));
      },
    );
    req.on('error', () => resolve(''));
    req.setTimeout(15000, () => { req.destroy(); resolve(''); });
  });
}

// ── 동명이인 판별 헬퍼 ───────────────────────────────────────────────
// 흔한 잡음어(인물 식별에 의미 없음) — 문맥 토큰에서 뺀다.
const STOP = new Set(['근황', '사진', '공개', '기자', '뉴스', '오늘', '지난', '최근', '이번', '대한', '관련', '이후', '모습', '진짜', '이유', '대해', '이날', '당시', '전했다', '밝혔다', '이라고', '누리꾼']);
// 문자열(들)에서 2글자+ 한글/영문 토큰 집합을 만든다(잡음어 제외).
function tokens(strs) {
  const text = Array.isArray(strs) ? strs.join(' ') : String(strs || '');
  const set = new Set();
  (text.match(/[가-힣]{2,}|[A-Za-z]{2,}/g) || []).forEach((w) => { if (!STOP.has(w)) set.add(w); });
  return set;
}
// 나무위키 "분류"(카테고리) 구간을 뽑는다: "분류 … 1 ." 사이. 실패 시 분류 뒤 텍스트로 폴백.
function categoriesOf(cleanText) {
  const m = cleanText.match(/분류\s+([\s\S]{0,260}?)\s+\d+\s*\./);
  if (m) return m[1];
  const i = cleanText.indexOf('분류');
  return i >= 0 ? cleanText.slice(i + 2, i + 2 + 240) : cleanText.slice(0, 200);
}
// 인물 페이지 신호(분류에 이런 게 있으면 그 이름의 대표 인물 문서).
const PERSON_SIGNAL = /출생|출신 인물|여가수|남가수|여배우|남배우|드라마 배우|영화 배우|축구|야구|농구|배구|골프|테니스|아이돌|가수|배우|선수|감독|모델|개그맨|코미디언|방송인|아나운서|정치인|유튜버|프론트맨|보컬|래퍼|성우|프로듀서|MC/;
// 동음이의어/동명이인 "목록" 페이지인가 = 그 분류인데 특정 인물 신호가 없다.
function isDisambList(cats) {
  return /동음이의어|동명이인/.test(cats) && !PERSON_SIGNAL.test(cats);
}
// 동명이인 페이지 본문에서 "이름(수식어)" 후보 문서명을 뽑는다(예: "정유미(1983)", "정유미(기자)").
function candidatesFromText(cleanText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc + '\\([^)]{1,20}\\)', 'g');
  return [...new Set(cleanText.match(re) || [])];
}
// ★네 방식: "왜 떴는지(그룹/소속)"를 뉴스·자동완성에서 뽑아 "이름(그룹)" 문서를 직접 찾는다.
//   나무위키 목록 페이지가 멤버를 "이름(그룹)"으로 직접 링크 안 하는 경우가 많아(마크→NCT 검증) 목록파싱은 불안정.
//   대신 그룹/소속 후보로 문서 제목을 구성해 시도한다(예: 자동완성 "마크 nct" → "마크(NCT)").
//   ★자동완성(hint)=검색 의도라 1순위, 그다음 뉴스는 빈도순. 영문은 대문자로 통일해 구성.
function qualifierCandidates(ctxText, hintText) {
  const engOf = (text) => (String(text || '').match(/[A-Za-z]{2,}/g) || []).map((s) => s.toUpperCase());
  const korOf = (text) => (String(text || '').match(/[가-힣]{2,4}/g) || []).filter((t) => !STOP.has(t));
  const hintEng = engOf(hintText), hintKor = korOf(hintText);
  const ctxEng = engOf(ctxText);
  const freq = {}; ctxEng.forEach((t) => { freq[t] = (freq[t] || 0) + 1; });
  const ctxEngRanked = [...new Set(ctxEng)].sort((a, b) => freq[b] - freq[a]); // 자주 나온 그룹 유력
  // 순서: 자동완성 영문 → 자동완성 한글 → 뉴스 영문(빈도순). 흔한 약어 잡음은 뒤로.
  const NOISE = new Set(['THE', 'TV', 'AI', 'SNS', 'MV', 'OST', 'LIVE', 'ABC', 'NYT', 'CEO', 'MC']);
  const ranked = [...new Set([...hintEng, ...hintKor, ...ctxEngRanked])];
  return [...ranked.filter((t) => !NOISE.has(t)), ...ranked.filter((t) => NOISE.has(t))].slice(0, 8);
}
// 인물 페이지가 최근 뉴스 문맥의 "그 사람"이 맞는지(토큰 겹침). 문맥 빈약하면 검증 스킵(수용).
function matchesContext(cleanText, cats, ctxTokens, name) {
  if (!ctxTokens || ctxTokens.size < 4) return true;
  // 뉴스가 이 인물 이름을 아예 언급 안 하면 → 다른 사람일 가능성(교차도메인 오접속 차단).
  if (name && name.length >= 2 && !ctxTokens.has(name)) return false;
  const pageToks = tokens(cats + ' ' + cleanText.slice(0, 1500));
  let hit = 0;
  ctxTokens.forEach((t) => { if (pageToks.has(t)) hit += 1; });
  return hit >= 2; // 이름 + 최소 1개 더 겹치면 같은 인물로 인정(느슨)
}

// HTML → 사람이 읽을 수 있는 텍스트(스크립트·스타일·태그·엔티티 제거).
function htmlToText(html) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
  return t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// 정제된 나무위키 텍스트 → 배경 사실 "서술문"만 추출(어그로용 가십 서사 우선).
function extractSentences(text, limit) {
  const rawSents = text
    .split(/(?<=[.!?」』\]])\s+|\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .map((s) => s.replace(/(\s*\[\d+\])+\s*$/, '')) // 끝의 각주 마커 제거
    .map((s) => s.replace(/^[\s,#·•\-–—.]+/, '').trim()); // 앞의 조각 부호 제거
  // ★인포박스·메뉴 나열을 걷어내려면 "진짜 서술문(~했다/~이다로 끝남)"만 남긴다.
  const isSentence = (s) => /(다|요|함|음)[.!?」』)\]]?$/.test(s) && /[가-힣]/.test(s);
  const BG_KW = [
    '미스코리아', '데뷔', '결혼', '이혼', '재혼', '연애', '열애', '재벌', '회장',
    '수상', '대상', '신인상', '주연', '출연', '복귀', '입대', '제대', '결성', '탈퇴',
    '논란', '사건', '루머', '화제', '출산', '임신', '별세', '사망', '투병',
  ];
  const isNoise = (s) =>
    s.length < 14 || s.length > 240 ||
    /편집|리다이렉트|나무위키|CCL|저작권|목차|각주|분류:|파일:|더 보기|접기|펼치기|틀:|토론/.test(s) ||
    (s.match(/\[\d+\]/g) || []).length > 1 ||
    (s.match(/ /g) || []).length > 34; // 링크·메뉴 나열(공백 과다)
  const seen = new Set();
  const primary = []; // 서술문 + 배경 키워드(가십 서사)
  const filler = []; // 그 외 서술문(도입부 프로세)
  for (const s of rawSents) {
    if (!isSentence(s) || isNoise(s) || seen.has(s)) continue;
    seen.add(s);
    if (BG_KW.some((k) => s.includes(k))) primary.push(s);
    else filler.push(s);
    if (primary.length >= limit) break;
  }
  return [...primary, ...filler].slice(0, limit);
}

/**
 * 나무위키에서 인물 배경 사실 문장들을 뽑는다(동명이인 판별 포함).
 * @param {string} name  인물 이름(코어 엔티티). 예: "고현정"
 * @param {object} [opts]
 * @param {number} [opts.limit=12]  최대 문장 수
 * @param {string[]} [opts.context] 최근 뉴스 등 "지금 그 사람" 문맥 → 동명이인 판별에 사용.
 * @param {string[]} [opts.hints]   자동완성 롱테일(="마크 nct") → 그룹/소속 판별 1순위 힌트.
 * @returns {Promise<string[]>} 배경 사실 문장 배열(실패/차단/불일치 시 [])
 */
async function fetchNamuBackground(name, { limit = 12, context = null, hints = null } = {}) {
  const clean = (name || '').trim();
  if (!clean) return [];
  loadCache(); // 첫 호출 시 디스크에서 복원
  const ctxTokens = context ? tokens(context) : null;
  const ctxText = Array.isArray(context) ? context.join(' ') : (context || '');
  const hintText = Array.isArray(hints) ? hints.join(' ') : (hints || '');
  // ★캐시 키에 문맥 서명 포함 — 같은 이름이라도 문맥(그룹)에 따라 다른 인물로 해석되므로(마크+NCT vs 마크 단독).
  const cacheKey = clean + '¦' + (ctxTokens && ctxTokens.size ? [...ctxTokens].sort().join(',') : '');
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data.slice(0, limit);
  const looksBlocked = (h) => !h || h.length < 2000 || /Just a moment|Enable JavaScript|cf-browser-verification/i.test(h);
  const load = async (title) => {
    const html = await fetchHtml('https://namu.wiki/w/' + encodeURIComponent(title));
    if (looksBlocked(html) || !html.includes(clean)) return null;
    const text = htmlToText(html);
    return { html, text, cats: categoriesOf(text) };
  };
  try {
    let doc = await load(clean);
    if (!doc) return [];

    // 애매하면(동음이의어 목록 페이지 or 인물 페이지인데 문맥의 그 사람이 아님) → 그룹기반으로 다시 찾는다.
    const ambiguous =
      isDisambList(doc.cats) ||
      (ctxTokens && !matchesContext(doc.text, doc.cats, ctxTokens, clean));
    if (ambiguous) {
      if (!ctxTokens) return []; // 문맥 없으면 어느 인물인지 못 정함 → 폴백(뉴스)
      let picked = null;
      // (1) 그룹 fast-path — "이름(그룹)"을 자동완성·뉴스 그룹명으로 직접 구성(아이돌 등, 예: "마크(NCT)").
      for (const q of qualifierCandidates(ctxText, hintText)) {
        if (q === clean) continue;
        const d = await load(`${clean}(${q})`);
        if (d && !isDisambList(d.cats) && matchesContext(d.text, d.cats, ctxTokens, clean)) { picked = d; break; }
      }
      // (2) 배우 등 — 동명이인 본문에서 후보 문서(정유미(1983)…)를 뽑아 각 페이지의 "작품(필모)"을
      //     최근 뉴스 문맥과 비교해 가장 많이 겹치는 인물을 고른다(=최근 드라마로 구분).
      if (!picked) {
        let bestHit = 1; // 이름만 겹치는 건 무의미 → 2개+ 요구
        for (const title of candidatesFromText(doc.text, clean).slice(0, 5)) {
          if (title === clean) continue;
          const d = await load(title);
          if (!d || isDisambList(d.cats)) continue;
          const pageToks = tokens(d.cats + ' ' + d.text.slice(0, 8000)); // 필모까지 포함되게 넉넉히
          let hit = 0; ctxTokens.forEach((t) => { if (pageToks.has(t)) hit += 1; });
          if (hit > bestHit) { bestHit = hit; picked = d; }
        }
      }
      if (!picked) return []; // 못 찾으면 폴백(뉴스 배경검색이 실제 화제 인물 기준이라 안전)
      doc = picked;
    }

    const out = extractSentences(doc.text, limit);
    if (out.length) { _cache.set(cacheKey, { at: Date.now(), data: out }); saveCache(); } // 성공분만 캐시(디스크 영속)
    return out;
  } catch (e) {
    return [];
  }
}

module.exports = { fetchNamuBackground, setCacheDir };
