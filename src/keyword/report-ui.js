'use strict';

const cleanDisplay = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
const hasControlCharacter = (value) => /[\u0000-\u001f\u007f]/.test(value);

function normalizeKeywordReportRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('키워드 조사 요청이 올바르지 않습니다.');
  }
  if (typeof input.seed !== 'string' || hasControlCharacter(input.seed)) {
    throw new Error('씨앗 키워드를 확인해 주세요.');
  }
  const seed = cleanDisplay(input.seed);
  if (!seed || seed.length > 80) throw new Error('씨앗 키워드는 1~80자로 입력해 주세요.');
  const count = Number(input.count);
  if (![30, 50, 100].includes(count)) throw new Error('키워드 수는 30, 50, 100 중에서 선택해 주세요.');

  let rawExcludeTerms = input.excludeTerms == null ? [] : input.excludeTerms;
  if (typeof rawExcludeTerms === 'string') rawExcludeTerms = rawExcludeTerms.split(/[,，\n]/);
  if (!Array.isArray(rawExcludeTerms) || rawExcludeTerms.length > 20) {
    throw new Error('제외어는 최대 20개까지 입력해 주세요.');
  }
  const excludeTerms = [];
  for (const rawTerm of rawExcludeTerms) {
    if (typeof rawTerm !== 'string' || hasControlCharacter(rawTerm)) throw new Error('제외어를 확인해 주세요.');
    const term = cleanDisplay(rawTerm);
    if (!term) continue;
    if (term.length > 80) throw new Error('제외어는 각각 80자 이내로 입력해 주세요.');
    if (!excludeTerms.includes(term)) excludeTerms.push(term);
  }
  return { seed, count, excludeTerms };
}

module.exports = { normalizeKeywordReportRequest };
