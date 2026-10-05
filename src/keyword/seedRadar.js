// 씨앗 레이더 — 여러 소스에서 모은 후보를 점수화해 "선점 좋은 키워드" 순으로 랭킹.
//
// 흐름:
//   1) 후보(구글트렌드 + 기존소스 + …)를 예비 점수(빈틈 제외)로 정렬 → 상위 N만 추림(빈틈 조회 비용 절약).
//   2) 상위 N에만 실시간 빈틈(네이버 발행밀도) 조회 → 최종 점수 재계산 → 랭킹.
//   → main.js가 구글트렌드를 웹뷰로 긁어 candidates로 넘겨주면 이 모듈이 랭킹을 돌려준다.

const { fetchBlogGap } = require('./competition');
const { scoreCandidate } = require('./score');

// 같은 키워드 중복 제거(공백·특수문자 무시).
function norm(s) { return String(s || '').replace(/\s+/g, '').replace(/[^가-힣a-zA-Z0-9]/g, ''); }

/**
 * 후보들을 랭킹한다.
 * @param {Array} candidates [{keyword, volume, risePct, time, related, source}]
 * @param {object} [opts] { type, gapProbe=25, limit=15 }
 * @returns {Promise<Array>} 점수순 정렬된 후보(각 {..., gap, score, components})
 */
async function rankSeeds(
  candidates,
  { type, gapProbe = 25, limit = 15, fetchBlogGap: gapFetcher = fetchBlogGap } = {},
) {
  // 중복 제거
  const seen = new Set();
  const uniq = [];
  for (const c of candidates || []) {
    const k = norm(c && c.keyword);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }

  // 1) 빈틈 없이 예비 점수 → 상위만 빈틈 조회(비용 절약)
  const prelim = uniq
    .map((c) => ({ c, s: scoreCandidate({ ...c, type, gap: null, measured: false }).score }))
    .sort((a, b) => b.s - a.s)
    .slice(0, gapProbe)
    .map((x) => x.c);

  // 2) 상위에만 실시간 빈틈 → 최종 점수
  const scored = await Promise.all(
    prelim.map(async (c) => {
      let gapInfo;
      try {
        gapInfo = await gapFetcher(c.keyword);
      } catch (e) {
        gapInfo = { measured: false, gap: null, perDay: null, count: null, spanHours: null, reason: 'fetch_failed' };
      }
      const measured = gapInfo?.measured === true
        ? Number.isFinite(gapInfo.gap)
        : gapInfo?.measured == null && Number.isFinite(gapInfo?.gap);
      const gap = measured ? gapInfo.gap : null;
      const r = scoreCandidate({ ...c, type, gap, measured });
      return {
        ...c,
        gap,
        measured: r.measured,
        reason: measured ? null : gapInfo?.reason || 'fetch_failed',
        gapInfo: { ...gapInfo, measured: r.measured, gap },
        score: r.score,
        components: r.components,
      };
    }),
  );
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = { rankSeeds };
