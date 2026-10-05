// 빈틈(경쟁도) 근사 측정 — "선점 여지"를 무료로 잰다.
//
// ★왜 이 방식인가: 정확한 블로그 총 문서수는 무료로 못 얻는다(네이버 검색이 캡 1000으로 숨김,
//   DAF도 키 없으면 못 함). 대신 우리는 "선점" 철학에 더 맞는 신호를 쓴다:
//   → 네이버 블로그 "최신순" 상위 글들의 발행 밀도(발행 속도).
//     사람들이 지금 이 키워드에 몰려 글을 쏟아내고 있으면(짧은 시간에 많은 글) = 이미 레드오션(빈틈 없음).
//     날짜·응답 자료가 충분하지 않으면 측정 불가로 둔다.
//   무키·무로그인·무료(공개 AJAX). 네이버 로그인 세션도 필요 없음.

const https = require('https');

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

function fetchText(url, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('요청 시간초과')));
  });
}

/**
 * 키워드의 "빈틈"(선점 여지)을 0~100으로 반환. 높을수록 경쟁 적음(=선점 기회).
 *   - 최신순 상위 글들의 발행 속도(글/일)를 로그 스케일로 환산.
 *   - 최근 글 날짜가 부족하거나 응답이 유효하지 않으면 측정 불가로 반환한다.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchText] Injectable transport for deterministic callers/tests.
 * @param {number} [options.now=Date.now()] Current epoch milliseconds for timestamp validation.
 * @returns {Promise<{ measured:boolean, gap:number|null, perDay:number|null, count:number|null, spanHours:number|null, reason:'insufficient_dates'|'invalid_response'|'fetch_failed'|null }>}
 *   count is null until a valid search-list array has been received and counted.
 */
async function fetchBlogGap(keyword, { fetchText: textFetcher = fetchText, now = Date.now() } = {}) {
  let count = null;
  try {
    const url =
      'https://section.blog.naver.com/ajax/SearchList.naver?countPerPage=30&currentPage=1&keyword=' +
      encodeURIComponent(keyword) +
      '&orderBy=recentdate&type=post';
    const body = await textFetcher(url, { Referer: 'https://section.blog.naver.com/Search/Post.naver', Accept: 'application/json' });
    let j;
    try {
      j = JSON.parse(body.replace(/^\)\]\}',?\s*/, ''));
    } catch (e) {
      return { measured: false, gap: null, perDay: null, count: null, spanHours: null, reason: 'invalid_response' };
    }
    const posts = j?.result?.searchList ?? j?.searchList;
    if (!Array.isArray(posts)) {
      return { measured: false, gap: null, perDay: null, count: null, spanHours: null, reason: 'invalid_response' };
    }
    const earliestSensibleDate = Date.UTC(2000, 0, 1);
    const latestSensibleDate = now + 24 * 60 * 60 * 1000;
    const dates = posts
      .map((p) => Number(p?.addDate))
      .filter((n) => Number.isFinite(n) && n >= earliestSensibleDate && n <= latestSensibleDate)
      .sort((a, b) => b - a);
    count = dates.length;

    if (dates.length < 3) {
      return { measured: false, gap: null, perDay: null, count, spanHours: null, reason: 'insufficient_dates' };
    }
    const spanMs = dates[0] - dates[dates.length - 1];
    const spanHours = spanMs / 3600000;
    // 하루당 발행 수(근사). span이 0에 가까우면 초포화.
    const perDay = dates.length / Math.max(spanHours / 24, 0.01);
    // gap: 발행 많을수록 낮음. perDay 1/일→약90, 10/일→약60, 100/일→약30, 1000/일→약0.
    const gap = clamp(Math.round(90 - Math.log10(Math.max(1, perDay)) * 30));
    return {
      measured: true,
      gap,
      perDay: Math.round(perDay),
      count,
      spanHours: Math.round(spanHours * 10) / 10,
      reason: null,
    };
  } catch (e) {
    return { measured: false, gap: null, perDay: null, count, spanHours: null, reason: 'fetch_failed' };
  }
}

module.exports = { fetchBlogGap, clamp };
