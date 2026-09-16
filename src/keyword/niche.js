// 세부 틈새 키워드 생성 — 레드오션 메인 키워드를 "선점 가능한 세부 각도"로 쪼갠다.
//
// ★왜: "전기차 보조금"·"문근영" 같은 메인은 이미 레드오션(빈틈 0). 단독 발행하면 안 뜬다.
//   → 자동완성 롱테일 + 인텐트 수식어로 세부 후보를 만들고, "빈틈 큰" 세부를 골라 그 각도로 쓴다.
//   예) 전기차 보조금 → "수원 전기차 보조금", "전기차 보조금 신청방법", "추가 지원금"
//       가평 펜션    → "가평 펜션 예약", "자릿세 없는 가평 계곡"
//   (인물은 세부 키워드보다 "다양한 소스 조합"으로 차별화 → generatePost의 다각도 조사가 담당.)

const { fetchAutocomplete } = require('./expand');
const { fetchBlogGap } = require('./competition');
const { scoreCandidate } = require('./score');

// 정보·행동 인텐트 수식어(독자가 실제로 찾는 각도).
const INTENT_MODIFIERS = [
  '신청방법', '신청', '조회', '2026', '조건', '자격', '얼마', '가장 높은 곳',
  '추가 지원금', '후기', '비교', '언제까지', '예약', '예약방법', '순위', '총정리',
];

/**
 * 메인 키워드의 "빈틈 큰 세부 각도"를 찾는다.
 * @param {string} mainKeyword
 * @param {object} [opts] { type, limit=5, probe=15 }
 * @returns {Promise<Array<{keyword, gap, perDay, score}>>} 점수순
 */
async function findNicheAngles(mainKeyword, { type, limit = 5, probe = 15 } = {}) {
  if (!mainKeyword) return [];
  // 1) 세부 후보 = 자동완성 롱테일 + (메인 + 인텐트) 조합
  let ac = [];
  try { ac = await fetchAutocomplete(mainKeyword); } catch (e) { ac = []; }
  const combos = INTENT_MODIFIERS.map((m) => `${mainKeyword} ${m}`);
  const cands = [...new Set([...(ac || []), ...combos])]
    .filter((k) => k && k !== mainKeyword && k.length <= 25);

  // 2) 상위 후보에만 실시간 빈틈 조회 → 점수(빈틈 큰 세부 우선)
  const picked = cands.slice(0, probe);
  const scored = await Promise.all(
    picked.map(async (k) => {
      let gap = 60, perDay = null;
      try { const g = await fetchBlogGap(k); gap = g.gap; perDay = g.perDay; } catch (e) {}
      const s = scoreCandidate({ keyword: k, volume: 3000, risePct: 300, time: '', gap, type });
      return { keyword: k, gap, perDay, score: s.score };
    }),
  );
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = { findNicheAngles, INTENT_MODIFIERS };
