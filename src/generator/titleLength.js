'use strict';

// 제목 길이 기준 — 네이버 모바일 목록에서 잘리지 않고 한눈에 읽히는 길이.
//   홈판: 공백 포함 22~28자 목표, 최대 30자 / 검색용: 키워드 앞 배치, 최대 32자.
const TITLE_MAX = { home: 30, search: 32 };

// 긴 제목을 "의미가 끝나는 지점"(쉼표·물음표·느낌표·말줄임·괄호·구분선 앞)까지만 남겨 줄인다.
// keyword가 있으면 그 키워드가 남아 있어야 하고, accept(후보)가 true여야 채택한다. 못 줄이면 원래 제목을 돌려준다.
function shortenTitle(title, { keyword = '', max = TITLE_MAX.home, min = 10, accept = () => true } = {}) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const kw = String(keyword || '').replace(/\s+/g, '');
  const hasKeyword = (s) => !kw || s.replace(/\s+/g, '').includes(kw);
  const clean = (s) => s.replace(/[\s,，:|\-—…·]+$/u, '').trim();
  const candidates = new Set();
  // ① 괄호 덧붙임 제거
  candidates.add(clean(text.replace(/\s*[([（【][^)\]）】]*[)\]）】]\s*/g, ' ').replace(/\s+/g, ' ')));
  // ② 구분자 앞까지(물음표·느낌표는 포함)
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '?' || ch === '!') candidates.add(clean(text.slice(0, i + 1)));
    else if (',，|…([（【'.includes(ch)) candidates.add(clean(text.slice(0, i)));
    else if ((ch === '-' || ch === '—' || ch === ':') && text[i - 1] === ' ') candidates.add(clean(text.slice(0, i)));
  }
  // ③ 쉼표로 나뉜 각 조각(키워드가 뒤 조각에 있는 경우)
  for (const part of text.split(/\s*[,，|]\s*/)) candidates.add(clean(part));
  const ok = [...candidates].filter((c) => c.length >= min && c.length <= max && hasKeyword(c) && accept(c));
  if (!ok.length) return text;
  return ok.sort((a, b) => b.length - a.length)[0];
}

module.exports = { TITLE_MAX, shortenTitle };
