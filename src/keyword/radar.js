// 키워드 레이더 — 씨앗 → 롱테일 확장 → 점수화 → 상위 N개 선정.
//
// 점수 = 빈틈(선점) 중심. "검색은 되는데 아직 문서 적은" 키워드가 황금.
//  - 빈틈(gap)  : 블로그 문서수가 적을수록 ↑ (경쟁 낮음 = 선점 기회). ★우리 핵심 무기.
//  - 노출(seen) : 자동완성 확장에서 일찍/자주 등장할수록 수요 신호 근사.
//  - 상승(rise) : (선택) 트렌드 상승률. 데이터랩 등에서 주입.
//
// ★문서수는 배포 시 네이버 검색 API 키가 필요 → docCountFn으로 "주입"받는다.
//   docCountFn 없으면 노출 점수만으로 순위(자동완성 기반, 완전 무키/무로그인).

const { expandKeywords } = require('./expand');

// 액션 인텐트(검색용 세부 수식어) — 돈 되는 방향. searchTopics 액션인텐트와 정합.
const ACTION_MODIFIERS = [
  '신청', '방법', '조회', '발급', '예약', '확인', '환급', '비교', '계산', '갱신', '후기', '추천',
];

/**
 * 키워드 레이더 실행.
 * @param {object} opts
 * @param {string[]} opts.seeds            - 씨앗 키워드(중심키워드/트렌드어)
 * @param {boolean}  [opts.useActionModifiers=false] - 검색용이면 true(액션 인텐트 붙여 확장)
 * @param {function} [opts.docCountFn]     - async (keyword)=>number. 블로그 문서수(빈틈용). 없으면 생략.
 * @param {number}   [opts.topN=15]        - 상위 몇 개 반환
 * @param {number}   [opts.docLookupLimit=30] - 문서수 조회할 상위 후보 수(API 호출 절약)
 * @returns {Promise<{keyword,scores,total}[]>}
 */
async function buildKeywordRadar({
  seeds,
  useActionModifiers = false,
  docCountFn = null,
  topN = 15,
  docLookupLimit = 30,
} = {}) {
  const modifiers = useActionModifiers ? ACTION_MODIFIERS : [];
  const candidates = await expandKeywords(seeds, { modifiers, rounds: 2 });

  // 노출 점수: 확장 순서가 빠를수록(=자동완성 상위) 높게. 0~1 정규화.
  const n = candidates.length || 1;
  let scored = candidates.map((kw, i) => ({
    keyword: kw,
    scores: { exposure: +(1 - i / n).toFixed(3) },
  }));

  // 빈틈 점수: 문서수 조회 가능하면 상위 후보에 한해 붙인다(호출 절약).
  if (typeof docCountFn === 'function') {
    const head = scored.slice(0, docLookupLimit);
    for (const item of head) {
      let docs = null;
      try {
        docs = await docCountFn(item.keyword);
      } catch {
        docs = null;
      }
      if (typeof docs === 'number') {
        item.scores.docCount = docs;
        // 문서 적을수록 빈틈↑. log 스케일로 완만하게(0~1).
        item.scores.gap = +(1 / (1 + Math.log10(1 + docs))).toFixed(3);
      }
    }
  }

  // 종합 점수: 빈틈 있으면 빈틈 0.6 + 노출 0.4, 없으면 노출만.
  for (const item of scored) {
    const { exposure = 0, gap, rise } = item.scores;
    let total;
    if (typeof gap === 'number') total = gap * 0.6 + exposure * 0.4;
    else total = exposure;
    if (typeof rise === 'number') total = total * 0.8 + rise * 0.2; // 트렌드 주입 시 가산
    item.total = +total.toFixed(3);
  }

  scored.sort((a, b) => b.total - a.total);
  return scored.slice(0, topN);
}

module.exports = { buildKeywordRadar, ACTION_MODIFIERS };
