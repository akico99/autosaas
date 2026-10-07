'use strict';

const {
  normalizeConnectProduct,
  readConnectCatalog,
  writeConnectCatalog,
} = require('./products');
const { matchConnectKeywords } = require('./keywords');

const hasOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.includes(key));
const isText = (value, max = 4000) => typeof value === 'string' && value.length <= max;
const isId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function validateConnectRequest(channel, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '요청 형식이 올바르지 않습니다.' };
  const schemas = {
    'connect:catalog': [],
    'connect:saveProduct': ['product', 'sources'],
    'connect:prepareKeywords': ['seed', 'productIds', 'questions', 'importXlsx'],
    'connect:prepareDelivery': ['id'],
  };
  const allowed = schemas[channel];
  if (!allowed || !hasOnly(input, allowed)) return { ok: false, error: '허용되지 않은 요청 필드가 있습니다.' };
  if (channel === 'connect:catalog') return { ok: true };
  if (channel === 'connect:saveProduct') {
    const productKeys = ['id', 'connectKind', 'name', 'provider', 'detailUrl', 'affiliateUrlRaw', 'profileKey', 'eligibility', 'variants', 'facts', 'travelDetails', 'shoppingDetails', 'images'];
    if (!hasOnly(input.product, productKeys)) return { ok: false, error: '상품 입력에 허용되지 않은 필드가 있습니다.' };
    const product = input.product;
    if (product.variants !== undefined && (!Array.isArray(product.variants) || product.variants.some((variant) => !hasOnly(variant, ['id', 'currency', 'amountMinor', 'priceCheckedAt', 'options', 'departureDate', 'adults', 'children', 'roomBasis'])))) return { ok: false, error: '옵션 입력에 허용되지 않은 필드가 있습니다.' };
    if (product.facts !== undefined && (!Array.isArray(product.facts) || product.facts.some((fact) => !hasOnly(fact, ['field', 'value', 'sourceId', 'excerpt', 'status', 'checkedAt', 'reason'])))) return { ok: false, error: '사실 근거 입력에 허용되지 않은 필드가 있습니다.' };
    if (product.images !== undefined && (!Array.isArray(product.images) || product.images.some((image) => !hasOnly(image, ['url', 'sourceId'])))) return { ok: false, error: '이미지 입력에 허용되지 않은 필드가 있습니다.' };
    if (product.travelDetails !== undefined && product.travelDetails !== null && !hasOnly(product.travelDetails, ['destination', 'travelType', 'nights', 'days', 'inclusions', 'exclusions', 'cancellationPolicy'])) return { ok: false, error: '여행 상세 입력에 허용되지 않은 필드가 있습니다.' };
    if (product.shoppingDetails !== undefined && product.shoppingDetails !== null && !hasOnly(product.shoppingDetails, ['category'])) return { ok: false, error: '쇼핑 상세 입력에 허용되지 않은 필드가 있습니다.' };
    if (!Array.isArray(input.sources) || input.sources.length > 100) return { ok: false, error: '출처 목록이 올바르지 않습니다.' };
    const sourceKeys = ['id', 'url', 'accessLevel', 'publishedAt', 'collectedAt', 'excerpt'];
    if (input.sources.some((source) => !hasOnly(source, sourceKeys))) return { ok: false, error: '출처 입력에 허용되지 않은 필드가 있습니다.' };
    if (new Set(input.sources.map((source) => source.id)).size !== input.sources.length) return { ok: false, error: 'source id가 중복되었습니다.' };
    return { ok: true };
  }
  if (channel === 'connect:prepareKeywords') {
    if (!isText(input.seed, 160) || !input.seed.trim()) return { ok: false, error: '씨앗 키워드를 입력해 주세요.' };
    if (!Array.isArray(input.productIds) || input.productIds.length > 20 || input.productIds.some((id) => !isId(id)) || new Set(input.productIds).size !== input.productIds.length) return { ok: false, error: '상품 선택이 올바르지 않습니다.' };
    if (input.importXlsx !== undefined && typeof input.importXlsx !== 'boolean') return { ok: false, error: '엑셀 가져오기 옵션이 올바르지 않습니다.' };
    if (input.questions !== undefined && (!Array.isArray(input.questions) || input.questions.length > 100
      || input.questions.some((question) => !hasOnly(question, ['keyword', 'question', 'sourceIds'])
        || !isText(question.keyword, 160) || !question.keyword.trim()
        || !isText(question.question, 1200) || !question.question.trim()
        || !Array.isArray(question.sourceIds) || question.sourceIds.some((id) => !isId(id))))) {
      return { ok: false, error: '질문 입력이 올바르지 않습니다.' };
    }
    return { ok: true };
  }
  if (!isId(input.id)) return { ok: false, error: '저장된 원고 id가 올바르지 않습니다.' };
  return { ok: true };
}

function buildTravelImportRequest(request) {
  const result = {
    topicId: 'travel-connect',
    profileKey: request.profileKey,
    keyword: request.keyword,
    productIds: Array.isArray(request.productIds) ? request.productIds.slice() : [],
    variantIds: Array.isArray(request.variantIds) ? request.variantIds.slice() : [],
  };
  if (request.experience !== undefined) result.experience = request.experience;
  if (request.travelTopic !== undefined) result.travelTopic = request.travelTopic;
  return result;
}

function createConnectIpcHandlers({ ipcMain, isTrustedSender, service }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('ipcMain.handle가 필요합니다.');
  if (typeof isTrustedSender !== 'function' || !service) throw new Error('IPC 연결 설정이 필요합니다.');
  const methods = {
    'connect:catalog': 'catalog',
    'connect:saveProduct': 'saveProduct',
    'connect:prepareKeywords': 'prepareKeywords',
    'connect:prepareDelivery': 'prepareDelivery',
  };
  for (const [channel, method] of Object.entries(methods)) {
    ipcMain.handle(channel, (event, input = {}) => dispatchConnectIpc(channel, event, input, { isTrustedSender, service }));
  }
}

async function dispatchConnectIpc(channel, event, input, { isTrustedSender, service }) {
  if (!isTrustedSender(event)) return { ok: false, error: '허용되지 않은 IPC 발신자입니다.' };
  const checked = validateConnectRequest(channel, input);
  if (!checked.ok) return checked;
  const method = { 'connect:catalog': 'catalog', 'connect:saveProduct': 'saveProduct', 'connect:prepareKeywords': 'prepareKeywords', 'connect:prepareDelivery': 'prepareDelivery' }[channel];
  try {
    if (!method || typeof service[method] !== 'function') throw new Error('기능을 사용할 수 없습니다.');
    return await service[method](input);
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : '여행 연결 요청을 처리하지 못했습니다.' };
  }
}

function createConnectService({
  catalogFile,
  readCatalog = (file) => readConnectCatalog(file),
  writeCatalog = (file, value) => writeConnectCatalog(file, value),
  selectWorkbook = async () => null,
  readWorkbook,
  autocomplete = async () => [],
  observe = async () => [],
  prepareDelivery = async () => ({ ok: false, error: '에디터 준비를 사용할 수 없습니다.' }),
  now = () => new Date(),
} = {}) {
  if (!catalogFile) throw new Error('카탈로그 저장 위치가 필요합니다.');
  const catalog = () => readCatalog(catalogFile);
  return {
    catalog() { return { ok: true, ...catalog() }; },
    saveProduct({ product: input, sources: newSources }) {
      const current = catalog();
      const sourceMap = new Map(current.sources.map((source) => [source.id, source]));
      for (const source of newSources) sourceMap.set(source.id, source);
      const sources = [...sourceMap.values()];
      const product = normalizeConnectProduct(input, { sources, now });
      const products = current.products.filter((item) => item.id !== product.id).concat(product);
      writeCatalog(catalogFile, { version: 1, products, sources });
      return { ok: true, product, products, sources };
    },
    async prepareKeywords(input) {
      const current = catalog();
      const wanted = new Set(input.productIds);
      const products = current.products.filter((product) => wanted.has(product.id) && product.connectKind === 'travel' && product.travelDetails);
      if (!products.length) throw new Error('여행 상품을 하나 이상 선택해 주세요.');
      if (products.length !== wanted.size) throw new Error('등록되지 않았거나 여행 상품이 아닌 선택 항목이 있습니다.');
      const knownSourceIds = new Set(current.sources.map((source) => source.id));
      for (const question of input.questions || []) {
        if (question.sourceIds.some((id) => !knownSourceIds.has(id))) throw new Error('질문이 참조하는 출처를 찾지 못했습니다.');
      }
      let adsRows = [];
      let sourceFileName = '';
      if (input.importXlsx) {
        const selected = await selectWorkbook();
        if (!selected || selected.canceled || !selected.filePath) return { ok: true, cancelled: true, rows: [], meta: {} };
        const imported = await readWorkbook(selected.filePath);
        adsRows = imported.rows || [];
        sourceFileName = imported.sourceFileName || '';
      }
      const autocompleteRows = await autocomplete(input.seed);
      const observations = await observe({ seed: input.seed, adsRows, autocomplete: autocompleteRows, max: 20 });
      const rows = matchConnectKeywords({
        seed: input.seed,
        adsRows,
        autocomplete: autocompleteRows,
        questions: input.questions || [],
        products,
        observations: Array.isArray(observations) ? observations : [],
        now: now(),
      });
      return {
        ok: true,
        rows,
        meta: {
          seed: input.seed.trim(), productIds: products.map((product) => product.id),
          sourceFileName, importedCount: adsRows.length, autocompleteCount: autocompleteRows.length,
          observedCount: Array.isArray(observations) ? observations.length : 0,
          importedAt: now().toISOString(),
        },
      };
    },
    async prepareDelivery(input) { return prepareDelivery(input); },
  };
}

module.exports = { validateConnectRequest, buildTravelImportRequest, dispatchConnectIpc, createConnectIpcHandlers, createConnectService };
