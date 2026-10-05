// ★수집 자가진단 — "조용한 0건"을 잡아낸다.
//
// 이 앱의 수집 함수는 전부 실패하면 catch → [] 로 떨어진다(하나가 죽어도 나머지로 굴러가게).
// 그 대가로 네이버가 마크업을 바꾸면 **에러 없이** 근거가 0건이 되고, 모델은 빈손으로 글을 쓴다.
// 그래서 수집할 때마다 결과 건수를 여기 기록하고, 0건이 나오면 표면화한다.
//
// 쓰는 곳:
//   - src/keyword/trends.js  : 각 수집 함수가 record() 호출
//   - electron/main.js       : 생성 결과에 report()를 실어 렌더러가 경고 표시
//   - scripts/doctor.js      : 실제로 한 번 수집해보고 어디가 깨졌는지 출력
const { getBlockState } = require('./naverSearchGuard');

// 소스 id → 사람이 읽는 이름 + 깨졌을 때 볼 곳.
const SOURCES = {
  'news-headlines': { label: '뉴스 검색(제목+요약)', fix: 'markup.js SDS_TEXT_CLASS / searchUrl.news' },
  'news-articles': { label: '뉴스 기사 본문', fix: 'markup.js ARTICLE_LINK_RE / ARTICLE_BODY_RE' },
  'blog-facts': { label: '블로그 검색(참고)', fix: 'markup.js SDS_TEXT_CLASS / searchUrl.blog' },
  'place-reviews': { label: '장소·제품 후기', fix: 'markup.js SDS_TEXT_CLASS / searchUrl.blog' },
  'top-titles': { label: '상위 제목 참고', fix: 'markup.js SDS_TEXT_CLASS / searchUrl.blog' },
  serp: { label: '통합검색 결과 관찰', fix: 'markup.js parseSerpSections / searchUrl.integrated' },
  'autocomplete': { label: '네이버 자동완성', fix: 'src/keyword/expand.js' },
  'realtime-trends': { label: '실시간 트렌드(통합)', fix: 'src/keyword/trends.js 각 소스' },
  'ent-ranking': { label: '연예 랭킹', fix: 'markup.js ENT_EXTRACT' },
  'spt-ranking': { label: '스포츠 랭킹', fix: 'markup.js SPT_EXTRACT' },
  'google-trends': { label: '구글 트렌드', fix: 'src/keyword/googleTrends.js' },
  'advisor': { label: '크리에이터 어드바이저', fix: 'src/keyword/advisor.js (네이버 로그인 필요)' },
  'namu-background': { label: '인물 배경(나무위키)', fix: 'src/keyword/background.js' },
  'official-facts': { label: '기관 페이지 원문', fix: 'electron/main.js fetchOfficialFacts' },
  'trend-signal': { label: 'Signal 실시간 트렌드', fix: 'src/keyword/trends.js fetchSignal' },
  'trend-nate': { label: '네이트 실시간 트렌드', fix: 'src/keyword/trends.js fetchNate' },
  'trend-zum': { label: '줌 실시간 트렌드', fix: 'src/keyword/trends.js fetchZum' },
  'trend-google': { label: 'Google Trends', fix: 'src/keyword/trends.js fetchGoogleTrends' },
  'trend-naver-news': { label: '네이버 뉴스 트렌드', fix: 'src/keyword/trends.js fetchNaverNews' },
};

// 소스별 최근 기록: { count, at, zeroStreak }
const state = new Map();

/**
 * 수집 결과를 기록한다. 호출만 하면 되고 실패해도 수집을 막지 않는다.
 * @param {string} source SOURCES의 키
 * @param {number} count  수집 건수
 * @param {object} [meta] 참고 정보(질의어 등)
 */
function record(source, count, meta = {}) {
  try {
    const n = Number(count) || 0;
    const prev = state.get(source) || { zeroStreak: 0 };
    const errorKind = meta.errorKind || (meta.blocked ? 'blocked' : '');
    state.set(source, {
      count: n,
      at: Date.now(),
      query: meta.query || '',
      blocked: meta.blocked === true,
      status: meta.status != null && Number.isFinite(Number(meta.status)) ? Number(meta.status) : null,
      errorKind,
      errorCode: meta.errorCode || '',
      resultKind: meta.resultKind || (errorKind ? 'error' : n === 0 ? 'empty' : 'ok'),
      zeroStreak: n === 0 ? (prev.zeroStreak || 0) + 1 : 0,
    });
  } catch (e) { /* 진단이 본 작업을 막지 않는다 */ }
  return count;
}

/** 지금까지 한 번이라도 수집을 시도한 소스들의 상태. */
function snapshot() {
  const out = {};
  for (const [k, v] of state) out[k] = { ...v, label: (SOURCES[k] || {}).label || k, fix: (SOURCES[k] || {}).fix || '' };
  return out;
}

/**
 * 깨진 것으로 의심되는 소스 목록.
 * @param {number} minStreak 연속 0건이 몇 번이면 의심할지(기본 1 — 한 번만 0건이어도 보고)
 */
function broken(minStreak = 1) {
  const out = [];
  for (const [k, v] of state) {
    if (v.blocked || v.errorKind || v.resultKind === 'parser_mismatch') {
      out.push({
        source: k, label: (SOURCES[k] || {}).label || k, fix: (SOURCES[k] || {}).fix || '',
        zeroStreak: v.zeroStreak, query: v.query, blocked: !!v.blocked,
        status: v.status, errorKind: v.errorKind, errorCode: v.errorCode, resultKind: v.resultKind,
      });
    }
  }
  return out;
}

/**
 * 한 번의 생성에 대한 진단 요약 — 렌더러가 경고를 띄울지 판단하는 데 쓴다.
 * @returns {{ok:boolean, broken:Array, message:string}}
 */
function report() {
  const b = broken(1);
  const blocked = [...state.values()].some((value) => value.blocked || value.errorKind === 'rate_limited');
  if (blocked) {
    const block = getBlockState();
    const statusNote = block.status ? ` (원인: ${block.kind || 'blocked'}, HTTP ${block.status})` : '';
    return {
      ok: false, blocked: true, broken: b,
      status: block.status || null, errorKind: block.kind || 'blocked', errorCode: block.code || '',
      message: (block.message || '네이버 검색이 일시적으로 제한되어 자료 수집을 멈췄습니다. 잠시 후 다시 시도해 주세요.') + statusNote,
    };
  }
  if (!b.length) return { ok: true, broken: [], message: '' };
  const diagnostics = b.map((item) => {
    if (item.resultKind === 'parser_mismatch' || item.errorKind === 'parser_mismatch') {
      return `${item.label}: 페이지 구조를 확인하지 못했습니다`;
    }
    const kind = item.errorKind || 'collection_error';
    const status = item.status == null ? '' : `, HTTP ${item.status}`;
    return `${item.label}: ${kind}${status}`;
  });
  return {
    ok: false,
    broken: b,
    message: `자료 수집 중 확인이 필요한 오류가 있어요: ${diagnostics.join('; ')}.`,
  };
}

/** 생성 한 건이 끝나면 초기화(다음 생성의 진단이 섞이지 않게). */
function reset() { state.clear(); }

module.exports = { SOURCES, record, snapshot, broken, report, reset };
