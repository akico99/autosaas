// 실제 가게 정보 조회 — 네이버 플레이스(pcmap) 스크래핑.
//
// 목적 2가지:
//   1) 업종 환각 방지("기린아 = 돈까스집"인데 카페로 지어내는 것 차단).
//   2) ★가게정보 정리블록용 실데이터: 주소·영업시간·브레이크타임·정기휴무·라스트오더·전화·편의·결제.
//      → 사용자가 "상상으로 만들면 안 된다"고 못박음. 등록 안 된 정보는 null(=표시 안 함), 절대 지어내지 않는다.
// 비용: 0원(공개 페이지, API 키·로그인 불필요). 배포 안전.
// ★안전장치: 막히거나 형식이 바뀌면 예외 없이 null/빈값 → 호출측은 그냥 정보 없이 진행.
//
// 근거: 2026-08-11 실측. map.naver.com allSearch API는 400으로 막힘 → pcmap 리스트+상세로 전환.
//   상세 영업시간은 /home이 아니라 /information 페이지의 __APOLLO_STATE__(NewBusinessHour) 안에 있음.

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

async function getText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://pcmap.place.naver.com/',
      Accept: 'text/html,application/json,*/*',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });
  if (!res || !res.ok) throw new Error('status ' + (res && res.status));
  return await res.text();
}

// __APOLLO_STATE__ = {…} 객체를 "중괄호 균형"으로 정확히 잘라낸다(문자열 내 괄호·이스케이프 고려).
function extractApollo(html) {
  const anchor = html.indexOf('__APOLLO_STATE__');
  if (anchor < 0) return null;
  const s = html.indexOf('{', anchor);
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return html.slice(s, i + 1); }
    }
  }
  return null;
}

// 리스트 페이지에서 첫 placeId + 업종 타입(restaurant/place/attraction 등)을 얻는다.
async function searchFirstPlace(query) {
  const types = ['restaurant', 'place', 'attraction', 'hairshop', 'hospital'];
  for (const t of types) {
    try {
      const html = await getText('https://pcmap.place.naver.com/' + t + '/list?query=' + encodeURIComponent(query));
      const m = html.match(/"id":"(\d{7,})"/);
      if (m) return { id: m[1], type: t };
    } catch (e) { /* 다음 타입 */ }
  }
  return null;
}

// 특정 키워드가 속한 [ … ] 배열을 "괄호 균형"으로 잘라 JSON.parse (문자열/이스케이프 인지).
//   영업시간(WorkingHoursInfo[])이 __APOLLO_STATE__ 밖 별도 블롭에 있어서, 구조 의존 없이 원문에서 직접 뽑는다.
function extractArrayAround(html, keyword) {
  const at = html.indexOf(keyword);
  if (at < 0) return null;
  const lb = html.lastIndexOf('[', at); // 이 항목을 담은 배열의 여는 대괄호
  if (lb < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = lb; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(lb, i + 1)); } catch (e) { return null; } } }
    }
  }
  return null;
}

// "11:00"~"20:00" + 브레이크 + 정기휴무 → 요일별 사람이 읽는 문자열 배열. (원문에서 WorkingHoursInfo[] 직접 파싱)
function parseBusinessHours(html) {
  const arr = extractArrayAround(html, '"__typename":"WorkingHoursInfo"');
  if (!Array.isArray(arr) || !arr.length) return null;
  const t = (x) => (x && x.start && x.end ? x.start + '~' + x.end : '');
  const out = [];
  for (const w of arr) {
    if (!w || !w.day) continue;
    const bh = w.businessHours ? t(w.businessHours) : '';
    const desc = (w.description || '').trim(); // "정기휴무 (매주 월요일)" 등
    const breaks = Array.isArray(w.breakHours) ? w.breakHours.map(t).filter(Boolean) : [];
    if (!bh && desc) { out.push({ day: w.day, closed: /휴무/.test(desc), text: desc }); continue; }
    if (!bh) continue;
    let line = bh;
    if (breaks.length) line += ' (브레이크 ' + breaks.join(', ') + ')';
    out.push({ day: w.day, closed: false, text: line });
  }
  return out.length ? out : null;
}

// 요일별 영업시간을 "같은 시간끼리 묶어" 짧게 요약. 예: 화~일 11:00~20:00 / 월 정기휴무.
function summarizeHours(hours) {
  if (!hours || !hours.length) return null;
  const lines = [];
  let i = 0;
  while (i < hours.length) {
    let j = i;
    while (j + 1 < hours.length && hours[j + 1].text === hours[i].text) j++;
    const span = i === j ? hours[i].day : hours[i].day + '~' + hours[j].day;
    lines.push(span + ' ' + hours[i].text);
    i = j + 1;
  }
  return lines;
}

/**
 * 장소명으로 실제 가게 정보를 조회한다(가게정보 정리블록용 풀버전).
 * @param {string} query - 예: "평택 진위면 기린아", "서울 은평구 냉면시대"
 * @returns {Promise<null | {name,category,roadAddress,address,tel,x,y,id,conveniences,payment,hoursLines,holiday,hasHours}>}
 */
async function fetchPlaceInfo(query) {
  const q = (query || '').trim();
  if (!q || typeof fetch !== 'function') return null;
  try {
    const found = await searchFirstPlace(q);
    if (!found) return null;
    const html = await getText('https://pcmap.place.naver.com/' + found.type + '/' + found.id + '/information');
    const raw = extractApollo(html);
    if (!raw) return null;
    const state = JSON.parse(raw);
    const base = Object.values(state).find((v) => v && /PlaceDetailBase|RestaurantBase|PlaceBase/i.test(v.__typename || ''));
    if (!base) return null;

    let category = '';
    if (typeof base.category === 'string') category = base.category;
    else if (Array.isArray(base.categoryCodeList)) category = base.category || '';

    const hours = parseBusinessHours(html);
    // 영업시간 줄에는 "여는 요일"만(휴무일은 아래 정기휴무 줄에서 따로 표기 → 중복 제거).
    const hoursLines = summarizeHours((hours || []).filter((h) => !h.closed));
    // 정기휴무 = businessHours가 닫힌(휴무) 요일 모음.
    const holidayDays = (hours || []).filter((h) => h.closed).map((h) => h.day);
    const holiday = holidayDays.length ? '매주 ' + holidayDays.join('·') + '요일' : '';

    return {
      name: base.name || q,
      category: (category || '').replace(/,/g, '>').trim(),
      roadAddress: base.roadAddress || '',
      address: base.address || '',
      tel: base.phone || base.virtualPhone || '',
      x: (base.coordinate && base.coordinate.x) || base.x || '',
      y: (base.coordinate && base.coordinate.y) || base.y || '',
      id: base.id || found.id,
      conveniences: Array.isArray(base.conveniences) ? base.conveniences.filter(Boolean) : [],
      payment: Array.isArray(base.paymentInfo) ? base.paymentInfo.filter(Boolean) : [],
      hoursLines: hoursLines || null,   // ["화~일 11:00~20:00", ...] 또는 null(등록 안 됨=표시 안 함)
      holiday: holiday || '',           // "매주 월요일" 또는 ''(모름)
      hasHours: !!(hoursLines && hoursLines.length),
    };
  } catch (e) {
    return null; // 막히면 조용히 포기 → 글은 사용자 입력만으로 정확히 나옴
  }
}

/**
 * (하위호환) 기존 lookupPlace — 업종 환각 방지용 축약본. 내부적으로 fetchPlaceInfo를 쓴다.
 * @returns {Promise<null | {name,category,address,roadAddress,x,y,id,tel}>}
 */
async function lookupPlace(query) {
  const info = await fetchPlaceInfo(query);
  if (!info) return null;
  return {
    name: info.name,
    category: info.category,
    address: info.address,
    roadAddress: info.roadAddress,
    x: info.x,
    y: info.y,
    id: info.id,
    tel: info.tel,
  };
}

module.exports = { lookupPlace, fetchPlaceInfo };
