// ★수집 건강검진 — 실제로 한 번씩 수집해보고 어디가 깨졌는지 알려준다. `npm run doctor`
//
// 왜 필요한가: 수집 함수는 전부 실패하면 catch → [] 라서, 네이버가 마크업을 바꿔도
// 에러 없이 근거만 사라진다(글은 계속 나오지만 내용이 빈약해짐). 정기적으로 이걸 돌리면
// "언제부터 무엇이 안 들어오는지"를 바로 알 수 있다.
//
// 브라우저 렌더가 필요한 소스(연예·스포츠 랭킹, 구글 트렌드, 어드바이저)는 Electron이 있어야 해서
// 여기서는 제외한다 — 그쪽은 앱 실행 로그(`[entSp] 0건 …`)와 생성 결과 경고로 확인한다.

const trends = require('../src/keyword/trends');
const expand = require('../src/keyword/expand');
const health = require('../src/scrape/health');
const { isSearchBlocked, getBlockState } = require('../src/scrape/naverSearchGuard');
const { observeSerp } = require('../src/keyword/serpObserve');

const KW_PERSON = process.argv[2] || '손흥민';   // 인물·뉴스가 확실히 있는 키워드
const KW_PLACE = process.argv[3] || '성심당';    // 후기가 확실히 있는 장소
const KW_TOPIC = process.argv[4] || '청년도약계좌'; // 블로그 정보가 확실히 있는 주제

const checks = [
  ['news-headlines', '뉴스 검색(제목+요약)', () => trends.fetchNewsHeadlines(KW_PERSON), 3],
  ['news-articles', '뉴스 기사 본문', () => trends.fetchNewsArticles(KW_PERSON, { limit: 2 }), 1],
  ['top-titles', '상위 제목 참고', () => trends.fetchTopTitles(KW_PLACE), 3],
  ['place-reviews', '장소·제품 후기', () => trends.fetchPlaceReviews(KW_PLACE), 3],
  ['blog-facts', '블로그 검색(참고)', () => trends.fetchBlogFacts(KW_TOPIC), 3],
  ['serp', '통합검색 결과 관찰', () => observeSerp(KW_TOPIC), 3],
  ['autocomplete', '네이버 자동완성', () => expand.fetchAutocomplete(KW_PLACE), 3],
  ['realtime-trends', '실시간 트렌드(통합)', () => trends.fetchRealtimeTrends(), 5],
];

function sample(v) {
  if (v && !Array.isArray(v) && Array.isArray(v.sections)) return String(v.sections[0] || '');
  if (!Array.isArray(v) || !v.length) return '';
  const first = v[0];
  const t = typeof first === 'string' ? first : (first.title || first.keyword || JSON.stringify(first));
  return String(t).replace(/\s+/g, ' ').slice(0, 52);
}

(async () => {
  console.log(`수집 건강검진 — 키워드: "${KW_PERSON}" / "${KW_PLACE}" / "${KW_TOPIC}"\n`);
  const rows = [];
  for (const [id, label, fn, min] of checks) {
    const t0 = Date.now();
    if (isSearchBlocked()) {
      rows.push({ id, label, n: 0, state: 'BLOCKED', ms: Date.now() - t0, err: getBlockState().message, sample: '' });
      continue;
    }
    let v = [], err = '';
    try { v = await fn(); } catch (e) { err = e.message; }
    const n = Array.isArray(v) ? v.length : (v && v.measured && Array.isArray(v.sections) ? v.sections.length : 0);
    const healthState = health.snapshot()[id] || {};
    const state = err ? 'ERROR' : n === 0 && (healthState.blocked || (v && v.blocked)) ? 'BLOCKED' : n === 0 ? 'FAIL' : n < min ? 'WARN' : 'OK';
    rows.push({ id, label, n, state, ms: Date.now() - t0, err, sample: sample(v) });
  }
  const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2000 ? 2 : 1), 0)));
  console.log(pad('소스', 24) + pad('상태', 8) + pad('건수', 6) + pad('시간', 8) + '예시');
  console.log('-'.repeat(96));
  for (const r of rows) {
    const mark = { OK: '✓', WARN: '△', FAIL: '✗', ERROR: '✗', BLOCKED: '🚫' }[r.state];
    console.log(pad(r.label, 24) + pad(mark + ' ' + r.state, 8) + pad(r.n, 6) + pad(r.ms + 'ms', 8) + (r.err || r.sample));
  }
  const bad = rows.filter((r) => r.state === 'FAIL' || r.state === 'ERROR');
  const blocked = rows.filter((r) => r.state === 'BLOCKED');
  if (bad.length) {
    console.log('\n깨진 것으로 보이는 소스:');
    for (const r of bad) {
      const fix = (health.SOURCES[r.id] || {}).fix || '';
      console.log(`  ✗ ${r.label}${fix ? ' → 고칠 곳: ' + fix : ''}`);
    }
    if (!blocked.length) console.log('\n네이버가 페이지 구조를 바꿨을 수 있습니다. src/scrape/markup.js 의 해당 상수를 실제 페이지에서 다시 찾아 고치세요.');
  }
  if (blocked.length) {
    console.log('\n' + getBlockState().message);
  } else if (!bad.length) {
    console.log('\n모든 소스 정상.');
  }
  process.exit(bad.length ? 1 : blocked.length ? 2 : 0);
})();
