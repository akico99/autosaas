'use strict';

const TRAVEL_TYPES = Object.freeze(['package', 'hotel', 'flight', 'activity', 'other']);

// 여행 원고에서 빠지면 안 되는 질문. 상품 데이터에 답이 없을 때만 requiredAnswers로 남긴다.
const TRAVEL_QUESTIONS = Object.freeze({
  departureDate: '출발일은 언제인가요?',
  travelers: '여행 인원(성인·아동)은 몇 명인가요?',
  roomBasis: '객실 유형과 투숙 기준은 무엇인가요?',
  inclusions: '가격에 포함된 항목은 무엇인가요?',
  exclusions: '가격에 포함되지 않은 항목은 무엇인가요?',
  cancellationPolicy: '취소·환불 조건은 어떻게 되나요?',
});

const TRAVEL_DETAILS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['destination', 'travelType', 'nights', 'days', 'inclusions', 'exclusions', 'cancellationPolicy'],
  properties: {
    destination: { type: 'string' },
    travelType: { enum: TRAVEL_TYPES },
    nights: { type: ['integer', 'null'], minimum: 0 },
    days: { type: ['integer', 'null'], minimum: 1 },
    inclusions: { type: 'array', items: { type: 'string', minLength: 1 } },
    exclusions: { type: 'array', items: { type: 'string', minLength: 1 } },
    cancellationPolicy: { type: 'string' },
  },
};

function cleanList(list) {
  return Array.isArray(list) ? list.map((item) => String(item == null ? '' : item).trim()).filter(Boolean) : [];
}

// 입력 정리만 하고 값을 추정하지 않는다. 빠진 값은 빈 값으로 두어 질문으로 남긴다.
function normalizeTravelDetails(input) {
  const src = input && typeof input === 'object' ? input : {};
  const intOrNull = (value) => (Number.isInteger(value) ? value : null);
  return {
    destination: String(src.destination == null ? '' : src.destination).trim(),
    travelType: src.travelType == null ? 'other' : src.travelType,
    nights: intOrNull(src.nights),
    days: intOrNull(src.days),
    inclusions: cleanList(src.inclusions),
    exclusions: cleanList(src.exclusions),
    cancellationPolicy: String(src.cancellationPolicy == null ? '' : src.cancellationPolicy).trim(),
  };
}

// product: 정규화된 여행 상품, variants: 이번 글에 선택한 옵션들.
function travelRequiredAnswers(product, variants) {
  const details = product.travelDetails || normalizeTravelDetails(null);
  const picked = Array.isArray(variants) ? variants : [];
  const missing = [];
  if (!picked.length || picked.some((v) => !v.departureDate)) missing.push('departureDate');
  if (!picked.length || picked.some((v) => v.adults == null)) missing.push('travelers');
  if (!picked.length || picked.some((v) => !v.roomBasis)) missing.push('roomBasis');
  if (!details.inclusions.length) missing.push('inclusions');
  if (!details.exclusions.length) missing.push('exclusions');
  if (!details.cancellationPolicy) missing.push('cancellationPolicy');
  return missing.map((id) => ({ id, productId: product.id, question: TRAVEL_QUESTIONS[id] }));
}

module.exports = { TRAVEL_TYPES, TRAVEL_QUESTIONS, TRAVEL_DETAILS_SCHEMA, normalizeTravelDetails, travelRequiredAnswers };
