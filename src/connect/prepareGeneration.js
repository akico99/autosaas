'use strict';

const { needsPriceRefresh } = require('./autoPipeline');

// Repair older/manual registrations from their stored issued link before writing.
// Never manufacture evidence or change the user's selected options.
async function prepareTravelGeneration({ catalog, productIds, variantIds, refreshProduct, readCatalog, now = Date.now() }) {
  const ids = [...new Set(productIds || [])];
  const selected = catalog.products.filter((product) => ids.includes(product.id));
  if (!ids.length || selected.length !== ids.length || selected.some((product) => product.connectKind !== 'travel')) {
    return { ok: false, error: '원고에 사용할 여행 상품을 선택해 주세요.' };
  }
  if (!variantIds.length || variantIds.some((id) => !selected.some((product) => product.variants.some((variant) => variant.id === id)))) {
    return { ok: false, error: '원고에 사용할 상품 옵션을 선택해 주세요.' };
  }
  let refreshed = false;
  for (const product of selected) {
    if (product.eligibility === 'excluded') return { ok: false, error: '제외한 상품은 원고에 사용할 수 없습니다. 상품 설정을 확인해 주세요.' };
    const chosen = product.variants.filter((variant) => variantIds.includes(variant.id));
    const pricesVerified = chosen.every((variant) => product.facts.some((fact) => fact.field === 'variant:' + variant.id + ':price' && fact.status === 'verified' && fact.value === variant.amountMinor));
    const mustRefresh = product.eligibility !== 'verified' || !pricesVerified || needsPriceRefresh(product, chosen.map((variant) => variant.id), now);
    if (!mustRefresh) continue;
    let issued;
    try { issued = new URL(product.affiliateUrlRaw); } catch (_) {}
    if (!issued || issued.protocol !== 'https:' || issued.hostname !== 'naver.me') {
      return { ok: false, error: '발급 링크를 확인해야 합니다. 위의 상품 링크 입력란에 브랜드커넥트 발급 링크를 넣어 주세요.' };
    }
    let result;
    try { result = await refreshProduct({ productId: product.id }); }
    catch (error) { return { ok: false, error: '발급 링크와 가격을 다시 확인하지 못했습니다: ' + error.message }; }
    if (!result || !result.ok) return { ok: false, error: '발급 링크와 가격을 다시 확인하지 못했습니다. ' + (result && result.error || '잠시 후 원고 만들기를 다시 눌러 주세요.') };
    if (!result.product || result.product.id !== product.id || !Array.isArray(result.variantIds) || chosen.some((variant) => !result.variantIds.includes(variant.id))) {
      return { ok: false, error: '선택한 옵션이 상품 페이지에서 변경됐습니다. 상품 옵션을 확인해 주세요.' };
    }
    refreshed = true;
  }
  return { ok: true, catalog: refreshed ? readCatalog() : catalog, refreshed };
}

module.exports = { prepareTravelGeneration };
