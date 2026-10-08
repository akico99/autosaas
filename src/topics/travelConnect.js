'use strict';

(function(){

const TRAVEL_DISCLOSURE = '이 포스팅은 네이버 여행 커넥트 활동의 일환으로, 예약 발생 시 수수료를 제공받습니다.';

function formatSeoulDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return fields.year + '-' + fields.month + '-' + fields.day + 'T' + fields.hour + ':' + fields.minute;
}

function parseSeoulDateTimeInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 9, Number(match[5]))).toISOString();
}

function shouldFetchRelatedLinks(connectKind) { return connectKind !== 'travel'; }

function validatePreparedHandoff(finalText, prepared) {
  const post = finalText && typeof finalText === 'object' ? finalText : null;
  const blocks = post && Array.isArray(post.blocks) ? post.blocks : [];
  const deepStrings = (value) => value == null ? [] : typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(deepStrings)
      : typeof value === 'object' ? Object.values(value).flatMap(deepStrings) : [];
  const text = post ? deepStrings(post).join('\n') : String(finalText || '');
  const links = Array.isArray(prepared && prepared.affiliateUrls)
    ? prepared.affiliateUrls.map(String).filter(Boolean)
    : [String(prepared && prepared.affiliateUrlRaw || '')].filter(Boolean);
  const disclosure = String(prepared && prepared.disclosure || '');
  const allowedUrls = new Set(Array.isArray(prepared && prepared.allowedUrls) ? prepared.allowedUrls.map(String) : links);
  if (!links.length || !disclosure) return { ok: false, reason: '검증할 여행 고지와 등록 링크가 없습니다.' };
  if (prepared && prepared.connectKind !== 'travel') return { ok: false, reason: '제휴 서비스 종류가 여행으로 확인되지 않았습니다.' };
  if (!text.includes(disclosure)) return { ok: false, reason: '최종 원고에 등록된 여행 고지 문구가 없습니다.' };
  const hrefs = blocks.filter((block) => block && block.kind === 'link').map((block) => block.href);
  const urls = text.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  const urlMatchesRaw = (candidate, raw) => candidate === raw || (candidate.startsWith(raw) && /^[.,;:!?，。；：！？、)\]}]+$/u.test(candidate.slice(raw.length)));
  if (links.some((link) => !hrefs.includes(link) && !urls.some((url) => urlMatchesRaw(url, link)))) return { ok: false, reason: '최종 원고에 등록된 제휴 링크 원문이 그대로 없습니다.' };
  if (urls.some((url) => ![...allowedUrls].some((raw) => urlMatchesRaw(url, raw)))) return { ok: false, reason: '등록된 출처·상품 주소가 아닌 URL 또는 변경된 제휴 링크가 있습니다.' };
  return { ok: true };
}

async function recheckPreparedHandoff({ api, id, expectedPost, finalPost } = {}) {
  if (!api || typeof api.connectPrepareDelivery !== 'function' || typeof id !== 'string' || !id) {
    return { ok: false, reason: '저장된 여행 원고를 다시 확인할 수 없습니다.' };
  }
  const prepared = await api.connectPrepareDelivery({ id });
  if (!prepared || !prepared.ok) {
    const reasons = [...(prepared && prepared.holdReasons || []), prepared && prepared.error].filter(Boolean);
    return { ok: false, prepared, reason: reasons.join(' / ') || '전달 직전 확인에서 보류되었습니다.' };
  }
  const result = prepared.result || {};
  if (JSON.stringify(result.post) !== JSON.stringify(expectedPost)) {
    return { ok: false, prepared, reason: '전달 준비 중 보관 원고가 수정되었습니다. 최신 원고를 다시 열어 검수해 주세요.' };
  }
  const context = prepared.draft && prepared.draft.result && prepared.draft.result.connect || result.connect;
  if (!context || context.connectKind !== 'travel') {
    return { ok: false, prepared, reason: '전달 직전 여행 제휴 정보를 다시 확인할 수 없습니다.' };
  }
  const links = Array.isArray(context.links) ? context.links : [];
  const allowedUrls = [...links.map((item) => item.affiliateUrlRaw), ...(context.productSnapshots || []).map((item) => item.detailUrl), ...(context.sources || []).map((item) => item.url)].filter(Boolean);
  const check = validatePreparedHandoff(finalPost, {
    connectKind: 'travel', disclosure: context.disclosureLine || TRAVEL_DISCLOSURE,
    affiliateUrls: links.map((item) => item.affiliateUrlRaw).filter(Boolean), allowedUrls,
  });
  if (!check.ok) return { ok: false, prepared, context, reason: check.reason };
  return { ok: true, prepared, context, check };
}

function createTravelConnectController({ api } = {}) {
  const state = { activeTab: 'travel', generationBusy: false, lastResult: null, photos: [], keywords: [], profileKey: '' };
  return {
    getState: () => state,
    setActiveTab(tab) { state.activeTab = tab; },
    async generate(request) {
      state.generationBusy = true;
      try {
        const result = await api.generateTopic({ ...request, topicId: 'travel-connect' });
        state.lastResult = result;
        return result;
      } finally { state.generationBusy = false; }
    },
  };
}

function mergeTravelVariants(existing, updated, { addVariant = false, refreshConfirmed = false } = {}) {
  const prior = Array.isArray(existing) ? existing : [];
  const replacement = Object.assign({}, updated);
  const current = prior.find((variant) => variant && variant.id === replacement.id);
  if (current && !refreshConfirmed) replacement.priceCheckedAt = current.priceCheckedAt;
  const variants = prior.filter((variant) => variant && variant.id !== replacement.id);
  if (addVariant && current) variants.push(current);
  variants.push(replacement);
  return variants;
}

function createTravelProductImportGuard() {
  let generation = 0;
  return {
    begin(url) {
      generation += 1;
      return { generation, url: String(url || '').trim() };
    },
    invalidate() { generation += 1; },
    isCurrent(request, url) {
      return !!request && request.generation === generation && request.url === String(url || '').trim();
    },
  };
}

function withTravelProductImportTimeout(operation, timeoutMs = 15000) {
  let timer;
  const pending = typeof operation === 'function' ? Promise.resolve().then(operation) : Promise.resolve(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('상품 정보를 가져오는 데 시간이 오래 걸립니다. 다시 시도해 주세요.');
      error.name = 'TimeoutError';
      reject(error);
    }, Math.max(1, Number(timeoutMs) || 15000));
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

function resolveTravelProductImportCollectedAt({ refreshTime = false, manualSource = null, sourceUrl = '', existingSource = null, fallback = null } = {}) {
  if (refreshTime) return fallback;
  if (manualSource && manualSource.url === String(sourceUrl || '').trim() && manualSource.collectedAt) return manualSource.collectedAt;
  if (existingSource && existingSource.collectedAt) return existingSource.collectedAt;
  return fallback;
}

function describeTravelProductImportEvidence(imported) {
  const labels = {
    price: '기본 성인 요금', adultPrice: '기본 성인 요금', childPrice: '기본 아동 요금', infantPrice: '기본 유아 요금',
    couponPrice: '쿠폰 적용가', discountPrice: '할인 적용가', points: '적립 포인트', fee: '수수료',
    departureDate: '출발일', duration: '여행 기간', nights: '숙박 일수', days: '여행 일수',
  };
  return (Array.isArray(imported && imported.fieldEvidence) ? imported.fieldEvidence : []).map((evidence) => {
    const field = String(evidence && evidence.field || '');
    const suffix = field.split(':').pop();
    return {
      field,
      label: labels[suffix] || suffix || '확인 정보',
      value: evidence && evidence.value != null ? evidence.value : null,
      sourceId: evidence && evidence.sourceId || null,
      excerpt: String(evidence && evidence.excerpt || ''),
    };
  });
}

function formatTravelProductImportEvidenceValue(evidence) {
  const value = evidence && evidence.value;
  if (value == null) return '';
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  const suffix = String(evidence.field || '').split(':').pop();
  const unit = {
    price: '원', adultPrice: '원', childPrice: '원', infantPrice: '원', couponPrice: '원', discountPrice: '원',
    points: 'P', fee: '%', feePercent: '%', nights: '박', days: '일',
  }[suffix] || '';
  return Number(value).toLocaleString('ko-KR') + unit;
}

function importVariantIdentity(variant) {
  return JSON.stringify([
    String(variant && variant.currency || '').toUpperCase(),
    variant && variant.departureDate || null,
    variant && variant.adults != null ? variant.adults : null,
    variant && variant.children != null ? variant.children : null,
    variant && variant.roomBasis || null,
    Array.isArray(variant && variant.options) ? variant.options : [],
  ]);
}

function buildTravelProductImportPayload({
  imported,
  selectedVariantIds,
  formValues = {},
  profileKey = '',
  existingProduct = null,
  existingSources = [],
  sourceConfirmed = false,
  checkedAt = null,
} = {}) {
  if (!imported || !imported.product || !Array.isArray(imported.sources) || !imported.sources.length) {
    throw new Error('상품 정보와 출처가 포함된 가져오기 결과가 필요합니다.');
  }
  const incomingProduct = imported.product;
  const importedDetailUrl = String(incomingProduct.detailUrl || imported.sources[0].url || '').trim();
  const existingDetailUrl = String(existingProduct && existingProduct.detailUrl || '').trim();
  const formDetailUrl = String(formValues.detailUrl || '').trim();
  if (existingProduct && existingDetailUrl && importedDetailUrl && existingDetailUrl !== importedDetailUrl) {
    throw new Error('다른 상품 URL은 새 상품으로 등록해 주세요. 기존 상품의 옵션과 제휴 링크를 보존하려면 같은 상세 URL을 사용하세요.');
  }
  if (formDetailUrl && importedDetailUrl && formDetailUrl !== importedDetailUrl) {
    throw new Error('가져온 상품 URL과 등록할 상세 URL이 다릅니다. URL을 맞춘 뒤 저장해 주세요.');
  }
  const selected = new Set((Array.isArray(selectedVariantIds) ? selectedVariantIds : []).map(String));
  const observedVariants = (Array.isArray(incomingProduct.variants) ? incomingProduct.variants : [])
    .filter((variant) => selected.has(String(variant && variant.id)));
  if (!observedVariants.length) throw new Error('저장할 옵션을 하나 이상 선택해 주세요.');
  const selectedIncomingVariantIds = new Set(observedVariants.map((variant) => String(variant.id)));
  const belongsToSelectedVariant = (field) => {
    const match = /^variant:([^:]+):/.exec(String(field || ''));
    return !match || selectedIncomingVariantIds.has(match[1]);
  };

  const usedSourceIds = new Set((Array.isArray(existingSources) ? existingSources : []).map((source) => String(source && source.id || '')));
  const sourceIdMap = new Map();
  const sources = imported.sources.map((raw) => {
    const source = JSON.parse(JSON.stringify(raw));
    const originalId = String(source.id || '');
    let id = originalId;
    const collision = (Array.isArray(existingSources) ? existingSources : []).find((item) => item && item.id === id);
    if (collision && (collision.url !== source.url || collision.collectedAt !== source.collectedAt || collision.excerpt !== source.excerpt)) {
      const suffix = String(source.collectedAt || imported.collectedAt || Date.now()).replace(/[^0-9A-Za-z]/g, '').slice(-16) || 'new';
      id = originalId + '-' + suffix;
      let attempt = 2;
      while (usedSourceIds.has(id)) id = originalId + '-' + suffix + '-' + attempt++;
    }
    source.id = id;
    usedSourceIds.add(id);
    sourceIdMap.set(originalId, id);
    return source;
  });

  const existingVariants = Array.isArray(existingProduct && existingProduct.variants) ? existingProduct.variants : [];
  const variantIdMap = new Map();
  const selectedByIdentity = new Map();
  const selectedVariants = observedVariants.map((raw) => {
    const variant = JSON.parse(JSON.stringify(raw));
    if (!variant.priceCheckedAt && imported.collectedAt) variant.priceCheckedAt = imported.collectedAt;
    const prior = existingVariants.find((item) => importVariantIdentity(item) === importVariantIdentity(variant));
    if (prior) variant.id = prior.id;
    variantIdMap.set(String(raw.id), String(variant.id));
    selectedByIdentity.set(importVariantIdentity(variant), variant);
    return variant;
  });
  const variants = existingProduct
    ? existingVariants.map((variant) => selectedByIdentity.get(importVariantIdentity(variant)) || JSON.parse(JSON.stringify(variant)))
      .concat(selectedVariants.filter((variant) => !existingVariants.some((prior) => importVariantIdentity(prior) === importVariantIdentity(variant))))
    : selectedVariants;

  const mapField = (field) => {
    const match = /^variant:([^:]+):(.*)$/.exec(String(field || ''));
    return match && variantIdMap.has(match[1]) ? 'variant:' + variantIdMap.get(match[1]) + ':' + match[2] : String(field || '');
  };
  const mapFact = (raw) => {
    const fact = JSON.parse(JSON.stringify(raw));
    fact.field = mapField(fact.field);
    if (fact.sourceId != null) fact.sourceId = sourceIdMap.get(String(fact.sourceId)) || fact.sourceId;
    if (sourceConfirmed) {
      fact.status = 'verified';
      fact.checkedAt = checkedAt || null;
      delete fact.reason;
      delete fact.verificationBasis;
    } else {
      fact.status = 'unverified';
      fact.checkedAt = null;
      delete fact.reason;
      delete fact.verificationBasis;
    }
    return fact;
  };
  const evidenceFacts = (Array.isArray(imported.fieldEvidence) ? imported.fieldEvidence : []).filter((evidence) => belongsToSelectedVariant(evidence && evidence.field)).map((evidence) => mapFact({
    field: evidence.field,
    value: evidence.value,
    sourceId: evidence.sourceId,
    excerpt: evidence.excerpt,
    status: 'unverified',
    checkedAt: null,
  }));
  const variantIds = new Set(variants.map((variant) => String(variant.id)));
  const remappedIncomingFacts = (Array.isArray(incomingProduct.facts) ? incomingProduct.facts : []).filter((fact) => belongsToSelectedVariant(fact && fact.field)).map(mapFact);
  const importFacts = remappedIncomingFacts.concat(evidenceFacts).filter((fact) => {
    const match = /^variant:([^:]+):/.exec(fact.field);
    return !match || variantIds.has(match[1]);
  });
  const existingFacts = Array.isArray(existingProduct && existingProduct.facts) ? existingProduct.facts : [];
  const replacedFields = new Set(importFacts.map((fact) => fact.field));
  const dedupedImportFacts = new Map();
  for (const fact of importFacts) dedupedImportFacts.set(JSON.stringify([fact.field, fact.sourceId, fact.value]), fact);
  const facts = existingFacts.filter((fact) => !replacedFields.has(mapField(fact.field))).concat([...dedupedImportFacts.values()]);

  const hasValue = (name) => Object.prototype.hasOwnProperty.call(formValues, name);
  const value = (name, fallback) => hasValue(name) ? formValues[name] : fallback;
  const text = (name, fallback) => String(value(name, fallback == null ? '' : fallback) || '').trim();
  const numberOrNull = (name, fallback) => {
    const raw = String(value(name, fallback == null ? '' : fallback) || '').trim();
    return raw && /^\d+$/.test(raw) ? Number(raw) : null;
  };
  const list = (name, fallback) => {
    const raw = value(name, fallback || []);
    const items = Array.isArray(raw) ? raw : String(raw || '').split('\n');
    return items.map((item) => String(item || '').trim()).filter(Boolean);
  };
  const incomingDetails = incomingProduct.travelDetails || {};
  const existingDetails = existingProduct && existingProduct.travelDetails || {};
  const name = text('name', incomingProduct.name || existingProduct && existingProduct.name);
  const detailUrl = text('detailUrl', incomingProduct.detailUrl || existingProduct && existingProduct.detailUrl);
  const affiliateUrlRaw = (existingProduct && existingProduct.affiliateUrlRaw) || incomingProduct.affiliateUrlRaw || '';
  const product = {
    ...(existingProduct ? JSON.parse(JSON.stringify(existingProduct)) : {}),
    ...JSON.parse(JSON.stringify(incomingProduct)),
    id: existingProduct && existingProduct.id || incomingProduct.id,
    connectKind: 'travel',
    name,
    provider: text('provider', incomingProduct.provider || existingProduct && existingProduct.provider),
    detailUrl,
    affiliateUrlRaw,
    profileKey: text('profileKey', profileKey || incomingProduct.profileKey || existingProduct && existingProduct.profileKey),
    eligibility: existingProduct ? existingProduct.eligibility : 'unknown',
    variants,
    facts,
    travelDetails: {
      destination: text('destination', incomingDetails.destination || existingDetails.destination),
      travelType: text('travelType', incomingDetails.travelType || existingDetails.travelType || 'package'),
      nights: numberOrNull('nights', incomingDetails.nights != null ? incomingDetails.nights : existingDetails.nights),
      days: numberOrNull('days', incomingDetails.days != null ? incomingDetails.days : existingDetails.days),
      inclusions: list('inclusions', incomingDetails.inclusions || existingDetails.inclusions),
      exclusions: list('exclusions', incomingDetails.exclusions || existingDetails.exclusions),
      cancellationPolicy: text('cancellationPolicy', incomingDetails.cancellationPolicy || existingDetails.cancellationPolicy),
    },
    shoppingDetails: null,
    images: existingProduct && Array.isArray(existingProduct.images) ? JSON.parse(JSON.stringify(existingProduct.images)) : [],
  };
  return { product, sources };
}

const api = { TRAVEL_DISCLOSURE, formatSeoulDateTimeInput, parseSeoulDateTimeInput, shouldFetchRelatedLinks, validatePreparedHandoff, recheckPreparedHandoff, createTravelConnectController, mergeTravelVariants, createTravelProductImportGuard, withTravelProductImportTimeout, resolveTravelProductImportCollectedAt, buildTravelProductImportPayload, describeTravelProductImportEvidence, formatTravelProductImportEvidenceValue };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.travelConnectUI = api;
})();
