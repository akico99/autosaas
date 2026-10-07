'use strict';

const crypto = require('node:crypto');
const fsDefault = require('node:fs');
const pathDefault = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { POLICY_VERSION, CONNECT_KINDS, isConnectKind, getConnectDisclosure, validateAffiliateUrl } = require('./policy');
const { TRAVEL_DETAILS_SCHEMA, normalizeTravelDetails, travelRequiredAnswers } = require('./travel');

const ACCESS_LEVELS = ['full-page', 'search-snippet', 'user-excerpt'];
const FACT_STATUSES = ['verified', 'unverified', 'conflict', 'missing'];
const ELIGIBILITIES = ['verified', 'unknown', 'excluded'];
const AFFILIATE_STATUSES = ['issued', 'not-issued'];

const str = { type: 'string' };
const nullableStr = { type: ['string', 'null'] };
const SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'url', 'accessLevel', 'publishedAt', 'collectedAt', 'excerpt'],
  properties: {
    id: { type: 'string', minLength: 1 }, url: str, accessLevel: { enum: ACCESS_LEVELS },
    publishedAt: { type: ['string', 'null'], format: 'date-time' }, collectedAt: { type: 'string', format: 'date-time' }, excerpt: str,
  },
};
const FACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['field', 'value', 'sourceId', 'excerpt', 'status', 'checkedAt'],
  properties: {
    field: { type: 'string', minLength: 1 },
    value: { type: ['string', 'number', 'boolean', 'null'] },
    sourceId: nullableStr, excerpt: str, status: { enum: FACT_STATUSES },
    checkedAt: { type: ['string', 'null'], format: 'date-time' },
    reason: str,
    verificationBasis: { enum: ['full-page', 'user-excerpt'] },
  },
};
const VARIANT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'currency', 'amountMinor', 'priceCheckedAt', 'options', 'departureDate', 'adults', 'children', 'roomBasis'],
  properties: {
    id: { type: 'string', minLength: 1 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    amountMinor: { type: 'integer', minimum: 0 },
    priceCheckedAt: { type: 'string', format: 'date-time' },
    options: { type: 'array', items: { type: 'string' } },
    departureDate: { type: ['string', 'null'], format: 'date' },
    adults: { type: ['integer', 'null'], minimum: 0 },
    children: { type: ['integer', 'null'], minimum: 0 },
    roomBasis: nullableStr,
  },
};
const PRODUCT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'connectKind', 'name', 'provider', 'detailUrl', 'affiliateUrlRaw', 'affiliateStatus', 'profileKey', 'eligibility', 'variants', 'facts', 'travelDetails', 'shoppingDetails', 'images'],
  properties: {
    id: { type: 'string', minLength: 1 }, connectKind: { enum: CONNECT_KINDS },
    name: { type: 'string', minLength: 1 }, provider: str, detailUrl: str,
    affiliateUrlRaw: str, affiliateStatus: { enum: AFFILIATE_STATUSES }, profileKey: str,
    eligibility: { enum: ELIGIBILITIES },
    variants: { type: 'array', items: VARIANT_SCHEMA },
    facts: { type: 'array', items: FACT_SCHEMA },
    travelDetails: { anyOf: [{ type: 'null' }, TRAVEL_DETAILS_SCHEMA] },
    // 쇼핑 상세 스키마는 첫 구현 범위 밖이다. 종류 분리만 고정한다.
    shoppingDetails: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { category: str } }] },
    images: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['url', 'sourceId'], properties: { url: str, sourceId: nullableStr } },
    },
  },
};
const CATALOG_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'products', 'sources'],
  properties: {
    version: { const: 1 },
    products: { type: 'array', items: PRODUCT_SCHEMA },
    sources: { type: 'array', items: SOURCE_SCHEMA },
  },
};

const ajv = addFormats(new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }));
const validateSourceSchema = ajv.compile(SOURCE_SCHEMA);
const validateProductSchema = ajv.compile(PRODUCT_SCHEMA);
const validateCatalogSchema = ajv.compile(CATALOG_SCHEMA);

function schemaError(label, validate) {
  return new Error(label + ': ' + ajv.errorsText(validate.errors, { dataVar: label }));
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const trimText = (value) => String(value == null ? '' : value).trim();
const compact = (text) => String(text == null ? '' : text).replace(/[\s,]/g, '');
// 숫자는 토큰 경계로만 비교한다. "129,000"은 129000 하나로 읽고 1290·12900의 근거가 되지 않는다.
const NUMBER_TOKEN = /(?<![\d.,])\d+(?:,\d{3})*(?:\.\d+)?(?![\d])/g;
const numberTokens = (text) => (String(text == null ? '' : text).match(NUMBER_TOKEN) || []).map((t) => t.replace(/,/g, ''));
const isNumericValue = (value) => typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()));
const PRICE_FIELD = /^variant:(.+):price$/;
const VARIANT_FIELD = /^variant:(.+):[^:]+$/;

function normalizeSources(sources) {
  const seen = new Map();
  for (const raw of Array.isArray(sources) ? sources : []) {
    const source = normalizeConnectSource(raw);
    if (seen.has(source.id)) throw new Error('source id 중복: ' + source.id);
    seen.set(source.id, source);
  }
  return [...seen.values()];
}

function assertUniqueProducts(products) {
  const ids = new Set();
  const variantIds = new Set();
  for (const product of products) {
    if (ids.has(product.id)) throw new Error('product id 중복: ' + product.id);
    ids.add(product.id);
    for (const v of product.variants) {
      if (variantIds.has(v.id)) throw new Error('상품 사이에 variant id 중복: ' + v.id);
      variantIds.add(v.id);
    }
  }
}

function normalizeConnectSource(input) {
  const source = {
    id: trimText(input && input.id),
    url: trimText(input && input.url),
    accessLevel: input && input.accessLevel,
    publishedAt: input && input.publishedAt != null ? input.publishedAt : null,
    collectedAt: input && input.collectedAt,
    excerpt: trimText(input && input.excerpt),
  };
  if (!validateSourceSchema(source)) throw schemaError('source', validateSourceSchema);
  if (!validateAffiliateUrl(source.url).valid) throw new Error('source.url이 올바른 http(s) URL이 아닙니다.');
  return source;
}

// verified는 검토된 full-page/user-excerpt 출처 발췌가 있고 값·검토일이 맞을 때만 유지한다.
// search-snippet 출처, 변형 가격과 다른 금액, 숫자 부분 문자열 일치는 verified가 될 수 없다.
function reviewFact(input, sourcesById, variantsById) {
  const fact = {
    field: trimText(input && input.field),
    value: input && input.value !== undefined ? input.value : null,
    sourceId: input && input.sourceId != null ? input.sourceId : null,
    excerpt: trimText(input && input.excerpt),
    status: FACT_STATUSES.includes(input && input.status) ? input.status : 'unverified',
    checkedAt: input && input.checkedAt != null ? input.checkedAt : null,
  };
  if (!fact.field) throw new Error('fact.field가 필요합니다.');
  if (fact.status === 'verified') {
    const source = fact.sourceId != null ? sourcesById.get(fact.sourceId) : undefined;
    const price = PRICE_FIELD.exec(fact.field);
    let reason = '';
    if (!source) reason = 'source-not-found';
    else if (source.accessLevel === 'search-snippet') reason = 'snippet-not-verifiable';
    else if (!fact.excerpt) reason = 'missing-excerpt';
    else if (!compact(source.excerpt).includes(compact(fact.excerpt))) reason = 'excerpt-not-in-source';
    else if (!fact.checkedAt) reason = 'missing-checked-at';
    else if (fact.value == null) reason = 'value-not-in-excerpt';
    else if (isNumericValue(fact.value) ? !numberTokens(fact.excerpt).includes(String(fact.value).trim()) : !compact(fact.excerpt).includes(compact(fact.value))) reason = 'value-not-in-excerpt';
    else if (price) {
      const variant = variantsById.get(price[1]);
      if (!variant) reason = 'variant-not-found';
      else if (!Number.isInteger(fact.value) || fact.value !== variant.amountMinor) reason = 'price-mismatch';
    }
    if (reason) {
      fact.status = 'unverified';
      fact.reason = reason;
    } else {
      fact.verificationBasis = source.accessLevel;
    }
  } else if (input && typeof input.reason === 'string' && input.reason) {
    fact.reason = input.reason;
  }
  return fact;
}

// 같은 필드에 서로 다른 검토 값이 있거나 conflict 표시가 있으면 verified를 모두 인정하지 않는다.
function resolveFactConflicts(facts) {
  const byField = new Map();
  for (const f of facts) {
    if (!byField.has(f.field)) byField.set(f.field, []);
    byField.get(f.field).push(f);
  }
  for (const list of byField.values()) {
    const verified = list.filter((f) => f.status === 'verified');
    if (!verified.length) continue;
    const distinct = new Set(verified.map((f) => stableStringify(f.value)));
    if (distinct.size > 1 || list.some((f) => f.status === 'conflict')) {
      for (const f of verified) {
        f.status = 'conflict';
        f.reason = 'conflicting-reviewed-values';
        delete f.verificationBasis;
      }
    }
  }
  return facts;
}

function variantIdentity(v) {
  return stableStringify([v.currency, v.departureDate, v.adults, v.children, v.roomBasis, v.options]);
}

function normalizeVariants(list, productId) {
  const seen = new Map();
  const ids = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const v = {
      id: trimText(raw && raw.id),
      currency: trimText(raw && raw.currency).toUpperCase(),
      amountMinor: raw && raw.amountMinor,
      priceCheckedAt: raw && raw.priceCheckedAt,
      options: (raw && Array.isArray(raw.options) ? raw.options : []).map(trimText).filter(Boolean),
      departureDate: raw && raw.departureDate != null && raw.departureDate !== '' ? trimText(raw.departureDate) : null,
      adults: raw && raw.adults != null ? raw.adults : null,
      children: raw && raw.children != null ? raw.children : null,
      roomBasis: raw && raw.roomBasis != null && trimText(raw.roomBasis) !== '' ? trimText(raw.roomBasis) : null,
    };
    const identity = variantIdentity(v);
    if (!v.id) v.id = 'v_' + sha256(productId + identity).slice(0, 12);
    if (ids.has(v.id)) throw new Error('variant id 중복: ' + v.id);
    const prior = seen.get(identity);
    if (prior) {
      if (prior.amountMinor !== v.amountMinor) throw new Error('같은 variant 조건에 서로 다른 가격이 있습니다: ' + v.id);
      throw new Error('같은 variant 조건이 중복되었습니다: ' + v.id);
    }
    ids.add(v.id);
    seen.set(identity, v);
    out.push(v);
  }
  return out;
}

function normalizeConnectProduct(input, { sources = [], now = () => new Date() } = {}) {
  void now;
  if (!input || typeof input !== 'object') throw new Error('상품 입력이 올바르지 않습니다.');
  if (!isConnectKind(input.connectKind)) throw new Error('알 수 없는 connectKind: ' + String(input.connectKind));
  const connectKind = input.connectKind;
  const sourcesById = new Map(normalizeSources(sources).map((s) => [s.id, s]));
  const detail = validateAffiliateUrl(input.detailUrl);
  if (!detail.valid) throw new Error('detailUrl이 올바른 http(s) URL이 아닙니다: ' + detail.reason);
  const detailUrl = detail.raw;

  const given = input.affiliateUrlRaw != null ? input.affiliateUrlRaw : input.affiliateUrl;
  let affiliateUrlRaw = '';
  let affiliateStatus = 'not-issued';
  if (given != null && trimText(given) !== '') {
    const checked = validateAffiliateUrl(given);
    // 상세 URL과 같은 값은 발급 링크가 아니다.
    if (checked.valid && checked.raw !== detailUrl) {
      affiliateUrlRaw = checked.raw;
      affiliateStatus = 'issued';
    }
  }

  if (connectKind === 'travel' && input.shoppingDetails != null) throw new Error('여행 상품에 shoppingDetails를 넣을 수 없습니다.');
  if (connectKind === 'shopping' && input.travelDetails != null) throw new Error('쇼핑 상품에 travelDetails를 넣을 수 없습니다.');

  const id = trimText(input.id) || 'cp_' + sha256(connectKind + '\n' + detailUrl).slice(0, 12);
  const variants = normalizeVariants(input.variants, id);
  const variantsById = new Map(variants.map((v) => [v.id, v]));
  const facts = resolveFactConflicts((Array.isArray(input.facts) ? input.facts : []).map((fact) => reviewFact(fact, sourcesById, variantsById)));
  const eligibilityInput = ELIGIBILITIES.includes(input.eligibility) ? input.eligibility : 'unknown';
  const eligibilityReviewed = facts.some((f) => f.field === 'eligibility' && f.status === 'verified');
  const eligibility = eligibilityInput === 'verified' && !eligibilityReviewed ? 'unknown' : eligibilityInput;

  const product = {
    id,
    connectKind,
    name: trimText(input.name),
    provider: trimText(input.provider),
    detailUrl,
    affiliateUrlRaw,
    affiliateStatus,
    profileKey: trimText(input.profileKey),
    eligibility,
    variants,
    facts,
    travelDetails: connectKind === 'travel' ? normalizeTravelDetails(input.travelDetails) : null,
    shoppingDetails: connectKind === 'shopping' && input.shoppingDetails ? clone(input.shoppingDetails) : null,
    images: (Array.isArray(input.images) ? input.images : []).map((img) => ({
      url: trimText(img && img.url), sourceId: img && img.sourceId != null ? img.sourceId : null,
    })),
  };
  for (const img of product.images) if (!validateAffiliateUrl(img.url).valid) throw new Error('images.url이 올바른 http(s) URL이 아닙니다.');
  if (!validateProductSchema(product)) throw schemaError('product', validateProductSchema);
  return product;
}

function verifiedPriceFieldFor(variantId) {
  return 'variant:' + variantId + ':price';
}

function buildConnectContext({ products: rawProducts, variantIds = [], sources: rawSources = [], experience = '', policyVersion, now = () => new Date() } = {}) {
  void now;
  if (!Array.isArray(rawProducts) || !rawProducts.length) throw new Error('상품이 하나 이상 필요합니다.');
  // 호출자가 넘긴 상품·출처도 신뢰하지 않고 다시 검증한다. 링크 원문은 그대로 보존된다.
  const sources = normalizeSources(rawSources);
  const products = rawProducts.map((p) => normalizeConnectProduct(p, { sources }));
  assertUniqueProducts(products);
  const kinds = new Set(products.map((p) => p.connectKind));
  if (kinds.size !== 1) throw new Error('서로 다른 connectKind 상품을 한 글에 섞을 수 없습니다.');
  const connectKind = products[0].connectKind;
  const disclosureLine = getConnectDisclosure(connectKind);
  const wanted = Array.isArray(variantIds) ? variantIds : [];
  const known = new Set(products.flatMap((p) => p.variants.map((v) => v.id)));
  for (const vid of wanted) if (!known.has(vid)) throw new Error('알 수 없는 variant id: ' + vid);

  const sourcesById = new Map(sources.map((s) => [s.id, s]));
  const productSnapshots = [];
  const verifiedFacts = [];
  const verifiedNames = [];
  const uncertain = [];
  const requiredAnswers = [];
  const links = [];
  const usedSources = new Set();

  for (const product of products) {
    const picked = product.variants.filter((v) => wanted.includes(v.id));
    productSnapshots.push(clone({ ...product, variants: picked }));
    const scoped = (field) => product.id + '.' + field;
    if (!picked.length) uncertain.push(scoped('variant'));
    if (product.affiliateStatus === 'issued') {
      links.push({ productId: product.id, detailUrl: product.detailUrl, affiliateUrlRaw: product.affiliateUrlRaw });
    } else {
      uncertain.push(scoped('affiliateUrl'));
    }
    if (product.eligibility !== 'verified') uncertain.push(scoped('eligibility'));
    const pickedIds = new Set(picked.map((v) => v.id));
    const inScope = (field) => {
      const m = VARIANT_FIELD.exec(field);
      return !m || pickedIds.has(m[1]);
    };
    for (const fact of product.facts.filter((f) => inScope(f.field))) {
      if (fact.status === 'verified') {
        verifiedFacts.push({ productId: product.id, ...clone(fact) });
        verifiedNames.push(product.name);
        if (fact.sourceId) usedSources.add(fact.sourceId);
      } else {
        uncertain.push(scoped(fact.field));
      }
    }
    for (const v of picked) {
      const field = verifiedPriceFieldFor(v.id);
      if (!product.facts.some((f) => f.field === field && f.status === 'verified')) uncertain.push(scoped(field));
    }
    if (connectKind === 'travel') requiredAnswers.push(...travelRequiredAnswers(product, picked));
  }

  const uncertainFields = [...new Set(uncertain)];
  const snapshotHash = sha256(stableStringify({ connectKind, productSnapshots, policyVersion: policyVersion || POLICY_VERSION }));
  const ctxSources = [...usedSources].map((sid) => sourcesById.get(sid)).filter(Boolean).map(clone);
  const experienceText = trimText(experience);

  const lines = [
    '[제휴 연결 정보]',
    '서비스 종류: ' + connectKind,
    '필수 고지문(그대로 포함): ' + disclosureLine,
  ];
  for (const snap of productSnapshots) {
    lines.push('상품: ' + snap.name + (snap.provider ? ' (' + snap.provider + ')' : '') + ' [' + snap.id + ']');
    for (const v of snap.variants) {
      lines.push('  옵션 ' + v.id + ': ' + [v.departureDate, v.adults != null ? '성인 ' + v.adults : '', v.roomBasis, v.amountMinor + ' ' + v.currency + ' minor'].filter(Boolean).join(' / '));
    }
  }
  if (verifiedFacts.length) {
    lines.push('검토된 사실:');
    verifiedFacts.forEach((f, i) => lines.push('  - ' + verifiedNames[i] + ' ' + f.field + ': ' + f.value + ' (출처 ' + f.sourceId + ')'));
  }
  if (uncertainFields.length) lines.push('확인되지 않은 항목(단정하지 말 것): ' + uncertainFields.join(', '));
  if (requiredAnswers.length) lines.push('답이 필요한 질문: ' + requiredAnswers.map((a) => a.question).join(' / '));
  if (links.length) {
    lines.push('발급 링크(원문 그대로 사용, 수정 금지):');
    for (const l of links) lines.push('  - ' + l.affiliateUrlRaw);
  }
  if (experienceText) lines.push('작성자 경험: ' + experienceText);

  return {
    connectKind,
    productIds: products.map((p) => p.id),
    variantIds: [...wanted],
    productSnapshots,
    snapshotHash,
    sources: ctxSources,
    verifiedFacts,
    uncertainFields,
    requiredAnswers,
    experience: experienceText,
    disclosureLine,
    links,
    policyVersion: policyVersion || POLICY_VERSION,
    promptBlock: lines.join('\n'),
  };
}

const emptyCatalog = () => ({ version: 1, products: [], sources: [] });

// 스키마 검증 뒤 출처·링크·검토 상태를 다시 계산한다. 버전과 링크 원문은 그대로 유지된다.
function normalizeCatalog(value) {
  const candidate = { version: value && value.version, products: value && value.products, sources: value && value.sources };
  if (!validateCatalogSchema(candidate)) throw schemaError('catalog', validateCatalogSchema);
  const sources = normalizeSources(candidate.sources);
  const products = candidate.products.map((p) => normalizeConnectProduct(p, { sources }));
  assertUniqueProducts(products);
  return { version: 1, products, sources };
}

function readConnectCatalog(file, { fs = fsDefault } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyCatalog();
    throw new Error('catalog를 읽을 수 없습니다: ' + error.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('catalog 파일이 손상되었습니다: ' + error.message);
  }
  return normalizeCatalog(parsed);
}

function writeConnectCatalog(file, value, { fs = fsDefault, path = pathDefault } = {}) {
  // 기존 파일이 손상되어 있으면 읽기에서 던져 덮어쓰지 않는다.
  readConnectCatalog(file, { fs });
  const normalized = normalizeCatalog(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    throw error;
  }
}

module.exports = {
  ACCESS_LEVELS, FACT_STATUSES, ELIGIBILITIES,
  normalizeConnectSource, normalizeConnectProduct, buildConnectContext, readConnectCatalog, writeConnectCatalog,
  verifiedPriceFieldFor,
};