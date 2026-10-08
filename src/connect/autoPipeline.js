'use strict';

// 발급 링크 자동 진행의 순수 계산 계층. electron·IPC·네트워크 호출을 하지 않는다.
// 호출 쪽(Task C의 IPC/main)이 해석기·수집기로 얻은 imported 결과와 현재 카탈로그를 넘기면,
// 이 모듈은 저장할 상품/출처/옵션 id만 계산해 돌려준다. 실제 카탈로그 쓰기(normalizeCatalog
// 를 통한 reviewFact 재검증)는 호출 쪽의 writeConnectCatalog 경로가 맡는다.

const crypto = require('node:crypto');
const travelConnect = require('../topics/travelConnect');

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ELIGIBILITY_LABEL = '브랜드커넥트 발급 링크';
const BRANDCONNECT_HOST = 'brandconnect.naver.com';
const BRANDCONNECT_PATH_PREFIX = '/connect/';
const PKGTOUR_HOST = 'pkgtour.naver.com';
const PKGTOUR_PATH_PREFIX = '/products/';

function trimText(value) {
  return String(value == null ? '' : value).trim();
}

function parseUrl(value) {
  try { return new URL(String(value || '')); } catch (_) { return null; }
}

function hasBrandConnectHop(chainEntry) {
  const url = parseUrl(chainEntry);
  return !!url && url.protocol === 'https:' && url.hostname.toLowerCase() === BRANDCONNECT_HOST && /^\/connect\/[^/]+/.test(url.pathname);
}

function isPkgtourProductUrl(chainEntry) {
  const url = parseUrl(chainEntry);
  return !!url && url.protocol === 'https:' && url.hostname.toLowerCase() === PKGTOUR_HOST && /^\/products\/[^/]+\/[^/]+/.test(url.pathname);
}

// chain: 해석기가 반환한 방문 주소 순서(chain[0]=최초 입력 URL). 중계(brandconnect.naver.com/connect/*)를
// 거쳐 최종 주소가 pkgtour.naver.com/products/*로 끝나야 발급 링크 경로로 인정한다.
function isBrandConnectChain(chain) {
  if (!Array.isArray(chain) || !chain.length) return false;
  const last = chain[chain.length - 1];
  if (!isPkgtourProductUrl(last)) return false;
  return chain.some(hasBrandConnectHop);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// variants: 조건 비교에 priceCheckedAt을 넣지 않는다(travelConnectUI.buildTravelProductImportPayload의
// importVariantIdentity와 동일 기준). 가격 신선도와 무관하게 "같은 옵션"을 식별하기 위함이다.
function variantIdentity(variant) {
  return JSON.stringify([
    String(variant && variant.currency || '').toUpperCase(),
    variant && variant.departureDate || null,
    variant && variant.adults != null ? variant.adults : null,
    variant && variant.children != null ? variant.children : null,
    variant && variant.roomBasis || null,
    Array.isArray(variant && variant.options) ? variant.options : [],
  ]);
}

function buildEligibilitySourceAndFact({ chain, issuedUrl, checkedAt }) {
  const hash = sha256Hex(JSON.stringify(chain)).slice(0, 12);
  const id = 'src_chain_' + hash;
  // excerpt에 라벨 문구를 함께 적어 둔다: products.js의 reviewFact는 fact.value 문자열이
  // fact.excerpt 안에 그대로 있어야 verified를 인정한다. 경로(chain)만 적으면 값 문구가
  // 없어 검토를 통과하지 못하므로, 사람이 읽을 라벨과 실제 이동 경로를 한 문자열에 담는다.
  const excerpt = ELIGIBILITY_LABEL + ': ' + chain.join(' → ');
  const source = {
    id,
    url: trimText(issuedUrl),
    accessLevel: 'full-page',
    publishedAt: null,
    collectedAt: checkedAt,
    excerpt,
  };
  const fact = {
    field: 'eligibility',
    value: ELIGIBILITY_LABEL,
    sourceId: id,
    excerpt,
    status: 'verified',
    checkedAt,
  };
  return { source, fact };
}

function fail(kind, error) {
  return { ok: false, error, kind };
}

// imported: productImport.createTravelProductImporter()가 반환하는 { product, sources, collectedAt,
//   resolution:{issuedUrl, finalUrl, chain} } 형태(resolution은 단축 링크 해석 경로, Task A 계약).
// catalog: readConnectCatalog()가 반환하는 { version, products, sources } 형태(없거나 비어도 된다).
function buildAutoImportSave({ imported, catalog, now } = {}) {
  const product = imported && imported.product;
  const sources = imported && Array.isArray(imported.sources) ? imported.sources : null;
  const collectedAt = imported && imported.collectedAt;
  if (!imported || typeof imported !== 'object' || !product || typeof product !== 'object' || product.connectKind !== 'travel'
    || !sources || !sources.length || typeof collectedAt !== 'string' || !Number.isFinite(Date.parse(collectedAt))) {
    return fail('invalid', '가져온 상품 정보가 올바르지 않습니다.');
  }

  const resolution = imported.resolution;
  const chain = resolution && Array.isArray(resolution.chain) ? resolution.chain : null;
  const issuedUrl = resolution && trimText(resolution.issuedUrl);
  if (!chain || !issuedUrl || !isBrandConnectChain(chain)
    || chain[0] !== issuedUrl || chain[chain.length - 1] !== trimText(product.detailUrl)
    || trimText(resolution.finalUrl) !== trimText(product.detailUrl)) {
    return fail('not_issued_link', '브랜드커넥트에서 발급한 링크를 넣어 주세요.');
  }

  const krwVariants = (Array.isArray(product.variants) ? product.variants : [])
    .filter((variant) => variant && String(variant.currency || '').toUpperCase() === 'KRW');
  if (!krwVariants.length) {
    return fail('no_price', '원화 판매가를 확인하지 못해 자동 진행할 수 없습니다.');
  }
  const selectedVariantIds = krwVariants.map((variant) => String(variant.id));

  const catalogProducts = Array.isArray(catalog && catalog.products) ? catalog.products : [];
  const catalogSources = Array.isArray(catalog && catalog.sources) ? catalog.sources : [];
  const importedDetailUrl = trimText(product.detailUrl);
  const existingProduct = catalogProducts.find((item) => item && trimText(item.detailUrl) === importedDetailUrl) || null;

  let built;
  try {
    built = travelConnect.buildTravelProductImportPayload({
      imported: { ...imported, product: { ...product, affiliateUrlRaw: issuedUrl } },
      selectedVariantIds,
      formValues: {},
      profileKey: (existingProduct && existingProduct.profileKey) || product.profileKey || '',
      existingProduct,
      existingSources: catalogSources,
      sourceConfirmed: true,
      checkedAt: collectedAt,
    });
  } catch (error) {
    return fail('invalid', error && error.message ? error.message : '상품 정보를 저장할 수 없습니다.');
  }

  const { source: eligibilitySource, fact: eligibilityFact } = buildEligibilitySourceAndFact({
    chain, issuedUrl, checkedAt: collectedAt,
  });

  const savedProduct = {
    ...built.product,
    eligibility: 'verified',
    facts: (Array.isArray(built.product.facts) ? built.product.facts : [])
      .filter((fact) => !fact || fact.field !== 'eligibility')
      .concat([eligibilityFact]),
  };
  const savedSources = (Array.isArray(built.sources) ? built.sources : []).concat([eligibilitySource]);

  // 선택한 옵션의 최종 id는 기존 옵션과 조건이 같으면 재사용되므로(travelConnectUI 내부 규칙과 동일),
  // 반환 전에 krwVariants의 조건으로 저장된 상품에서 실제 id를 다시 찾는다.
  const selectedIdentities = new Set(krwVariants.map(variantIdentity));
  const variantIds = (Array.isArray(savedProduct.variants) ? savedProduct.variants : [])
    .filter((variant) => selectedIdentities.has(variantIdentity(variant)))
    .map((variant) => String(variant.id));

  return { ok: true, product: savedProduct, sources: savedSources, variantIds };
}

// product: 저장된(또는 저장하려는) 상품. travelDetails.destination을 방문 도시로 쓰고,
// facts에 field:'departureCity' 사실이 있으면 출발 도시로 더한다(검토 여부는 보지 않는다 —
// 씨앗은 검색 제안일 뿐이고 실제 생성 글은 travelCostGate가 다시 검증한다).
function deriveSeedKeywords(product) {
  const destination = trimText(product && product.travelDetails && product.travelDetails.destination);
  if (!destination) return [];
  const facts = Array.isArray(product && product.facts) ? product.facts : [];
  const departureFact = facts.find((fact) => fact && fact.field === 'departureCity' && trimText(fact.value));
  const departureCity = departureFact ? trimText(departureFact.value) : trimText(product && product.travelDetails && product.travelDetails.departureCity);
  const seeds = [destination + ' 여행', destination + ' 패키지'];
  if (departureCity) seeds.push(departureCity + '출발 ' + destination);
  const deduped = [];
  const seen = new Set();
  for (const seed of seeds) {
    if (seen.has(seed)) continue;
    seen.add(seed);
    deduped.push(seed);
    if (deduped.length >= 3) break;
  }
  return deduped;
}

function toEpochMs(value) {
  if (typeof value === 'function') return toEpochMs(value());
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

// 선택된 옵션(variantIds) 중 하나라도 priceCheckedAt이 없거나, now 기준 maxAgeMs(기본 6시간)
// 이상 지났으면 true. travelCostGate의 24시간 보류 한도보다 더 일찍(여유 있게) 재수집을 유도한다.
function needsPriceRefresh(product, variantIds, now, maxAgeMs = SIX_HOURS_MS) {
  const ids = new Set((Array.isArray(variantIds) ? variantIds : []).map(String));
  const variants = (Array.isArray(product && product.variants) ? product.variants : [])
    .filter((variant) => variant && ids.has(String(variant.id)));
  if (!variants.length || variants.length !== ids.size) return true;
  const nowMs = toEpochMs(now);
  if (!Number.isFinite(nowMs)) return true;
  return variants.some((variant) => {
    const checkedMs = Date.parse(variant.priceCheckedAt);
    return !Number.isFinite(checkedMs) || checkedMs > nowMs || nowMs - checkedMs >= maxAgeMs;
  });
}

module.exports = {
  isBrandConnectChain,
  buildAutoImportSave,
  deriveSeedKeywords,
  needsPriceRefresh,
};
