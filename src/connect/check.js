'use strict';

const { validateAffiliateUrl } = require('./policy');

const DAY_MS = 24 * 60 * 60 * 1000;

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function substantiveProduct(product, selectedIds) {
  const copy = JSON.parse(JSON.stringify(product));
  copy.variants = (copy.variants || []).filter((variant) => selectedIds.has(variant.id));
  for (const variant of copy.variants) delete variant.priceCheckedAt;
  // A human price refresh changes verification time, not the reviewed value or its provenance.
  for (const fact of copy.facts || []) delete fact.checkedAt;
  return copy;
}

// Include every textual field in post metadata and each renderer block shape. This deliberately
// handles table cells and Q&A fields directly instead of relying on prose-only factCheck.
function flattenPostText(post) {
  const out = [];
  const visit = (value) => {
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  if (!post || typeof post !== 'object') return out;
  ['title', 'description', 'thumbnailText', 'hashtags', 'blocks'].forEach((key) => visit(post[key]));
  return out;
}

function compact(value) { return String(value == null ? '' : value).toLowerCase().replace(/[\s,，]/g, ''); }
function priceTokens(text) {
  const matches = [];
  const re = /(?<![\d])(?:(?<myriad>\d+(?:,\d{3})*)\s*만(?:\s*(?<thousandPart>\d+(?:,\d{3})*)\s*천)?\s*원?|(?<thousandOnly>\d+(?:,\d{3})*)\s*천\s*원?|(?<plain>\d{1,3}(?:,\d{3})+|\d{4,})\s*(?:원|KRW|₩))(?=$|[^\d])/gi;
  let match;
  while ((match = re.exec(String(text)))) {
    const groups = match.groups || {};
    const number = (value) => Number(String(value || '0').replace(/,/g, ''));
    let amount;
    if (groups.myriad) amount = number(groups.myriad) * 10000 + number(groups.thousandPart) * 1000;
    else if (groups.thousandOnly) amount = number(groups.thousandOnly) * 1000;
    else amount = number(groups.plain);
    matches.push({ raw: match[0], amount, index: match.index, end: re.lastIndex });
  }
  return matches;
}
function bareMoneyTokens(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^(\d{1,3}(?:,\d{3})+|\d+)$/);
  return match ? [{ raw, amount: Number(raw.replace(/,/g, '')), index: 0, end: raw.length }] : [];
}
const EXTRA_MONEY_FIELDS = ['tips', 'optionalTours', 'taxes', 'fees', 'exclusions'];
function moneyRoleFromCue(text) {
  const cue = String(text || '').toLowerCase();
  const extras = [];
  if (/가이드\s*팁|팁|tip/.test(cue)) extras.push('tips');
  if (/선택\s*관광|선택\s*투어|optional\s*tour/.test(cue)) extras.push('optionalTours');
  if (/세금|유류\s*할증|공항세|부가세|\btaxes?\b/.test(cue)) extras.push('taxes');
  if (/수수료|추가\s*(?:요금|비용)|현지\s*비용|\bfees?\b/.test(cue)) extras.push('fees');
  if (/불포함|미포함|별도\s*비용|제외/.test(cue)) extras.push('exclusions');
  const uniqueExtras = [...new Set(extras)];
  if (uniqueExtras.length) return uniqueExtras.length === 1 ? uniqueExtras[0] : null;
  if (/가격|요금|금액|\bprice\b|1인(?:당)?|부터/.test(cue)) return 'basePrice';
  return null;
}
function moneyRoleForClaim(text, token) {
  const content = String(text || '');
  const priorTokens = priceTokens(content).filter((candidate) => candidate.index < token.index);
  const priorEnd = priorTokens.length ? priorTokens[priorTokens.length - 1].end : 0;
  const before = content.slice(Math.max(priorEnd, token.index - 36), token.index);
  const nextBoundary = content.slice(token.end).search(/[,;\n.!?。]/);
  const afterEnd = nextBoundary < 0 ? Math.min(content.length, token.end + 24) : token.end + nextBoundary;
  const after = content.slice(token.end, afterEnd);
  return moneyRoleFromCue(before + ' ' + after);
}
function factAmountMatches(fact, amount) {
  const valueText = String(fact.value == null ? '' : fact.value);
  const excerptText = String(fact.excerpt || '');
  const valueMatches = typeof fact.value === 'number' ? fact.value === amount
    : /^\d+$/.test(valueText) ? Number(valueText) === amount
      : priceTokens(valueText).some((token) => token.amount === amount);
  const excerptMatches = priceTokens(excerptText).some((token) => token.amount === amount);
  return valueMatches && excerptMatches;
}
function findMoneyFact(context, productId, variantId, field, amount) {
  const facts = Array.isArray(context.verifiedFacts) ? context.verifiedFacts : [];
  const sourceIds = new Set((Array.isArray(context.sources) ? context.sources : []).map((source) => source && source.id).filter(Boolean));
  const acceptable = (fact, wantedField) => fact && fact.productId === productId && fact.field === wantedField
    && fact.status === 'verified' && fact.sourceId && sourceIds.has(fact.sourceId) && factAmountMatches(fact, amount);
  return facts.find((fact) => acceptable(fact, `variant:${variantId}:${field}`))
    || facts.find((fact) => acceptable(fact, field)) || null;
}
function validateMoneyClaim({ text, token, role, scope, context, holdReasons, label }) {
  const resolvedRole = role || moneyRoleForClaim(text, token);
  if (!resolvedRole) {
    addReason(holdReasons, `${label}의 금액 역할을 상품 가격과 추가 비용 중 어느 쪽인지 확인할 수 없습니다.`);
    return;
  }
  if (resolvedRole === 'basePrice') {
    const expected = scope.variant.amountMinor;
    const fact = findMoneyFact(context, scope.product.id, scope.variant.id, 'price', expected);
    if (token.amount !== expected || !fact) addReason(holdReasons, `${label}의 기본 가격이 해당 상품·옵션의 검토된 가격과 다릅니다: ${scope.product.name} ${scope.variant.id}`);
    return;
  }
  if (!EXTRA_MONEY_FIELDS.includes(resolvedRole) || !findMoneyFact(context, scope.product.id, scope.variant.id, resolvedRole, token.amount)) {
    addReason(holdReasons, `${label}의 추가 비용에 해당 상품·옵션의 검토된 ${resolvedRole} 근거가 없습니다: ${scope.product.name} ${scope.variant.id}`);
  }
}
function dateTokens(text) {
  const matches = [];
  // Keep incomplete year dates too: they are date-like claims, but cannot be approved as a
  // departure date unless they normalize to a complete, verified calendar day.
  const re = /20\d{2}\s*년(?:\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?)?|20\d{2}[-./]\d{1,2}(?:[-./]\d{1,2})?|\d{1,2}월\s*\d{1,2}일|20\d{2}[-./]\d{1,2}[-./]\d{1,2}/g;
  let match;
  while ((match = re.exec(String(text)))) matches.push({ raw: match[0], index: match.index });
  return matches;
}
function splitSentences(text) {
  return String(text || '').split(/\n+|(?<=[!?。])\s*|(?<=\.)\s+(?=[가-힣])/u).map((part) => part.trim()).filter(Boolean);
}
function sameDate(claim, value) {
  const raw = String(claim).replace(/\s/g, '');
  const expected = String(value || '');
  let year, month, day;
  let m = raw.match(/^(20\d{2})년(\d{1,2})월(\d{1,2})일$/);
  if (m) [, year, month, day] = m;
  else {
    m = raw.match(/^(20\d{2})[-./](\d{1,2})[-./](\d{1,2})$/);
    if (m) [, year, month, day] = m;
    else {
      m = raw.match(/^(\d{1,2})월(\d{1,2})일$/);
      if (!m) return false;
      [, month, day] = m;
    }
  }
  const monthNum = Number(month), dayNum = Number(day);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return false;
  const expectedMatch = expected.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!expectedMatch) return false;
  const expectedYear = Number(expectedMatch[1]);
  const yearNum = year == null ? expectedYear : Number(year);
  const date = new Date(Date.UTC(yearNum, monthNum - 1, dayNum));
  if (date.getUTCFullYear() !== yearNum || date.getUTCMonth() !== monthNum - 1 || date.getUTCDate() !== dayNum) return false;
  return yearNum === Number(expectedMatch[1]) && monthNum === Number(expectedMatch[2]) && dayNum === Number(expectedMatch[3]);
}
function findScope(text, context) {
  const s = compact(text);
  const products = context.productSnapshots || [];
  const product = products.find((p) => [p.id, p.name].filter(Boolean).some((alias) => s.includes(compact(alias))));
  if (!product) return products.length === 1 ? { product: products[0], variant: (products[0].variants || []).length === 1 ? products[0].variants[0] : null } : null;
  const variant = (product.variants || []).find((v) => s.includes(compact(v.id))
    || (v.options || []).some((o) => compact(o) && s.includes(compact(o)))
    || (v.roomBasis && s.includes(compact(v.roomBasis)))
    || (v.departureDate && s.includes(compact(v.departureDate))));
  if (!variant && /\bv[_-]?[a-z0-9]+\b/i.test(String(text))) return { product, variant: null };
  return { product, variant: variant || ((product.variants || []).length === 1 ? product.variants[0] : null) };
}
function findVariantFact(context, productId, variantId, field, expectedValue) {
  const facts = Array.isArray(context.verifiedFacts) ? context.verifiedFacts : [];
  const matches = (fact, wantedField) => fact && fact.productId === productId && fact.field === wantedField
    && fact.status === 'verified' && String(fact.value) === String(expectedValue);
  const scoped = facts.find((fact) => matches(fact, `variant:${variantId}:${field}`));
  if (scoped) return scoped;
  // Legacy product-wide facts are safe only when their reviewed value equals this exact variant.
  return facts.find((fact) => matches(fact, field)) || null;
}
function addReason(list, reason) { if (!list.includes(reason)) list.push(reason); }

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const URL_TRAILING_PROSE_PUNCTUATION = /^[.,;:!?，。；：！？、)\]}]+$/u;
function extractUrls(text) { return String(text || '').match(URL_RE) || []; }
function urlMatchesRaw(candidate, raw) {
  if (candidate === raw) return true;
  // Only tolerate prose punctuation after a byte-identical approved URL. Query delimiters and
  // other URL syntax remain significant, so appended query/redirect parameters fail closed.
  return candidate.startsWith(raw) && URL_TRAILING_PROSE_PUNCTUATION.test(candidate.slice(raw.length));
}

function checkConnectPost(post, { connectContext, currentProducts, now = Date.now() } = {}) {
  const holdReasons = [];
  const reviewReasons = [];
  const ctx = connectContext && typeof connectContext === 'object' ? connectContext : {};
  const snapshots = Array.isArray(ctx.productSnapshots) ? ctx.productSnapshots : [];
  const products = Array.isArray(currentProducts) ? currentProducts : [];
  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  const texts = flattenPostText(post);
  const whole = texts.join('\n');
  const allowedUrls = new Set();
  for (const link of Array.isArray(ctx.links) ? ctx.links : []) if (link && typeof link.affiliateUrlRaw === 'string') allowedUrls.add(link.affiliateUrlRaw);
  for (const product of snapshots) if (product && typeof product.detailUrl === 'string') allowedUrls.add(product.detailUrl);
  for (const source of Array.isArray(ctx.sources) ? ctx.sources : []) if (source && typeof source.url === 'string') allowedUrls.add(source.url);
  const foundUrls = texts.flatMap(extractUrls);
  for (const candidate of foundUrls) {
    if (![...allowedUrls].some((raw) => urlMatchesRaw(candidate, raw))) addReason(holdReasons, `등록 정보에 없는 URL 또는 변경된 목적지 URL이 있습니다: ${candidate}`);
  }

  if (!snapshots.length || !Array.isArray(ctx.variantIds) || !ctx.variantIds.length) addReason(holdReasons, '연결 상품과 선택 옵션 스냅샷이 없습니다.');
  if (ctx.connectKind !== 'travel') addReason(holdReasons, '여행 제휴 상품 연결 정보가 올바르지 않습니다.');
  for (const snapshot of snapshots) {
    const current = products.find((p) => p && p.id === snapshot.id);
    if (!current) { addReason(holdReasons, `등록 상품 ${snapshot.name || snapshot.id}을(를) 찾을 수 없습니다.`); continue; }
    const selectedIds = new Set((snapshot.variants || []).map((v) => v.id));
    const currentProjection = substantiveProduct(current, selectedIds);
    if (stable(currentProjection) !== stable(substantiveProduct(snapshot, selectedIds))) addReason(holdReasons, `등록 상품 또는 선택 옵션이 저장 시점과 달라졌습니다: ${snapshot.name || snapshot.id}`);
    if (current.eligibility !== 'verified') addReason(holdReasons, '발급 링크 확인이 필요합니다. 상품 링크 입력란에서 다시 확인해 주세요.');
    if (current.affiliateStatus !== 'issued' || !current.affiliateUrlRaw || !validateAffiliateUrl(current.affiliateUrlRaw).valid) addReason(holdReasons, `발급된 제휴 링크가 없습니다: ${current.name || current.id}`);
    for (const variant of snapshot.variants || []) {
      const currentVariant = (current.variants || []).find((v) => v.id === variant.id);
      const priceField = `variant:${variant.id}:price`;
      const priceFact = (ctx.verifiedFacts || []).find((f) => f.productId === snapshot.id && f.field === priceField && f.status === 'verified' && f.value === variant.amountMinor);
      const currentPriceFact = (current.facts || []).find((f) => f.field === priceField && f.status === 'verified' && f.value === variant.amountMinor);
      const priceTime = currentVariant && Date.parse(currentVariant.priceCheckedAt);
      if (!currentVariant || !Number.isFinite(priceTime)) addReason(holdReasons, `가격 확인 시간이 없거나 올바르지 않습니다: ${snapshot.name} ${variant.id}`);
      else if (priceTime > nowMs) addReason(holdReasons, `가격 확인 시간이 미래입니다: ${snapshot.name} ${variant.id}`);
      else if (nowMs - priceTime >= DAY_MS) addReason(holdReasons, `가격 확인 후 24시간이 지났습니다. 상품을 갱신한 뒤 다시 검수하세요: ${snapshot.name} ${variant.id}`);
      if (!priceFact || !currentPriceFact || currentPriceFact.sourceId !== priceFact.sourceId || currentPriceFact.excerpt !== priceFact.excerpt) addReason(holdReasons, `검토된 현재 가격 근거가 저장된 상품과 다릅니다: ${snapshot.name} ${variant.id}`);
    }
  }

  if (!ctx.disclosureLine || !whole.includes(ctx.disclosureLine)) addReason(holdReasons, '필수 제휴 고지문이 원문 그대로 포함되지 않았습니다.');
  for (const uncertain of Array.isArray(ctx.uncertainFields) ? ctx.uncertainFields : []) {
    if (!/\.eligibility$|\.affiliateUrl$|\.variant$|\.variant:[^:]+:price$/.test(String(uncertain))) {
      addReason(reviewReasons, `확인되지 않은 상품 항목을 사람이 확인해야 합니다: ${uncertain}`);
    }
  }
  for (const link of Array.isArray(ctx.links) ? ctx.links : []) {
    const current = products.find((p) => p && p.id === link.productId);
    const raw = current && current.affiliateUrlRaw;
    if (!raw || link.affiliateUrlRaw !== raw || !validateAffiliateUrl(raw).valid || !foundUrls.some((candidate) => urlMatchesRaw(candidate, raw))) addReason(holdReasons, `발급된 제휴 링크가 원문 그대로 포함되지 않았습니다: ${link.productId}`);
  }
  for (const snapshot of snapshots) {
    if (!Array.isArray(ctx.links) || !ctx.links.some((link) => link.productId === snapshot.id)) addReason(holdReasons, `발급된 제휴 링크 정보가 없습니다: ${snapshot.name || snapshot.id}`);
  }

  const experience = compact(ctx.experience || '');
  const firstPerson = /내돈내산|직접\s*(?:다녀|방문|이용|예약|구매|체험|묵)|(?:다녀왔|방문했|이용했|예약했|구매했|체험했|묵어봤|묵었)|제가\s*(?:다녀|방문|이용|예약|구매|체험)|저는\s*(?:다녀|방문|이용|예약|구매|체험)|우리\s*(?:가족|부부)가\s*(?:다녀|방문|이용|예약|구매)/;
  const assertedFirstPerson = texts.filter((text) => firstPerson.test(text));
  if (assertedFirstPerson.length && (!experience || assertedFirstPerson.some((text) => !experience.includes(compact(text)) && !compact(text).includes(experience)))) {
    addReason(holdReasons, '제공된 작성자 경험으로 확인되지 않는 직접 이용·내돈내산 표현이 있습니다.');
  }

  // Inspect each sentence and each structured table row in its own scope. A value from a
  // different product can never authorize the cell in this row.
  const inspectClaim = (text, label, { skipMoney = false } = {}) => {
    const claimText = String(text || '').replace(URL_RE, ' ');
    const prices = skipMoney ? [] : priceTokens(claimText);
    const dates = dateTokens(claimText);
    const roomClaim = /객실|룸|오션뷰|시티뷰|디럭스|스탠다드|트윈|더블/i.test(claimText);
    const moneyCue = /가격|요금|금액|팁|선택\s*관광|선택\s*투어|세금|유류\s*할증|공항세|수수료|추가\s*(?:요금|비용)|현지\s*비용|불포함|미포함|별도\s*비용|\bKRW\b|₩|만원|천원|원/i.test(claimText);
    const unsupportedMoney = !skipMoney && !prices.length && moneyCue && /\d/.test(claimText);
    if (!prices.length && !dates.length && !roomClaim && !unsupportedMoney) return;
    const scope = findScope(text, ctx);
    if (!scope || !scope.product || !scope.variant) {
      addReason(holdReasons, `${label}의 가격·출발일을 특정 상품과 옵션에 연결할 수 없습니다.`);
      return;
    }
    if (unsupportedMoney) addReason(holdReasons, `${label}의 금액 단위나 표기를 안전하게 해석할 수 없습니다.`);
    for (const claim of prices) validateMoneyClaim({ text: claimText, token: claim, scope, context: ctx, holdReasons, label });
    for (const claim of dates) {
      const fact = findVariantFact(ctx, scope.product.id, scope.variant.id, 'departureDate', scope.variant.departureDate);
      if (!fact || !sameDate(claim.raw, scope.variant.departureDate)) addReason(holdReasons, `${label}의 출발일이 해당 상품·옵션에서 검토한 값과 다릅니다: ${scope.product.name} ${scope.variant.id}`);
    }
    if (roomClaim) {
      const fact = findVariantFact(ctx, scope.product.id, scope.variant.id, 'roomBasis', scope.variant.roomBasis);
      if (!fact || !scope.variant.roomBasis || !compact(text).includes(compact(scope.variant.roomBasis)) || compact(fact.value) !== compact(scope.variant.roomBasis)) {
        addReason(holdReasons, `${label}의 객실 조건이 해당 상품·옵션에서 검토한 값과 다릅니다: ${scope.product.name} ${scope.variant.id}`);
      }
    }
  };
  for (const block of (post && post.blocks) || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.kind === 'table') {
      const columns = Array.isArray(block.columns) ? block.columns : [];
      const headers = columns.map((cell) => String(cell || '').toLowerCase());
      const relevant = headers.some((h) => /가격|금액|price/.test(h)) || headers.some((h) => /출발일|날짜|date/.test(h)) || headers.some((h) => /객실|룸|room/.test(h));
      if (relevant) {
        for (const rawRow of block.rows || []) {
          const row = Array.isArray(rawRow) ? rawRow : [];
          const rowText = row.join(' | ');
          inspectClaim(rowText, '표 행', { skipMoney: true });
          const scope = findScope(rowText, ctx);
          if (!scope || !scope.product || !scope.variant) {
            const rowHasMoney = row.some((rawCell, cellIndex) => {
              const cell = String(rawCell == null ? '' : rawCell).trim();
              if (!cell) return false;
              const role = moneyRoleFromCue(headers[cellIndex] || '');
              return !!role || priceTokens(cell).length > 0
                || (/\d/.test(cell) && /가격|요금|금액|팁|선택\s*관광|선택\s*투어|세금|공항세|수수료|비용|불포함|만원|천원|원/i.test(cell));
            });
            if (rowHasMoney) addReason(holdReasons, '표의 금액을 특정 상품과 옵션에 연결할 수 없습니다.');
            continue;
          }
          const priceIndex = headers.findIndex((h) => /가격|금액|price/.test(h));
          const dateIndex = headers.findIndex((h) => /출발일|날짜|date/.test(h));
          const roomIndex = headers.findIndex((h) => /객실|룸|room/.test(h));
          const optionIndex = headers.findIndex((h) => /옵션|variant/.test(h));
          if (optionIndex >= 0 && String(row[optionIndex] == null ? '' : row[optionIndex]).trim()) {
            const enteredOption = compact(row[optionIndex]);
            const allowedOptions = [scope.variant.id, ...(Array.isArray(scope.variant.options) ? scope.variant.options : [])]
              .map(compact).filter(Boolean);
            if (!allowedOptions.includes(enteredOption)) addReason(holdReasons, `표의 옵션이 날짜·객실에서 확인된 상품 옵션과 다릅니다: ${scope.product.name} ${scope.variant.id}`);
          }
          if (priceIndex >= 0) {
            const values = priceTokens(row[priceIndex]);
            if (!values.length) values.push(...bareMoneyTokens(row[priceIndex]));
            if (!values.length || values.some((v) => v.amount !== scope.variant.amountMinor)) addReason(holdReasons, `표의 가격 열이 해당 상품·옵션의 검토된 가격과 다릅니다: ${scope.product.name} ${scope.variant.id}`);
          }
          if (dateIndex >= 0) {
            const values = dateTokens(row[dateIndex]);
            const fact = findVariantFact(ctx, scope.product.id, scope.variant.id, 'departureDate', scope.variant.departureDate);
            if (!values.length || values.some((v) => !sameDate(v.raw, scope.variant.departureDate)) || !fact) addReason(holdReasons, `표의 출발일 열이 해당 상품·옵션의 검토된 날짜와 다릅니다: ${scope.product.name} ${scope.variant.id}`);
          }
          if (roomIndex >= 0) {
            const value = compact(row[roomIndex]);
            const fact = findVariantFact(ctx, scope.product.id, scope.variant.id, 'roomBasis', scope.variant.roomBasis);
            if (!fact || value !== compact(scope.variant.roomBasis) || compact(fact.value) !== value) addReason(holdReasons, `표의 객실 열이 해당 상품·옵션의 검토된 조건과 다릅니다: ${scope.product.name} ${scope.variant.id}`);
          }
          for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
            const cell = String(row[cellIndex] == null ? '' : row[cellIndex]);
            const amounts = priceTokens(cell);
            const headerRole = moneyRoleFromCue(headers[cellIndex] || '');
            if (!amounts.length && /\d/.test(cell) && (headerRole || /가격|요금|금액|팁|선택\s*관광|선택\s*투어|세금|공항세|수수료|비용|불포함|만원|천원|원/i.test(cell))) {
              const bareAmounts = headerRole ? bareMoneyTokens(cell) : [];
              if (!bareAmounts.length) addReason(holdReasons, `표의 금액 단위나 역할을 안전하게 확인할 수 없습니다: ${scope.product.name} ${scope.variant.id}`);
              for (const amount of bareAmounts) validateMoneyClaim({ text: `${headers[cellIndex] || ''} ${cell}`, token: amount, role: headerRole, scope, context: ctx, holdReasons, label: '표' });
            } else {
              for (const amount of amounts) validateMoneyClaim({ text: `${headers[cellIndex] || ''} ${cell}`, token: amount, role: headerRole, scope, context: ctx, holdReasons, label: '표' });
            }
          }
        }
      }
      else for (const row of [columns, ...(block.rows || [])]) inspectClaim((row || []).join(' | '), '표');
    } else if (block.kind === 'qna') {
      inspectClaim(`질문 ${block.question || ''} 답변 ${block.answer || ''}`, 'FAQ');
    } else {
      for (const text of [block.text, block.caption, block.alt, block.imageHint].filter((v) => typeof v === 'string')) {
        for (const sentence of splitSentences(text)) inspectClaim(sentence, '본문');
      }
    }
  }
  for (const key of ['title', 'description', 'thumbnailText', 'hashtags']) {
    const value = post && post[key];
    for (const text of Array.isArray(value) ? value : [value]) {
      if (typeof text === 'string') for (const sentence of splitSentences(text)) inspectClaim(sentence, '원고 메타정보');
    }
  }
  // Required product conditions are only considered verified when explicitly present in scoped facts.
  const claimFacts = (ctx.verifiedFacts || []).filter((fact) => fact && fact.status === 'verified' && fact.productId);
  const conditionTexts = [];
  for (const block of (post && post.blocks) || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.kind === 'table') conditionTexts.push(...(block.rows || []).map((row) => (row || []).join(' | ')));
    else if (block.kind === 'qna') conditionTexts.push(`질문 ${block.question || ''} 답변 ${block.answer || ''}`);
    else if (typeof block.text === 'string') conditionTexts.push(...splitSentences(block.text));
  }
  for (const key of ['title', 'description', 'hashtags']) {
    const value = post && post[key];
    conditionTexts.push(...(Array.isArray(value) ? value : [value]).filter((text) => typeof text === 'string'));
  }
  for (const text of conditionTexts) {
    if (/포함|불포함|취소|환불|변경/.test(text)) {
      const mentions = text.match(/포함|불포함|취소|환불|변경/g) || [];
      for (const word of mentions) {
        const matching = claimFacts.some((fact) => {
          const field = String(fact.field || '');
          const map = { 포함: /inclusion|included/i, 불포함: /exclusion|excluded/i, 취소: /cancellation/i, 환불: /refund/i, 변경: /change/i };
          return map[word].test(field) && compact(text).includes(compact(fact.value));
        });
        if (!matching) { addReason(reviewReasons, `상품의 ${word} 조건 주장은 등록 상품 근거를 직접 확인해야 합니다.`); break; }
      }
    }
  }

  if (!Number.isFinite(nowMs)) addReason(holdReasons, '검수 기준 시간이 올바르지 않습니다.');
  return { status: holdReasons.length ? 'hold' : reviewReasons.length ? 'review' : 'ready', holdReasons, reviewReasons };
}

module.exports = { checkConnectPost, flattenPostText, substantiveProduct };
