// 씨앗 키워드 점수화 — DAF radar-score를 우리 데이터/철학에 맞게 각색.
//
// ★확정 가중치(사용자): 빈틈 0.28 · 세기 0.24 · 급상승(신선도) 0.18 · 지역 0.12 · 안전 0.08 · 유형정합 0.10
//   - 빈틈이 최고 = "선점"(뜨는데 아직 남들이 안 쓴 것) 우선.
//   - 세기 = 구글트렌드 검색량(로그 정규화). 급상승 = 급상승%+신선도(막 뜬 것 우대).
//   - 지역 = 지역 키워드면 가점(여행·맛집이면 부스트). 단 연관어가 사건/재해면 여행부스트 대신 이슈로.
//   - 안전 = 법적 리스크 낮을수록 높음. 유형정합 = 요청 유형과 맞는지(자동모드면 대체로 중립).

function clamp(n, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, Math.round(n))); }

// 검색량(구글트렌드) → 세기 0~100. 2천→약27, 2만→약57, 10만→약83.
function strengthFromVolume(volume) {
  if (!volume || volume <= 0) return 45;
  return clamp(((Math.log10(volume) - 2.5) / 3) * 100);
}

// "5시간 전" / "어제" / "22시간 전" → 대략 시간(h). 모르면 null.
function hoursFromTime(t) {
  if (!t) return null;
  const s = String(t);
  if (/어제/.test(s)) return 24;
  const m = s.match(/(\d+)\s*시간/);
  if (m) return Number(m[1]);
  const d = s.match(/(\d+)\s*일/);
  if (d) return Number(d[1]) * 24;
  if (/분/.test(s)) return 0.5;
  return null;
}

// 급상승 = 급상승%(대부분 캡) + 신선도(막 뜬 것 우대). 신선도 비중을 크게.
function momentum(risePct, time) {
  const rise = clamp(Math.min(100, (Number(risePct) || 0) / 10)); // 1000%→100, 200%→20
  const h = hoursFromTime(time);
  const fresh = h == null ? 55 : clamp(100 - h * 1.9); // 1h→98, 12h→77, 24h→54, 48h→9
  return clamp(rise * 0.35 + fresh * 0.65);
}

// 지역 감지 — 광역/도시 + 유명 여행지 + 시/군/구 접미. related로 여행 vs 사건 구분.
const REGION_WORDS = ['서울','부산','대구','인천','광주','대전','울산','세종','경기','강원','충북','충남','전북','전남','경북','경남','제주','수원','성남','용인','고양','창원','청주','천안','전주','포항','김해','평택','안산','가평','양평','강릉','속초','여수','경주','통영','거제','남해','태안','제천','단양','춘천'];
const ISSUE_WORDS = /지진|태풍|화재|사고|사망|참사|붕괴|침수|폭발|살인|실종|테러|홍수|산불/;
function isRegion(keyword) {
  const k = String(keyword || '');
  if (REGION_WORDS.some((r) => k.includes(r))) return true;
  return /[가-힣]{1,4}(시|군|구|동|읍|면)\b/.test(k) && k.length <= 8;
}
function localScore(keyword, related, type) {
  if (!isRegion(keyword)) return 42; // 지역 아님 = 중립
  const relText = (related || []).join(' ');
  const isIssue = ISSUE_WORDS.test(relText) || ISSUE_WORDS.test(String(keyword));
  if (isIssue) return 50; // 사건/재해로 뜬 지역 = 이슈(여행 부스트 안 함, 그래도 유지)
  const travelBoost = (type === 'travel' || type === 'restaurant') ? 32 : 10;
  return clamp(60 + travelBoost); // 여행·맛집이면 부스트
}

// 안전 — 법적 리스크 높은 소재는 감점(생성 단계에서 완곡/초성 처리하지만 점수도 낮춤).
const RISK_WORDS = /마약|성범죄|성폭행|음주운전|자살|도박|불법|사기|횡령|탈세|아동/;
function safetyScore(keyword, related) {
  const t = String(keyword) + ' ' + (related || []).join(' ');
  return RISK_WORDS.test(t) ? 45 : 88;
}

/**
 * 씨앗 후보 하나를 점수화.
 * @param {object} c { keyword, volume, risePct, time, related, gap, measured, typeFit, type }
 *   - gap: competition.fetchBlogGap()의 measured result. 없으면 내부 계산에만 60(중립)을 사용.
 *   - typeFit: 요청 유형 정합 0~100(없으면 60).
 * @returns {{score:number, measured:boolean, components:object}}
 */
function scoreCandidate(c = {}) {
  const value = strengthFromVolume(c.volume);
  const mom = momentum(c.risePct, c.time);
  const gapMeasured = Number.isFinite(c.gap) && c.measured !== false;
  const gapValue = gapMeasured ? clamp(c.gap) : 60;
  const local = localScore(c.keyword, c.related, c.type);
  const safety = safetyScore(c.keyword, c.related);
  const typeFit = c.typeFit == null ? 60 : clamp(c.typeFit);

  const score = clamp(
    gapValue * 0.28 + value * 0.24 + mom * 0.18 + local * 0.12 + safety * 0.08 + typeFit * 0.10,
  );
  return {
    score,
    measured: gapMeasured,
    components: {
      gap: gapMeasured ? gapValue : null,
      gapMeasured,
      value,
      momentum: mom,
      local,
      safety,
      typeFit,
    },
  };
}

module.exports = { scoreCandidate, strengthFromVolume, momentum, isRegion, clamp };
