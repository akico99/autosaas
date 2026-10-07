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

const api = { TRAVEL_DISCLOSURE, formatSeoulDateTimeInput, parseSeoulDateTimeInput, shouldFetchRelatedLinks, validatePreparedHandoff, recheckPreparedHandoff, createTravelConnectController, mergeTravelVariants };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.travelConnectUI = api;
})();
