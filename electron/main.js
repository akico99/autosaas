// Electron 메인 프로세스 — 앱 껍데기 + 우리 Node 모듈을 렌더러(UI)에 연결한다.
//
// 첫 마일스톤: 창 하나 + 키워드 파이프라인(src/keyword/radar)을 IPC로 UI에 노출.
//   → "우리가 만든 Node 모듈이 Electron 안에서 실제로 돈다"를 증명.
//   이후 여기에 생성기(generatePost/generateSearchPost)·네이버 편집기 webview 등을 붙인다.

const { app, BrowserWindow, ipcMain, dialog, session, clipboard, webContents, shell, nativeImage, powerSaveBlocker } = require('electron');
const { createRenderedCollector } = require('./renderedCollector');

// ★#8 방송 캡쳐 "하단" 워터마크 크롭 — 방송사 자막·로고 워터마크는 대부분 화면 "아래쪽 띠"에 있음(실무자 확인).
//   이미지 아래쪽 pct(기본 13%)만큼을 잘라내 워터마크를 제거한다. Electron 내장 nativeImage(추가 설치 0).
//   실패하면 원본 그대로 둔다(글 생성 안 막힘). 파일을 제자리에 덮어쓴다.
function cropBottomBanner(filePath, pct = 0.13) {
  const img = nativeImage.createFromPath(filePath);
  if (!img || img.isEmpty()) return false;
  const { width, height } = img.getSize();
  if (!width || !height) return false;
  const cut = Math.round(height * pct);
  if (cut < 4 || cut >= height - 20) return false; // 너무 작거나(무의미) 사진 대부분을 자르면 스킵
  const cropped = img.crop({ x: 0, y: 0, width, height: height - cut }); // 위는 남기고 아래를 잘라냄
  const isPng = /\.png$/i.test(filePath);
  const buf = isPng ? cropped.toPNG() : cropped.toJPEG(92);
  require('fs').writeFileSync(filePath, buf);
  return true;
}
// ★상단(얼굴) 크롭 — 좋은 사진인데 위쪽에 일반인 얼굴이 있을 때, 위 일부를 잘라 얼굴을 없애고 아래(손·물건·본문)만 쓴다.
function cropTopBanner(filePath, pct = 0.4) {
  const img = nativeImage.createFromPath(filePath);
  if (!img || img.isEmpty()) return false;
  const { width, height } = img.getSize();
  if (!width || !height) return false;
  const cut = Math.round(height * pct);
  if (cut < 4 || cut >= height - 20) return false;
  const cropped = img.crop({ x: 0, y: cut, width, height: height - cut }); // 위를 잘라내고 아래를 남긴다
  const isPng = /\.png$/i.test(filePath);
  const buf = isPng ? cropped.toPNG() : cropped.toJPEG(92);
  require('fs').writeFileSync(filePath, buf);
  return true;
}
const path = require('path');
const http = require('http');
const fs = require('fs');
// ★네이버·외부 사이트 마크업 의존부(셀렉터·페이지 추출 스크립트)는 전부 여기 한 곳.
const M = require('../src/scrape/markup');
// ★수집 자가진단 — "조용한 0건"(구조 변경)을 생성 결과에 실어 보낸다.
const scrapeHealth = require('../src/scrape/health');
const { createEntry, matchPublished, linkManually, dueChecks, findRank, addCheck, summarize } = require('../src/performance/tracker');
const { guardedSearchFetch, runGuardedSearch, isSearchBlocked, getBlockState, NaverSearchBlockedError, setStorageDir } = require('../src/scrape/naverSearchGuard');
const { observeSerp } = require('../src/keyword/serpObserve');

function readSearchPerformance() {
  const file = path.join(app.getPath('userData'), 'search-performance.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.version === 1 && Array.isArray(saved.entries)) return saved;
  } catch (e) {}
  return { version: 1, entries: [] };
}

function writeSearchPerformance(data) {
  const file = path.join(app.getPath('userData'), 'search-performance.json');
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: Array.isArray(data.entries) ? data.entries : [] }, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

async function fetchMyBlogPosts(blogId) {
  try {
    if (!blogId) return { ok: false, posts: [] };
    const https = require('https');
    const get = (url) => new Promise((resolve) => {
      try {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://blog.naver.com/' } }, (response) => {
          let data = ''; response.on('data', (chunk) => (data += chunk)); response.on('end', () => resolve(data));
        }).on('error', () => resolve('')).setTimeout(9000, function () { try { this.destroy(); } catch (e) {} resolve(''); });
      } catch (e) { resolve(''); }
    });
    let posts = [];
    for (let page = 1; page <= 2; page++) {
      const raw = await get('https://blog.naver.com/PostTitleListAsync.naver?blogId=' + encodeURIComponent(blogId) + '&currentPage=' + page + '&countPerPage=30&categoryNo=0&parentCategoryNo=&viewdate=');
      let json = null; try { json = JSON.parse(raw); } catch (e) {}
      const list = json && Array.isArray(json.postList) ? json.postList : [];
      for (const post of list) {
        if (String(post.openType) !== '2' || !post.logNo) continue;
        let title = String(post.title || '');
        try { title = decodeURIComponent(title.replace(/\+/g, ' ')); } catch (e) {}
        title = title.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").trim();
        const item = { title, url: 'https://blog.naver.com/' + blogId + '/' + post.logNo, categoryNo: String(post.categoryNo || '') };
        if (post.addDate != null) item.addDate = post.addDate;
        posts.push(item);
      }
      if (list.length < 30) break;
    }
    const seen = new Set();
    posts = posts.filter((post) => post.url && !seen.has(post.url) && seen.add(post.url));
    return { ok: true, posts };
  } catch (error) { return { ok: false, error: error.message, posts: [] }; }
}

// ★앱 표시 이름. userData 폴더는 이름과 분리해 고정(이름을 바꿔도 로그인 세션이 유지되게).
try { app.setPath('userData', path.join(app.getPath('appData'), 'blog-auto')); } catch (e) {}
try { app.setName('블로그 자동글쓰기'); } catch (e) {}

// ★로컬 정적 서버 — file:// 대신 http로 띄워 유튜브 임베드 등 origin 문제 해결.
const APP_ROOT = path.join(__dirname, '..');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml',
  '.webp':'image/webp', '.otf':'font/otf', '.woff2':'font/woff2', '.json':'application/json', '.ico':'image/x-icon' };
function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' ) p = '/app/login.html';
    const file = path.normalize(path.join(APP_ROOT, p));
    if (!file.startsWith(APP_ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      // ★캐시 금지 — 코드 수정 후 새로고침하면 항상 최신 파일이 뜨도록(개발·테스트 편의).
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      res.end(data);
    });
  });
  // ★고정 포트 — 랜덤 포트(0)면 실행마다 origin이 바뀌어 localStorage(글씨체·정렬·예약설정 등 "저장돼요")가 매번 초기화된다.
  //   고정하면 origin이 같아 저장값이 유지됨. 혹시 포트가 점유돼 있으면 랜덤으로 폴백(그땐 저장 유지 안 되지만 실행은 됨).
  const FIXED_PORT = 47318;
  return new Promise((resolve) => {
    const onListen = () => resolve(server.address().port);
    server.once('error', (e) => {
      if (e && e.code === 'EADDRINUSE') { try { server.listen(0, '127.0.0.1', onListen); } catch (_) {} }
    });
    server.listen(FIXED_PORT, '127.0.0.1', onListen);
  });
}
let APP_PORT = 0;

// ★세션 쿠키 → 지속 쿠키 변환. 네이버 로그인 쿠키(NID_AUT 등)가 만료시간 없는
//   세션 쿠키로 오면 앱 종료 시 사라진다. 만료시간(30일)을 붙여 디스크에 고정한다.
async function persistSessionCookies() {
  try {
    const ses = session.fromPartition('persist:naver');
    const all = await ses.cookies.get({});
    const nowSec = Math.floor(Date.now() / 1000);
    const KEEP = 60 * 60 * 24 * 30; // 30일
    for (const c of all) {
      if (!c.session) continue; // 이미 만료시간 있는 쿠키는 건드리지 않음
      const host = (c.domain || '').replace(/^\./, '');
      if (!host) continue;
      // ★소셜 로그인(카카오) 쿠키는 다시 set 하지 않는다 — 세션 쿠키를 재설정하면 OAuth 세션이 깨진다.
      if (/kakao\.com|kauth|kakaocdn/i.test(host)) continue;
      const url = (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
      try {
        await ses.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: nowSec + KEEP,
        });
      } catch (e) { /* 개별 쿠키 실패는 무시 */ }
    }
    // (진단) 네이버 로그인 핵심 쿠키 상태를 파일로 — 지속쿠키(session:false)인지 확인용.
    try {
      const auth = all.filter((c) => /NID_AUT|NID_SES|NID_JKL|nid_inf/i.test(c.name));
      const dump = auth.map((c) => `${c.name} session=${c.session} exp=${c.expirationDate ? new Date(c.expirationDate * 1000).toISOString().slice(0, 16) : '-'} domain=${c.domain} secure=${c.secure} sameSite=${c.sameSite}`).join('\n');
      fs.writeFileSync(path.join(app.getPath('userData'), 'naver-cookie-debug.txt'), (auth.length ? dump : '(네이버 로그인 쿠키 없음 = 로그아웃)') + '\n\nat ' + new Date().toISOString());
    } catch (e) {}
    ses.cookies.flushStore();
  } catch (e) { /* ignore */ }
}

// 사진 불러오기 시작 폴더 — 처음엔 다운로드, 이후엔 마지막 고른 폴더를 기억.
let lastImageDir = null;
// 자동 로그인 유지(기본 true). false면 종료 시 네이버 세션 삭제.
let keepSession = true;

// ★엔터/스포츠 랭킹 = JS 렌더 페이지 → 숨은 창으로 렌더 후 DOM 긁기(네이버 세션 사용).
//   페이지 하나 로드 → JS 실행 → 결과 반환 → 창 폐기.
const scrapeRendered = createRenderedCollector({ BrowserWindow });

// ★★공식 사실 수집 = "네이버 AI브리핑 요약 + 정부/기관 페이지 본문"을 JS 렌더링으로 읽는다(주력 근거).
//   블로그는 부실할 수 있어 보조로만 → 이건 공식/정확 출처. (부평구청 복지ON 같은 .go.kr 페이지 실제 내용)
const _DESKTOP_UA_OF = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
function isInstitutionCandidateUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    const inDomain = (domain) => host === domain || host.endsWith('.' + domain);
    return ['go.kr', 'korea.kr', 'bokjiro.go.kr', 'or.kr'].some(inDomain);
  } catch (e) { return false; }
}
function isGovernmentSourceUrl(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    return ['go.kr', 'korea.kr'].some((domain) => host === domain || host.endsWith('.' + domain));
  } catch (e) { return false; }
}
async function fetchOfficialFacts(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return { brief: '', pages: [], urls: [], collectedAt: null };
  // 1) 통합검색 렌더 → AI브리핑/상단 요약 텍스트 + 정부·기관 링크
  const searchUrl = 'https://search.naver.com/search.naver?query=' + encodeURIComponent(kw);
  const SEARCH_EXTRACT = "(function(){var out={brief:'',urls:[]};try{out.blocked=!!((document.body&&document.body.innerText)||'').includes('검색 서비스 이용이 제한되었습니다');function T(e){return (e&&e.innerText||'').replace(/\\s+/g,' ').trim();}"
    + "var sel=['.api_subject_bx','.sc_new','[class*=brief]','[class*=answer]','[class*=summary]','.main_pack .total_wrap','#main_pack'];"
    + "var chunks=[],seen1={};for(var i=0;i<sel.length;i++){var els=document.querySelectorAll(sel[i]);for(var j=0;j<els.length;j++){var t=T(els[j]);if(t.length>90&&!seen1[t.slice(0,40)]){seen1[t.slice(0,40)]=1;chunks.push(t);}if(chunks.length>=6)break;}if(chunks.length>=6)break;}"
    + "out.brief=chunks.join(' | ').slice(0,3500);if(out.brief.length<120){out.brief=T(document.querySelector('#main_pack')||document.body).slice(0,3000);}"
    + "function official(u){try{var p=new URL(u),h=p.hostname.toLowerCase();function d(x){return h===x||h.endsWith('.'+x);}return p.protocol==='https:'&&!p.username&&!p.password&&(d('go.kr')||d('korea.kr')||d('bokjiro.go.kr')||d('or.kr'));}catch(e){return false;}}"
    + "var seen={};var as=document.querySelectorAll('a');for(var k=0;k<as.length;k++){var h=as[k].href||'';if(official(h)&&!seen[h]){seen[h]=1;out.urls.push(h.split('#')[0]);}if(out.urls.length>=4)break;}"
    + "}catch(e){}return JSON.stringify(out);})()";
  const SEARCH_READY = "(function(){var e=document.querySelector('#main_pack,.api_subject_bx,.sc_new');var t=(e&&e.innerText||'').replace(/\\s+/g,' ').trim();return !!e&&(t.length>=80||/검색\\s*결과가\\s*없습니다/.test(t));})()";
  let brief = '', urls = [], searchCollectedAt = null;
  try {
    const response = await runGuardedSearch('rendered:' + searchUrl, async () => {
      const r = await scrapeRendered(searchUrl, SEARCH_EXTRACT, 0, 'persist:naver-search', _DESKTOP_UA_OF, { readyScript: SEARCH_READY, timeoutMs: 12000 });
      if (r && r.error) {
        const status = Number(r.status) || undefined;
        const kind = r.kind || (status === 429 ? 'rate_limited' : status === 403 ? 'blocked' : 'load_error');
        throw Object.assign(new Error(r.error), { kind, status, code: r.code || (status === 429 ? 'NAVER_SEARCH_RATE_LIMITED' : status === 403 ? 'NAVER_SEARCH_BLOCKED' : 'RENDER_LOAD_ERROR') });
      }
      const j = typeof r === 'string' ? JSON.parse(r) : (r || {});
      const status = Number(j.status) || (j.blocked ? 403 : 200);
      return { status, body: j.blocked ? '검색 서비스 이용이 제한되었습니다' : JSON.stringify(j) };
    });
    const j = JSON.parse(response.body.toString('utf8'));
    brief = (j && j.brief) || ''; urls = (j && Array.isArray(j.urls) ? j.urls : []);
    searchCollectedAt = response.collectedAt || null;
  } catch (e) {
    const blocked = e instanceof NaverSearchBlockedError || e && (
      e.code === 'NAVER_SEARCH_BLOCKED' || e.code === 'NAVER_SEARCH_RATE_LIMITED'
        || e.kind === 'blocked' || e.kind === 'rate_limited'
    );
    const errorKind = e && e.kind || (blocked ? 'blocked' : 'render_error');
    const status = Number(e && e.status) || undefined;
    scrapeHealth.record('official-facts', 0, { query: kw, blocked, status, errorKind, errorCode: e && e.code || '', resultKind: 'error' });
    return {
      brief: '', pages: [], urls: [], collectedAt: null,
      error: { kind: errorKind, status: status || null, code: e && e.code || '', message: e && e.message || '공식 출처 검색에 실패했습니다.' },
    };
  }
  // 2) 상위 정부/기관 페이지 1~2개 렌더 → 본문 텍스트(자격·금액·사용처·신청)
  const pages = [];
  const PAGE_EXTRACT = "(function(){try{var m=document.querySelector('#content')||document.querySelector('#container')||document.querySelector('.contents')||document.querySelector('main')||document.querySelector('[role=main]')||document.body;var t=(m.innerText||'').replace(/\\s+/g,' ').trim();return JSON.stringify({url:location.href,title:document.title||'',text:t.slice(0,2600)});}catch(e){return JSON.stringify({error:String(e)});}})()";
  const PAGE_READY = "(function(){var m=document.querySelector('#content')||document.querySelector('#container')||document.querySelector('.contents')||document.querySelector('main')||document.querySelector('[role=main]');if(!m)return false;var t=(m.innerText||'').replace(/\\s+/g,' ').trim();var blocks=m.querySelectorAll('p,li,td,dd,article,[itemprop=articleBody]');var meaningful=false;for(var i=0;i<blocks.length;i++){if((blocks[i].innerText||blocks[i].textContent||'').replace(/\\s+/g,' ').trim().length>=48){meaningful=true;break;}}return t.length>=120&&meaningful;})()";
  // ★다운로드 파일(.hwp·pdf·문서·zip)이나 /download 링크는 열지 않는다 — 저장 대화상자가 떠서 앱이 멈춘다(법무부 .hwp 등). (홈판·검색 공통 안전 필터)
  const _isDownloadUrl = (u) => /\.(hwp|hwpx|pdf|docx?|xlsx?|pptx?|zip|egg|al[zx]|tar|gz)(\?|#|$)/i.test(u || '') || /[/?&](download|filedown|fileDownload|down)\b/i.test(u || '');
  urls = (Array.isArray(urls) ? urls : []).filter((u) => isInstitutionCandidateUrl(u) && !_isDownloadUrl(u));
  const pageErrors = [];
  for (const u of urls.slice(0, 2)) {
    if (_isDownloadUrl(u)) continue;
    try {
      const result = await scrapeRendered(u, PAGE_EXTRACT, 0, 'persist:naver', _DESKTOP_UA_OF, { readyScript: PAGE_READY, timeoutMs: 12000 });
      if (result && result.error) throw Object.assign(new Error(result.error), { kind: result.kind || 'parse_error', status: result.status, code: result.code });
      let parsed;
      try { parsed = typeof result === 'string' ? JSON.parse(result) : result; } catch (e) { parsed = { title: '', text: String(result || '') }; }
      if (parsed && parsed.error) throw Object.assign(new Error(parsed.error), { kind: 'parse_error', code: 'OFFICIAL_PAGE_EXTRACTION_FAILED' });
      const text = String(parsed && parsed.text || '').replace(/\s+/g, ' ').trim();
      const pageUrl = String(parsed && parsed.url || u);
      if (!isInstitutionCandidateUrl(pageUrl)) throw Object.assign(new Error('기관 검색 결과와 실제 페이지 주소가 일치하지 않습니다.'), { kind: 'provenance_mismatch', code: 'OFFICIAL_PAGE_URL_MISMATCH' });
      if (text.length >= 120) pages.push({
        url: pageUrl, title: String(parsed.title || ''), text: text.slice(0, 2600), collectedAt: new Date().toISOString(),
        sourceType: isGovernmentSourceUrl(pageUrl) ? 'institution-page' : 'page-body',
        kind: isGovernmentSourceUrl(pageUrl) ? 'article-body' : 'page-body', contentKind: 'body', provenance: 'rendered-page',
      });
      else pageErrors.push({ kind: 'parser_mismatch', status: null, code: 'OFFICIAL_PAGE_BODY_MISSING' });
    } catch (e) {
      pageErrors.push({ kind: e && e.kind || 'load_error', status: Number(e && e.status) || null, code: e && e.code || '' });
    }
  }
  const pageError = pages.length ? null : pageErrors[0] || null;
  const resultKind = pages.length ? 'ok' : urls.length ? 'parser_mismatch' : 'empty';
  scrapeHealth.record('official-facts', pages.length, {
    query: kw, resultKind,
    ...(pageError ? { errorKind: pageError.kind, status: pageError.status, errorCode: pageError.code } : {}),
  });
  return {
    brief, pages, urls, collectedAt: searchCollectedAt,
    ...(pageError ? { error: { ...pageError, message: '기관 페이지 본문을 확인하지 못했습니다.' } } : {}),
  }; // urls는 이미지 후보 발견 경로이며 원문 근거와 구분한다.
}

// ★한 글당 "글쓰기" 토큰 사용량을 token-usage.log에 기록 → 5시간에 몇 개 가능한지 실측용. (모델=Opus/Sonnet 확인 포함)
function logTokenUsage(kind, kw, meta) {
  try {
    const u = (meta && meta.usage) || {};
    const _rawIn = u.input_tokens || 0;                  // 캐시 안 탄 순수 입력
    const _cacheRead = u.cache_read_input_tokens || 0;   // 캐시에서 재사용(싸다) — 크면 캐싱 잘 되는 것
    const _cacheCreate = u.cache_creation_input_tokens || 0; // 캐시 최초 생성
    const _in = _rawIn + _cacheRead + _cacheCreate;
    const _out = u.output_tokens || 0;
    const _pc = (meta && meta.promptChars) || {};
    const line = '[' + new Date().toLocaleString() + '] 글쓰기(' + kind + ') "' + String(kw || '').slice(0, 24) + '"'
      + ' model=' + ((meta && meta.model) || '?')
      + ' 입력=' + _in + '(순입력=' + _rawIn + ' 캐시읽기=' + _cacheRead + ' 캐시생성=' + _cacheCreate + ')'
      + ' 출력=' + _out + ' 합=' + (_in + _out)
      + (_pc.system != null ? ' [규칙서=' + _pc.system + '자 자료=' + (_pc.user || 0) + '자]' : '')
      + ' turns=' + ((meta && meta.numTurns) || '?')
      + ' 비용참고=$' + (((meta && meta.costUsd) || 0)).toFixed(4) + '\n';
    require('fs').appendFileSync(require('path').join(app.getPath('userData'), 'token-usage.log'), line);
  } catch (e) {}
}

// ★★공식 출처 사이트에서 "이미지"를 직접 수집한다(정책·정부 주제). AI브리핑이 인용한 공식 페이지(부평복지ON·or.kr 등)를
//   렌더 → 콘텐츠 이미지 추출(로고·아이콘·배너 제외) → 다운로드. 쓸만한 이미지가 없으면 그 페이지를 통째로 "캡쳐"해서 이미지로.
//   반환: [{ path, press:'공식 출처', official:true, fromCapture:bool, siteHost }]  (사용자 확정: 정책은 공식 사이트 이미지가 1순위)
async function collectOfficialSiteImages(urls, outDir, { maxPerSite = 4, maxSites = 3 } = {}) {
  const fs = require('fs');
  // ★다운로드 파일(.hwp·pdf·문서·zip)이나 /download 링크는 제외 — 열면 저장 대화상자가 떠서 앱이 멈춘다(법무부 .hwp 등).
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)
    && !/\.(hwp|hwpx|pdf|docx?|xlsx?|pptx?|zip|egg|al[zx]|tar|gz)(\?|#|$)/i.test(u)
    && !/[/?&](download|filedown|down|fileDownload)\b/i.test(u)).slice(0, maxSites);
  const results = [];
  let captureUsed = false; // ★페이지 통째 캡쳐는 글 전체에서 딱 1장만(사용자 확정).
  for (const url of list) {
    const host = (url.match(/^https?:\/\/([^/]+)/) || ['', ''])[1] || '';
    const win = new BrowserWindow({ show: false, width: 1200, height: 1700, webPreferences: { partition: 'persist:naver', offscreen: false, backgroundThrottling: false } });
    try {
      await win.loadURL(url, { userAgent: _DESKTOP_UA_OF });
      await new Promise((r) => setTimeout(r, 3200));
      // 1) 페이지 안의 콘텐츠 이미지 추출 → 다운로드
      let imgs = [];
      try { const j = await win.webContents.executeJavaScript(M.OFFICIAL_IMG_EXTRACT); imgs = JSON.parse(typeof j === 'string' ? j : '[]'); } catch (e) { imgs = []; }
      const dled = await downloadImagesToDir(imgs.map((x) => ({ url: x.url, press: '공식 출처' })), outDir, { max: maxPerSite });
      if (dled.length) {
        dled.forEach((f) => { f.press = '공식 출처'; f.official = true; f.siteHost = host; });
        results.push(...dled);
      } else if (!captureUsed) {
        // 2) 쓸만한 이미지가 없으면 → 페이지를 통째로 캡쳐해서 이미지로 사용. ★단 캡쳐는 글 전체에서 1장만.
        try {
          captureUsed = true;
          const shot = await win.webContents.capturePage();
          const file = path.join(outDir, 'official_cap_' + host.replace(/[^a-z0-9]/gi, '').slice(0, 16) + '_' + Date.now() + '.png');
          try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
          fs.writeFileSync(file, shot.toPNG());
          results.push({ path: file, url, press: '공식 출처', official: true, fromCapture: true, siteHost: host });
        } catch (e) {}
      }
    } catch (e) { /* 한 사이트 실패해도 계속 */ } finally { try { win.destroy(); } catch (e) {} }
    if (results.length >= maxPerSite * maxSites) break;
  }
  return results;
}

// ★Pexels(무료 스톡) 이미지 수집 — 서버 fetch는 Cloudflare로 차단(403)되므로 Electron 브라우저로 렌더 후 URL 추출.
//   동양인 위주로 "korean/asian"을 붙여 검색. 반환: [{url}] (images.pexels.com 원본, w=1200로 요청).
async function fetchPexelsImages(query, { limit = 8 } = {}) {
  try {
    const q = String(query || '').trim();
    if (!q) return [];
    // 동양인 위주 + 인물 얼굴 회피는 비전이 처리. 한국어 검색 페이지.
    const url = 'https://www.pexels.com/ko-kr/search/' + encodeURIComponent(q + ' korean') + '/';
    const r = await scrapeRendered(url, M.PEXELS_EXTRACT, 4000, 'persist:naver', _DESKTOP_UA_OF);
    let arr = [];
    try { arr = JSON.parse(typeof r === 'string' ? r : '[]'); } catch (e) { arr = []; }
    return (Array.isArray(arr) ? arr : []).slice(0, limit).map((u) => ({ url: u, title: q, pexels: true }));
  } catch (e) { return []; }
}

// ★네이버 이미지 수집 — 검색 결과에서 이미지 URL을 뽑고, 블로그 출처(워터마크 위험)는 제외.
//   프록시(search.pstatic.net/common?src=원본)에서 원본 URL 디코드. 뉴스·방송·기타만 남긴다.
async function collectNaverImages(query, { limit = 15 } = {}) {
  const url = 'https://search.naver.com/search.naver?where=image&sort=1&query=' + encodeURIComponent(query);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const win = new BrowserWindow({ show: false, width: 1200, height: 1000, webPreferences: { partition: 'persist:naver', contextIsolation: true, sandbox: true } });
  let list = [];
  try {
    await win.loadURL(url, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
    await sleep(2000);
    // 스크롤로 lazy-load 더 불러오기(뉴스/방송 이미지 확보)
    for (let i = 0; i < 5; i++) { await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)').catch(() => {}); await sleep(900); }
    list = JSON.parse(await win.webContents.executeJavaScript(M.NAVER_IMG_EXTRACT));
  } catch (e) { list = []; } finally { try { win.destroy(); } catch (e) {} }
  // ★블로그·카페·커뮤니티·리뷰 출처(워터마크·개인사진 위험) 제외. 뉴스·방송·공식·인스타·연예매체만 남긴다.
  const isBlog = (h) => /blogfiles|blog\.naver|postfiles|blogthumb|blogpfthumb|mblogthumb|cafefiles|cafethumb|tistory|egloos|dcinside|brunch|velog|wordpress|ppomppu|clien|instiz|theqoo|fmkorea|ruliweb|mlbpark|82cook|missycoupons|inven|todayhumor|bobaedream|slrclub|kakaocdn|daumcdn|pstatic\.net\/.*blog/i.test(h || '');
  // ★고위험 방송·OTT 도메인 차단(워터마크·저작권·소송 위험 큼 — 사용자 피드백). tv조선 등.
  // ★#8 하드 차단 = 연합뉴스 + TV조선만(소송 위험). 다른 방송사는 허용하되 하단 워터마크를 크롭해서 쓴다.
  const isRiskyBroadcast = (h) => /tvchosun|yna\.co\.kr|yonhapnews|yonhap|yeonhap/i.test(h || '');
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && x.url && !isBlog(x.host) && !isRiskyBroadcast(x.host)) // ★블로그·고위험방송 출처 제외
    .slice(0, limit);
}

// (개발) 엔터/스포츠 랭킹 페이지의 리스트 구조를 로그로 덤프 — 셀렉터 찾기용.

// ★엔터/스포츠 랭킹 추출 스크립트(해시 클래스는 바뀔 수 있어 접두어로 매칭). 앞의 순위숫자 제거.

// 엔터/스포츠 랭킹 캐시 — 백그라운드로 갱신, 생성 시엔 캐시만 읽어 느려지지 않게.
let entSpCache = [];
async function refreshEntertainSports() {
  try {
    const [ent, spt] = await Promise.all([
      scrapeRendered(M.ENT_URL, M.ENT_EXTRACT),
      scrapeRendered(M.SPT_URL, M.SPT_EXTRACT),
    ]);
    const out = [];
    const parse = (d, src) => {
      try { (JSON.parse(d).items || []).forEach((t) => out.push({ keyword: t, rising: true, source: src })); } catch (e) {}
    };
    const nEnt = out.length; parse(ent, 'naver-ent');
    const entCount = out.length - nEnt; parse(spt, 'naver-sports');
    scrapeHealth.record('ent-ranking', entCount);
    scrapeHealth.record('spt-ranking', out.length - entCount);
    if (out.length) { entSpCache = out; console.log('[entSp] 갱신', out.length, '개'); }
    else console.warn('[entSp] 0건 — 랭킹 페이지 구조가 바뀌었을 수 있음 (src/scrape/markup.js ENT_EXTRACT/SPT_EXTRACT)');
  } catch (e) { scrapeHealth.record('ent-ranking', 0); scrapeHealth.record('spt-ranking', 0); /* 실패해도 캐시 유지 */ }
}

// ★구글 트렌드(실시간 48h) 스크랩 — 검색량·연관어 있는 씨앗 몸통. 웹뷰 렌더(데스크톱 UA + 긴 대기).
const { GT_URL, GT_EXTRACT } = require('../src/keyword/googleTrends');
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
let gtCache = [];
async function refreshGoogleTrends() {
  try {
    const raw = await scrapeRendered(GT_URL, GT_EXTRACT, 5500, 'persist:gt', DESKTOP_UA);
    const list = typeof raw === 'string' ? JSON.parse(raw) : (raw && !raw.error ? raw : []);
    scrapeHealth.record('google-trends', Array.isArray(list) ? list.length : 0);
    if (Array.isArray(list) && list.length) { gtCache = list; console.log('[gtrends] 갱신', list.length, '개'); }
    else console.warn('[gtrends] 0건 — 구글 트렌드 구조가 바뀌었을 수 있음 (src/keyword/googleTrends.js)');
  } catch (e) { scrapeHealth.record('google-trends', 0); /* 실패해도 캐시 유지 */ }
}

// ★우리 모듈은 앱 루트(../src) 기준. Electron에서도 그대로 require.
const { buildKeywordRadar } = require('../src/keyword/radar');
const {
  mergeKeywordCandidates,
  selectKeywordReportRows,
  readSearchAdsWorkbook,
  buildKeywordReportWorkbook,
} = require('../src/keyword/report');
const { normalizeKeywordReportRequest } = require('../src/keyword/report-ui');
const { generatePost } = require('../src/generator/generatePost');
const { generateSearchPost } = require('../src/generator/generateSearchPost');
const { SEARCH_TOPIC_GROUPS, FAMILY_BY_KEY, SEARCH_FAMILIES, TONES_WITH_NOTE } = require('../src/generator/searchTopics');
const { setCacheDir: setBgCacheDir } = require('../src/keyword/background');
const { ADVISOR_UA, ADVISOR_EXTRACT, ADVISOR_BYTOPIC_EXTRACT, ADVISOR_TOPICS, keywordsForTopics, parseCategoryApi, classifyTrendKeyword } = require('../src/keyword/advisor');
const { fetchRealtimeTrends, fetchArticleImages } = require('../src/keyword/trends');
const { dedupeSimilar, excludeUsed, capPerCore } = require('../src/keyword/advisor');
const { expandKeywords } = require('../src/keyword/expand'); // 네이버 자동완성 롱테일(개수 보강용)
const { runClaude } = require('../src/generator/runClaude');
const { ADVISOR_TOPIC_BY_TYPE } = require('../src/generator/postTypes');
const { rankSeeds } = require('../src/keyword/seedRadar');
// ★백필 전용 잡음 게이트 — "우리가 채워 넣는" 키워드에서 정체불명 숫자상호·순수숫자 코드 등을 뺀다.
//   (어드바이저 원본에는 적용 안 함 — 네이버가 준 건 그대로 둔다는 사용자 원칙.)
function looksJunkKeyword(k) {
  const s = String(k || '').trim();
  if (!s) return true;
  if (!/[가-힣0-9A-Za-z]/.test(s)) return true;                       // 글자·숫자 하나도 없음(\-, ―, ··· 같은 기호만) = 잡음
  if (s.replace(/\s+/g, '').length < 2) return true;                 // 한 글자
  for (const t of s.split(/\s+/)) {
    if (/^\d{3,}$/.test(t) && !/^(19|20)\d\d$/.test(t)) return true; // "8794" 컷(단 1900~2099 연도는 허용)
    if (/^카페\d+$/.test(t)) return true;                            // "카페8794"
    if (/\d{3,}카페$/.test(t)) return true;                          // "8794카페"
  }
  return false;
}
// ★"끝 단어(대상)"가 같은 게 너무 많으면 컷 — "대구/서울/부산 추석 민생지원금", "달러/일본/오늘 엔화 환율"처럼
//   지역·수식어만 다른 같은 글감 홍수 방지(capPerCore는 첫 단어 기준이라 못 잡음). 앞쪽(우선정렬된 것) 우선 유지.
//   단 "○○ 논란/가격/방법"처럼 끝 단어가 "일반 수식 접미사"면 주어가 앞이라 캡 안 함(서로 다른 글감이므로).
const GENERIC_TAIL = new Set(['논란', '사건', '이유', '가격', '방법', '후기', '정보', '일정', '효능', '증상', '순위', '근황', '결말', '반응', '나이', '재산', '프로필', '수출', '계약', '뜻', '전망', '공개', '총정리', '관련', '소식', '현황', '상황', '내용', '정체', '논평', '의혹', '논쟁', '사퇴', '청탁']);
function capPerTail(keywords, max) {
  const cap = max || 2;
  const cnt = {}, out = [];
  for (const k of keywords || []) {
    const toks = String(k || '').trim().split(/\s+/);
    const tail = (toks[toks.length - 1] || '').replace(/\s+/g, '');
    if (tail.length < 2 || GENERIC_TAIL.has(tail)) { out.push(k); continue; } // 1글자·일반 수식 접미사는 대상 아님 → 통과
    if ((cnt[tail] || 0) >= cap) continue;
    cnt[tail] = (cnt[tail] || 0) + 1; out.push(k);
  }
  return out;
}
// ★유형별 "우선 단어" — 어드바이저 원본에서 이 단어가 들어간 키워드는 순위 낮아도 상단으로 끌어올린다.
//   (초보가 글쓰기 좋은 돈·제도·재테크 글감. 부분일치. 어드바이저 원본에만 적용, 다른 유형·백필엔 영향 없음.)
//   ※ '코인'은 앞에 뭔가 붙은 "○○코인"만(비트코인·도지코인 O / 코인노래방·코인세탁 X) → 리스트가 아니라 priorityHit에서 정규식으로 처리.
const PRIORITY_WORDS_BY_TYPE = {
  policy: ['지원금', '보조금', '수당', '급여', '바우처', '상품권', '환급', '페이백', '캐시백', '장려금',
    '청년', '신혼', '신생아', '출산', '육아', '노인', '어르신', '저소득', '소상공인', '자영업', '다자녀', '한부모', '장애인',
    '민생', '재난지원금', '기초연금', '국민연금', '실업급여', '부모급여', '아동수당', '육아휴직', '근로장려금', '기초생활수급', '긴급복지', '에너지바우처', '국가장학금',
    '적금', '청년도약계좌', '청년내일저축', '내일채움공제', '희망두배', '비과세', '소득공제', '세액공제', '연말정산',
    '청약', '전세', '전세자금', '전세대출', '버팀목', '디딤돌', '주거급여', '월세지원', '행복주택', '주담대', '신생아특례', '보금자리',
    '공무원', '봉급표', '호봉', '최저임금', '주휴수당', '실수령액'],
  invest: ['적금', '예금', '청약통장', '청년도약계좌', 'ISA', '연금저축', 'IRP', '퇴직연금', '파킹통장', 'CMA', '펀드', '채권', '국채', '비과세', '절세',
    '배당', '배당금', '배당주', '공모주', 'IPO', '상장', '실적', 'ETF', '리츠', '우선주', '유상증자', '자사주',
    '코스피', '코스닥', '나스닥', 'S&P', '금리', '기준금리', '환율', '달러', '엔화', '물가', '인플레이션', '유가', '금값',
    '가상자산', '알트코인', '스테이블코인',
    '양도세', '금투세', '배당소득세', '이자소득세', '종합소득세', '연말정산', '소득공제', '세액공제'],
  it: ['아이폰', '갤럭시', '갤럭시S', '갤럭시Z', '폴드', '플립', '아이패드', '맥북', '에어팟', '갤럭시워치', '애플워치', '버즈',
    '사전예약', '출시', '출시일', '언팩', '스펙', '자급제', '요금제', '알뜰폰', '5G',
    '챗지피티', 'GPT', '오픈AI', '클로드', '제미나이', '제미니', '아스트라', '코파일럿', '딥시크', '그록', '소라', '미드저니', '퍼플렉시티', '클로바X', '하이퍼클로바', '뤼튼', '생성형AI', '노트북LM',
    '바이브코딩', '클로드코드', '힉스필스', '힉스필드', '클링', '시댄스'],
};
// ★"풍부한 것만" 우선 단어 — 단독이면(그 단어만) 글쓰기 어려워서, 뒤에 뭔가 더 붙은 키워드일 때만 우선(부동산·노코딩). (사용자 확정)
const PRIORITY_RICH_ONLY = {
  policy: ['부동산'],
  it: ['노코딩'],
};
function priorityHit(type, kw) {
  const s = String(kw || '');
  const list = PRIORITY_WORDS_BY_TYPE[type];
  if (list && list.some((w) => s.includes(w))) return true;
  const rich = PRIORITY_RICH_ONLY[type];
  if (rich) { const norm = s.replace(/\s+/g, ''); if (rich.some((w) => s.includes(w) && norm !== w.replace(/\s+/g, ''))) return true; } // 그 단어+@ 일 때만
  if (type === 'invest' && /[가-힣A-Za-z0-9]코인/.test(s)) return true; // ★"○○코인"만(코인노래방·코인세탁은 앞이 공백/시작이라 제외)
  return false;
}
// ★썸네일 렌더 — Playwright/크로미움 없이 Electron 내장 브라우저로(배포 안정·경량). 순수함수만 재사용.
const { makeThumbnailSvg, fontFaceCss, FONTS: THUMB_FONTS, DEFAULTS: THUMB_DEFAULTS } = require('../src/thumbnail/makeThumbnail');
const { fetchBuffer: fetchFontBuffer } = require('../src/image/newsImages');

// ★썸네일 글씨체가 "미리보기는 맞는데 실제 삽입은 다른 폰트"로 나오던 버그의 근본 해결:
//   폰트를 CDN/시스템설치에 의존하지 말고 "파일→base64로 박아넣기(임베드)". 개발자 PC엔 폰트가 설치돼 있어 우연히 됐지만,
//   폰트가 없는 사용자 윈도우에선 CDN 로드가 오프스크린 렌더에서 불안정해 기본폰트로 폴백됐음. data:URL 임베드면 어디서든 동일.
const _fontEmbedCache = {}; // key → @font-face css(base64) 캐시(세션+디스크)
async function embedFontFaceCss(key) {
  if (_fontEmbedCache[key] != null) return _fontEmbedCache[key];
  const f = THUMB_FONTS && THUMB_FONTS[key];
  if (!f) return '';
  const fam = f.family.split(',')[0].replace(/'/g, '');
  // 1) 번들된 로컬 파일 우선(clipart .otf) — 네트워크 불필요, 완전 자립.
  if (f.localFile) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, '..', f.localFile));
      const css = `@font-face{font-family:'${fam}';font-weight:${f.weight || 400};src:url(data:font/otf;base64,${buf.toString('base64')}) format('opentype');font-display:block;}`;
      _fontEmbedCache[key] = css; return css;
    } catch (e) {}
  }
  // 2) woff2 URL이면 다운로드→userData 캐시→base64 임베드(첫 실행만 네트워크, 이후 오프라인 OK).
  const url = f.src && f.src.woff2;
  if (url) {
    try {
      const dir = path.join(app.getPath('userData'), 'font-cache');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const cacheFile = path.join(dir, key + '.woff2');
      let buf;
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1000) buf = fs.readFileSync(cacheFile);
      else { buf = await fetchFontBuffer(url, { timeoutMs: 12000 }); if (buf && buf.length > 1000) fs.writeFileSync(cacheFile, buf); }
      if (buf && buf.length > 1000) {
        const css = `@font-face{font-family:'${fam}';font-weight:${f.weight || 400};src:url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');font-display:block;}`;
        _fontEmbedCache[key] = css; return css;
      }
    } catch (e) {}
  }
  // 3) 폴백: 기존 CDN @import/@font-face(pretendard css·round google 등) — 아래 renderHtmlToPngWin이 명시적으로 로드 대기.
  try { const css = fontFaceCss(key); _fontEmbedCache[key] = css; return css; } catch (e) { return ''; }
}
async function renderHtmlToPngWin(html, outPath, size, families) {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  let _tmpHtml = null;
  try {
    win.setContentSize(size, size);
    // ★큰 HTML(폰트 base64 + 사진배경 base64)은 data: URL 크기 한계를 넘어 loadURL이 실패한다(=사진배경 썸네일 "넣기 안됨"의 원인).
    //   → 임시 .html 파일로 저장 후 loadFile(크기 제한 없음). data:URI 폰트·사진은 file:// 문맥에서도 그대로 자립.
    _tmpHtml = String(outPath) + '.html';
    try { fs.mkdirSync(path.dirname(_tmpHtml), { recursive: true }); } catch (e) {}
    fs.writeFileSync(_tmpHtml, html);
    await win.loadFile(_tmpHtml);
    // ★폰트를 "명시적으로 로드하고 기다린다". document.fonts.ready만으론 @import 폰트를 놓쳐 폴백으로 캡쳐되던 문제.
    const famList = JSON.stringify(Array.isArray(families) && families.length ? families : ['Pretendard', 'Jua', 'MitmiFont', 'OngleipKonkon', 'ClipArtKorea', 'Cafe24ProSlim']);
    try {
      await win.webContents.executeJavaScript(`(async()=>{try{
        var fams=${famList};
        await Promise.all(fams.map(function(fm){ return document.fonts.load('80px "'+fm+'"','가나다ABC123').catch(function(){}); }));
        await Promise.race([document.fonts.ready, new Promise(function(r){setTimeout(r,3500);})]);
      }catch(e){} return document.fonts.size;})()`);
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 350)); // 렌더 안정화
    let img = await win.webContents.capturePage();
    try { img = img.resize({ width: size, height: size }); } catch (e) {} // 정확히 size×size (레티나 배율 보정)
    fs.writeFileSync(outPath, img.toPNG());
    return outPath;
  } finally { try { win.destroy(); } catch (e) {} try { if (_tmpHtml) fs.unlinkSync(_tmpHtml); } catch (e) {} }
}
async function renderSvgPng(svg, outPath, { size = 1080 } = {}) {
  const allFonts = ['pretendard', 'round', 'cute', 'konkon', 'clipart', 'slim'];
  const face = (await Promise.all(allFonts.map((k) => embedFontFaceCss(k).catch(() => '')))).join('\n');
  const html = ['<!doctype html><meta charset="utf-8"><style>', '*{margin:0;padding:0}', face,
    'html,body{width:' + size + 'px;height:' + size + 'px;overflow:hidden;background:#fff}',
    'svg{display:block;width:' + size + 'px;height:' + size + 'px}', '</style>', String(svg)].join('\n');
  return renderHtmlToPngWin(html, outPath, size);
}
async function renderThumbnailPng(opts, outPath) {
  const size = opts.size || THUMB_DEFAULTS.size;
  const font = opts.font || THUMB_DEFAULTS.font;
  const svg = makeThumbnailSvg(opts);
  const keys = [font, opts.subFont].filter((v, i, a) => v && a.indexOf(v) === i);
  const face = (await Promise.all(keys.map((k) => embedFontFaceCss(k).catch(() => '')))).join('\n');
  const fams = keys.map((k) => (THUMB_FONTS[k] ? THUMB_FONTS[k].family.split(',')[0].replace(/'/g, '') : '')).filter(Boolean);
  const html = ['<!doctype html><meta charset="utf-8"><style>', '*{margin:0;padding:0}', face,
    'html,body{width:' + size + 'px;height:' + size + 'px;overflow:hidden}', 'svg{display:block}', '</style>', svg].join('\n');
  return renderHtmlToPngWin(html, outPath, size, fams);
}
const { collectNewsImages, collectImages, collectMoviePhotos, downloadImagesToDir, summarizeAttribution } = require('../src/image/newsImages');
const { filterImagesByVision, classifyMyPhotos } = require('../src/image/visionFilter');

// ★예약 자동 실행 모드 — 스케줄러가 "앱 --auto"(홈판) 또는 "--auto-search"(검색용)로 실행하면 창 숨기고 자동 생성→임시저장→종료.
const AUTO_MODE = process.argv.includes('--auto');            // 홈판 예약
const AUTO_SEARCH_MODE = process.argv.includes('--auto-search'); // 검색용 예약
const AUTO_ANY = AUTO_MODE || AUTO_SEARCH_MODE;

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: '블로그 자동화',
    backgroundColor: '#f4f6fa',
    show: !AUTO_ANY, // 자동 모드(홈판/검색)면 창 숨김(백그라운드)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // 보안: 렌더러에서 Node 직접 접근 차단
      nodeIntegration: false,
      webviewTag: true, // ★네이버 글쓰기를 앱 안에 임베드하기 위함
      autoplayPolicy: 'no-user-gesture-required', // 유튜브 소리까지 자동재생 허용
      backgroundThrottling: false, // 숨김 창이어도 자동 생성이 느려지지 않게
    },
  });
  // 자동 모드 = 로그인 화면 건너뛰고 바로 메인 앱을 auto=1로 로드(세션은 디스크에 유지됨). kind=검색용 구분.
  if (AUTO_ANY) win.loadURL('http://127.0.0.1:' + APP_PORT + '/app/app.html?auto=1&kind=' + (AUTO_SEARCH_MODE ? 'search' : 'home'));
  else win.loadURL('http://127.0.0.1:' + APP_PORT + '/app/login.html'); // ★첫 화면 = 로그인 (http로 서빙)
  win.webContents.once('destroyed', () => keywordReportPreparedBySender.delete(win.webContents.id));

  // ★순수 웹뷰(가로채기·팝업 없음). 카카오 로그인은 웹뷰 안(또는 웹뷰가 여는 자식 창)에서 자연스럽게 처리한다.
  //   진단용: 웹뷰 메인프레임 이동을 로그로 남겨 카카오가 어디까지 가는지 본다.
  win.webContents.on('did-attach-webview', (_e, guest) => {
    try {
      guest.on('did-start-navigation', (_e2, url, _inPlace, isMainFrame) => { if (isMainFrame) console.log('[ov-web nav]', url.slice(0, 80)); });
      // ★[새 글 쓰기] 등으로 에디터를 벗어날 때 네이버가 띄우는 beforeunload 네이티브 확인창(자동으로 못 닫힘)이
      //   이동을 막아 "리로드가 안 되고 옛 글이 그대로 남는" 문제가 있었다. → 무조건 이동 허용(임시저장은 네이버가 자동).
      guest.on('will-prevent-unload', (e) => { e.preventDefault(); });
      // ★★네이버 "작성 중인 내용을 임시저장하고 선택한 문서를 불러오시겠습니까?" 같은 window.confirm() 네이티브 창은
      //   DOM 클릭으로 못 닫혀 저장·새글 자동화가 멈춘다. → 그 "불러오기/이어쓰기" 계열 confirm만 자동으로 '취소(false)' 반환.
      //   (그 외 confirm은 원래 네이티브 그대로 두어 사용자의 수동 편집엔 영향 없음.)
      const CONFIRM_PATCH =
        "(function(){try{if(window.__abConfirmPatched)return;window.__abConfirmPatched=true;var oc=window.confirm;" +
        "window.confirm=function(msg){try{var m=String(msg||'');" +
        "if(/불러|이어\\s*쓰기|이어서\\s*작성|작성\\s*중인\\s*내용|선택한\\s*문서/.test(m))return false;" +
        "return oc.apply(window,arguments);}catch(e){return false;}};}catch(e){}})();";
      const patchConfirm = () => { try { guest.executeJavaScript(CONFIRM_PATCH); } catch (e) {} };
      guest.on('dom-ready', patchConfirm);
      guest.on('did-navigate', patchConfirm);
      guest.on('did-navigate-in-page', patchConfirm);
      guest.on('did-fail-load', (_e2, code, desc, url, isMainFrame) => { if (isMainFrame) console.log('[ov-web fail]', code, desc, url.slice(0, 80)); });
      // ★소셜 로그인 팝업은 같은 세션(persist:naver)으로 열어야 콜백 쿠키가 웹뷰 세션에 들어온다.
      try {
        guest.setWindowOpenHandler(() => (
          { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition: 'persist:naver' } } }
        ));
      } catch (e) {}
    } catch (err) {}
  });

  // 개발 중 디버깅용 — 렌더러 콘솔 확인 (배포 시 제거)
  if (process.env.DEV_TOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  mainWindow = win; // ★실행 중인 창 참조(예약 위임 트리거용)
  return win;
}

// ★단일 인스턴스 — 앱이 이미 켜져 있는데 예약(--auto)이 새 프로세스로 뜨면, 그 새 프로세스는 같은 userData(네이버 세션)를
//   동시에 못 읽어 "네이버 로그인 안 됨"으로 오판한다(로그 확인됨). → 두 번째 실행은 즉시 종료하고,
//   이미 로그인된 "실행 중인 앱"에 자동 생성을 위임한다(argv의 --auto/--auto-search를 넘겨서). 앱이 꺼져 있으면 첫 실행이 그대로 자동 수행.
let mainWindow = null;
// 키워드 미리보기는 이 프로세스에서 만든 값만 저장한다. 렌더러는 파일 경로나 임의 행을 export로 넘길 수 없다.
const keywordReportPreparedBySender = new Map();
const _gotSingleLock = app.requestSingleInstanceLock();
if (!_gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    try {
      const isSearch = (argv || []).includes('--auto-search');
      const isAuto = (argv || []).includes('--auto') || isSearch;
      if (isAuto && mainWindow && !mainWindow.isDestroyed()) {
        try { fs.appendFileSync(path.join(app.getPath('userData'), 'auto-run.log'), '[' + new Date().toISOString() + '] 예약 위임 → 실행 중인 앱에서 자동 생성 (' + (isSearch ? 'search' : 'home') + ')\n'); } catch (e) {}
        try { mainWindow.webContents.send('run-auto', { kind: isSearch ? 'search' : 'home' }); } catch (e) {}
      }
    } catch (e) {}
  });
}

app.whenReady().then(async () => {
  // ★독/작업표시줄 아이콘을 우리 로고로(프리스틴 Electron을 그대로 쓰므로 런타임에 지정).
  try { if (process.platform === 'darwin' && app.dock) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon-rounded.png')); } catch (e) {}
  try { setBgCacheDir(app.getPath('userData')); } catch (e) {} // 인물 배경 캐시를 사용자 영역에 영속화
  try { setStorageDir(app.getPath('userData')); } catch (e) {} // 공개 검색 캐시와 제한 유예를 앱 프로필에 영속화
  APP_PORT = await startServer(); // 로컬 http 서버 먼저 띄우기
  // ★예약 자동 생성은 "그 시각에 컴퓨터가 켜져 있어야" 실행됨(잠자면 launchd/schtasks가 못 뜬다).
  //   → 앱이 켜져 있는 동안 "시스템 잠자기 방지"(화면은 꺼져도 됨, 배터리 영향 최소). 앱 끄면 자동 해제.
  try { global._psbId = powerSaveBlocker.start('prevent-app-suspension'); } catch (e) {}
  // ★로그인 유지의 핵심 — 네이버 로그인 쿠키는 "세션 쿠키"(만료 없음)라 앱이 꺼지면 메모리에서 사라진다.
  //   그래서 세션 쿠키를 "30일 유지 쿠키"로 바꿔 디스크에 고정 → 재시작/강제종료에도 로그인 유지.
  await persistSessionCookies();
  setInterval(persistSessionCookies, 8000); // 로그인 직후 빨리 디스크 고정(강제종료 대비)
  // 렌더러(UI) → 키워드 파이프라인 호출
  ipcMain.handle('keyword:radar', async (_e, { seed, useAction }) => {
    console.log('[IPC] keyword:radar', seed, useAction);
    if (!seed || !seed.trim()) return { ok: false, error: '씨앗 키워드를 입력하세요.' };
    try {
      const rows = await buildKeywordRadar({
        seeds: [seed.trim()],
        useActionModifiers: !!useAction,
        topN: 20,
      });
      return { ok: true, rows };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 네이버 검색광고에서 사용자가 내보낸 XLSX를 가져와 공개 자동완성 후보와 합친다.
  // 로그인 세션이나 비공개 API는 사용하지 않으며 파일 경로는 OS 파일 선택창에서만 얻는다.
  ipcMain.handle('keyword-report:prepare', async (event, input = {}) => {
    let request;
    try { request = normalizeKeywordReportRequest(input); }
    catch (error) { return { ok: false, error: error.message }; }

    try {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: '네이버 검색광고 키워드 도구에서 내려받은 XLSX 선택',
        defaultPath: app.getPath('downloads'),
        properties: ['openFile'],
        filters: [{ name: 'Excel 통합 문서', extensions: ['xlsx'] }],
      });
      if (!picked || picked.canceled || !picked.filePaths || !picked.filePaths[0]) {
        return { ok: true, cancelled: true };
      }

      const selectedFile = picked.filePaths[0];
      if (path.extname(selectedFile).toLowerCase() !== '.xlsx') {
        return { ok: false, error: '검색광고 .xlsx 파일을 선택해 주세요.' };
      }
      const importedAt = new Date().toISOString();
      const imported = await readSearchAdsWorkbook(selectedFile, { importedAt });
      let autocompleteKeywords = [];
      let autocompleteWarning = '';
      try {
        autocompleteKeywords = await expandKeywords([request.seed], {
          rounds: 1,
          maxCandidates: 120,
          delayMs: 120,
        });
      } catch (error) {
        autocompleteWarning = error.message || '자동완성 후보를 가져오지 못했습니다.';
      }
      const candidates = mergeKeywordCandidates(request.seed, imported.rows, autocompleteKeywords);
      const selected = selectKeywordReportRows(candidates, {
        seed: request.seed,
        count: request.count,
        excludeTerms: request.excludeTerms,
      });
      const meta = {
        seed: request.seed,
        requestedCount: selected.requestedCount,
        importedCount: imported.rows.length,
        sourceFileName: imported.sourceFileName,
        importedAt: imported.importedAt,
        sourceSheetName: imported.sourceSheetName,
        availableCount: selected.availableCount,
        shortfall: selected.shortfall,
        autocompleteEnabled: true,
        autocompleteCount: autocompleteKeywords.length,
        autocompleteWarning,
        excludeTerms: request.excludeTerms,
      };
      const prepared = { request, rows: selected.rows, meta };
      keywordReportPreparedBySender.set(event.sender.id, prepared);
      return { ok: true, cancelled: false, rows: prepared.rows, meta };
    } catch (error) {
      return { ok: false, error: error.message || '검색광고 파일을 읽지 못했습니다.' };
    }
  });

  // 준비된 미리보기만 저장한다. 렌더러는 경로나 XLSX 행을 IPC로 전달하지 않는다.
  ipcMain.handle('keyword-report:export', async (event, input = {}) => {
    const prepared = keywordReportPreparedBySender.get(event.sender.id);
    if (!prepared) return { ok: false, error: '먼저 키워드 미리보기를 만들어 주세요.' };
    let request;
    try { request = normalizeKeywordReportRequest(input); }
    catch (error) { return { ok: false, error: error.message }; }
    if (request.seed !== prepared.request.seed || request.count !== prepared.request.count
      || request.excludeTerms.join('\n') !== prepared.request.excludeTerms.join('\n')) {
      return { ok: false, error: '조사 조건이 바뀌었습니다. 다시 조사한 뒤 저장해 주세요.' };
    }

    try {
      const safeSeed = prepared.meta.seed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 40) || '키워드';
      const suggestedName = `${safeSeed}_키워드_${prepared.meta.requestedCount}.xlsx`;
      const saved = await dialog.showSaveDialog(mainWindow, {
        title: '키워드 보고서 저장',
        defaultPath: path.join(app.getPath('documents'), suggestedName),
        buttonLabel: '엑셀 저장',
        filters: [{ name: 'Excel 통합 문서', extensions: ['xlsx'] }],
      });
      if (!saved || saved.canceled || !saved.filePath) return { ok: true, cancelled: true };
      let outputPath = saved.filePath;
      const extension = path.extname(outputPath).toLowerCase();
      if (!extension) outputPath += '.xlsx';
      else if (extension !== '.xlsx') return { ok: false, error: '.xlsx 파일로 저장해 주세요.' };

      const workbook = await buildKeywordReportWorkbook(prepared.rows, prepared.meta);
      await fs.promises.writeFile(outputPath, workbook);
      return { ok: true, cancelled: false, filePath: outputPath };
    } catch (error) {
      return { ok: false, error: error.message || '엑셀 파일을 저장하지 못했습니다.' };
    }
  });

  // ★크리에이터 어드바이저 트렌드 키워드 — 네이버 로그인 세션으로 SPA 렌더 후 수집.
  //   되면 keywords 반환, 안 되면 첫 실행 구조가 userData/advisor-debug.txt로 남아 파서 튜닝 가능.
  const advisorLoad = async (u) => {
    const raw = await scrapeRendered(u, ADVISOR_EXTRACT, 7500, 'persist:naver', ADVISOR_UA);
    // ★extract는 JSON "문자열"을 돌려준다 → 반드시 파싱(안 하면 문자로 쪼개짐).
    let r; try { r = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch (e) { r = { parseError: e.message, raw: String(raw).slice(0, 300) }; }
    return { tried: u, ...r };
  };
  // 트렌드 페이지를 스크롤로 32개 주제 다 로딩한 뒤 "주제별 키워드"를 뽑는다.
  async function collectAdvisorByTopic(targetTopics) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 1) 베이스 로드 → 로그인 여부 + blogId + "트렌드" 탭 URL.
    const base = await advisorLoad('https://creator-advisor.naver.com/');
    const sawLogin = base.loginNeeded || /introduction/i.test(base.href || '') || /introduction/i.test(base.error || '');
    if (sawLogin) return { loginNeeded: true, byTopic: {} };
    const m = (base.href || '').match(/naver_blog\/([^\/?#]+)/);
    const blogId = m ? m[1] : null;
    const abs = (h) => (!h ? null : h.startsWith('http') ? h : 'https://creator-advisor.naver.com' + (h.startsWith('/') ? h : '/' + h));
    const nav = (base.navLinks || []).find((x) => /트렌드|trend/i.test(x.t) || /trend/i.test(x.h || ''));
    const trendUrl = (nav && abs(nav.h)) || (blogId ? 'https://creator-advisor.naver.com/naver_blog/' + blogId + '/trends' : null);
    if (!trendUrl) return { loginNeeded: false, byTopic: {} };
    // 2) 트렌드 페이지 로드(세션 확립) → category API를 직접 호출해 주제별 키워드 수집.
    //    ★숨긴 창(show:false)이면 됨 — API fetch는 화면 표시 불필요(스크롤 lazy-load 안 씀). 그래서 팝업 깜빡임 없음.
    const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { partition: 'persist:naver', backgroundThrottling: false } });
    let byTopic = {};
    let probe = {};
    try {
      await win.loadURL(trendUrl, { userAgent: ADVISOR_UA });
      await sleep(1800); // 로그인/세션 확립
      const cats = (targetTopics && targetTopics.length) ? targetTopics : ADVISOR_TOPICS;
      // ★API는 한 번에 "최대 5개 주제"만 허용 → 5개씩 쪼개 병렬 호출 후 병합(연예 6개·생활 7개도 다 받음).
      const chunks = [];
      for (let i = 0; i < cats.length; i += 5) chunks.push(cats.slice(i, i + 5));
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = (back) => { const dt = new Date(); dt.setDate(dt.getDate() - back); return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()); };
      // ★그날 대상 주제들의 키워드 총개수. 새벽엔 오늘/어제가 덜 올라와 몇 개뿐일 수 있다.
      const targetCount = (bt) => cats.reduce((a, t) => a + ((bt[t] || []).length), 0);
      // ★"충분히 많다" 기준 — 대상 주제 수에 비례(주제당 4개). 최소 6개. 이보다 적으면 전날 데이터로 더 가져온다.
      const ENOUGH = Math.max(6, cats.length * 4);
      const fetchCat = (chunk, date) => {
        const apiUrl = 'https://creator-advisor.naver.com/api/v6/trend/category?categories=' + encodeURIComponent(chunk.join(',')) + '&contentType=text&date=' + date + '&hasRankChange=true&interval=day&limit=50&service=naver_blog';
        return win.webContents.executeJavaScript('fetch(' + JSON.stringify(apiUrl) + ',{credentials:"include",headers:{accept:"application/json"}}).then(function(r){return r.text();}).catch(function(e){return "ERR:"+e;})').catch(() => '');
      };
      // ★어제(back=1)부터 뒤로 가며, "충분히 많이" 나오는 날에서 멈춘다. 새벽에 오늘/어제가 부실하면 그 전날꺼로 채운다.
      //   충분한 날이 끝내 없으면 = 6일 중 "가장 많이 나온 날"을 쓴다(빈손 방지).
      let rawSample = '', usedDate = '', bestCount = -1, bestByTopic = null, bestDate = '';
      for (let back = 1; back <= 6; back++) {
        const date = dateStr(back);
        const raws = await Promise.all(chunks.map((ch) => fetchCat(ch, date))); // 5개씩 병렬
        const merged = {};
        for (const raw of raws) {
          if (!rawSample) rawSample = String(raw || '').slice(0, 1500);
          let parsed = null; try { parsed = JSON.parse(raw); } catch (e) { /* non-JSON */ }
          Object.assign(merged, parseCategoryApi(parsed));
        }
        const cnt = targetCount(merged);
        if (cnt > bestCount) { bestCount = cnt; bestByTopic = merged; bestDate = date; } // 지금까지 가장 많은 날 기억
        if (cnt >= ENOUGH) { byTopic = merged; usedDate = date; break; } // 충분하면 그 날로 확정(더 안 거슬러감)
      }
      if (!usedDate && bestByTopic) { byTopic = bestByTopic; usedDate = bestDate; } // 끝내 충분한 날 없으면 가장 많은 날
      probe = { usedDate, rawSample, enough: ENOUGH, count: targetCount(byTopic) };
    } catch (e) { byTopic = { _error: e.message }; } finally { try { win.destroy(); } catch (e) {} }
    return { loginNeeded: false, byTopic, probe, trendUrl };
  }
  // 실시간 트렌드 키워드를 "실제 내용"으로 분류(클로드) → 선택 유형에 맞는 것만. 실패 시 휴리스틱 폴백.
  async function classifyTrendsByType(keywords, type) {
    const kws = (keywords || []).filter(Boolean);
    if (!kws.length) return [];
    const CATS = 'celebrity(연예인·아이돌·배우·방송·예능·드라마·영화·콘서트·공연·티켓 — ★"영화 결말·쿠키(쿠키영상)·엔딩·개봉일·N차관람·회차·OTT공개일"도 전부 여기. 예: 호프 결말·호프 쿠키·스파이더맨 쿠키. ★팝업스토어·마트행사·전시회는 여기 아님) / sportsnews(스포츠·선수·경기·이적) / policy(★정부가 주는 것만: 지원금·근로장려금·청년도약계좌·정부지원대출·소상공인·바우처·세금혜택·환급·법 개정·전기 누진세·k패스/교통비 지원·다자녀 할인·통행료 할인·지급일·신청방법) / it(IT·컴퓨터·폰·앱·테크·가전) / car(자동차·신차·전기차) / invest(★딱 투자·금융만: 주식·종목·코스피·코스닥·상장·실적·배당·ETF·레버리지·코인·환율·금시세·유가·펀드·사이드카·외국인순매수. 정책·지원금·생활경제는 여기 아님) / travel(여행지·관광) / restaurant(맛집·카페) / life(건강·육아·요리·재난·사고·화재·지진·폭염·날씨·★이마트 고래잇·팝업스토어·마트행사·신상품·전시회·박물관·나들이·생활정보·생활경제) / coupang(쇼핑·상품리뷰) / none(해당없음)';
    const system = '너는 실시간 급상승 검색어 분류기다. 각 키워드가 "실제로 무슨 내용인지"(누구·무슨 사건인지)를 알고 아래 카테고리 키 하나로 정확히 분류한다. 애매하면 none. 설명 없이 JSON만.';
    const user = '분류할 키워드:\n' + kws.map((k, i) => `${i + 1}. ${k}`).join('\n') + '\n\n카테고리: ' + CATS + '\n\n출력(JSON 객체만): {"키워드":"카테고리키", ...}';
    try {
      const { text } = await runClaude({ system, user });
      const m = (text || '').match(/\{[\s\S]*\}/);
      const map = m ? JSON.parse(m[0]) : {};
      if (Object.keys(map).length) return kws.filter((k) => map[k] === type); // 분류 성공
    } catch (e) { /* 폴백 */ }
    return kws.filter((k) => classifyTrendKeyword(k) === type);
  }
  // ★검색용 — "그 주제 하나"의 크리에이터 어드바이저 인기유입 검색어 20개(주제 라벨 그대로: 영화→영화, 드라마→드라마).
  ipcMain.handle('advisor:searchTopic', async (_e, { label } = {}) => {
    try {
      if (!label) return { ok: false, keywords: [] };
      // ★어드바이저(주제별 인기유입) + 실시간 급상승(네이트·ZUM·signal.bz)을 병렬 수집. 실시간은 렌더러에서 유형에 맞는 것만 추려 씀.
      const [collected, realtimeRaw] = await Promise.all([
        collectAdvisorByTopic([label]),
        fetchRealtimeTrends().catch(() => []),
      ]);
      if (collected && collected.loginNeeded) return { ok: false, needLogin: true, keywords: [] };
      let keywords = keywordsForTopics(collected.byTopic, [label], 40, { perTopic: 40 });
      keywords = dedupeSimilar(keywords).slice(0, 20); // 겹치는 것(스파이더맨/쿠키/결말→하나) 제거 후 20개
      // ★③ 20개 미만이면 = 주제별 "네이버 뉴스·섹션" 기사 제목 → 핵심 대상 추출로 backfill(화면 표시도 20개 채우게).
      if (keywords.length < 20) {
        try {
          let tkey = '', fam = 'C';
          for (const g of (SEARCH_TOPIC_GROUPS || [])) { for (const t of (g.topics || [])) { if (t.label === label) { tkey = t.key; fam = FAMILY_BY_KEY[t.key] || 'C'; } } }
          const urls = SEARCH_TOPIC_URLS[tkey] || SEARCH_GROUP_URLS[fam] || [];
          if (urls.length) {
            const titles = await scrapeRankingTitles(urls, 40);
            let subs = await extractSubjectsFromTitles(titles);
            subs = subs.filter((k) => !looksJunkKeyword(k)); // ★백필 잡음(숫자상호·순수숫자 코드) 제외. 검색용 주제는 이미 섹션이 정합.
            keywords = dedupeSimilar([...keywords, ...subs]).slice(0, 20);
            console.log(`[advisor:searchTopic] ${label} URL backfill → ${keywords.length}개`);
          }
        } catch (e) { /* backfill 실패해도 원래 목록 유지 */ }
      }
      // ★겹침 제거로 20개 밑이면 자동완성으로 더 끌어와 채운다(플로어 보장, 잡음 제외).
      if (keywords.length < 20 && keywords.length) {
        try {
          const more = await expandKeywords(keywords.slice(0, 10), { rounds: 1, maxCandidates: 120, delayMs: 60 });
          const add = (more || []).filter((k) => !looksJunkKeyword(k));
          keywords = dedupeSimilar([...keywords, ...add]).slice(0, 20);
        } catch (e) { /* 실패해도 원래 목록 유지 */ }
      }
      // ★핵심어(첫 단어)당 최대 2개까지만 — 한 대상 쏠림 방지. coreCount는 자동발행 로테이션에 쓴다.
      let coreCount = {};
      try { const _cc = capPerCore(keywords, 2); keywords = capPerTail(_cc.list, 2).slice(0, 20); coreCount = _cc.coreCount || {}; } catch (e) {}
      const realtime = (realtimeRaw || []).map((t) => (typeof t === 'string' ? t : (t && t.keyword) || '')).filter(Boolean);
      return { ok: true, keywords, coreCount, realtime };
    } catch (e) { return { ok: false, error: e.message, keywords: [] }; }
  });

  ipcMain.handle('advisor:trends', async (_e, { type } = {}) => {
    const t0 = Date.now();
    const topics = ADVISOR_TOPIC_BY_TYPE[type] || [];
    // ★주제 매핑이 유형과 정확히 일치 → 대부분 Claude 재분류·실시간 불필요(그게 제일 느렸음). 어드바이저에서 바로 가져와 속도↑.
    //   단 ★연예 유형만은 "지금 뜨는" 속보가 중요 → 실시간도 병렬 수집(빠른 규칙 분류로 연예만 골라 붙임, Claude 미사용).
    const wantRealtime = (type === 'celebrity');
    const tA = Date.now(); let tAdvisorMs = 0, tClaudeMs = 0;
    const [collected, realtimeRaw] = await Promise.all([
      collectAdvisorByTopic(topics),
      wantRealtime ? fetchRealtimeTrends().catch(() => []) : Promise.resolve([]),
    ]);
    tAdvisorMs = Date.now() - tA;
    const { loginNeeded, byTopic, probe } = collected;
    // ★NEW(신규 진입) 우선 + 상단(rank) 우선. 연예는 각 주제 "상위 5"에서 주로. 넉넉히 뽑고 아래서 유사중복 제거.
    // ★주제당 몇 개 뽑을지 — 연예=10(주제 많음), ★2주제 유형(정책·IT)=주제당 20(어드바이저가 주제당 ~20개 다 주므로 총 40개→화면 30개까지 채움), 3주제+=8, 단일주제=40.
    //   (이전엔 2주제를 8개씩만 뽑아 총 16개→화면 ~20개로 적게 나왔음. 사용자 지적 반영해 다 끌어옴.)
    const perTopic = (type === 'celebrity') ? 10 : (topics.length > 2 ? 8 : (topics.length === 2 ? 20 : 40));
    // ★연예 패션·미용만 "NEW·상위 1~2개"(몸매·아이템 이슈만). 정책·IT는 위 perTopic(20)로 충분 → 별도 부스트 불필요(우선정렬이 지원금·IT제품을 상단화).
    const perTopicMap = (type === 'celebrity') ? { '패션·미용': 2 } : {};
    // ★alwaysTop: 각 주제 "맨 위(rank 최소)" 키워드는 NEW 아니어도 무조건 포함(연예는 특히 최상단 속보 중요).
    let keywords = keywordsForTopics(byTopic, topics, 50, { perTopic, perTopicMap, alwaysTop: true });
    // ★연예만: 실시간 급상승 중 "연예로 분류되는 것"을 뒤에 덧붙임(속보 반영). 규칙 분류라 빠름.
    if (wantRealtime) {
      const rtCeleb = (realtimeRaw || []).map((t) => t && t.keyword).filter(Boolean)
        .filter((k) => classifyTrendKeyword(k) === 'celebrity');
      if (rtCeleb.length) keywords = keywords.concat(rtCeleb);
    }
    // ★유사 중복 제거 — "스파이더맨" / "스파이더맨 줄거리"처럼 같은 소재는 하나만(NEW·상단 순서 유지, 먼저 온 것 남김).
    keywords = dedupeSimilar(keywords);
    // ★연예에서 정치 키워드 제외 — "민주당 전당대회"처럼 정치가 섞이면 뺀다(연예는 연예만).
    if (type === 'celebrity') {
      const POL = /민주당|국민의힘|전당대회|대통령|국회|의원|장관|총선|대선|선거|경선|탄핵|특검|정당|여당|야당|개헌|시국/;
      keywords = keywords.filter((k) => !POL.test(k));
      // ★박람회·전시·박물관·팝업·드론쇼·불꽃·축제·야시장 등 "공개 이벤트·나들이" = 연예 아님(생활). "공연·전시" 어드바이저 주제에서 딸려온 것 제거.
      //   단 콘서트·공연·뮤지컬·연극·팬미팅·시상식·내한은 연예로 유지(전시·나들이류만 걸러냄).
      const LIFE = /박람회|전시회|박물관|미술관|팝업|마트\s*행사|마트행사|베이비페어|웨딩페어|페어\b|나들이|드론쇼|불꽃|야시장|플리마켓|벼룩시장|장터|축제|나이트마켓|워터파크/;
      keywords = keywords.filter((k) => !LIFE.test(k));
    }
    // ★14일 이내에 쓴 것만 회피(그보다 오래된 건 다시 써도 됨). at 없는 옛 기록은 유지(안전).
    const _cut14 = Date.now() - 14 * 24 * 3600 * 1000;
    const recent = loadRecentTopics().filter((r) => r && (!r.at || r.at >= _cut14));
    keywords = excludeUsed(keywords, recent.map((r) => r.keyword), recent.map((r) => r.title));
    // ★금융 낚시성 잡음 정리 — 투자 유형이 아닌데 "…, 코스피 폭락 속 흥행할까?"처럼 딸려온 주식 뒷말을 자른다.
    //   쉼표 뒷절이 금융 잡음이면 앞절만 남기고, 그래도 금융 잡음이 남으면(=키워드 자체가 주식) 아예 제외.
    if (type !== 'invest') {
      const NOISE = /코스피|코스닥|증시|주가|폭락|급락|폭등|상한가|하한가|나스닥|환율|사이드카|서킷브레이커/;
      keywords = keywords
        .map((k) => {
          const parts = String(k).split(/\s*,\s*/);
          if (parts.length > 1 && NOISE.test(parts.slice(1).join(' ')) && !NOISE.test(parts[0])) return parts[0].trim();
          return k;
        })
        .filter((k) => !NOISE.test(k));
    }
    // 잡음 정리로 생길 수 있는 "정확히 같은" 중복만 제거(유사중복은 이미 위에서 처리 — 여기서 또 하면 롱테일이 뭉개짐).
    { const s = new Set(); keywords = keywords.filter((k) => { const n = (k || '').replace(/\s+/g, ''); if (!n || s.has(n)) return false; s.add(n); return true; }); }
    // ★키워드 문장형(뉴스 헤드라인) 제거 — 홈판 자동에도 '배우 하영 증조부 "나는…"…고종 독살설까지 파묘' 같은 문장이 섞임.
    //   키워드가 아니라 문장/헤드라인이면 뺀다: 따옴표·말줄임표·문장부호가 있거나, 너무 길거나(20자+), 어절이 5개 이상.
    const looksLikeKeyword = (k) => {
      const s = String(k || '').trim();
      if (!s) return false;
      if (/["'“”‘’「」『』]|\.{2,}|…|[?!]|~~/.test(s)) return false; // 인용부호·말줄임·물음표·느낌표 = 문장
      if (s.length > 20) return false;               // 20자 넘으면 헤드라인
      if (s.split(/\s+/).length > 5) return false;   // 어절 5개 초과 = 문장
      return true;
    };
    keywords = keywords.filter(looksLikeKeyword);
    // ★우선 단어(정책·금융) 매칭 키워드를 앞으로(안정정렬) — 순위 낮아 CAP에 잘리던 돈·제도·재테크 글감을 상단에 살린다.
    //   어드바이저 원본 순서(NEW·상단) 안에서 "우선 단어 포함"만 앞으로 끌어올릴 뿐, 나머지 순서는 그대로 유지(안정정렬).
    if (PRIORITY_WORDS_BY_TYPE[type]) {
      keywords = keywords.slice().sort((a, b) => (priorityHit(type, b) ? 1 : 0) - (priorityHit(type, a) ? 1 : 0));
    }
    // ★연예/이슈는 항상 30개 이상 보이게(캡 40). 다른 유형은 30개.
    const CAP = (type === 'celebrity') ? 40 : 30;
    keywords = keywords.slice(0, CAP);
    // ★개수 보강 — 연예는 30개 미만이면, 그 외는 15개 미만이면 네이버 자동완성으로 롱테일 확장.
    //   ★이번엔 확장분도 유사중복 제거(사용자 요청: 겹치는 검색어 X). 다른 유형으로 분명히 분류되는 건 제외.
    const MIN_WANT = 30; // ★모든 유형 최소 30개 목표(비연예 15→30 상향, 사용자 확정). 20은 하드 플로어(아래 top-up).
    // ★백필 정합(사용자 확정): 어드바이저 원본은 그대로 두되, "우리가 채워 넣는" 백필만 유형에 맞게.
    //   판별 규칙 = "명백히 다른 유형으로 분류되는 것 + 잡음"만 제외한다(★모름=null은 통과 — 폴스타4처럼 신호어에 없는 신차도 살린다).
    //   자동완성 확장은 이미 유형에 맞는 키워드를 씨앗으로 넓히는 거라 결과도 대부분 그 유형 → "확실한 것만"으로 조이면 신차가 억울하게 빠져서 안 됨.
    const sourceType = (arr) => (arr || []).filter((k) => { const c = classifyTrendKeyword(k); return !(c && c !== type) && !looksJunkKeyword(k) && looksLikeKeyword(k); });
    // ★백필 전 "어드바이저 원본" 스냅샷 — 최종 화면에서 파랑(원본)/빨강(우리가 추가) 구분용.
    const _normKw = (s) => String(s || '').replace(/\s+/g, '');
    const advisorNativeSet = new Set(keywords.map(_normKw));
    if (keywords.length < MIN_WANT) {
      try {
        const seeds = keywords.slice(0, 6);
        if (seeds.length) {
          const expanded = await expandKeywords(seeds, { rounds: 1, maxCandidates: 80, delayMs: 70 });
          const add = sourceType(expanded); // ★다른 유형/잡음만 제외(모름은 통과)
          keywords = dedupeSimilar([...keywords, ...add]).slice(0, CAP); // 유사중복 제거 → 겹침 없음
        }
      } catch (e) { /* 확장 실패해도 원래 목록 유지 */ }
    }
    // ★③ 그래도 30개 미만이면 = 유형별 "네이버 뉴스·랭킹 섹션" 기사 제목 → 핵심 대상 추출로 backfill(화면 표시도 30개 채우게).
    if (keywords.length < MIN_WANT && HOME_TYPE_URLS[type]) {
      try {
        const titles = await scrapeRankingTitles(HOME_TYPE_URLS[type], 60);
        let subs = await extractSubjectsFromTitles(titles);
        subs = sourceType(subs); // ★섹션 소스가 이미 유형 정합 → 다른 유형/잡음만 제거
        keywords = dedupeSimilar([...keywords, ...subs]).slice(0, CAP);
        console.log(`[advisor:trends] ${type} URL backfill → ${keywords.length}개`);
      } catch (e) { /* backfill 실패해도 원래 목록 유지 */ }
    }
    // ★겹침 제거로 20개 밑으로 떨어지면, 마지막으로 한 번 더 완화해 끌어와 최소 20개를 맞춘다(딱 맞는 걸 우선하되 플로어 보장).
    if (keywords.length < 20) {
      try {
        const seeds = keywords.slice(0, 10);
        if (seeds.length) {
          const more = await expandKeywords(seeds, { rounds: 2, maxCandidates: 160, delayMs: 60 });
          const add = sourceType(more); // 플로어용 = 완화(다른 유형/잡음만 제외)
          keywords = dedupeSimilar([...keywords, ...add]).slice(0, CAP);
          console.log(`[advisor:trends] ${type} 20개 top-up → ${keywords.length}개`);
        }
      } catch (e) { /* 실패해도 원래 목록 유지 */ }
    }
    // ★핵심어(첫 단어)당 최대 2개까지만 — 투싼×9 같은 쏠림 방지. coreCount는 자동발행 로테이션(반복 많은 것 위주)에 쓴다.
    let coreCount = {};
    try {
      const _cc = capPerCore(keywords, 2);
      const CAP = (type === 'celebrity') ? 40 : 30;
      keywords = capPerTail(_cc.list, 2).slice(0, CAP); // ★끝단어(대상) 캡 = 지역·수식어만 다른 같은 글감 홍수 방지
      coreCount = _cc.coreCount || {};
    } catch (e) {}
    // ★출처 태그(화면 색 구분): 'adv'=네이버 어드바이저 원본(파랑) / 'add'=우리가 백필로 채운 것(빨강).
    const srcTags = keywords.map((k) => (advisorNativeSet.has(_normKw(k)) ? 'adv' : 'add'));
    const elapsedMs = Date.now() - t0;
    // ★실제 소요시간 기록(디버그 + UI 표시용). 어드바이저 수집 vs 클로드 분류 어느 쪽이 느린지도 남긴다.
    // ★최종 화면 키워드 + 우선단어(★) 표시 — 우선정렬이 실제 먹었는지 눈으로 확인용.
    const finalKeywords = keywords.map((k) => (PRIORITY_WORDS_BY_TYPE[type] && priorityHit(type, k) ? '★' + k : k));
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'advisor-debug.txt'), JSON.stringify({ type, topics, elapsedMs, tAdvisorMs, tClaudeMs, counts: Object.fromEntries(Object.entries(byTopic).map(([k, v]) => [k, (v || []).length])), finalKeywords, probe, byTopic }, null, 2)); } catch (e) {}
    console.log(`[advisor:trends] ${type} 완료 — 총 ${(elapsedMs/1000).toFixed(1)}s (어드바이저 ${(tAdvisorMs/1000).toFixed(1)}s · Claude 미사용)`);
    return { ok: true, loginNeeded, topics, keywords, srcTags, coreCount, elapsedMs, tAdvisorMs, tClaudeMs };
  });

  // ★반복 회피 — 최근 생성한 소재(제목·키워드)를 저장해뒀다가 금지어로 넘긴다.
  const recentTopicsFile = path.join(app.getPath('userData'), 'recent-topics.json');
  function loadRecentTopics() {
    try { return JSON.parse(fs.readFileSync(recentTopicsFile, 'utf8')) || []; } catch (e) { return []; }
  }
  function saveRecentTopic(entry) {
    try {
      const list = loadRecentTopics();
      list.unshift({ ...entry, at: Date.now() });
      fs.writeFileSync(recentTopicsFile, JSON.stringify(list.slice(0, 500))); // ★날짜 기반 회피(14일)로 바꿔 상한 40→500(비대화 방지용 상한일 뿐)
    } catch (e) {}
  }

  // 렌더러(UI) → 실제 글 생성(홈판용). 구독 인증(query()), API 키 없음.
  // ★검색용 — 네이버 32주제 목록(드롭다운 소스) + 생성.
  ipcMain.handle('search:topics', async () => {
    try {
      const groups = (SEARCH_TOPIC_GROUPS || []).map((g) => ({ group: g.group, topics: (g.topics || []).map((t) => ({ key: t.key, label: t.label, family: FAMILY_BY_KEY[t.key] || 'C' })) }));
      return { ok: true, groups, families: SEARCH_FAMILIES, tonesWithNote: TONES_WITH_NOTE };
    } catch (e) { return { ok: false, error: e.message, groups: [] }; }
  });
  function appendSearchQuality(record) {
    try {
      const file = path.join(app.getPath('userData'), 'search-quality.jsonl');
      fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    } catch (e) {}
  }

  ipcMain.handle('generate:search', async (_e, { topic, keyword, extra, style, memo, paid, commerce, source, persona, avoidKeywords, review, opts } = {}) => {
    console.log('[IPC] generate:search', topic, keyword, style, memo ? 'memo' : '', paid || '', commerce || '', source ? 'link:' + (source.siteName || '') : '', persona ? 'persona' : '', review ? 'review:' + (review.target || '') : '');
    try {
      // ★키워드 없이 생성할 때 최근 쓴 키워드는 모델이 피하도록(중복 방지). 렌더러가 이미 concrete 키워드를 골라 넘기면 이건 보조.
      const avoid = Array.isArray(avoidKeywords) ? avoidKeywords : loadSearchRecentKws();
      // ★★공식 사실 우선 수집 = AI브리핑 + 정부/기관 페이지 본문(JS 렌더링). 링크형(source)·리뷰형(내돈내산)이 아닐 때만.
      //   이게 "인천 안마바우처가 정확히 뭔지·자격·사용처·신청"의 주력 근거가 된다(블로그는 보조).
      let officialFacts = null;
      if (!source && !review && keyword) { try { officialFacts = await fetchOfficialFacts(keyword); } catch (e) { officialFacts = null; } }
      const result = await generateSearchPost({ topic, keyword: keyword || '', extra: extra || '', style: style || '', memo: memo || '', paid: paid || '', commerce: commerce || '', source: source || null, linkNote: (source && source.note) || '', persona: persona || '', avoidKeywords: avoid, officialFacts, review: review || null, strictEvidence: !!(opts && opts.auto === true) });
      const { post, validation, meta, attempts, factCheck, scrapeHealth: health } = result;
      const brief = result.brief || {};
      const contentCheck = result.contentCheck || null;
      const status = result.status || 'review';
      const holdReasons = result.holdReasons || [];
      const reviewReasons = result.reviewReasons || [];
      if (post) {
        try {
          const store = readSearchPerformance();
          store.entries.push(createEntry({
            keyword: keyword || (post.hashtags && post.hashtags[0]) || post.title,
            topic,
            intent: brief.intent || 'general',
            status,
            title: post.title || '',
            generatedAt: new Date().toISOString(),
            version: brief.version || '',
          }));
          store.entries = store.entries.slice(-500);
          writeSearchPerformance(store);
        } catch (error) { console.warn('[perf] 검색 성과 항목 저장 실패:', error.message); }
      }
      const briefSummary = brief ? {
        intent: brief.intent,
        intentLabel: brief.intentLabel,
        requiredAnswers: brief.requiredAnswers || [],
        ambiguous: !!brief.ambiguous,
      } : null;
      const missing = contentCheck && Array.isArray(contentCheck.missing) ? contentCheck.missing : [];
      appendSearchQuality({
        at: new Date().toISOString(),
        version: brief.version || '',
        keyword: keyword || '',
        topic: topic || '',
        intent: brief.intent || '',
        ambiguous: !!brief.ambiguous,
        status,
        holdReasons,
        reviewReasons,
        title: post && post.title || '',
        bodyLength: validation && validation.bodyLength || 0,
        attempts: attempts || 0,
        missing: missing.map((item) => item.id),
      });
      if (!post && status === 'hold') {
        return { ok: true, status, holdReasons, reviewReasons, post: null, validation: null, meta: null, attempts: attempts || 0, brief: briefSummary, contentCheck, factCheck: null, scrapeHealth: health || null, officialUrls: [] };
      }
      logTokenUsage('검색', keyword || (post && post.title) || '', meta);
      // ★쓴 키워드(또는 모델이 정한 제목 키워드)를 최근 목록에 저장 → 다음 생성/예약에서 회피.
      try {
        const usedKw = String(keyword || '').trim() || (post && post.hashtags && post.hashtags[0]) || (post && post.title ? String(post.title).slice(0, 20) : '');
        if (usedKw) pushSearchRecent(usedKw); // {kw,at} 형식으로 저장(14일 회피와 일관)
      } catch (e) {}
      // ★AI브리핑이 인용한 공식 출처 URL을 함께 반환 → 앱이 그 공식 사이트 이미지를 1순위로 수집(정책·정부 주제).
      const officialUrls = (officialFacts && Array.isArray(officialFacts.urls)) ? officialFacts.urls : [];
      return { ok: true, post, validation, meta, attempts, officialUrls, factCheck: factCheck || null, scrapeHealth: health || null, status, holdReasons, reviewReasons, brief: briefSummary, contentCheck };
    } catch (e) { try { if (/exited with code|process|spawn|ENOENT|bash|not found/i.test(e && e.message || '')) diagnoseClaudeSpawn('generate:search ' + (e && e.message)); } catch (_) {} return { ok: false, error: e.message }; }
  });

  ipcMain.handle('generate:post', async (_e, { type, keyword, tone, style, persona, fan, places, reviews, coupangLinks, reviewInfo, reviewOpts, headingTarget, cardMode, contentForm }) => {
    console.log('[IPC] generate:post', type, keyword, tone, style, persona, fan, places);
    try {
      // 최근 소재 → 금지어(제목 + 키워드)
      const recent = loadRecentTopics();
      const avoidKeywords = recent.flatMap((r) => [r.keyword, r.title].filter(Boolean)).slice(0, 30);

      // ★자동 모드 = 씨앗 레이더: 구글트렌드(검색량·연관어) + 엔터/스포츠 랭킹 → 빈틈 점수로 "선점 좋은" 순 랭킹.
      //   랭킹된 씨앗을 trends로 넘기면 generatePost가 상위(선점 좋은 것)를 우선 surface해 Claude가 고른다.
      let rankedTrends = null;
      if (!keyword) {
        try {
          const cands = [
            ...gtCache.map((t) => ({ ...t, source: 'google-trends' })),
            ...(entSpCache || []),
          ];
          if (cands.length) rankedTrends = await rankSeeds(cands, { type, gapProbe: 20, limit: 12 });
        } catch (e) { rankedTrends = null; }
      }

      const { post, validation, meta, attempts, trends, factCheck, scrapeHealth: health } = await generatePost({
        type, keyword: keyword || '', tone: tone || '존댓말', style: style || '', persona: persona || '', fan: fan || '', places: places || [], reviews: reviews || [], coupangLinks: coupangLinks || [], reviewInfo: reviewInfo || null, reviewOpts: reviewOpts || null,
        headingTarget: headingTarget || null, cardMode: cardMode || false, contentForm: contentForm || 'auto',
        trends: rankedTrends, extraTrends: rankedTrends ? [] : entSpCache, avoidKeywords,
        maxAttempts: 2, // ★재생성 3→2 (속도). 분량 미달은 가끔 허용(사용자 인지).
      });
      logTokenUsage('홈판', keyword || (post && post.title) || '', meta);
      // 이번 소재 저장(다음 생성부터 회피)
      if (post && post.title) saveRecentTopic({ title: post.title, keyword: keyword || '' });
      // ★팩트 대조에서 지적이 나오면 파일로도 남긴다(화면 경고는 렌더러가 표시).
      try {
        if (factCheck && factCheck.ran && factCheck.issues.length) {
          const lines = factCheck.issues.map(function (i) { return '[' + i.verdict + '/' + i.severity + '] ' + i.text + '  <- ' + i.why; }).join('\n');
          fs.appendFileSync(path.join(app.getPath('userData'), 'factcheck.log'),
            '\n[' + new Date().toLocaleString() + '] ' + (keyword || (post && post.title) || '') + '\n' + lines + '\n');
        }
      } catch (e) {}
      return { ok: true, post, validation, meta, attempts, trends: trends || [], factCheck: factCheck || null, scrapeHealth: health || null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 자동 로그인 유지 여부 저장 (렌더러 로그인 화면에서 설정)
  ipcMain.handle('session:autologin', async (_e, keep) => { keepSession = !!keep; return { ok: true }; });

  // ★네이버 로그아웃(다른 아이디로 로그인) — naver.com 쿠키만 골라 삭제한다.
  //   ★카카오·클로드 쿠키는 건드리지 않는다 — 도메인이 naver.com 계열인 쿠키만 지워 네이버 세션만 끊는다.
  ipcMain.handle('session:logoutNaver', async () => {
    try {
      const ses = session.fromPartition('persist:naver');
      const cookies = await ses.cookies.get({});
      let n = 0;
      for (const c of cookies) {
        const dom = (c.domain || '').replace(/^\./, '');
        // naver.com 및 하위도메인(nid.naver.com=인증쿠키, blog.naver.com 등)만. kakao 등은 제외.
        if (/(^|\.)naver\.com$/i.test(dom) || /(^|\.)naver\.com$/i.test('.' + dom)) {
          for (const host of [dom, dom.split('.').slice(-2).join('.')]) {
            for (const proto of ['https://', 'http://']) {
              try { await ses.cookies.remove(proto + host + (c.path || '/'), c.name); } catch (e) {}
            }
          }
          n++;
        }
      }
      // 네이버 도메인 스토리지만 정리(카카오 origin은 손대지 않음).
      for (const origin of ['https://naver.com', 'https://nid.naver.com', 'https://blog.naver.com', 'https://www.naver.com']) {
        try { await ses.clearStorageData({ origin, storages: ['cookies', 'localstorage'] }); } catch (e) {}
      }
      return { ok: true, removed: n };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ★진단 파일 쓰기 — 에디터 주입·caret 프로브 덤프 등을 userData에 저장.
  ipcMain.handle('debug:saveText', async (_e, { name, text } = {}) => {
    try {
      const safe = String(name || 'debug.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(app.getPath('userData'), safe), String(text || ''));
    } catch (e) {}
    return { ok: true };
  });

  // ★외부 링크를 기본 브라우저로 연다.
  ipcMain.handle('open:external', async (_e, { url } = {}) => {
    try {
      const u = String(url || '');
      if (/^https?:\/\//.test(u)) { await shell.openExternal(u); return { ok: true }; }
      return { ok: false, error: 'invalid-url' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ★예약 설정 = "파일"에 저장(localStorage는 포트에 묶여 --auto가 랜덤 포트로 뜨면 못 읽음 → 예약 실패 버그).
  //   파일에 두면 포트·창과 무관하게 --auto가 항상 읽는다.
  const resvFilePath = (kind) => path.join(app.getPath('userData'), kind === 'search' ? 'resv-settings-search.json' : 'resv-settings.json');
  ipcMain.handle('schedule:saveSettings', async (_e, arg) => {
    // arg = {kind, settings}  (하위호환: settings만 오면 홈판)
    const kind = (arg && arg.kind) || 'home';
    const s = (arg && arg.settings) ? arg.settings : arg;
    try { fs.writeFileSync(resvFilePath(kind), JSON.stringify(s || {})); } catch (e) {}
    return { ok: true };
  });
  ipcMain.handle('schedule:getSettings', async (_e, arg) => {
    const kind = (arg && arg.kind) || 'home';
    try { return { ok: true, settings: JSON.parse(fs.readFileSync(resvFilePath(kind), 'utf8')) }; }
    catch (e) { return { ok: true, settings: null }; }
  });

  // ★검색용 "내 프로필(페르소나)" — 파일 저장. localStorage는 윈도우에서 포트가 바뀌면 날아가서
  //   프로필이 사라지고 [글 만들기]가 막히던 문제 → 예약설정처럼 userData 파일에 저장해 재시작·포트변경에도 유지.
  const profileFilePath = () => path.join(app.getPath('userData'), 'search-profile.json');
  ipcMain.handle('profile:save', async (_e, arg) => {
    const p = (arg && arg.profile) ? arg.profile : arg;
    try { fs.writeFileSync(profileFilePath(), JSON.stringify(p || {})); } catch (e) {}
    return { ok: true };
  });
  ipcMain.handle('profile:get', async () => {
    try { return { ok: true, profile: JSON.parse(fs.readFileSync(profileFilePath(), 'utf8')) }; }
    catch (e) { return { ok: true, profile: null }; }
  });

  // ★검색용 "최근 쓴 키워드" 저장소 — 중복 방지(홈판 loadRecentTopics의 검색용판). 예약 발행은 매번 새 프로세스라 파일로만 유지 가능.
  //   ★2026-09 날짜 기반으로 변경: {kw, at} 객체로 저장 → "14일 이내에 쓴 것"만 회피(그 뒤엔 다시 써도 됨). 옛 문자열 항목도 호환.
  //   get은 예전처럼 "문자열 목록"을 돌려줘서 렌더러·autoRun은 그대로. (14일 필터는 여기서 함)
  const RECENT_DAYS = 14;
  const searchRecentPath = () => path.join(app.getPath('userData'), 'search-recent-keywords.json');
  const loadSearchRecentRaw = () => { try { const a = JSON.parse(fs.readFileSync(searchRecentPath(), 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  // 저장 형태(문자열 또는 {kw,at})를 {kw,at}로 정규화. 옛 문자열은 at 없음 → 회피 유지(안전).
  const _srNorm = (x) => (x && typeof x === 'object') ? { kw: String(x.kw || '').trim(), at: x.at || 0 } : { kw: String(x || '').trim(), at: 0 };
  // ★14일 이내 "최근 쓴 키워드 문자열 목록" — 생성 코드(회피용)가 쓴다. (예전 loadSearchRecent 대체)
  const loadSearchRecentKws = () => { const cut = Date.now() - RECENT_DAYS * 24 * 3600 * 1000; return loadSearchRecentRaw().map(_srNorm).filter((o) => o.kw && (!o.at || o.at >= cut)).map((o) => o.kw); };
  // ★최근 쓴 키워드 1개 추가({kw,at} 형식, 500개 상한) — 생성 완료 후 회피 목록에 쌓기.
  const pushSearchRecent = (kw) => { try { const k = String(kw || '').trim(); if (!k) return; const n = (s) => s.replace(/\s+/g, '').toLowerCase(); let list = loadSearchRecentRaw().map(_srNorm).filter((o) => o.kw && n(o.kw) !== n(k)); list.unshift({ kw: k, at: Date.now() }); fs.writeFileSync(searchRecentPath(), JSON.stringify(list.slice(0, 500))); } catch (e) {} };
  ipcMain.handle('searchRecent:get', async () => {
    try {
      const cut = Date.now() - RECENT_DAYS * 24 * 3600 * 1000;
      const list = loadSearchRecentRaw().map(_srNorm)
        .filter((o) => o.kw && (!o.at || o.at >= cut)) // ★14일 이내만(at 없는 옛 항목은 유지)
        .map((o) => o.kw);
      return { ok: true, list };
    } catch (e) { return { ok: true, list: [] }; }
  });
  ipcMain.handle('searchRecent:add', async (_e, arg) => {
    try {
      const kw = String((arg && arg.keyword) || '').trim(); if (!kw) return { ok: true };
      const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
      let list = loadSearchRecentRaw().map(_srNorm).filter((o) => o.kw && norm(o.kw) !== norm(kw)); // 같은 키워드 옛 기록 제거
      list.unshift({ kw, at: Date.now() });                              // 맨 앞에(최신, 시각 기록)
      list = list.slice(0, 500);                                         // 저장 상한(파일 비대화 방지)
      fs.writeFileSync(searchRecentPath(), JSON.stringify(list));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ★자동발행 키워드 "로테이션" — 여러 사람이 같은 키워드만 쓰지 않게, 발행마다 뽑는 방식을 번갈아 쓴다.
  //   0=반복많은것(hot: 핵심어 여러번 등장) / 1=NEW(실시간·신규) / 2=상단부터(랭킹 위). 설치마다 카운터를 파일로 유지 → 실행할 때마다 +1.
  const rotStatePath = () => path.join(app.getPath('userData'), 'autopost-rotation.json');
  const ROT_NAMES = ['hot', 'new', 'top'];
  ipcMain.handle('autopost:nextStrategy', async () => {
    let n = 0;
    try { const o = JSON.parse(fs.readFileSync(rotStatePath(), 'utf8')); n = (o && Number.isFinite(o.n)) ? o.n : 0; } catch (e) {}
    const idx = ((n % 3) + 3) % 3;
    try { fs.writeFileSync(rotStatePath(), JSON.stringify({ n: n + 1 })); } catch (e) {}
    return { ok: true, idx, name: ROT_NAMES[idx] };
  });

  // ★★★키워드 backfill — 어드바이저/트렌드로 개수가 모자랄 때만, 유형/주제별 네이버 랭킹·섹션에서 "기사 제목 → 핵심 대상"을 추가로 뽑는다.
  //   (사용자 확정: 어드바이저 1순위, 부족할 때만 URL. "이미 뜬 것" 물량 확보용.)
  const HOME_TYPE_URLS = {
    celebrity: ['https://m.entertain.naver.com/ranking','https://m.entertain.naver.com/now','https://m.entertain.naver.com/now?sid=224','https://m.entertain.naver.com/now?sid=221','https://m.entertain.naver.com/now?sid=222','https://m.entertain.naver.com/now?sid=225','https://m.entertain.naver.com/now?sid=7a5','https://m.entertain.naver.com/now?sid=309'],
    invest: ['https://news.naver.com/section/101','https://news.naver.com/section/104','https://news.naver.com/breakingnews/section/101/259','https://news.naver.com/breakingnews/section/101/258','https://news.naver.com/breakingnews/section/101/310'],
    policy: ['https://news.naver.com/section/100','https://news.naver.com/section/102','https://news.naver.com/breakingnews/section/103/240'],
    it: ['https://news.naver.com/section/105'],
    car: ['https://news.naver.com/breakingnews/section/103/239','https://news.naver.com/breakingnews/section/103/240'],
    sportsnews: ['https://m.sports.naver.com/index','https://m.sports.naver.com/kbaseball/index','https://m.sports.naver.com/wbaseball/index','https://m.sports.naver.com/kfootball/index','https://m.sports.naver.com/wfootball/index','https://m.sports.naver.com/basketball/index','https://m.sports.naver.com/volleyball/index','https://m.sports.naver.com/general/index','https://game.naver.com/esports/League_of_Legends/home'],
    life: ['https://news.naver.com/breakingnews/section/103/241','https://news.naver.com/breakingnews/section/101/310','https://news.naver.com/breakingnews/section/102/257'],
  };
  const SEARCH_TOPIC_URLS = {
    fashion: ['https://news.naver.com/breakingnews/section/103/376'],
    show: ['https://news.naver.com/breakingnews/section/103/242'],
    literature: ['https://news.naver.com/breakingnews/section/103/243'],
    broadcast: ['https://m.entertain.naver.com/home'],
    drama: ['https://m.entertain.naver.com/drama'],
    movie: ['https://m.entertain.naver.com/movie'],
    music: ['https://m.entertain.naver.com/music'],
    star: ['https://m.entertain.naver.com/relationship','https://m.entertain.naver.com/ranking','https://m.entertain.naver.com/now'],
    daily: ['https://news.naver.com/section/103','https://news.naver.com/breakingnews/section/103/245','https://news.naver.com/breakingnews/section/102/249'],
    restaurant: ['https://news.naver.com/breakingnews/section/103/238'],
    domestictravel: ['https://news.naver.com/breakingnews/section/103/237'],
    worldtravel: ['https://news.naver.com/breakingnews/section/103/237'],
    game: ['https://game.naver.com/esports/League_of_Legends/news/lol','https://game.naver.com/esports/OVERWATCH/home','https://game.naver.com/esports/Valorant/home','https://game.naver.com/esports/Player_Unknowns_Battle_Grounds/home','https://game.naver.com/esports/general/home'],
    it: ['https://news.naver.com/section/105'],
    society: ['https://news.naver.com/section/100','https://news.naver.com/section/102','https://news.naver.com/breakingnews/section/102/250','https://news.naver.com/breakingnews/section/102/249'],
    business: ['https://news.naver.com/section/101','https://news.naver.com/section/104','https://news.naver.com/breakingnews/section/101/771'],
  };
  const SEARCH_GROUP_URLS = {
    A: ['https://m.entertain.naver.com/home','https://m.entertain.naver.com/ranking','https://m.entertain.naver.com/now'],
    B: ['https://news.naver.com/section/103','https://news.naver.com/breakingnews/section/103/245'],
    C: ['https://news.naver.com/breakingnews/section/103/238','https://news.naver.com/breakingnews/section/103/237'],
    D: ['https://news.naver.com/section/100','https://news.naver.com/section/101','https://news.naver.com/section/102','https://news.naver.com/section/104'],
  };
  // 랭킹·섹션 페이지에서 "기사 제목 후보" 추출(범용: 링크·헤드라인 텍스트 중 8~60자 한글).
  const RANK_TITLE_EXTRACT = "(function(){var out=[],seen={};var els=document.querySelectorAll('a, strong, [class*=tit], [class*=title], [class*=headline], [class*=Headline]');for(var i=0;i<els.length;i++){var t=(els[i].textContent||'').replace(/\\s+/g,' ').trim();if(t.length>=8&&t.length<=60&&/[가-힣]/.test(t)&&!/로그인|더보기|네이버|바로가기|서비스|고객센터|앱\\s*다운|구독|공지|이벤트|전체보기|랭킹뉴스|많이본|댓글/.test(t)&&!seen[t]){seen[t]=1;out.push(t);}if(out.length>=50)break;}return JSON.stringify(out);})()";
  async function scrapeRankingTitles(urls, maxTitles) {
    const titles = []; const seen = {};
    for (const u of (urls || []).slice(0, 5)) {
      try {
        const r = await scrapeRendered(u, RANK_TITLE_EXTRACT, 2600, 'persist:naver', _DESKTOP_UA_OF);
        const arr = typeof r === 'string' ? JSON.parse(r) : (Array.isArray(r) ? r : []);
        (arr || []).forEach((t) => { t = String(t || '').trim(); if (t && !seen[t]) { seen[t] = 1; titles.push(t); } });
      } catch (e) {}
      if (titles.length >= (maxTitles || 40)) break;
    }
    return titles.slice(0, maxTitles || 40);
  }
  // 기사 제목들 → 각 "핵심 대상(사람·작품·사물·사건)" 1개씩 (Haiku 배치, 저렴). 회차·수식어·후킹 제거.
  async function extractSubjectsFromTitles(titles) {
    if (!titles || !titles.length) return [];
    try {
      const { runClaude } = require('../src/generator/runClaude');
      const system = '너는 기사 제목에서 "블로그 글감이 되는 완성된 검색 키워드" 1개를 뽑는 추출기다. 규칙:\n'
        + '①각 제목당 키워드 하나, 한 줄.\n'
        + '②★"대상 + 핵심 맥락"을 붙인 완성형으로 뽑아라(2~15자). 단독 일반명사(일정·가격·출시일·옵션·논란·방법·후기·정보 등)만 달랑 뽑지 마라 — 반드시 그 앞에 "무엇의(대상)"를 붙여라. 예: 제목이 "아이폰18 출시일 유출" → "아이폰18 출시일"(O) / "출시일"(X). "포켓몬고 자시안 이벤트 일정" → "포켓몬고 자시안 일정"(O) / "일정"(X).\n'
        + '③단, 대상 자체가 이미 자기설명적 고유명사면(오디세이·투싼·손흥민) 그대로도 좋다.\n'
        + '④"○○화(회차)"·"총정리/공개/논란 이유" 같은 순수 후킹 군더더기는 빼되, 검색되는 핵심 맥락(가격·출시일·일정·방법)은 붙여서 남겨라.\n'
        + '⑤광고·안내·의미없는 조각(카페8794·AG·옵션 같은 것만)이면 그 줄은 "-"만 출력해라(설명·"빈 줄" 같은 글자 쓰지 말 것).\n'
        + '⑥출력은 제목당 한 줄, 완성 키워드만(번호·설명 없이).';
      const user = titles.map((t, i) => (i + 1) + '. ' + t).join('\n') + '\n\n각 제목의 "완성 키워드"만 한 줄씩(대상+맥락 붙여서):';
      const { text } = await runClaude({ system, user, model: 'claude-haiku-4-5-20251001' });
      return String(text || '').split('\n')
        .map((s) => s.replace(/^\s*\d+[.)\]]?\s*/, '').replace(/^["'\s]+|["'\s]+$/g, '').trim())
        // ★모델이 조각 대신 뱉는 자리표시(-, [빈 줄], [빈 줄 3개], (없음) 등) 제거 + 잡음 게이트.
        .filter((s) => s && s.length >= 2 && s.length <= 20 && !/^[-–—]+$/.test(s) && !/빈\s*줄/.test(s) && !/^[\[(].*[\])]$/.test(s) && !looksJunkKeyword(s));
    } catch (e) { return []; }
  }
  ipcMain.handle('keyword:urlBackfill', async (_e, { kind, key, family, need } = {}) => {
    const t0 = Date.now();
    try {
      let urls = [];
      if (kind === 'home') urls = HOME_TYPE_URLS[key] || [];
      else urls = (SEARCH_TOPIC_URLS[key] || SEARCH_GROUP_URLS[family] || []);
      if (!urls.length) return { ok: true, subjects: [], note: 'no-url-mapping' };
      const titles = await scrapeRankingTitles(urls, Math.max(24, (need || 20) + 10));
      let subjects = await extractSubjectsFromTitles(titles);
      try { subjects = dedupeSimilar(subjects); } catch (e) {}
      try { fs.appendFileSync(path.join(app.getPath('userData'), 'token-usage.log'), '[' + new Date().toLocaleString() + '] 키워드 URL backfill(' + kind + '/' + (key || family) + ') 제목' + titles.length + '개→대상' + subjects.length + '개 소요' + Math.round((Date.now() - t0) / 1000) + '초\n'); } catch (e) {}
      return { ok: true, subjects };
    } catch (e) { return { ok: false, error: e.message, subjects: [] }; }
  });

  // ★"오늘 만든 글 제목" 목록 — 제목 자동입력이 실패해도 사용자가 여기서 제목을 복사해 넣을 수 있게 파일에 쌓는다.
  const titlesPath = () => path.join(app.getPath('userData'), 'generated-titles.json');
  const loadTitles = () => { try { const a = JSON.parse(fs.readFileSync(titlesPath(), 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const dayStr = (d) => { const x = d || new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  ipcMain.handle('titles:add', async (_e, arg) => {
    try {
      const title = String((arg && arg.title) || '').trim(); if (!title) return { ok: true };
      const now = new Date();
      const hh = now.getHours(), ap = hh < 12 ? '오전' : '오후', h12 = ((hh % 12) || 12), mm = String(now.getMinutes()).padStart(2, '0');
      let list = loadTitles();
      list.unshift({ title, kind: (arg && arg.kind) || 'home', titleOk: !!(arg && arg.titleOk), day: dayStr(now), time: ap + ' ' + h12 + ':' + mm });
      list = list.slice(0, 300); // 최근 300개 보관
      fs.writeFileSync(titlesPath(), JSON.stringify(list));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('titles:today', async () => {
    try { const today = dayStr(new Date()); return { ok: true, list: loadTitles().filter((x) => x && x.day === today) }; }
    catch (e) { return { ok: true, list: [] }; }
  });

  // ★범용 디버그 로그 — 렌더러(버튼 클릭 등) 흐름을 파일로 추적(stdout엔 안 잡히므로).
  ipcMain.handle('debug:log', async (_e, msg) => {
    try {
      const line = `[${new Date().toISOString()}] ${String(msg || '')}\n`;
      fs.appendFileSync(path.join(app.getPath('userData'), 'insert-debug.txt'), line);
    } catch (e) {}
    return { ok: true };
  });

  // ★클로드 로그인 — 구독(프로/맥스) 계정만. setup-token·API키·콘솔 안 씀. 번들된 claude 실행기의 auth 사용.
  const _cpAuth = require('child_process');
  function claudeBinPath() {
    const want = 'claude-agent-sdk-' + process.platform; // win32/darwin/linux — ★현재 플랫폼 것만(엉뚱한 OS 바이너리 실행 금지)
    const names = process.platform === 'win32' ? ['claude.exe', 'claude'] : ['claude', 'claude.exe'];
    // ★패키징 구조가 top-level일 수도, claude-agent-sdk 안에 nested일 수도, asar.unpacked일 수도 있어 여러 후보를 다 뒤진다.
    const nmList = [path.join(__dirname, '..', 'node_modules')];
    if (nmList[0].includes('app.asar') && !nmList[0].includes('app.asar.unpacked')) nmList.push(nmList[0].replace('app.asar', 'app.asar.unpacked'));
    const roots = [];
    for (const nm of nmList) {
      roots.push(path.join(nm, '@anthropic-ai'));
      roots.push(path.join(nm, '@anthropic-ai', 'claude-agent-sdk', 'node_modules', '@anthropic-ai'));
    }
    for (const root of roots) {
      try {
        const dirs = fs.readdirSync(root).filter((d) => d.startsWith(want));
        for (const d of dirs) {
          for (const n of names) {
            const p = path.join(root, d, n);
            if (fs.existsSync(p)) return p;
          }
        }
      } catch (e) {}
    }
    return null;
  }
  // ★윈도우: 번들한 Git Bash 경로를 찾는다. claude.exe(클로드 코드)는 윈도우에서 bash가 필수라, 초보가 Git 안 깔아도 되게 앱에 bash를 동봉.
  function bundledBashPath() {
    if (process.platform !== 'win32') return null;
    const cands = [
      path.join(process.resourcesPath || '', 'gitbash', 'bash.exe'),   // 패키징(extraResources) → resources/gitbash/bash.exe
      path.join(__dirname, '..', 'win-gitbash', 'bash.exe'),           // 개발/미패키징 저장소 경로
    ];
    for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
    return null;
  }
  // ★★★[윈도우 핵심] gitbash 경로를 "전역 process.env"에 심는다 → 로그인뿐 아니라 "생성(claude-agent-sdk query())"이
  //   띄우는 claude.exe도 이 env를 상속해 bash를 찾는다.
  //   ★★★반드시 "동봉 bash로 덮어쓴다"(기존 값 무시): 사용자 시스템에 이미 CLAUDE_CODE_GIT_BASH_PATH가
  //      "깨진/오래된 시스템 Git bash"로 설정돼 있으면, 로그인은 되는데(동봉 bash 씀) 생성만 그 시스템 bash로 code 1 나던 실측 버그.
  //      동봉 bash는 우리가 검증한 것이라 무조건 이걸 쓰게 강제한다.
  try {
    if (process.platform === 'win32') {
      const _gb = bundledBashPath();
      if (_gb) { process.env.CLAUDE_CODE_GIT_BASH_PATH = _gb; claudeDebug && claudeDebug('전역(강제) CLAUDE_CODE_GIT_BASH_PATH=' + _gb); }
    }
  } catch (e) {}
  function claudeEnv() {
    const e = { ...process.env };
    delete e.ANTHROPIC_API_KEY;
    // ★윈도우: 동봉한 bash를 claude.exe에 알려준다(없으면 "CLAUDE_CODE_GIT_BASH_PATH path 못 찾음"으로 죽음).
    if (process.platform === 'win32') {
      const bash = bundledBashPath();
      if (bash) e.CLAUDE_CODE_GIT_BASH_PATH = bash;
    }
    return e;
  }
  let _claudeLogin = null; // 진행 중인 로그인 프로세스(코드 붙여넣기용)
  // ★클로드 로그인 진단 로그 — 윈도우 등에서 claude.exe가 실제로 뱉는 에러/출력/종료코드를 파일에 남긴다.
  function claudeDebug(msg) {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'claude-debug.txt'), `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
  }
  // ★★★[생성 실패 진단] "Claude Code process exited with code 1"이 나면 = bash·claude·env 중 뭐가 문제인지 직접 테스트해 파일에 남긴다.
  //   안 되는 컴퓨터에서 이 진단을 돌려 claude-debug.txt를 받으면 진짜 원인(bash 실행실패=보안차단/DLL, claude 실행실패 등)을 특정할 수 있다.
  function diagnoseClaudeSpawn(reason) {
    const L = [];
    const put = (s) => L.push(s);
    try {
      put('===== 생성실패 진단 =====');
      put('reason=' + String(reason || '').slice(0, 300));
      put('platform=' + process.platform + ' arch=' + process.arch + ' electron=' + process.versions.electron);
      put('win버전=' + (require('os').release && require('os').release()));
      put('env CLAUDE_CODE_GIT_BASH_PATH=' + (process.env.CLAUDE_CODE_GIT_BASH_PATH || '(unset)'));
      const bb = bundledBashPath();
      put('bundledBashPath=' + (bb || '(null)') + ' exists=' + (bb ? fs.existsSync(bb) : false));
      const bin = claudeBinPath();
      put('claudeBinPath=' + (bin || '(null)') + ' exists=' + (bin ? fs.existsSync(bin) : false));
      // 1) 동봉 bash가 이 컴퓨터에서 실제로 실행되나 (보안차단·DLL문제면 여기서 FAIL)
      if (bb) {
        try { const r = _cpAuth.execFileSync(bb, ['-c', 'echo BASHOK'], { timeout: 8000, env: claudeEnv() }); put('bash 실행테스트: OK → ' + String(r).trim()); }
        catch (e) { put('bash 실행테스트: FAIL msg=' + (e && e.message || e) + ' code=' + (e && e.status) + ' stderr=' + String((e && e.stderr) || '').slice(0, 400)); }
      }
      // 2) claude 실행기가 이 컴퓨터에서 실제로 실행되나
      if (bin) {
        try { const r = _cpAuth.execFileSync(bin, ['--version'], { timeout: 15000, env: claudeEnv() }); put('claude --version: OK → ' + String(r).trim().slice(0, 150)); }
        catch (e) { put('claude --version: FAIL msg=' + (e && e.message || e) + ' code=' + (e && e.status) + ' stderr=' + String((e && e.stderr) || '').slice(0, 400)); }
      }
      put('');
    } catch (e) { put('진단 자체 오류: ' + (e && e.message)); }
    claudeDebug(L.join('\n'));
  }

  // 로그인 상태 확인 → {loggedIn, email, subscriptionType}. 이미 로그인돼 있으면 그대로 연동.
  ipcMain.handle('claude:status', async () => {
    const bin = claudeBinPath();
    claudeDebug('status: bin=' + (bin || 'NULL') + ' platform=' + process.platform);
    if (!bin) return { ok: false, loggedIn: false, error: 'claude 실행기를 찾지 못했어요(번들 경로)' };
    return new Promise((resolve) => {
      _cpAuth.execFile(bin, ['auth', 'status'], { timeout: 15000, env: claudeEnv() }, (err, stdout, stderr) => {
        claudeDebug('status: err=' + (err && err.message) + ' | out=' + String(stdout || '').slice(0, 300) + ' | errout=' + String(stderr || '').slice(0, 300));
        try { const j = JSON.parse(String(stdout || '').trim()); resolve({ ok: true, ...j }); }
        catch (e) { resolve({ ok: false, loggedIn: false, error: (err && err.message) || '상태 확인 실패' }); }
      });
    });
  });

  // 공식 로그인 시작 → claude.ai OAuth 창을 열고, "코드 붙여넣기" 필요 여부와 URL 반환.
  ipcMain.handle('claude:login', async (_e, { email } = {}) => {
    const bin = claudeBinPath();
    claudeDebug('login: bin=' + (bin || 'NULL') + ' platform=' + process.platform + ' bash=' + (bundledBashPath() || 'NONE') + ' userData=' + app.getPath('userData'));
    if (!bin) return { ok: false, error: 'claude 실행기를 찾지 못했어요(번들 경로). 재설치해도 계속되면 알려주세요.' };
    try { _claudeLogin && _claudeLogin.kill(); } catch (e) {}
    const args = ['auth', 'login', '--claudeai'];
    if (email) args.push('--email', email);
    let proc;
    try {
      proc = _cpAuth.spawn(bin, args, { env: claudeEnv(), windowsHide: true });
    } catch (e) {
      claudeDebug('login: spawn threw = ' + e.message);
      return { ok: false, error: 'claude 실행 실패: ' + e.message };
    }
    _claudeLogin = proc;
    return new Promise((resolve) => {
      let buf = '', settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      const onData = (d) => {
        buf += d.toString();
        // ★OAuth URL 매칭을 넓게 — claude.ai/oauth·authorize·login, anthropic OAuth 등 다양한 형태 대응.
        const m = buf.match(/https:\/\/[^\s"']*(?:claude\.ai|anthropic\.com|console\.anthropic\.com)\/[^\s"']*(?:oauth|authorize|login)[^\s"']*/i)
               || buf.match(/https:\/\/[^\s"']*(?:oauth|authorize)[^\s"']*/i);
        if (m) { claudeDebug('login: got url = ' + m[0]); try { shell.openExternal(m[0]); } catch (e) {} done({ ok: true, needCode: true, url: m[0] }); }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', (code) => {
        claudeDebug('login: EXIT code=' + code + ' | captured=' + buf.slice(0, 600));
        // ★실패 시 claude.exe가 뱉은 실제 메시지를 error로 올려보낸다(팝업에 그대로 표시 → 진짜 원인 파악).
        const tail = buf.replace(/\s+/g, ' ').trim().slice(-400);
        done({ ok: code === 0, needCode: false, error: code === 0 ? undefined : ('claude 종료(코드 ' + code + ')' + (tail ? ' · ' + tail : ' · 출력 없음')) });
      });
      proc.on('error', (e) => { claudeDebug('login: proc error = ' + e.message); done({ ok: false, error: 'claude 실행 오류: ' + e.message }); });
      setTimeout(() => { claudeDebug('login: TIMEOUT captured=' + buf.slice(0, 600)); done({ ok: false, error: '로그인 시작 응답이 없어요(15초). 출력: ' + (buf.replace(/\s+/g, ' ').trim().slice(-300) || '없음') }); }, 15000);
    });
  });

  // 브라우저에서 받은 코드를 stdin으로 전달 → 완료 판정. 완료 후 렌더러가 claude:status로 재확인.
  ipcMain.handle('claude:loginCode', async (_e, { code } = {}) => {
    const proc = _claudeLogin;
    if (!proc || proc.exitCode !== null) return { ok: false, error: '로그인 진행 중이 아니에요. [클로드 로그인]을 다시 눌러주세요.' };
    return new Promise((resolve) => {
      let out = '', settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { out += d.toString(); });
      proc.on('exit', (c) => done({ ok: c === 0, raw: out.slice(-300) }));
      proc.on('error', (e) => done({ ok: false, error: e.message }));
      try { proc.stdin.write(String(code || '').trim() + '\n'); } catch (e) { done({ ok: false, error: e.message }); }
      setTimeout(() => done({ ok: false, error: '코드 확인 시간 초과' }), 25000);
    });
  });

  // ★클로드 "다른 계정으로 로그인 / 로그아웃" — 저장된 클로드 인증만 초기화(auth logout). 이후 렌더러가 claude:login 다시 호출.
  ipcMain.handle('claude:logout', async () => {
    const bin = claudeBinPath();
    if (!bin) return { ok: false, error: 'claude 실행기를 찾지 못했어요' };
    try { _claudeLogin && _claudeLogin.kill(); } catch (e) {}
    return new Promise((resolve) => {
      _cpAuth.execFile(bin, ['auth', 'logout'], { timeout: 15000, env: claudeEnv() }, (err) => {
        resolve({ ok: !err, error: err && err.message });
      });
    });
  });

  // ★자동 예약 발행에서 "붙여넣기(paste)"는 창이 포그라운드+포커스여야 에디터에 들어간다. 백그라운드면 첫 글 뒤부터 붙여넣기가 허공에 떨어져 "사진만" 나오는 문제 → 주입 직전에 창을 앞으로.
  ipcMain.handle('win:focus', async () => {
    try {
      // ★macOS: 백그라운드 앱은 창을 그냥 focus()해도 앞으로 안 나온다 → app.focus({steal:true})로 강제 포그라운드.
      try { app.focus({ steal: true }); } catch (e) {}
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        try { mainWindow.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {}
        mainWindow.moveTop && mainWindow.moveTop();
        mainWindow.focus();
        try { mainWindow.webContents.focus(); } catch (e) {}
        await new Promise((r) => setTimeout(r, 250));
        try { mainWindow.setAlwaysOnTop(false); } catch (e) {} // 잠깐만 위로 올리고 원복(창 계속 위에 고정되면 불편)
      }
    } catch (e) {}
    return { ok: true };
  });

  ipcMain.handle('session:check', async () => {
    let naver = false;
    try {
      const cookies = await session.fromPartition('persist:naver').cookies.get({});
      naver = cookies.some((c) => /naver\.com$/.test(c.domain || '') && /NID_AUT|NID_SES/.test(c.name));
    } catch (e) {}
    return { naver };
  });

  // ★자동 모드 — 렌더러의 autoRun이 다 끝나면 앱 종료 요청. 로그도 남긴다.
  ipcMain.handle('app:autoDone', async (_e, { log } = {}) => {
    try { if (log) fs.appendFileSync(path.join(app.getPath('userData'), 'auto-run.log'), '[' + new Date().toISOString() + '] ' + log + '\n'); } catch (e) {}
    setTimeout(() => { try { app.quit(); } catch (e) {} }, 800);
    return { ok: true };
  });
  ipcMain.handle('app:isAuto', async () => ({ auto: AUTO_ANY, kind: AUTO_SEARCH_MODE ? 'search' : 'home' }));

  // ===== 예약 자동 발행 — OS 스케줄러 등록/해제 (Mac launchd / Win 작업 스케줄러) =====
  const cp = require('child_process');
  const AGENT_LABEL = 'com.blogauto.autopost';
  const WIN_TASK = 'BlogAutoPost';
  // 스케줄러가 실행할 명령. kind='search'면 --auto-search(검색용), 아니면 --auto(홈판).
  function autoArgs(kind) {
    const a = [process.execPath];
    if (!app.isPackaged) a.push(path.join(__dirname, '..'));
    a.push(kind === 'search' ? '--auto-search' : '--auto');
    return a;
  }
  // ★스마트 배치: intervalMin(분)에 하나씩, ★20개마다 1시간 휴식. 자동/수동 둘 다 이 배치를 쓴다.
  //   (자동=간격15 고정, 수동=사용자 간격. 휴식 이유: 몰아치는 티 방지 + 쉬는 동안 새 키워드가 떠 다음 배치는 더 신선.)
  function batchTimes(count, startMin, intervalMin) {
    const BATCH = 20, REST = 60, out = [], STEP = intervalMin || 15;
    for (let i = 0; i < count; i++) {
      const b = Math.floor(i / BATCH), p = i % BATCH;
      const m = (startMin + b * (BATCH * STEP + REST) + p * STEP) % (24 * 60);
      out.push(m);
    }
    return out.map((mm) => ({ h: Math.floor(mm / 60), m: mm % 60 }));
  }
  function parseStartMin(s) { const mt = (String(s || '')).match(/(\d{1,2}):(\d{2})/); return mt ? (Math.min(23, +mt[1]) * 60 + Math.min(59, +mt[2])) : 540; }
  function macAgentPath(kind) { return path.join(app.getPath('home'), 'Library', 'LaunchAgents', AGENT_LABEL + (kind === 'search' ? '.search' : '.home') + '.plist'); }

  ipcMain.handle('schedule:enable', async (_e, { count = 1, mode = 'auto', startTime = '09:00', intervalMin = 15, kind = 'home' } = {}) => {
    try {
      const isSearch = kind === 'search';
      const n = Math.max(1, Math.min(40, parseInt(count, 10) || 1)); // 하루 최대 40개(하루 안에 들어가게)
      const iv = Math.max(15, Math.min(180, parseInt(intervalMin, 10) || 15)); // ★수동 최소 간격 15분(봇감지 방지)
      const sm = parseStartMin(startTime);
      // 자동=간격 15분 고정, 수동=사용자 간격. 둘 다 20개마다 1시간 휴식(batchTimes).
      const times = batchTimes(n, sm, (mode === 'manual') ? iv : 15);
      const udir = app.getPath('userData');
      const label = AGENT_LABEL + (isSearch ? '.search' : '.home');
      const winPrefix = WIN_TASK + '_' + (isSearch ? 'search' : 'home') + '_';
      if (process.platform === 'darwin') {
        const args = autoArgs(kind);
        const argXml = args.map((s) => '    <string>' + s.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</string>').join('\n');
        const calXml = times.map((t) => '    <dict><key>Hour</key><integer>' + t.h + '</integer><key>Minute</key><integer>' + t.m + '</integer></dict>').join('\n');
        const plist = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>' + label + '</string>\n  <key>ProgramArguments</key><array>\n' + argXml + '\n  </array>\n  <key>StartCalendarInterval</key><array>\n' + calXml + '\n  </array>\n  <key>RunAtLoad</key><false/>\n  <key>ProcessType</key><string>Background</string>\n  <key>StandardOutPath</key><string>' + path.join(udir, 'launchd-out.log') + '</string>\n  <key>StandardErrorPath</key><string>' + path.join(udir, 'launchd-err.log') + '</string>\n</dict></plist>\n';
        const pl = macAgentPath(kind);
        fs.mkdirSync(path.dirname(pl), { recursive: true });
        fs.writeFileSync(pl, plist);
        try { cp.execFileSync('launchctl', ['unload', pl]); } catch (e) {}
        cp.execFileSync('launchctl', ['load', pl]);
        return { ok: true, platform: 'mac', times: times.map((t) => t.h + ':' + String(t.m).padStart(2, '0')) };
      } else if (process.platform === 'win32') {
        const exe = process.execPath;
        // ★execFileSync는 각 인자를 Windows 규칙대로 알아서 다시 감싼다 → /tr 값엔 "진짜 큰따옴표"로 exe를 감싼다.
        //   (기존 '\\"'(백슬래시+따옴표)는 이중 이스케이프돼 경로가 깨지고 등록이 조용히 실패했다 = 예약 아무 반응 없음의 원인)
        const extra = app.isPackaged ? '' : (' "' + path.join(__dirname, '..') + '"');
        const flag = isSearch ? ' --auto-search' : ' --auto';
        for (let i = 0; i < 40; i++) { try { cp.execFileSync('schtasks', ['/delete', '/tn', winPrefix + i, '/f'], { windowsHide: true }); } catch (e) {} }
        const done = [], errs = [];
        times.forEach((t, i) => {
          const tr = '"' + exe + '"' + extra + flag; // 예: "C:\...\blog-auto.exe" --auto
          const time = String(t.h).padStart(2, '0') + ':' + String(t.m).padStart(2, '0');
          try { cp.execFileSync('schtasks', ['/create', '/tn', winPrefix + i, '/tr', tr, '/sc', 'daily', '/st', time, '/f'], { windowsHide: true }); done.push(time); }
          catch (e) { errs.push(time + ' → ' + String(e.message || e).split('\n')[0].slice(0, 100)); }
        });
        // ★디버그 — 등록 성공/실패를 파일로 남긴다(예약이 안 될 때 원인 추적용).
        try { fs.writeFileSync(path.join(udir, 'schedule-debug.txt'), '[win 예약등록 ' + kind + '] ' + new Date().toISOString() + '\nexe=' + exe + '\npackaged=' + app.isPackaged + '\ntr예시=' + ('"' + exe + '"' + extra + flag) + '\n등록성공=' + done.length + '/' + times.length + ' → ' + JSON.stringify(done) + '\n실패=' + JSON.stringify(errs) + '\n'); } catch (e) {}
        return { ok: done.length > 0, platform: 'win', times: done, errors: errs, error: (done.length === 0 ? (errs[0] || 'schtasks 등록 실패(관리자 권한/정책 확인)') : undefined), total: times.length };
      }
      return { ok: false, error: 'unsupported platform' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('schedule:disable', async (_e, { kind = 'home' } = {}) => {
    try {
      const isSearch = kind === 'search';
      const winPrefix = WIN_TASK + '_' + (isSearch ? 'search' : 'home') + '_';
      if (process.platform === 'darwin') {
        const pl = macAgentPath(kind);
        try { cp.execFileSync('launchctl', ['unload', pl]); } catch (e) {}
        try { fs.unlinkSync(pl); } catch (e) {}
        return { ok: true };
      } else if (process.platform === 'win32') {
        for (let i = 0; i < 40; i++) { try { cp.execFileSync('schtasks', ['/delete', '/tn', winPrefix + i, '/f']); } catch (e) {} }
        return { ok: true };
      }
      return { ok: false, error: 'unsupported' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('schedule:status', async (_e, { kind = 'home' } = {}) => {
    try {
      const isSearch = kind === 'search';
      const winPrefix = WIN_TASK + '_' + (isSearch ? 'search' : 'home') + '_';
      if (process.platform === 'darwin') return { ok: true, enabled: fs.existsSync(macAgentPath(kind)) };
      if (process.platform === 'win32') { try { cp.execFileSync('schtasks', ['/query', '/tn', winPrefix + '0']); return { ok: true, enabled: true }; } catch (e) { return { ok: true, enabled: false }; } }
      return { ok: true, enabled: false };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ★에디터에 텍스트 붙여넣기 — 클립보드 + 실제 Cmd/Ctrl+V 키 이벤트(사람 붙여넣기와 동일).
  //   스마트에디터 ONE은 내부 모델이 따로라 execCommand가 막힘 → 붙여넣기가 가장 확실.
  ipcMain.handle('editor:paste', async (_e, { wcId, text, html }) => {
    try {
      const wc = webContents.fromId(wcId);
      if (!wc) return { ok: false, error: 'no-webContents' };
      const prev = clipboard.readText();
      // html이 있으면 텍스트+HTML 둘 다 클립보드에 → SmartEditor가 HTML을 정식 컴포넌트(소제목·인용구 등)로 변환.
      if (html) clipboard.write({ text: String(text == null ? '' : text), html: String(html) });
      else clipboard.writeText(String(text == null ? '' : text));
      // ★focus는 렌더러(executeJavaScript)가 이미 iframe 편집칸에 줬음 → 여기서 wc.focus() 하면 그게 날아감.
      //   Electron 정식 API paste()가 "현재 포커스된 편집영역"에 클립보드를 붙여넣음(iframe 안이라도 OK).
      wc.paste();
      await new Promise((r) => setTimeout(r, 200));
      clipboard.writeText(prev); // 사용자 클립보드 원상복구
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ★뉴스 기사 이미지 수집 — 키워드 최신순 → 정확·최신 사진 다운로드(로컬 저장) + 일괄 출처.
  //   수집·다운로드는 100% 코드(LLM 무관여) → 저작권 거절 경로 없음.
  ipcMain.handle('image:collectNews', async (_e, { keyword, limit = 8, maxAgeMonths = 18 } = {}) => {
    try {
      if (!keyword || !String(keyword).trim()) return { ok: false, error: 'no-keyword', files: [] };
      const imgs = await collectNewsImages(String(keyword).trim(), { limit, maxAgeMonths });
      const dir = path.join(app.getPath('userData'), 'img-cache');
      const saved = await downloadImagesToDir(imgs, dir, { max: limit });
      return { ok: true, files: saved, attribution: summarizeAttribution(imgs).line, count: saved.length };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  });

  // ★네이버 이미지 검색으로 수집(과거 사진·다양한 출처까지). Claude가 만든 정확한 검색어를 그대로 받는다.
  ipcMain.handle('image:collect', async (_e, { query, limit = 8, photoNews = false, maxAgeMonths = 0, allowLogo = false, allowBlog = false } = {}) => {
    try {
      if (!query || !String(query).trim()) return { ok: false, error: 'no-query', files: [] };
      const imgs = await collectImages(String(query).trim(), { limit, photoNews, maxAgeMonths, allowLogo, allowBlog });
      const dir = path.join(app.getPath('userData'), 'img-cache');
      const saved = await downloadImagesToDir(imgs, dir, { max: limit });
      return { ok: true, files: saved, count: saved.length };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  });

  // ★영화 전용 — "작품명 포토" 네이버 영화카드의 공식 스틸컷·포스터·프로모션. 6장 미만이면 영화 아님(빈 배열).
  ipcMain.handle('image:collectMovie', async (_e, { title, limit = 16 } = {}) => {
    try {
      if (!title || !String(title).trim()) return { ok: false, error: 'no-title', files: [] };
      const imgs = await collectMoviePhotos(String(title).trim(), { limit });
      if (!imgs || imgs.length < 6) return { ok: true, files: [], count: 0, notMovie: true }; // 공식 카드 없음 = 영화 아님
      const dir = path.join(app.getPath('userData'), 'img-cache');
      const saved = await downloadImagesToDir(imgs, dir, { max: limit });
      saved.forEach((f) => { f.press = '네이버 영화'; f.official = true; });
      return { ok: true, files: saved, count: saved.length };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  });

  // ★기사 자체 이미지(+사진별 캡션) — 그 키워드 기사의 사진이라 무조건 관련 + 캡션으로 정밀 관련성(농심 사진 등 걸러냄).
  ipcMain.handle('image:articleImages', async (_e, { keyword, limit = 8 } = {}) => {
    try {
      if (!keyword || !String(keyword).trim()) return { ok: true, files: [], count: 0 };
      const imgs = await fetchArticleImages(String(keyword).trim(), { limit });
      if (!imgs.length) return { ok: true, files: [], count: 0 };
      const dir = path.join(app.getPath('userData'), 'img-cache');
      const saved = await downloadImagesToDir(imgs, dir, { max: limit });
      // fetchArticleImages는 title(캡션)을 주므로 downloadImagesToDir가 title을 보존 → 그대로 사용.
      return { ok: true, files: saved, count: saved.length };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  });

  // ★정책·정부 전용 — AI브리핑이 인용한 공식 출처 사이트의 이미지(없으면 페이지 캡쳐). 정책 주제 1순위 이미지.
  ipcMain.handle('image:collectOfficial', async (_e, { urls } = {}) => {
    try {
      const list = Array.isArray(urls) ? urls : [];
      if (!list.length) return { ok: true, files: [], count: 0 };
      const dir = path.join(app.getPath('userData'), 'img-cache');
      const saved = await collectOfficialSiteImages(list, dir, { maxPerSite: 4, maxSites: 3 });
      return { ok: true, files: saved, count: saved.length };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  });

  // ★링크형 — "그 링크/기사 안에 실제로 실린 이미지"를 그대로 다운로드(남의 검색 그래픽 X, 원문 이미지 O).
  //   정부 사이트(go.kr·korea.kr 등)면 그들이 만든 인포그래픽도 허용(공식 자료). 일반 사이트면 뒤에서 비전으로 실사만 거른다.
  ipcMain.handle('image:collectLink', async (_e, { images, siteName = '', isGov = false } = {}) => {
    try {
      const urls = (Array.isArray(images) ? images : []).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
      if (!urls.length) return { ok: true, files: [], count: 0 };
      const imgs = urls.slice(0, 14).map((u) => ({ url: u, press: siteName || '' }));
      const dir = path.join(app.getPath('userData'), 'img-cache');
      const saved = await downloadImagesToDir(imgs, dir, { max: 12 });
      // 링크에서 온 이미지임을 표시(정부=신뢰, 비전 통과 없이도 사용 가능)
      saved.forEach((f) => { f.fromLink = true; f.isGov = !!isGov; if (siteName) f.caption = siteName; });
      return { ok: true, files: saved, count: saved.length };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  });

  // ★클로드 비전 이미지 필터 — 수집한 후보 사진을 실제로 "보고" 관련 있는 것만 남긴다(전남편·딴사람·그래픽·방송캡처 제거).
  // ★내 사진(내돈내산) 분류·배치 — Claude가 사진 보고 음식/메뉴판/내부/반찬/공간 분류 → 맞는 슬롯 배정 + 캡션.
  ipcMain.handle('image:classifyMine', async (_e, { photos, slots, subject } = {}) => {
    try {
      const list = Array.isArray(photos) ? photos.filter((p) => p && p.path) : [];
      if (!list.length) return { ok: true, results: [], cover: -1 };
      const r = await classifyMyPhotos(list, slots || [], { model: 'claude-haiku-4-5-20251001', subject: subject || '' });
      return { ok: true, results: r.results || [], cover: (r.cover != null ? r.cover : -1) };
    } catch (e) {
      return { ok: false, error: e.message, results: [], cover: -1 };
    }
  });

  // ★쿠팡(또는 임의 URL) 제품명 가져오기 — 실제 브라우저(숨은 창)로 렌더해 og:title/상품명 추출. (curl은 차단당함)
  //   → 제목에 진짜 제품명을 넣기 위해 생성 "전"에 호출.
  ipcMain.handle('link:productName', async (_e, { url } = {}) => {
    try {
      if (!url) return { ok: false, name: '' };
      const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const EXTRACT = "(function(){try{function g(s){var e=document.querySelector(s);return e?((e.content||e.textContent||'')+'').trim():'';}var og=g('meta[property=\"og:title\"]');var h=g('.prod-buy-header__title')||g('h1');var t=(document.title||'').replace(/\\s*[-|]\\s*쿠팡.*$/,'').replace(/^쿠팡!?\\s*/,'').trim();var name=og||h||t||'';if(/Access Denied|잠시 후 다시|error/i.test(name))name='';return name.slice(0,80);}catch(e){return '';}})()";
      let name = '';
      try { name = await scrapeRendered(url, EXTRACT, 4500, 'persist:naver', CHROME); } catch (e) { name = ''; }
      if (name && typeof name === 'object') name = '';
      return { ok: !!name, name: (name || '').trim() };
    } catch (e) { return { ok: false, name: '', error: e.message }; }
  });

  // ★링크형(URL→글) 1단계 — 페이지에서 제목·본문·이미지·출처를 뽑는다. (숨은 창으로 렌더 후 추출)
  ipcMain.handle('link:extract', async (_e, { url } = {}) => {
    try {
      if (!url || !/^https?:\/\//.test(url)) return { ok: false, error: 'URL 형식이 아니에요 (http로 시작해야 해요)' };
      const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
      const LINK_EXTRACT = "(function(){try{" +
        "function abs(u){try{return new URL(u,location.href).href;}catch(e){return u||'';}}" +
        "function meta(p){var e=document.querySelector('meta[property=\"'+p+'\"]')||document.querySelector('meta[name=\"'+p+'\"]');return e?((e.content||'')+'').trim():'';}" +
        "var title=meta('og:title')||document.title||'';" +
        "var site=meta('og:site_name')||location.hostname.replace(/^www\\./,'');" +
        "var cands=[].slice.call(document.querySelectorAll('article,[role=main],main,#content,#articleBody,.article,.article_body,.news_body,.post,.entry-content,.se-main-container'));" +
        "var best=null,bestLen=0;cands.forEach(function(c){var t=(c.innerText||'').trim();if(t.length>bestLen){bestLen=t.length;best=c;}});" +
        "if(!best||bestLen<200){[].slice.call(document.querySelectorAll('div,section')).forEach(function(c){var t=(c.innerText||'').trim();if(t.length>bestLen&&t.length<25000){bestLen=t.length;best=c;}});}" +
        "var root=best||document.body;" +
        "try{[].slice.call(root.querySelectorAll('nav,header,footer,aside,script,style,form,.nav,.menu,.gnb,.lnb,.comment,.reply,.replies,.ad,.ads,.related,.share,[role=navigation]')).forEach(function(e){e.remove();});}catch(e){}" +
        "var paras=[];[].slice.call(root.querySelectorAll('p,h1,h2,h3,li')).forEach(function(el){var t=(el.innerText||'').replace(/\\s+/g,' ').trim();if(t.length>=15)paras.push(t);});" +
        "if(paras.length<3){var tt=(root.innerText||'').replace(/\\n{2,}/g,'\\n').trim();paras=tt.split('\\n').map(function(s){return s.trim();}).filter(function(s){return s.length>=15;});}" +
        "var text=paras.join('\\n').slice(0,6000);" +
        "var imgs=[],seen={};[].slice.call(root.querySelectorAll('img')).forEach(function(i){var s=i.currentSrc||i.src||i.getAttribute('data-src')||'';if(!s)return;s=abs(s);var w=i.naturalWidth||i.width||0,h=i.naturalHeight||i.height||0;if(w&&w<200)return;if(h&&h<150)return;if(/icon|logo|sprite|blank|1x1|avatar|profile|emoji|button|badge/i.test(s))return;if(seen[s])return;seen[s]=1;imgs.push({url:s,alt:(i.alt||'').trim()});});" +
        "return JSON.stringify({title:title.slice(0,200),siteName:site,text:text,images:imgs.slice(0,12)});" +
        "}catch(e){return JSON.stringify({error:String(e)});}})()";
      let raw = '';
      try { raw = await scrapeRendered(url, LINK_EXTRACT, 5000, 'persist:naver', CHROME); } catch (e) { return { ok: false, error: '페이지 열기 실패: ' + e.message }; }
      let d = null; try { d = JSON.parse(raw); } catch (e) {}
      if (!d || d.error) return { ok: false, error: (d && d.error) || '페이지 내용을 읽지 못했어요' };
      return { ok: true, title: d.title || '', siteName: d.siteName || '', text: (d.text || '').trim(), images: Array.isArray(d.images) ? d.images : [] };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ★내 블로그 최근 글 목록 — "함께 보면 좋은 글"(내부 순환) 후보. 공개 API, 로그인 불필요·무료.
  ipcMain.handle('blog:myPosts', async (_e, { blogId } = {}) => fetchMyBlogPosts(blogId));

  ipcMain.handle('perf:list', async () => {
    const store = readSearchPerformance();
    const entries = store.entries.slice().sort((a, b) => (Date.parse(b.generatedAt) || 0) - (Date.parse(a.generatedAt) || 0));
    return {
      ok: true,
      entries: entries.slice(0, 50),
      summary: summarize(store.entries),
      blockState: getBlockState(),
      due: dueChecks(store.entries).length,
    };
  });

  ipcMain.handle('perf:sync', async (_e, { blogId } = {}) => {
    const fetched = await fetchMyBlogPosts(blogId);
    if (!fetched.ok) return { ok: false, linked: 0, error: fetched.error || '블로그 글 목록을 가져오지 못했습니다.' };
    const store = readSearchPerformance();
    const before = store.entries.filter((entry) => !entry.url).length;
    store.entries = matchPublished(store.entries, fetched.posts);
    const after = store.entries.filter((entry) => !entry.url).length;
    writeSearchPerformance(store);
    return { ok: true, linked: Math.max(0, before - after) };
  });

  ipcMain.handle('perf:link', async (_e, { id, url } = {}) => {
    const store = readSearchPerformance();
    const index = store.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return { ok: false, error: '추적 항목을 찾지 못했습니다.' };
    try {
      store.entries[index] = linkManually(store.entries[index], url);
      writeSearchPerformance(store);
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle('perf:check', async () => {
    const store = readSearchPerformance();
    const due = dueChecks(store.entries).slice(0, 6);
    let checked = 0;
    let stopped = null;
    for (const item of due) {
      const index = store.entries.findIndex((entry) => entry.id === item.id);
      if (index < 0) continue;
      const entry = store.entries[index];
      let blogRefs = [];
      let blogTabObserved = false;
      let failureReason = '';
      try {
        const response = await guardedSearchFetch(M.searchUrl.blog(entry.keyword));
        if (response.status !== 200) throw new Error('블로그 검색 응답 오류: HTTP ' + response.status);
        blogTabObserved = true;
        blogRefs = M.parseSerpSections(response.body.toString('utf8')).blogRefs;
      } catch (error) {
        if (error instanceof NaverSearchBlockedError || error && error.code === 'NAVER_SEARCH_BLOCKED') {
          stopped = 'blocked';
          break;
        }
        failureReason = String(error && error.message || error);
      }
      const integrated = await observeSerp(entry.keyword);
      if (integrated.blocked) {
        stopped = 'blocked';
        break;
      }
      const blogTabRank = findRank(blogRefs, entry.blogId, entry.logNo);
      const inIntegrated = findRank(integrated.blogRefs, entry.blogId, entry.logNo) != null;
      const reason = failureReason || (!integrated.measured ? integrated.reason || '통합검색 관찰 실패' : '');
      store.entries[index] = addCheck(entry, {
        at: new Date().toISOString(), dueDay: item.dueDay, blogTabRank,
        blogTabObserved, inIntegrated, measured: blogTabObserved && integrated.measured,
        reason,
      });
      checked++;
    }
    if (checked) writeSearchPerformance(store);
    return { ok: true, checked, stopped, blockState: getBlockState() };
  });

  ipcMain.handle('image:visionFilter', async (_e, { images, subject, keyword, keep, drop, photoOnly, allowBroadcast } = {}) => {
    try {
      const list = Array.isArray(images) ? images.filter((im) => im && im.path) : [];
      if (!list.length) return { ok: true, results: [] };
      // ★토큰 절약: 이미지 판정은 하이쿠(Haiku)로 충분(분류 작업). 실패 시 SDK 기본 모델로 폴백은 filterImagesByVision 내부 처리.
      const _visT = Date.now();
      const results = await filterImagesByVision(list, { subject: subject || '', keyword: keyword || '', keep: keep || [], drop: drop || [], photoOnly: !!photoOnly, allowBroadcast: !!allowBroadcast, model: 'claude-haiku-4-5-20251001' });
      try { require('fs').appendFileSync(require('path').join(app.getPath('userData'), 'token-usage.log'), '[' + new Date().toLocaleString() + '] 비전판정 model=haiku 이미지=' + list.length + '장 소요=' + Math.round((Date.now() - _visT) / 1000) + '초\n'); } catch (e) {}
      // ★#8 방송 워터마크 하단 크롭 — vision이 cropBottom=true(하단 워터마크)로 살린 사진은 아래쪽 띠를 잘라 워터마크 제거.
      //   ★cropFace=true = 좋은 사진인데 위쪽에 일반인 얼굴 → 상단을 잘라 얼굴 제거(손·물건만 남김).
      for (const r of results) {
        if (r && r.keep !== false && r.path) {
          const _rz = (r && r.reason) || '';
          // ★모델이 reason엔 "크롭"이라 써놓고 불린 필드(cropBottom/cropFace)를 안 켜는 경우가 있어, reason 문구로도 크롭을 강제(안전장치).
          const _wantFace = r.cropFace || /상단[^,]{0,6}(크롭|잘라|제거)|얼굴[^,]{0,6}(크롭|가림|제거)/.test(_rz);
          const _wantBottom = r.cropBottom || /하단[^,]{0,6}(크롭|로고|워터마크|잘라|제거)|아래[^,]{0,6}(로고|워터마크|크롭)|워터마크[^,]{0,6}(크롭|제거)/.test(_rz);
          if (_wantFace) { try { cropTopBanner(r.path, 0.4); } catch (e) {} }
          if (_wantBottom) { try { cropBottomBanner(r.path, 0.15); } catch (e) {} }
        }
      }
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: e.message, results: [] };
    }
  });

  // ★에디터에 실제 이미지 삽입(CDP) — 스마트에디터의 숨은 file input에 파일을 직접 주입한다.
  //   방식: Page.setInterceptFileChooserDialog로 네이티브 파일창 억제 → 사진버튼 클릭 →
  //         #mainFrame iframe의 마지막 input[type=file] objectId 획득 → DOM.setFileInputFiles →
  //         "개별사진" 모드 클릭 → 이미지 컴포넌트 수가 늘 때까지 대기.
  // ★에디터 본문 전체 선택 — wc.paste()와 같은 원리(포커스된 iframe 편집칸에 명령). 폰트 적용 전 전체 선택용.
  ipcMain.handle('editor:selectAll', async (_e, { wcId } = {}) => {
    try {
      const wc = webContents.fromId(wcId);
      if (!wc) return { ok: false, error: 'no-webContents' };
      // ★진짜 키보드 전체선택 이벤트 — 맥=Cmd+A(meta), 윈도우/리눅스=Ctrl+A(control). ★★플랫폼 틀리면 단축키가 안 먹고 'a'가 본문에 찍힘(윈도우 피드백 버그).
      //   ★wc.focus() 하면 안 됨 — 렌더러가 이미 iframe 편집칸에 준 포커스가 날아가 전체선택이 엉뚱한 곳으로 감(paste와 동일 원리).
      const selMod = process.platform === 'darwin' ? 'meta' : 'control';
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: [selMod] });
      // ★char 이벤트는 맥에서만 — 윈도우에선 char가 'a' 글자를 본문에 그대로 타이핑해버림(단축키가 아니라).
      if (process.platform === 'darwin') wc.sendInputEvent({ type: 'char', keyCode: 'a', modifiers: [selMod] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: [selMod] });
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ★키 이벤트 전송 — 소제목(인용구) 한 줄만 "키보드로" 선택하기 위해(JS range는 스마트에디터가 무시).
  //   현재 포커스된 편집칸 캐럿 기준으로 Home→Shift+End 등을 보내 그 문단을 선택한다. wc.focus() 금지(포커스 유지).
  // ★에디터 특정 좌표를 "진짜 마우스로" 클릭 → 실제 포커스 이동(가짜 JS 클릭이 안 먹는 제목칸 등에 필수).
  ipcMain.handle('editor:clickAt', async (_e, { wcId, x, y } = {}) => {
    try {
      const wc = webContents.fromId(wcId);
      if (!wc) return { ok: false, error: 'no-webContents' };
      wc.focus();
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
      wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 90));
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('editor:sendKey', async (_e, { wcId, keys } = {}) => {
    try {
      const wc = webContents.fromId(wcId);
      if (!wc) return { ok: false, error: 'no-webContents' };
      for (const k of (keys || [])) {
        const mods = k.modifiers || [];
        wc.sendInputEvent({ type: 'keyDown', keyCode: k.keyCode, modifiers: mods });
        wc.sendInputEvent({ type: 'keyUp', keyCode: k.keyCode, modifiers: mods });
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => setTimeout(r, 120));
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ★커서를 문서 "진짜 끝"으로 — CDP 실제 마우스 클릭(사진 삽입과 동일한 안정 경로) + Cmd+End.
  //   기존 pasteAtEnd는 Cmd+End를 wc.sendInputEvent로 보냈는데, 이건 최상위 창에만 가서 iframe 편집칸에 간헐 실패 →
  //   커서가 안 옮겨진 채 붙여 본문이 "역순으로 맨 끝(CTA 뒤)"에 쌓이는 버그. CDP는 OS레벨이라 iframe에 확실히 도달.
  ipcMain.handle('editor:caretEnd', async (_e, { wcId } = {}) => {
    const wc = webContents.fromId(wcId);
    if (!wc) return { ok: false, error: 'no-webContents' };
    const dbg = wc.debugger;
    const cdp = (m, p = {}) => dbg.sendCommand(m, p);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const evalIn = async (expr) => {
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r && r.result ? r.result.value : undefined;
    };
    const DOC = `(function(){var f=document.querySelector('#mainFrame');return (f&&f.contentWindow)?f.contentWindow.document:document;})()`;
    let attached = false;
    try {
      try { dbg.attach('1.3'); attached = true; } catch (e) { attached = false; }
      await cdp('Page.enable').catch(() => {});
      await cdp('Runtime.enable').catch(() => {});
      // 마지막 본문/인용구 문단을 화면에 보이게 하고 좌표 계산(실제 클릭 대상).
      const found = await evalIn(`(function(){var d=${DOC};var ps=d.querySelectorAll('.se-component.se-text .se-text-paragraph, .se-component.se-quotation .se-text-paragraph');var p=ps[ps.length-1];if(!p)return false;try{p.scrollIntoView({block:'end'});}catch(e){}window.__endPara=p;return true;})()`).catch(() => false);
      if (!found) return { ok: false, error: 'no-para' };
      await sleep(150);
      const coord = await evalIn(`(function(){var p=window.__endPara;if(!p)return null;var fr=document.querySelector('#mainFrame');var fRect=fr?fr.getBoundingClientRect():{left:0,top:0};var r=p.getBoundingClientRect();return {x:Math.round(fRect.left+r.right-6), y:Math.round(fRect.top+r.top+r.height-5)};})()`).catch(() => null);
      if (!coord || coord.x == null) return { ok: false, error: 'no-coord' };
      // ①실제 클릭 = 편집칸에 포커스 + React 모델 커서를 그 문단으로 확실히 이동.
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(60);
      // ②Cmd+End = 문서 진짜 끝으로(뒤에 사진이 더 있어도 그 아래로). 포커스가 확실하니 이제 먹는다.
      try {
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 4, windowsVirtualKeyCode: 35, code: 'End', key: 'End' });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, windowsVirtualKeyCode: 35, code: 'End', key: 'End' });
      } catch (e) {}
      await sleep(40);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      if (attached) { try { dbg.detach(); } catch (e) {} }
    }
  });

  // ★특정 텍스트(마커)를 포함한 문단으로 커서를 CDP 진짜 클릭으로 옮긴다. (텍스트 완성 후 지도/사진을 "그 마커 자리"에 넣기 위함)
  ipcMain.handle('editor:focusParaByText', async (_e, { wcId, text } = {}) => {
    const wc = webContents.fromId(wcId);
    if (!wc) return { ok: false, error: 'no-webContents' };
    const dbg = wc.debugger;
    const cdp = (m, p = {}) => dbg.sendCommand(m, p);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const evalIn = async (expr) => {
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r && r.result ? r.result.value : undefined;
    };
    const DOC = `(function(){var f=document.querySelector('#mainFrame');return (f&&f.contentWindow)?f.contentWindow.document:document;})()`;
    const A = JSON.stringify(String(text || '').replace(/\s+/g, ''));
    let attached = false;
    try {
      try { dbg.attach('1.3'); attached = true; } catch (e) { attached = false; }
      await cdp('Page.enable').catch(() => {});
      await cdp('Runtime.enable').catch(() => {});
      const found = await evalIn(`(function(){var d=${DOC};var A=${A};if(!A)return false;var ps=d.querySelectorAll('.se-component.se-text .se-text-paragraph, .se-component.se-quotation .se-text-paragraph');var p=null;for(var i=0;i<ps.length;i++){if((ps[i].textContent||'').replace(/\\s+/g,'').indexOf(A)>=0){p=ps[i];}}if(!p)return false;try{p.scrollIntoView({block:'center'});}catch(e){}window.__mkPara=p;return true;})()`).catch(() => false);
      if (!found) return { ok: false, error: 'no-para' };
      await sleep(160);
      const coord = await evalIn(`(function(){var p=window.__mkPara;if(!p)return null;var fr=document.querySelector('#mainFrame');var fRect=fr?fr.getBoundingClientRect():{left:0,top:0};var r=p.getBoundingClientRect();return {x:Math.round(fRect.left+r.right-6), y:Math.round(fRect.top+r.top+r.height-5)};})()`).catch(() => null);
      if (!coord || coord.x == null) return { ok: false, error: 'no-coord' };
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(70);
      // 문단 끝으로(End) — 마커 문단 맨 끝에 커서 → 지도/사진이 그 뒤(=마커 자리)에 삽입됨.
      try {
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 35, code: 'End', key: 'End' });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 35, code: 'End', key: 'End' });
      } catch (e) {}
      await sleep(40);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      if (attached) { try { dbg.detach(); } catch (e) {} }
    }
  });

  // ★특정 텍스트(마커) 문단을 "에디터 방식"으로 삭제한다. (DOM removeChild는 React가 되살리므로 안 됨 → 진짜 선택+백스페이스)
  //   CDP 클릭으로 마커 문단 포커스 → Home → Shift+End(마커 텍스트 선택) → Backspace(삭제) → Backspace(빈 줄 병합 제거).
  ipcMain.handle('editor:removeParaByText', async (_e, { wcId, text } = {}) => {
    const wc = webContents.fromId(wcId);
    if (!wc) return { ok: false, error: 'no-webContents' };
    const dbg = wc.debugger;
    const cdp = (m, p = {}) => dbg.sendCommand(m, p);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const evalIn = async (expr) => {
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r && r.result ? r.result.value : undefined;
    };
    const DOC = `(function(){var f=document.querySelector('#mainFrame');return (f&&f.contentWindow)?f.contentWindow.document:document;})()`;
    const A = JSON.stringify(String(text || '').replace(/\s+/g, ''));
    const key = async (vk, code, k, mod) => {
      try {
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mod || 0, windowsVirtualKeyCode: vk, code: code, key: k });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mod || 0, windowsVirtualKeyCode: vk, code: code, key: k });
      } catch (e) {}
    };
    let attached = false;
    try {
      try { dbg.attach('1.3'); attached = true; } catch (e) { attached = false; }
      await cdp('Page.enable').catch(() => {});
      await cdp('Runtime.enable').catch(() => {});
      const found = await evalIn(`(function(){var d=${DOC};var A=${A};if(!A)return false;var ps=d.querySelectorAll('.se-component.se-text .se-text-paragraph, .se-component.se-quotation .se-text-paragraph');var p=null;for(var i=0;i<ps.length;i++){if((ps[i].textContent||'').replace(/\\s+/g,'')===A){p=ps[i];}}if(!p){for(var j=0;j<ps.length;j++){if((ps[j].textContent||'').replace(/\\s+/g,'').indexOf(A)>=0){p=ps[j];}}}if(!p)return false;try{p.scrollIntoView({block:'center'});}catch(e){}window.__rmPara=p;return true;})()`).catch(() => false);
      if (!found) return { ok: false, error: 'no-para' };
      await sleep(150);
      // ★오른쪽 끝(문단 박스 우측 = 텍스트 뒤 빈 영역)을 클릭 → 커서가 줄 "끝"에 놓인다(Home/End 키가 이 에디터서 안 먹혀서 클릭 위치로 끝 잡음).
      // ★클릭 y = 문단 "세로 중앙"(height/2). 한 줄 마커(IMGSLOT 등)는 이게 확실 — height-6은 인접 컴포넌트(지도·표·이미지) 위로 클릭이 새서 마커 삭제가 실패했음(검색용 12장에서 확인).
      const coord = await evalIn(`(function(){var p=window.__rmPara;if(!p)return null;var fr=document.querySelector('#mainFrame');var fRect=fr?fr.getBoundingClientRect():{left:0,top:0};var r=p.getBoundingClientRect();return {x:Math.round(fRect.left+r.right-8), y:Math.round(fRect.top+r.top+r.height/2)};})()`).catch(() => null);
      if (!coord || coord.x == null) return { ok: false, error: 'no-coord' };
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(70);
      // ★마커 글자 수만큼 "끝까지" 백스페이스 후 빈 줄 병합(+1). ★조기 종료 금지 — "XX"만 지워지면 전체 문자열이 안 잡혀 일찍 멈추던 버그.
      const _mklen = String(text || '').replace(/\s+/g, '').length;
      for (let _b = 0; _b < _mklen; _b++) { await key(8, 'Backspace', 'Backspace', 0); await sleep(9); } // 마커 글자 전부 삭제 → 빈 문단
      await sleep(20);
      await key(8, 'Backspace', 'Backspace', 0); // 빈 줄을 이전 문단에 병합(줄 자체 제거, 다음 사진은 안 건드림)
      await sleep(30);
      // 검증(로그용): 마커 잔재가 남았나 (부분 포함 넓게)
      const gone = !(await evalIn(`(function(){var d=${DOC};var A=${A};if(!A)return false;var ps=d.querySelectorAll('.se-component.se-text .se-text-paragraph, .se-component.se-quotation .se-text-paragraph');for(var i=0;i<ps.length;i++){var t=(ps[i].textContent||'').replace(/\\s+/g,'');if(t.indexOf(A)>=0||/I?M?GSLOT\\d+/.test(t))return true;}return false;})()`).catch(() => false));
      return { ok: gone };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      if (attached) { try { dbg.detach(); } catch (e) {} }
    }
  });

  // ★현재 포커스된 편집칸에 클립보드 없이 텍스트를 직접 타이핑(insertText). 제목 붙여넣기(wc.paste)가 간헐 실패할 때 폴백.
  ipcMain.handle('editor:insertText', async (_e, { wcId, text } = {}) => {
    try {
      const wc = webContents.fromId(wcId);
      if (!wc) return { ok: false, error: 'no-webContents' };
      wc.insertText(String(text == null ? '' : text));
      await new Promise((r) => setTimeout(r, 120));
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('editor:insertImages', async (_e, { wcId, files, inline, anchorBefore, anchorAfter, anchorClick, atCursor } = {}) => {
    const wc = webContents.fromId(wcId);
    if (!wc) return { ok: false, error: 'no-webContents' };
    const existing = (files || []).filter((f) => f && fs.existsSync(f));
    if (!existing.length) return { ok: false, error: 'no-files' };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const dbg = wc.debugger;
    const cdp = (m, p = {}) => dbg.sendCommand(m, p);
    const evalIn = async (expr, byValue = true) => {
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: byValue, awaitPromise: true });
      return byValue ? (r && r.result ? r.result.value : undefined) : (r && r.result ? r.result.objectId : undefined);
    };
    const DOC = `(function(){var f=document.querySelector('#mainFrame');return (f&&f.contentWindow)?f.contentWindow.document:document;})()`;
    const imageCount = () =>
      evalIn(`(function(){var d=${DOC};return d.querySelectorAll('.se-component.se-image, .se-image').length;})()`);

    // 본문 끝 문단에 caret.
    const caretAtEnd = () =>
      evalIn(`(function(){var d=${DOC};var ps=d.querySelectorAll('.se-component.se-text .se-text-paragraph');var last=ps[ps.length-1];if(last){last.focus&&last.focus();var s=d.getSelection&&d.getSelection();if(s){var r=d.createRange();r.selectNodeContents(last);r.collapse(false);s.removeAllRanges();s.addRange(r);}}return !!last;})()`).catch(() => false);
    // ★특정 소제목(인용구) "바로 앞"에 caret — 그 소제목 컴포넌트의 이전 형제 마지막 문단 끝에 둔다(이미지는 caret 뒤=소제목 앞에 삽입됨).
    const anchorNorm = (anchorBefore || '').replace(/\s+/g, '');
    const caretBeforeHeading = () =>
      evalIn(`(function(){var d=${DOC};var A=${JSON.stringify(anchorNorm)};if(!A)return false;var qs=d.querySelectorAll('.se-component.se-quotation');var target=null;for(var i=0;i<qs.length;i++){var t=(qs[i].textContent||'').replace(/\\s+/g,'');if(t.indexOf(A)>=0){target=qs[i];break;}}if(!target)return false;var prev=target.previousElementSibling;var para=null;if(prev){var ps=prev.querySelectorAll('.se-text-paragraph');para=ps[ps.length-1];}if(!para)return false;try{para.focus&&para.focus();var s=d.getSelection();var r=d.createRange();r.selectNodeContents(para);r.collapse(false);s.removeAllRanges();s.addRange(r);}catch(e){return false;}return true;})()`).catch(() => false);
    // ★특정 문단(앵커 글자를 포함한 본문/소제목/인용구) "바로 뒤"에 caret — 이미지는 caret 뒤에 삽입되니 그 문단 다음에 꽂힌다.
    const anchorAfterNorm = (anchorAfter || '').replace(/\s+/g, '');
    const caretAfterText = () =>
      evalIn(`(function(){var d=${DOC};var A=${JSON.stringify(anchorAfterNorm)};if(!A)return false;var ps=d.querySelectorAll('.se-component.se-text .se-text-paragraph, .se-component.se-quotation .se-text-paragraph');var para=null;for(var i=0;i<ps.length;i++){var t=(ps[i].textContent||'').replace(/\\s+/g,'');if(t.indexOf(A)>=0){para=ps[i];/*마지막 매칭까지 계속 → 같은 글자 여러개면 뒤엣것*/}}if(!para)return false;try{para.focus&&para.focus();var s=d.getSelection();var r=d.createRange();r.selectNodeContents(para);r.collapse(false);s.removeAllRanges();s.addRange(r);}catch(e){return false;}return true;})()`).catch(() => false);
    // ★★앵커 문단으로 "진짜 마우스 클릭"(CDP Input) → 네이버 React 모델 커서를 그 자리로 옮긴다.
    //   (DOM 셀렉션만으론 네이버가 무시하고 사진을 맨 끝에 넣는다 = 원인. Cmd+End이 진짜 키인 것처럼 진짜 클릭이어야 커서가 움직임.)
    const clickParaByAnchor = async () => {
      if (!anchorAfterNorm) return false;
      const A = JSON.stringify(anchorAfterNorm);
      const found = await evalIn(`(function(){var d=${DOC};var A=${A};var ps=d.querySelectorAll('.se-component.se-text .se-text-paragraph, .se-component.se-quotation .se-text-paragraph');var para=null;for(var i=0;i<ps.length;i++){var t=(ps[i].textContent||'').replace(/\\s+/g,'');if(t.indexOf(A)>=0)para=ps[i];}if(!para)return false;try{para.scrollIntoView({block:'center'});}catch(e){}window.__anchorPara=para;return true;})()`).catch(() => false);
      if (!found) return false;
      await sleep(240);
      const coord = await evalIn(`(function(){var para=window.__anchorPara;if(!para)return null;var fr=document.querySelector('#mainFrame');var fRect=fr?fr.getBoundingClientRect():{left:0,top:0};var r=para.getBoundingClientRect();return {x:Math.round(fRect.left+r.right-8), y:Math.round(fRect.top+r.top+r.height-6)};})()`).catch(() => null);
      if (!coord || coord.x == null) return false;
      try {
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', buttons: 1, clickCount: 1 });
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', buttons: 0, clickCount: 1 });
      } catch (e) { return false; }
      await sleep(70);
      // 줄 끝으로(문단 끝에 커서 확실히 = 사진이 문단 뒤에 깔끔히 삽입)
      try { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 35, code: 'End', key: 'End' }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 35, code: 'End', key: 'End' }); } catch (e) {}
      return true;
    };

    let attached = false;
    try {
      try { dbg.attach('1.3'); attached = true; } catch (e) { attached = false; }
      await cdp('Page.enable').catch(() => {});
      await cdp('DOM.enable').catch(() => {});
      await cdp('Runtime.enable').catch(() => {});

      const before = Number(await imageCount()) || 0;

      // 커서를 본문 끝(또는 지정한 소제목 앞) 문단에 두고, 파일창 억제 → 사진버튼 → 숨은 input에 전체 파일 주입 → 개별사진.
      //   (컴포넌트 삭제 없음 = 본문 안전. 사진은 caret 위치에 정식 se-image로 붙는다.)
      let anchored = false;
      if (atCursor) { anchored = true; }                                 // ★키보드로 커서를 이미 옮겨놨음 → 그 자리에 그대로 삽입(좌표 추측 없음 = 문서 안 깨짐)
      else if (anchorClick && anchorAfterNorm) { anchored = await clickParaByAnchor(); } // ★CDP 진짜 클릭으로 마커 문단에 정확히 정박(텍스트 완성 후 사진을 제자리에 넣는 방식)
      else if (anchorAfterNorm) { anchored = await caretAfterText(); }    // (구) DOM선택 방식
      else if (anchorNorm) { anchored = await caretBeforeHeading(); }
      if (!anchored) await caretAtEnd(); // 앵커 없으면 끝에
      let intercepted = false;
      try { await cdp('Page.setInterceptFileChooserDialog', { enabled: true }); intercepted = true; } catch (e) {}
      await evalIn(`(function(){var d=${DOC};var sels=["button[data-name='image']","li.se-toolbar-item-image button",".se-image-toolbar-button","[data-click-area='tpb*i.image']","[data-click-area*='image']"];for(var i=0;i<sels.length;i++){var el=d.querySelector(sels[i]);if(el){el.click();return sels[i];}}return null;})()`);
      await sleep(500);
      const objectId = await evalIn(`(function(){var d=${DOC};var ins=d.querySelectorAll("input[type='file']");return ins[ins.length-1]||null;})()`, false);
      if (!objectId) { if (intercepted) await cdp('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {}); throw new Error('file-input-not-found'); }
      await cdp('DOM.setFileInputFiles', { objectId, files: existing });
      if (intercepted) await cdp('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      await sleep(900);
      // ★"사진 첨부 방식(개별사진·콜라주·슬라이드)" 팝업 자동 처리 — 여러 장 넣을 때 SE가 띄운다.
      //   뜨면 "개별사진"을 선택(우리 기본 레이아웃), 그래도 안 닫히면 팝업의 X(닫기)를 눌러 무조건 진행시킨다.
      //   (예전엔 셀렉터가 실제 팝업과 안 맞아 안 닫혀서 사용자가 수동으로 X를 눌러야 했음.)
      const dismissAttachPopup = `(function(){var d=${DOC};var W=d.defaultView;function vis(e){return e&&e.offsetParent!==null;}var els=[].slice.call(d.querySelectorAll('button,a,li,div,span,label'));var norm=function(x){return (x.innerText||x.textContent||'').replace(/\\s+/g,'');};var hasChooser=els.some(function(x){return vis(x)&&norm(x)==='개별사진';})&&els.some(function(x){return vis(x)&&norm(x)==='콜라주';});if(!hasChooser)return 'no-popup';var fire=function(el){['mousedown','mouseup','click'].forEach(function(t){try{el.dispatchEvent(new W.MouseEvent(t,{bubbles:true,cancelable:true,view:W}));}catch(e){}});};var indiv=els.find(function(x){return vis(x)&&norm(x)==='개별사진';});if(indiv){fire(indiv);return 'indiv';}var close=els.find(function(x){var c=(x.className||'')+'';var al=(x.getAttribute&&(x.getAttribute('aria-label')||''))||'';return vis(x)&&(/se-popup-close|popup-close|btn-close|_close|\\bclose\\b/i.test(c)||/닫기|취소/.test(al));});if(close){fire(close);return 'close';}return 'open';})()`;

      let after = before;
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        try { await evalIn(dismissAttachPopup); } catch (e) {} // 팝업 뜨면 개별사진 선택/닫기 → 진행
        after = Number(await imageCount()) || before;
        if (after >= before + existing.length) break;
      }
      return { ok: after > before, added: after - before, before, after, requested: existing.length, inline: !!inline };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      if (attached) { try { dbg.detach(); } catch (e) {} }
    }
  });

  // ★썸네일 자동 제작 — 문구를 1:1 텍스트카드 PNG로 렌더(Playwright). items=[{thumbnailText, subText, ...디자인}].
  ipcMain.handle('thumbnail:render', async (_e, { items } = {}) => {
    try {
      const dir = path.join(app.getPath('userData'), 'thumb-cache');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const out = [];
      const list = Array.isArray(items) ? items : [];
      for (let i = 0; i < list.length; i++) {
        if (!list[i] || !list[i].thumbnailText) continue;
        const file = path.join(dir, `thumb_${i}.png`);
        await renderThumbnailPng(list[i], file);
        out.push(file);
      }
      return { ok: true, files: out };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  });

  // ★편집기 카드 SVG → PNG(1080). ③[넣기]에서 그 카드를 실제 이미지로 만들어 네이버 에디터에 삽입할 때 사용.
  ipcMain.handle('thumbnail:svgToPng', async (_e, { svg, index } = {}) => {
    try {
      if (!svg) return { ok: false, error: 'no-svg' };
      const dir = path.join(app.getPath('userData'), 'thumb-cache');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `card_${index == null ? Date.now() % 100000 : index}.png`);
      await renderSvgPng(String(svg), file, { size: 700 }); // ★썸네일형 카드는 700×700(1:1 유지) — 사용자 요청(가볍게, 렌더 안정). SVG는 벡터라 화질 유지.
      return { ok: true, file };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 사진 불러오기 — 네이티브 파일 창(다운로드/마지막 폴더에서 시작), 이미지만, 여러 장.
  ipcMain.handle('image:pick', async () => {
    const startDir = lastImageDir || app.getPath('downloads');
    const res = await dialog.showOpenDialog({
      title: '사진 불러오기',
      defaultPath: startDir,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '이미지', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, files: [] };
    lastImageDir = path.dirname(res.filePaths[0]); // 다음엔 이 폴더에서 시작
    return { ok: true, files: res.filePaths };
  });

  // ★로컬 이미지 파일 → data URL(base64). 렌더러에서 file:// 미리보기가 막혀도 확실히 보이게. 썸네일용이라 원본 그대로(작으면 충분).
  ipcMain.handle('image:dataUrl', async (_e, { path: p } = {}) => {
    try {
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'no-file' };
      const buf = fs.readFileSync(p);
      const ext = String(path.extname(p) || '').toLowerCase().replace('.', '');
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
      return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  createWindow();

  // ★자동 모드 안전장치 — autoRun이 멈춰도 최대 45분 뒤 강제 종료(스케줄러 좀비 방지).
  if (AUTO_ANY) setTimeout(() => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'auto-run.log'), '[' + new Date().toISOString() + '] 안전 타임아웃(45분) 종료\n'); } catch (e) {} try { app.quit(); } catch (e) {} }, 45 * 60 * 1000);

  // ★엔터/스포츠 랭킹 백그라운드 갱신 — 시작 5초 뒤 1회 + 15분마다.
  setTimeout(refreshEntertainSports, 5000);
  setInterval(refreshEntertainSports, 15 * 60 * 1000);
  setTimeout(refreshGoogleTrends, 8000); // 구글트렌드(무거운 렌더) — 시작 8초 뒤 + 15분마다
  setInterval(refreshGoogleTrends, 15 * 60 * 1000);
  // (개발) 랭킹 구조 덤프 — DISCOVER=1 일 때만.
  if (process.env.DISCOVER === '1') {
    setTimeout(() => {
      scrapeRendered(M.ENT_URL, M.DISCOVER_DUMP).then((d) => console.log('\n===[ENT]===\n' + d));
      scrapeRendered(M.SPT_URL, M.DISCOVER_DUMP).then((d) => console.log('\n===[SPT]===\n' + d));
    }, 2000);
  }
  // (개발) 네이버 이미지 수집+필터 테스트 — 블로그 출처(워터마크) 제외, 뉴스/방송만 남기기.
  if (process.env.DISCOVER_IMG === '1') {
    setTimeout(() => {
      collectNaverImages('윤손하 캐나다').then((imgs) => {
        console.log('\n===[NAVER-IMG 수집결과]===');
        console.log('통과(뉴스/방송):', imgs.length, '장');
        imgs.slice(0, 12).forEach((x) => console.log('  [' + x.host + '] ' + x.url.slice(0, 80)));
      });
    }, 2500);
  }
  // (개발) DAF 방식 구글 AI 모드 재현 — 크롬UA + 동의페이지 "좌표 실제클릭" → CAPTCHA 회피 확인.
  if (process.env.DISCOVER_GOOGLE === '1') {
    (async () => {
      await new Promise((r) => setTimeout(r, 2500));
      const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
      const CONSENT_PROBE = "(function(){var accept=['모두 허용','모두 동의','accept all'];function norm(v){return String(v||'').replace(/\\s+/g,' ').trim().toLowerCase();}function vis(e){var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden';}var els=[].slice.call(document.querySelectorAll(\"button,[role='button'],input[type='submit'],a\"));var out=[];for(var i=0;i<els.length;i++){var e=els[i];if(!vis(e))continue;var label=[e.innerText,e.textContent,e.getAttribute('aria-label'),e.value].map(function(v){return String(v||'').replace(/\\s+/g,' ').trim();}).find(Boolean)||'';if(accept.indexOf(norm(label))<0)continue;var r=e.getBoundingClientRect();out.push({label:label,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),area:Math.round(r.width*r.height)});}return JSON.stringify({url:location.href,title:document.title,buttons:out});})()";
      const AI_DUMP = "(function(){var imgs=[].slice.call(document.querySelectorAll('img')).map(function(i){return i.src||'';}).filter(function(s){return /^https?:/.test(s);});var txt=(document.body.innerText||'').replace(/\\s+/g,' ');return JSON.stringify({url:location.href.slice(0,70), blocked:/sorry|비정상적인 트래픽/i.test(txt.slice(0,200)), textLen:txt.length, textHead:txt.slice(0,500), imgCount:imgs.length, imgSample:imgs.slice(0,6)});})()";
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { partition: 'persist:google-ai', contextIsolation: true, sandbox: true } });
      try {
        win.webContents.setUserAgent(CHROME_UA);
        await win.loadURL('https://www.google.com/?hl=ko', { userAgent: CHROME_UA });
        await sleep(3000);
        const probeRaw = await win.webContents.executeJavaScript(CONSENT_PROBE);
        const probe = JSON.parse(probeRaw);
        console.log('\n[GOOGLE consent probe]', probeRaw.slice(0, 300));
        const btn = (probe.buttons || []).sort((a, b) => b.area - a.area)[0];
        if (btn) {
          // ★좌표 실제 마우스 클릭(JS click 아님) — 사람처럼 보이게.
          win.webContents.sendInputEvent({ type: 'mouseMove', x: btn.x, y: btn.y });
          await sleep(120);
          win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
          console.log('[GOOGLE consent] clicked', btn.label, 'at', btn.x, btn.y);
          await sleep(3000);
        }
        await win.loadURL('https://www.google.com/search?udm=50&hl=ko&q=' + encodeURIComponent('윤손하 대표작과 최근 근황'), { userAgent: CHROME_UA });
        await sleep(17000);
        const d = await win.webContents.executeJavaScript(AI_DUMP);
        console.log('\n===[GOOGLE-AI DAF방식]===\n' + d);
      } catch (e) {
        console.log('[GOOGLE err]', e.message);
      } finally {
        try { win.destroy(); } catch (e) {}
      }
    })();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 종료 직전: 유지면 세션 쿠키를 "지금 확실히" 지속 쿠키로 변환(로그인 보존), 아니면 세션 삭제.
let _quitting = false;
app.on('before-quit', async (e) => {
  if (_quitting) return; // 재진입 방지
  _quitting = true;
  e.preventDefault();
  try {
    if (keepSession) {
      await persistSessionCookies(); // ★종료 직전 변환 → 강제종료·재시작에도 로그인 유지
    } else {
      await session.fromPartition('persist:naver').clearStorageData();
    }
  } catch (err) { /* ignore */ }
  app.exit(0);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
