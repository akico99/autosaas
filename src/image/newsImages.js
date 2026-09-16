// 뉴스 기사 이미지 수집 — "최신 기사에서 정확·최근 사진만" 뽑는다.
//
// ★왜 이 방식인가 (DAF 대비 우위):
//   DAF는 이미지를 "크기순"으로만 긁어서 → ①주제 안 맞음(김부장 드라마에 웹툰 섞임)
//   ②시점 안 맞음(2026 캐시백 글에 2023 사진). 우리는 이 두 축을 코드로 결정적으로 해결한다.
//     - 주제 정확: "그 키워드만 다루는 최신 기사"의 대표 사진을 씀 → 딴 주제 안 섞임.
//     - 시점 정확: 네이버 뉴스 이미지 원본 URL에 "촬영 날짜"가 박혀 있음
//         imgnews.pstatic.net/image/origin/{언론사}/{YYYY}/{MM}/{DD}/xxxx.jpg
//       → 날짜를 파싱해 오래된 사진(예: 18개월↑)을 코드가 자동 제외.
//
// ★배포 안전: 무키·무로그인·무료(공개 HTTP), Node 기본 모듈만. 클로드(LLM)를 절대 안 거침
//   = "저작권 때문에 못 가져온다" 같은 거절이 생길 경로 자체가 없다(수집은 100% 코드).
//
// ★안전 필터:
//   - 언론사 로고(office_logo/logo_)·아이콘 제외
//   - 블로그/카페 출처(워터마크·블로그주소 사진) 제외
//   - 실제 기사 사진(imgnews.pstatic.net) + 날짜 최근 것만 남김

const https = require('https');
const http = require('http');
const path = require('path');

// oid→언론사명 정적 폴백 맵(네이버 편집 언론사 82종). 검색 페이지 alt에서 못 뽑을 때만 사용.
let PRESS_FALLBACK = {};
try {
  PRESS_FALLBACK = require('./pressNames.json');
} catch (e) {
  PRESS_FALLBACK = {};
}

// ★큰 언론사(이름 표기 대상). 나머지 작은 언론사는 개별 표기 안 하고 "네이버 뉴스"로 뭉뚱그림.
//   블로그·DAF 관행 = 모든 사진에 출처 안 붙임. 큰 데만 이름, 작은 데는 생략/일괄.
const MAJOR_PRESS = new Set([
  // 통신·지상파·종편·보도
  '연합뉴스', '연합뉴스TV', '뉴시스', '뉴스1', 'KBS', 'MBC', 'SBS', 'SBS Biz',
  'JTBC', 'TV조선', '채널A', 'MBN', 'YTN', '한국경제TV',
  // 종합일간
  '조선일보', '중앙일보', '동아일보', '한겨레', '경향신문', '국민일보',
  '서울신문', '한국일보', '세계일보', '문화일보',
  // 경제
  '한국경제', '매일경제', '서울경제', '머니투데이', '이데일리',
  '파이낸셜뉴스', '헤럴드경제', '아시아경제', '조선비즈',
  // IT·연예스포츠 대형
  '전자신문', '디지털데일리', '지디넷코리아', '스포츠서울', '스포츠조선',
  '일간스포츠', 'OSEN', '스타뉴스', '마이데일리',
]);

/**
 * 수집 이미지들의 출처를 "블로그 관행대로" 정리한다.
 *   - 큰 언론사만 이름 표기, 작은 데는 "네이버 뉴스"로 일괄.
 *   - 같은 언론사 중복 제거.
 * @param {Array<{press?:string}>} images
 * @returns {{ line:string, majors:string[], hasOther:boolean }}
 *   line = 글 끝에 한 줄로 넣을 출처 문구. 예: "이미지 출처 · 연합뉴스, 스포츠서울, 네이버 뉴스"
 */
function summarizeAttribution(images) {
  const majors = [];
  let hasOther = false;
  const seen = new Set();
  for (const im of images || []) {
    const p = (im && im.press) || '';
    if (MAJOR_PRESS.has(p)) {
      if (!seen.has(p)) { seen.add(p); majors.push(p); }
    } else {
      hasOther = true; // 작은/미상 언론사 = 일괄 처리
    }
  }
  const parts = [...majors];
  if (hasOther || parts.length === 0) parts.push('네이버 뉴스');
  return { line: '이미지 출처 · ' + parts.join(', '), majors, hasOther };
}

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

// 원시 바이트로 받기(HTML은 utf8, 이미지는 그대로 버퍼).
function fetchBuffer(url, { timeoutMs = 12000, ua = MOBILE_UA, referer } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': ua, Accept: '*/*' };
    if (referer) headers.Referer = referer;
    const mod = /^http:\/\//i.test(url) ? http : https; // ★http/https 둘 다 지원(옛 imgnews.naver.net는 http)
    const req = mod.get(url, { headers }, (res) => {
      // 리다이렉트 따라가기(이미지 CDN이 302 주는 경우)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(fetchBuffer(next, { timeoutMs, ua, referer }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('요청 시간초과')));
  });
}

// 네이버 검색 프록시(search.pstatic.net/common/?src=원본)에서 원본 URL 디코드.
function decodeProxy(u) {
  try {
    const m = u.match(/[?&]src=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : u;
  } catch (e) {
    return u;
  }
}

// 네이버 뉴스 이미지 원본 URL에서 촬영 날짜를 뽑는다. 없으면 null.
//   .../image/origin/5813/2026/07/29/108415.jpg  → Date(2026,6,29)
function parseDateFromUrl(u) {
  const m = u.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

// 언론사 로고·아이콘·UI 이미지인가? (실제 기사 사진이 아님)
function isLogoOrIcon(u) {
  // blogpfthumb=블로그 프로필 썸네일(저화질 아바타), 200x200 등 소형 썸네일도 제외.
  return /office_logo|\/logo_|\/logo\/|favicon|sprite|blank\.|profile|reporter|ico_|btn_|blogpfthumb|pfthumb/i.test(u) ||
    /\b(?:[1-9]\d|1\d\d|2\d\d)x(?:[1-9]\d|1\d\d|2\d\d)\b/.test(u); // ~299px 이하 소형 썸네일
}

// ★블로그/뉴스/커뮤니티 전부 허용(2026-08-03 사용자 확정): "아옳이 김형배" 검색=91장 전부 블로그였고,
//   이걸 막으니 커플 사진이 하나도 안 왔다. 관련 사진 확보가 워터마크 회피보다 우선 → 블로그도 가져온다.
//   차단은 프로필 썸네일(저화질)·로고·광고만(isLogoOrIcon/isAdOrShopping이 담당). 여기선 아무것도 안 막는다.
function isBlogSource(u) {
  // ★개인 블로그·카페 이미지 CDN 차단(초상권·저작권·품질). 뉴스 CDN(imgnews.pstatic.net)은 절대 안 막는다.
  //   네이버 블로그: blogfiles / postfiles / mblogthumb / blogthumb / blogpfthumb
  //   네이버 카페: cafeptthumb / cafefiles / cafethumb   |  티스토리·다음: tistory / daumcdn
  return /blogfiles|postfiles|mblogthumb|blogthumb|blogpfthumb|cafeptthumb|cafefiles|cafethumb|tistory|daumcdn/i.test(u || '');
}

// 실제 기사 사진(네이버 뉴스 CDN)인가?
function isArticlePhoto(u) {
  return /imgnews\.pstatic\.net|mimgnews\.pstatic\.net/i.test(u) && /\/image\//i.test(u) && !isLogoOrIcon(u);
}

// 광고·쇼핑·상품 이미지인가? (이미지 검색에 섞여 오는 텀블러·배너 등 차단)
function isAdOrShopping(u) {
  return /shop(ping)?\.pstatic|shopping\.naver|adcr\.naver|gfmarket|storep-phinf|smartstore|/i.test(u) &&
    /shop|store|adcr|gfmarket|storep/i.test(u);
}

/**
 * ★네이버 "이미지 검색"으로 사진을 수집한다(뉴스 CDN 한정 X → 과거 사진·다양한 출처까지).
 *   - 인물의 졸업사진·데뷔 시절·과거 등은 최신 뉴스엔 없고 이미지 검색에 있으므로 이 경로가 필수.
 *   - Claude가 만든 정확한 검색어(예: "아이오아이 강미나 졸업사진")를 그대로 받아 검색한다.
 *   - 날짜 필터 없음(과거 사진을 일부러 가져오는 게 목적).
 * @param {string} query
 * @param {object} [opts]  { limit=12 }
 * @returns {Promise<Array<{url,proxy,oid,press,date,dateStr}>>}
 */
async function collectImages(query, { limit = 12, photoNews = false, maxAgeMonths = 0, allowLogo = false, allowBlog = false, now } = {}) {
  // ★기간(최신) 필터 = 네이버 실제 파라미터 &nso=so:r,p:<기간>. (검증: "영화 오디세이"에서 옛 "2001 스페이스오디세이"가 75→2로 걸러짐)
  //   maxAgeMonths → 네이버 코드: 1→1개월(1m), 3→3m, 6→6m, 12↑→1년(1y). 0이면 필터 없음.
  const _period = maxAgeMonths >= 12 ? '1y' : maxAgeMonths >= 6 ? '6m' : maxAgeMonths >= 3 ? '3m' : maxAgeMonths >= 1 ? '1m' : '';
  const _nso = _period ? '&nso=' + encodeURIComponent('so:r,p:' + _period) : '';
  const url = 'https://m.search.naver.com/search.naver?where=m_image&query=' + encodeURIComponent(query) + _nso;
  let html = '';
  try {
    html = (await fetchBuffer(url)).toString('utf8');
  } catch (e) {
    return [];
  }
  const proxies = [...new Set((html.match(/https?:\/\/search\.pstatic\.net\/[^"'\\ )]+/g) || []))];
  const seen = new Set();
  const out = [];
  // ★날짜 필터는 위 &nso 네트워크 파라미터가 처리(옛 동명작 배제). 클라이언트 재필터는 안 함(과필터로 0장 되던 문제 방지).
  // ★포토뉴스급인지(언론사 뉴스 CDN 사진 = 블로그·TV·위키·그래픽 아님) 판별. photoNews=true면 이것만 남긴다(네이버 이미지검색 "출처=포토뉴스"와 동일 효과).
  const isPressCdn = (u) => /imgnews\.(pstatic|naver)\.net|pstatic\.net\/image\/(origin|\d{2,4})\//i.test(u) || /\/(origin|image)\/\d{3,4}\//.test(u);
  for (const proxy of proxies) {
    const orig = decodeProxy(proxy);
    if (!/\.(jpg|jpeg|png|webp)/i.test(orig)) continue; // 이미지 URL만
    if (!allowLogo && isLogoOrIcon(orig)) continue; // ★allowLogo(검색 전용)=로고/CI 수집 허용(회사·기관 로고). 홈판은 미전달=기존대로 로고 차단.
    if (isAdOrShopping(orig)) continue; // 텀블러·상품·배너 차단
    if (!allowBlog && isBlogSource(orig)) continue; // 블로그 워터마크 제외(초상권·품질). ★allowBlog(엔터 장르)=블로그 사진 허용(공식/뉴스/방송이면 비전이 통과, 재가공은 비전이 거름)
    if (/wikimedia|ytimg/i.test(orig)) continue; // ★위키·유튜브 썸네일은 항상 제외(재가공·저작권)
    if (!allowBlog && /blogfiles\.naver|tistory|daumcdn/i.test(orig)) continue; // ★블로그·다음 = 기본 제외, 단 엔터(allowBlog)면 허용
    if (photoNews && !allowBlog && !isPressCdn(orig)) continue; // ★포토뉴스 모드 = 언론사 뉴스 CDN 사진만. 단 allowBlog(엔터)면 비press(블로그 등)도 허용
    if (seen.has(orig)) continue;
    seen.add(orig);
    const date = parseDateFromUrl(orig); // 뉴스 CDN이면 날짜 파싱(없으면 null=과거사진 OK)
    const oidM = orig.match(/\/(?:origin|image)\/(\d{3,4})\//) || orig.match(/\/(\d{3,4})\/20\d{2}\//);
    const oid = oidM ? oidM[1] : '';
    out.push({
      url: orig, proxy, date,
      dateStr: date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '',
      oid, press: oid ? (PRESS_FALLBACK[oid] || '') : '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 키워드로 뉴스 기사 이미지를 수집한다(최신순 + 최근 사진만).
 *
 * @param {string} keyword
 * @param {object} [opts]
 * @param {number} [opts.limit=12]         - 최대 반환 개수
 * @param {number} [opts.maxAgeMonths=18]  - 이보다 오래된 사진은 제외(0이면 날짜필터 끔)
 * @param {Date}   [opts.now]              - 기준 시각(테스트용). 기본 현재.
 * @returns {Promise<Array<{url:string, proxy:string, date:Date|null, oid:string, dateStr:string}>>}
 */
async function collectNewsImages(keyword, { limit = 12, maxAgeMonths = 18, now } = {}) {
  const url =
    'https://m.search.naver.com/search.naver?where=m_news&sort=1&query=' + encodeURIComponent(keyword);
  let html = '';
  try {
    html = (await fetchBuffer(url)).toString('utf8');
  } catch (e) {
    return [];
  }

  // ★oid→언론사명: 검색 HTML의 로고 이미지 alt="{언론사}의 프로필 이미지" + office_logo/{oid} 페어에서 뽑는다.
  //   (검색 페이지가 직접 제공 → 별도 목록 불필요. 못 뽑은 oid는 정적 폴백맵으로 보충.)
  const oidToPress = {};
  const imgTagRe = /<img[^>]+>/g;
  let tag;
  while ((tag = imgTagRe.exec(html))) {
    const t = tag[0];
    const oidM = t.match(/office_logo(?:%2F|\/)(\d{3,4})/);
    const altM = t.match(/alt="([^"]+?)(?:의 프로필 이미지)?"/);
    if (oidM && altM) {
      const name = altM[1].replace(/의 프로필 이미지$/, '').trim();
      if (name && !oidToPress[oidM[1]]) oidToPress[oidM[1]] = name;
    }
  }
  const pressOf = (oid) => oidToPress[oid] || PRESS_FALLBACK[oid] || '';

  const cutoff =
    maxAgeMonths > 0
      ? (() => {
          const base = now instanceof Date ? new Date(now) : new Date();
          base.setMonth(base.getMonth() - maxAgeMonths);
          return base;
        })()
      : null;

  // ★★각 이미지에 "그 기사 제목"을 붙인다 — 제목으로 관련성 판별(안마바우처 검색에 "축협 안마업소 논란" 사진 섞이는 것 방지).
  //   방법: 기사 제목(headline1) 위치를 찾고, 그 뒤 가까운 곳의 뉴스 이미지를 그 제목의 것으로 짝짓는다.
  const decodeT = (s) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const titleAt = []; // {pos, title}
  { const re = /<span[^>]*sds-comps-text-type-headline1[^>]*>([\s\S]*?)<\/span>/g; let m; while ((m = re.exec(html))) { const t = decodeT(m[1]); if (t) titleAt.push({ pos: m.index, title: t }); } }
  const titleForPos = (imgPos) => { let best = ''; for (const h of titleAt) { if (h.pos <= imgPos && imgPos - h.pos < 4000) best = h.title; else if (h.pos > imgPos) break; } return best; };

  // 검색 결과의 프록시 썸네일 → 위치와 함께(제목 매칭용). 중복 제거는 원본 URL로.
  const proxRe = /https?:\/\/search\.pstatic\.net\/[^"'\\ )]+/g;
  const seen = new Set();
  const out = [];
  let pm;
  while ((pm = proxRe.exec(html))) {
    const proxy = pm[0];
    const orig = decodeProxy(proxy);
    if (!isArticlePhoto(orig)) continue; // 로고·아이콘·비뉴스 제외
    if (isBlogSource(orig)) continue; // 블로그 워터마크 제외
    if (seen.has(orig)) continue;
    seen.add(orig);

    const date = parseDateFromUrl(orig);
    if (cutoff && date && date < cutoff) continue; // ★오래된 사진 제외(2023 등)

    const oidM = orig.match(/\/(?:origin|image)\/(\d{3,4})\//) || orig.match(/\/(\d{3,4})\/20\d{2}\//);
    const oid = oidM ? oidM[1] : '';
    out.push({
      url: orig,
      proxy,
      date,
      dateStr: date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '',
      oid,
      press: pressOf(oid), // ★출처(언론사명) — 사진 하단 "- 언론사명" 표기용
      title: titleForPos(pm.index), // ★그 기사 제목 — 관련성 판별·비전 판정에 사용
    });
    if (out.length >= limit + 8) break; // 정렬 위해 여유분
  }

  // 날짜 있는 것 우선 + 최신순 정렬
  out.sort((a, b) => {
    if (a.date && b.date) return b.date - a.date;
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
  return out.slice(0, limit);
}

/**
 * 이미지 원본을 바이트로 내려받는다(에디터 업로드용). 실패 시 null.
 * @returns {Promise<{buffer:Buffer, contentType:string}|null>}
 */
async function downloadImage(url) {
  try {
    const buffer = await fetchBuffer(url, { referer: 'https://n.news.naver.com/' });
    if (!buffer || buffer.length < 1024) return null; // 1KB 미만 = 깨진/빈 이미지
    // 매직 넘버로 타입 판별
    let contentType = 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50) contentType = 'image/png';
    else if (buffer[0] === 0x47 && buffer[1] === 0x49) contentType = 'image/gif';
    else if (buffer[8] === 0x57 && buffer[9] === 0x45) contentType = 'image/webp';
    return { buffer, contentType };
  } catch (e) {
    return null;
  }
}

/**
 * ★영화 전용 — "작품명 포토"로 네이버 영화 정보 카드의 공식 스틸컷·포스터·프로모션 사진을 수집한다.
 *   - 영화만 가능(드라마·예능은 이 카드가 없음 → 일반 이미지검색 사용).
 *   - 장점: 100% 그 영화 공식 이미지(딴 동명 영화 절대 안 섞임) + 공식 배포라 안전.
 *   - 이미지 = movie-phinf.pstatic.net(영화 전용 CDN)만 골라낸다.
 * @param {string} title  영화 제목(예: "오디세이")
 * @param {object} [opts] { limit=16 }
 * @returns {Promise<Array<{url,proxy,press,date:null,dateStr:''}>>}
 */
async function collectMoviePhotos(title, { limit = 16 } = {}) {
  const t = String(title || '').replace(/\s*(영화|포토|포스터|스틸컷?)\s*/g, ' ').trim();
  if (!t) return [];
  const url = 'https://m.search.naver.com/search.naver?query=' + encodeURIComponent(t + ' 포토');
  let html = '';
  try { html = (await fetchBuffer(url)).toString('utf8'); } catch (e) { return []; }
  const proxies = [...new Set((html.match(/https?:\/\/search\.pstatic\.net\/[^"'\\ )]+/g) || []))];
  const seen = new Set();
  const out = [];
  for (const proxy of proxies) {
    const orig = decodeProxy(proxy);
    // ★영화 전용 CDN(movie-phinf)만 = 공식 스틸컷·포스터·프로모션. 그 외(favicon·블로그 등) 배제.
    if (!/movie-phinf\.pstatic\.net/i.test(orig)) continue;
    if (!/\.(jpg|jpeg|png|webp)/i.test(orig)) continue;
    if (seen.has(orig)) continue;
    seen.add(orig);
    out.push({ url: orig, proxy, press: '네이버 영화', date: null, dateStr: '' });
    if (out.length >= limit) break;
  }
  return out;
}

// 개별 사진 하단 캡션 — 큰 언론사면 이름, 작으면 빈 문자열(표기 안 함).
//   글 끝 일괄 출처(summarizeAttribution)를 쓰면 개별 캡션은 생략해도 됨.
function captionFor(image) {
  const p = (image && image.press) || '';
  return MAJOR_PRESS.has(p) ? p : '';
}

// 수집 이미지를 실제 파일로 저장한다(에디터 CDP 삽입용 로컬 경로 확보).
//   @returns {Promise<Array<{path, url, press, dateStr, caption}>>} 저장 성공한 것만.
async function downloadImagesToDir(images, dir, { max = 12 } = {}) {
  const fs = require('fs');
  const crypto = require('crypto');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = (ct) => (ct === 'image/png' ? 'png' : ct === 'image/gif' ? 'gif' : ct === 'image/webp' ? 'webp' : 'jpg');
  const out = [];
  const seenHash = new Set(); // ★같은 사진이 다른 URL로 또 오는 경우까지 내용 해시로 중복 제거
  for (let i = 0; i < images.length && out.length < max; i++) {
    const im = images[i];
    const dl = await downloadImage(im.url);
    if (!dl) continue;
    // 실제 바이트 내용으로 해시 → 동일 이미지면(URL이 달라도) 건너뛴다.
    const hash = crypto.createHash('md5').update(dl.buffer).digest('hex');
    if (seenHash.has(hash)) continue;
    seenHash.add(hash);
    const file = path.join(dir, `news_${String(i).padStart(2, '0')}_${im.oid || 'x'}.${ext(dl.contentType)}`);
    try {
      fs.writeFileSync(file, dl.buffer);
      out.push({ path: file, url: im.url, press: im.press || '', dateStr: im.dateStr || '', caption: captionFor(im), title: im.title || '', bytes: dl.buffer.length, hash });
    } catch (e) { /* 한 장 실패해도 계속 */ }
  }
  return out;
}

module.exports = {
  fetchBuffer,
  collectNewsImages,
  collectImages,
  collectMoviePhotos,
  downloadImage,
  downloadImagesToDir,
  summarizeAttribution,
  captionFor,
  MAJOR_PRESS,
  parseDateFromUrl,
  decodeProxy,
  isArticlePhoto,
  isBlogSource,
};
