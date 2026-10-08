'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const cheerio = require('cheerio');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_EXCERPT = 18000;

class ProductImportError extends Error {
  constructor(message, kind = 'collection_failed', cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProductImportError';
    this.kind = kind;
  }
}

function ipv4IsPublic(value) {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255) return false;
  return true;
}

function ipv6ToBigInt(value) {
  const raw = value.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!raw || net.isIP(raw) !== 6) return null;
  let source = raw;
  let ipv4Tail = null;
  const lastColon = source.lastIndexOf(':');
  const tail = source.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!ipv4IsPublic(tail)) return null;
    const octets = tail.split('.').map(Number);
    ipv4Tail = ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
    source = source.slice(0, lastColon + 1) + ipv4Tail;
  }
  const [leftRaw, rightRaw = ''] = source.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[\da-f]{1,4}$/.test(part))) return null;
  return parts.reduce((total, part) => (total << 16n) | BigInt('0x' + part), 0n);
}

function isPublicIp(value) {
  const address = String(value || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family !== 6) return false;
  const packed = ipv6ToBigInt(address);
  if (packed == null) return false;
  const first16 = Number((packed >> 112n) & 0xffffn);
  const top3 = Number(packed >> 125n);
  if (top3 !== 1) return false; // Global unicast space 2000::/3 only.
  const second16 = Number((packed >> 96n) & 0xffffn);
  if (first16 === 0x2001 && (second16 <= 0x01ff || second16 === 0x0db8)) return false; // Teredo/benchmarking and documentation ranges.
  if (first16 === 0x2002 || first16 === 0x3fff) return false; // 6to4 and documentation space.
  return true;
}

function validateTravelProductUrl(value) {
  const fail = (error, kind = 'invalid_url') => ({ valid: false, error, kind });
  if (typeof value !== 'string' || !value.trim() || /[\s\u0000-\u001f\u007f]/.test(value)) {
    return fail('상품 URL을 확인해 주세요.');
  }
  let parsed;
  try { parsed = new URL(value); } catch (_) { return fail('올바른 URL 형식이 아닙니다.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return fail('http 또는 https URL만 가져올 수 있습니다.');
  if (parsed.username || parsed.password) return fail('계정 정보가 포함된 URL은 가져올 수 없습니다.');
  if (!parsed.hostname) return fail('URL에 호스트가 없습니다.');
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return fail('로컬 또는 사설 호스트는 가져올 수 없습니다.', 'private_target');
  }
  if (parsed.port && ((parsed.protocol === 'http:' && parsed.port !== '80')
    || (parsed.protocol === 'https:' && parsed.port !== '443'))) return fail('표준 HTTP/HTTPS 포트만 가져올 수 있습니다.');
  if (net.isIP(hostname) && !isPublicIp(hostname)) return fail('로컬 또는 사설 IP 주소는 가져올 수 없습니다.', 'private_target');
  return { valid: true, url: value, hostname, protocol: parsed.protocol };
}

function timeoutPromise(promise, timeoutMs, message, kind = 'timeout') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new ProductImportError(message, kind)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function publicDnsLookup(hostname, lookup = dns.promises.lookup.bind(dns.promises)) {
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  let results;
  try { results = await lookup(hostname, { all: true, verbatim: true }); }
  catch (error) { throw new ProductImportError('상품 주소를 확인하지 못했습니다.', 'dns_failed', error); }
  if (!Array.isArray(results) || !results.length || results.some((entry) => !isPublicIp(entry.address))) {
    throw new ProductImportError('상품 주소가 로컬 또는 사설 네트워크를 가리킵니다.', 'private_target');
  }
  return results;
}

function requestHtml(url, { lookup, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_HTML_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let totalTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      callback(value);
    };
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request(parsed, {
      method: 'GET',
      headers: { 'accept': 'text/html,application/xhtml+xml;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'Mozilla/5.0' },
      lookup,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400) {
        const location = response.headers.location || '';
        response.destroy();
        finish(resolve, { status, location });
        return;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        finish(reject, new ProductImportError(`상품 페이지 응답이 HTTP ${status}입니다.`, status === 403 || status === 429 ? 'blocked' : 'http_error'));
        return;
      }
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (contentType && !/text\/html|application\/xhtml\+xml/.test(contentType)) {
        response.destroy();
        finish(reject, new ProductImportError('HTML 상품 페이지가 아닙니다.', 'invalid_content'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          request.destroy(new ProductImportError('상품 페이지가 허용 크기를 초과했습니다.', 'page_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, { status, html: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', (error) => finish(reject, error));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new ProductImportError('상품 페이지 응답이 지연되었습니다.', 'timeout')));
    totalTimer = setTimeout(() => request.destroy(new ProductImportError('상품 페이지 응답이 지연되었습니다.', 'timeout')), timeoutMs);
    request.on('error', (error) => finish(reject, error));
    request.end();
  });
}

async function fetchPublicHtml(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_HTML_BYTES, lookup = dns.promises.lookup.bind(dns.promises) } = {}) {
  const checked = validateTravelProductUrl(url);
  if (!checked.valid) throw new ProductImportError(checked.error, checked.kind);
  const addresses = await timeoutPromise(publicDnsLookup(checked.hostname, lookup), timeoutMs, '상품 주소 확인 시간이 초과되었습니다.');
  const address = addresses[0];
  const pinnedLookup = (_hostname, options, callback) => {
    if (options && options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  return timeoutPromise(requestHtml(url, { lookup: pinnedLookup, timeoutMs, maxBytes }), timeoutMs,
    '상품 페이지 응답이 지연되었습니다.');
}

function compact(text) {
  return String(text == null ? '' : text).replace(/[\s\u00a0]+/g, '').toLocaleLowerCase('ko-KR');
}

function textLines($) {
  const body = ($('body').length ? $('body') : $.root()).clone();
  body.find('script,style,noscript,template,svg').remove();
  return body.find('*').filter((_, element) => $(element).children().length === 0)
    .map((_, element) => $(element).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
}

function sourceExcerpt(lines, needles = [], limit = 520) {
  const full = lines.join('\n');
  const haystack = compact(full);
  for (const needle of needles.filter(Boolean)) {
    const wanted = compact(needle);
    if (!wanted) continue;
    const at = haystack.indexOf(wanted);
    if (at < 0) continue;
    const positions = [];
    let compactOffset = 0;
    for (let index = 0; index < full.length; index += 1) {
      if (!/[\s\u00a0]/.test(full[index])) {
        if (compactOffset >= at && positions.length < limit) positions.push(index);
        compactOffset += 1;
        if (compactOffset >= at + wanted.length) break;
      }
    }
    const matchStart = positions.length ? positions[0] : 0;
    const matchEnd = positions.length ? positions[positions.length - 1] + 1 : matchStart;
    const start = Math.max(0, matchStart - Math.floor((limit - (matchEnd - matchStart)) / 2));
    const end = Math.min(full.length, start + limit);
    return full.slice(start, end).trim();
  }
  return '';
}

function safeJson(text) {
  try { return JSON.parse(String(text || '')); } catch (_) { return null; }
}

function jsonLdProducts(value, output = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => jsonLdProducts(item, output, seen));
    return output;
  }
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.some((type) => String(type || '').toLowerCase() === 'product')) output.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'offers' || key === 'itemOffered') continue;
    jsonLdProducts(child, output, seen);
  }
  return output;
}

function resolveApolloValue(value, state, depth = 0, seen = new Set()) {
  if (depth > 25 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => resolveApolloValue(item, state, depth + 1, seen));
  if (typeof value.__ref === 'string' && state[value.__ref] && !seen.has(value.__ref)) {
    const nextSeen = new Set(seen);
    nextSeen.add(value.__ref);
    return resolveApolloValue(state[value.__ref], state, depth + 1, nextSeen);
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveApolloValue(child, state, depth + 1, seen)]));
}

function naverRecord(nextData, url) {
  const state = nextData && nextData.props && nextData.props.pageProps && nextData.props.pageProps.initialApolloState;
  const root = state && state.ROOT_QUERY;
  if (!state || !root || typeof root !== 'object') return null;
  let requestedId = '';
  try { requestedId = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch (_) {}
  const records = Object.entries(root).filter(([key]) => key.startsWith('overseasProductById('))
    .map(([, value]) => resolveApolloValue(value, state))
    .filter((value) => value && typeof value === 'object' && value.__typename === 'OverseasProductByIdResponse');
  return records.find((record) => String(record.productId || '') === requestedId) || null;
}

function brandName(product) {
  for (const key of ['brand', 'manufacturer', 'seller', 'provider']) {
    const value = product && product[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  }
  return '';
}

function offerList(product) {
  const offers = product && product.offers;
  if (Array.isArray(offers)) return offers;
  return offers && typeof offers === 'object' ? [offers] : [];
}

function offerPrice(offer) {
  if (!offer || typeof offer !== 'object') return null;
  const spec = offer.priceSpecification && !Array.isArray(offer.priceSpecification) ? offer.priceSpecification : null;
  const raw = offer.price != null ? offer.price : spec && spec.price;
  const currency = String(offer.priceCurrency || (spec && spec.priceCurrency) || '').toUpperCase();
  if (currency !== 'KRW') return { invalid: 'currency', currency: currency || '통화 미표기' };
  if (typeof raw === 'string' && !/^\d+(?:\.0+)?$/.test(raw.trim())) return { invalid: 'range' };
  const amount = Number(raw);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { invalid: 'range' };
  if (offer.lowPrice != null || offer.highPrice != null || String(offer['@type'] || '').toLowerCase() === 'aggregateoffer') return { invalid: 'aggregate' };
  return { amount };
}

function findLabelValue($, labels) {
  const wanted = new Set(labels.map(compact));
  let result = '';
  $('dt,th').each((_, element) => {
    if (result || !wanted.has(compact($(element).text()))) return;
    const sibling = $(element).next('dd,td');
    if (sibling.length) result = sibling.text().replace(/\s+/g, ' ').trim();
  });
  return result;
}

function sectionText($, labels) {
  const wanted = labels.map(compact);
  let found = '';
  $('h1,h2,h3,h4,dt,th,strong,b').each((_, element) => {
    if (found) return;
    const heading = compact($(element).text());
    if (!wanted.some((label) => heading === label || heading.startsWith(label))) return;
    const parent = $(element).closest('section,article,li,div,dd,td').first();
    const text = parent.text().replace(/\s+/g, ' ').trim();
    if (text.length > $(element).text().trim().length) found = text;
  });
  return found;
}

function listFromSection($, labels, linePattern) {
  let values = [];
  $('h1,h2,h3,h4').each((_, element) => {
    if (values.length) return;
    const heading = compact($(element).text());
    if (!labels.some((label) => heading === compact(label) || heading.includes(compact(label)))) return;
    const container = $(element).closest('section,article,div').first();
    if (container.length) {
      values = container.find('li,p,dd').map((__, child) => $(child).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
    }
  });
  if (values.length) return [...new Set(values)];
  const body = $('body').text().split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const line of body) {
    const match = line.match(linePattern);
    if (match) values.push(match[1].trim());
  }
  return values;
}

function parseDuration(text) {
  const match = String(text || '').match(/(\d+)\s*박\s*(\d+)\s*일/);
  return match ? { nights: Number(match[1]), days: Number(match[2]) } : {};
}

function mapTravelType(value) {
  const text = String(value || '').toLowerCase();
  if (/package|패키지|투어텔|풀패키지/.test(text)) return 'package';
  if (/hotel|숙박|호텔/.test(text)) return 'hotel';
  if (/flight|항공/.test(text)) return 'flight';
  if (/activity|액티비티|체험/.test(text)) return 'activity';
  return '';
}

function cleanDestination(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].join(' ');
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function naverOptions(record, visible, warnings) {
  const prices = record.prices && typeof record.prices === 'object' ? record.prices : {};
  const ageOptions = [
    ['adult', '성인', record.priceAgeRanges && record.priceAgeRanges.adult, 1, 0],
    ['child', '소아', record.priceAgeRanges && record.priceAgeRanges.child, 0, 1],
    ['infant', '유아', record.priceAgeRanges && record.priceAgeRanges.infant, 0, 1],
  ];
  const beginDate = /^\d{4}-\d{2}-\d{2}$/.test(String(record.beginDate || '')) ? record.beginDate : null;
  const roomSource = (Array.isArray(record.includeOptions) ? record.includeOptions : []).find((value) => /\d+\s*인\s*1\s*실|더블룸\s*기준|트윈룸\s*기준/i.test(String(value || '')));
  const roomMatch = roomSource && String(roomSource).match(/(?:\d+\s*인\s*1\s*실\s*기준|더블룸\s*기준|트윈룸\s*기준)/i);
  const roomBasis = roomMatch ? roomMatch[0].replace(/\s+/g, ' ').trim() : null;
  const variants = [];
  const evidence = [];
  for (const [key, label, ageRange, adults, children] of ageOptions) {
    const amount = prices[key];
    if (!Number.isSafeInteger(amount) || amount <= 0) continue;
    const labelPattern = new RegExp(`^\\s*${label}\\s*(?:\\(([^)]*)\\))?\\s*[:：]\\s*([\\d,]+)\\s*원(?:\\s|$)`);
    const visiblePriceLine = visible.find((line) => {
      const match = line.match(labelPattern);
      return match && Number(match[2].replace(/,/g, '')) === amount;
    });
    const visiblePriceMatch = visiblePriceLine && visiblePriceLine.match(labelPattern);
    if (!visiblePriceLine) {
      warnings.push(`공개 페이지 본문에서 ${label} 가격과 일치하는 원화 가격을 확인하지 못해 옵션으로 가져오지 않았습니다.`);
      continue;
    }
    const displayedAgeRange = visiblePriceMatch && visiblePriceMatch[1] && visiblePriceMatch[1].trim() || ageRange;
    const ageLabel = displayedAgeRange ? `${label} (${displayedAgeRange})` : label;
    const excerpt = visiblePriceLine.slice(0, 520);
    const variantId = `v_${crypto.createHash('sha256').update([record.productId, beginDate, ageLabel, amount].join('|')).digest('hex').slice(0, 12)}`;
    variants.push({
      id: variantId, currency: 'KRW', amountMinor: amount,
      priceCheckedAt: '', options: [ageLabel], departureDate: beginDate,
      adults, children, roomBasis,
    });
    evidence.push({ field: `variant:${variantId}:price`, value: amount, excerpt });
    if (beginDate) evidence.push({ field: `variant:${variantId}:departureDate`, value: beginDate,
      excerpt: sourceExcerpt(visible, [beginDate.replace(/-/g, '.'), beginDate]) || `출발일 ${beginDate}` });
    if (roomBasis) evidence.push({ field: `variant:${variantId}:roomBasis`, value: roomBasis,
      excerpt: sourceExcerpt(visible, [roomBasis, roomSource]) || roomSource });
  }
  if (!variants.length) warnings.push('원화 기준의 연령별 판매가를 확인하지 못했습니다.');
  return { variants, evidence, roomBasis };
}

function extractNaverData(record, visible, warnings) {
  const areas = Array.isArray(record.visitAreas) ? record.visitAreas : [];
  const countries = [...new Set(areas.map((area) => String(area && area.countryName || '').trim()).filter(Boolean))];
  const cities = [...new Set(areas.map((area) => String(area && area.cityName || '').trim()).filter(Boolean))];
  const destination = cleanDestination([...countries, ...cities]);
  const includes = Array.isArray(record.includeOptions) ? record.includeOptions.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const excludes = Array.isArray(record.excludeOptions) ? record.excludeOptions.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const cancellation = record.refundPolicy && Array.isArray(record.refundPolicy.editors)
    ? record.refundPolicy.editors.flatMap((editor) => Array.isArray(editor && editor.contents) ? editor.contents : []).map((item) => String(item || '').trim()).filter(Boolean).join('\n').slice(0, 4000)
    : '';
  const category = record.tourCategory && record.tourCategory.name || '';
  const travelType = mapTravelType(category) || 'other';
  if (!mapTravelType(category) && category) warnings.push(`여행 유형 '${category}'은 기존 분류와 정확히 맞지 않아 추가 확인이 필요합니다.`);
  const priceOptions = naverOptions(record, visible, warnings);
  if (/최종\s*결제금액|최종\s*요금/.test(visible.join('\n'))) {
    warnings.push('페이지에 표시된 기준 판매가입니다. 연령·혜택이 반영된 최종 결제 금액은 예약 단계에서 달라질 수 있습니다.');
  }
  return {
    name: String(record.productName || '').trim(),
    provider: String(record.agtName || '').trim(),
    destination,
    travelType,
    nights: Number.isInteger(record.nightPeriod) ? record.nightPeriod : parseDuration(visible.join(' ')).nights,
    days: Number.isInteger(record.dayPeriod) ? record.dayPeriod : parseDuration(visible.join(' ')).days,
    inclusions: includes,
    exclusions: excludes,
    cancellationPolicy: cancellation,
    beginCityName: String(record.beginCityName || '').trim(),
    variants: priceOptions.variants,
    fieldEvidence: [
      ['name', record.productName, [record.productName]],
      ['provider', record.agtName, [record.agtName]],
      ['destination', destination, [...countries, ...cities]],
      ['travelType', travelType, [category]],
      ['nights', Number.isInteger(record.nightPeriod) ? record.nightPeriod : null, [`${record.nightPeriod}박`]],
      ['days', Number.isInteger(record.dayPeriod) ? record.dayPeriod : null, [`${record.dayPeriod}일`]],
      ['inclusions', includes.join('\n'), includes],
      ['exclusions', excludes.join('\n'), excludes],
      ['cancellationPolicy', cancellation, cancellation ? [cancellation.slice(0, 120)] : []],
      ['departureCity', record.beginCityName, [record.beginCityName]],
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
      .map(([field, value, needles]) => ({ field, value, excerpt: sourceExcerpt(visible, needles) || String(needles[0] || value).slice(0, 520) }))
      .concat(priceOptions.evidence),
  };
}

function selectJsonLdProduct(products, url) {
  let requested = '';
  try { requested = new URL(url).href.replace(/\/$/, ''); } catch (_) {}
  const candidateUrl = (product) => {
    const value = product && product.url;
    if (typeof value === 'string') return value.trim();
    if (value && typeof value['@id'] === 'string') return value['@id'].trim();
    return '';
  };
  const sameUrl = products.filter((product) => {
    const candidate = candidateUrl(product);
    if (!candidate) return false;
    try { return new URL(candidate, url).href.replace(/\/$/, '') === requested; } catch (_) { return false; }
  });
  if (sameUrl.length === 1) return sameUrl[0];
  if (products.length === 1 && !candidateUrl(products[0])) return products[0];
  return null;
}

function parseJsonLdData(product, visible, warnings, $) {
  const offers = offerList(product);
  const variants = [];
  const offerGroups = new Map();
  for (const offer of offers) {
    if (String(offer && offer['@type'] || '').toLowerCase() === 'aggregateoffer' || offer && (offer.lowPrice != null || offer.highPrice != null)) {
      warnings.push('AggregateOffer의 최저가·최고가는 특정 옵션 가격으로 가져오지 않았습니다.');
      continue;
    }
    const parsed = offerPrice(offer);
    if (!parsed || parsed.invalid) {
      warnings.push(parsed && parsed.invalid === 'currency' ? `원화가 아닌 가격(${parsed.currency})은 가져오지 않았습니다.` : '가격 범위 또는 확정할 수 없는 가격을 옵션에 넣지 않았습니다.');
      continue;
    }
    const departureDate = /^\d{4}-\d{2}-\d{2}$/.test(String(offer.departureDate || '')) ? offer.departureDate : null;
    const name = String(offer.name || offer.description || '').trim();
    const adults = Number.isInteger(offer.adults) ? offer.adults : null;
    const children = Number.isInteger(offer.children) ? offer.children : null;
    const roomBasis = String(offer.roomBasis || '').trim() || null;
    const label = name || [departureDate, adults != null ? `성인 ${adults}명` : '', roomBasis].filter(Boolean).join(' · ');
    const key = compact(JSON.stringify([label, departureDate, adults, children, roomBasis]));
    if (!offerGroups.has(key)) offerGroups.set(key, []);
    offerGroups.get(key).push({ offer, amount: parsed.amount, departureDate, adults, children, roomBasis, label });
  }
  const evidence = [];
  for (const rows of offerGroups.values()) {
    if (new Set(rows.map((row) => row.amount)).size > 1) {
      warnings.push(`같은 옵션 '${rows[0].label || '기본'}'에 서로 다른 원화 가격이 있어 해당 가격을 모두 보류했습니다.`);
      continue;
    }
    const row = rows[0];
    const offer = row.offer;
    const excerpt = sourceExcerpt(visible, [row.label, `${row.amount.toLocaleString('ko-KR')}원`, String(row.amount)])
      || sourceExcerpt(visible, [product.name, offer.name]) || '';
    const variantId = `v_${crypto.createHash('sha256').update([product.url || product['@id'] || product.name, row.label, row.departureDate, row.amount].join('|')).digest('hex').slice(0, 12)}`;
    const option = row.label ? [row.label] : [];
    variants.push({ id: variantId, currency: 'KRW', amountMinor: row.amount, priceCheckedAt: '', options: option,
      departureDate: row.departureDate, adults: row.adults, children: row.children, roomBasis: row.roomBasis });
    evidence.push({ field: `variant:${variantId}:price`, value: row.amount,
      excerpt: excerpt || `원화 판매가 ${row.amount.toLocaleString('ko-KR')}원` });
    if (row.departureDate) evidence.push({ field: `variant:${variantId}:departureDate`, value: row.departureDate,
      excerpt: sourceExcerpt(visible, [row.departureDate]) || `출발일 ${row.departureDate}` });
    if (row.roomBasis) evidence.push({ field: `variant:${variantId}:roomBasis`, value: row.roomBasis,
      excerpt: sourceExcerpt(visible, [row.roomBasis]) || row.roomBasis });
  }
  if (!variants.length) warnings.push('페이지에서 특정할 수 있는 단일 원화 옵션 가격을 찾지 못했습니다.');

  const description = String(product.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const labelDestination = findLabelValueFromVisible(visible, ['여행지', '목적지', '여행 지역', '방문 지역']);
  const duration = parseDuration([description, visible.join(' ')].join(' '));
  const type = mapTravelType(product.category || product.additionalType || product.serviceType || '');
  const inclusions = listFromSection($, ['포함사항', '포함 항목', '포함 내역'], /^포함(?:사항)?\s*[:：]\s*(.+)$/);
  const exclusions = listFromSection($, ['불포함사항', '불포함 항목', '불포함 내역'], /^불포함(?:사항)?\s*[:：]\s*(.+)$/);
  const cancelSection = sectionText($, ['취소 및 환불', '취소 규정', '환불 규정']);
  const cancelLabel = findLabelValueFromVisible(visible, ['취소 및 환불', '취소 규정', '환불 규정']);
  const cancellationPolicy = cancelSection || cancelLabel || '';
  return {
    name: String(product.name || '').trim(),
    provider: brandName(product),
    destination: labelDestination || '',
    travelType: type || 'other',
    nights: duration.nights,
    days: duration.days,
    inclusions,
    exclusions,
    cancellationPolicy,
    variants,
    fieldEvidence: [
      ['name', product.name, [product.name]],
      ['provider', brandName(product), [brandName(product)]],
      ['destination', labelDestination, [labelDestination]],
      ['travelType', type, [product.category, product.serviceType]],
      ['nights', duration.nights, [`${duration.nights}박`]],
      ['days', duration.days, [`${duration.days}일`]],
      ['inclusions', inclusions.join('\n'), inclusions],
      ['exclusions', exclusions.join('\n'), exclusions],
      ['cancellationPolicy', cancellationPolicy, [cancellationPolicy.slice(0, 100)]],
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
      .map(([field, value, needles]) => ({ field, value, excerpt: sourceExcerpt(visible, needles) || String(needles[0] || value).slice(0, 520) }))
      .concat(evidence),
  };
}

function findLabelValueFromVisible(lines, labels) {
  const wanted = new Set(labels.map(compact));
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (wanted.has(compact(lines[index]))) return lines[index + 1];
    const match = lines[index].match(/^(?:여행지|목적지|여행\s*지역|방문\s*지역)\s*[:：]\s*(.+)$/);
    if (match) return match[1].trim();
  }
  return '';
}

function uniqueWarnings(warnings) {
  return [...new Set(warnings.map((warning) => String(warning || '').trim()).filter(Boolean))];
}

function buildImportedData({ extracted, url, collectedAt, visible, warnings }) {
  const sourceId = 'src_' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  const productId = 'cp_' + crypto.createHash('sha256').update('travel\n' + url).digest('hex').slice(0, 12);
  const variants = (extracted.variants || []).map((variant) => ({ ...variant, priceCheckedAt: collectedAt }));
  const fieldEvidence = (extracted.fieldEvidence || []).map((entry) => ({
    ...entry,
    sourceId,
    excerpt: String(entry.excerpt || '').trim().slice(0, 1200),
  }));
  const facts = fieldEvidence.map((entry) => ({
    field: entry.field,
    value: Array.isArray(entry.value) ? entry.value.join('\n') : entry.value,
    sourceId,
    excerpt: entry.excerpt,
    status: 'unverified',
    checkedAt: null,
  }));
  const travelDetails = {
    destination: String(extracted.destination || '').trim(),
    travelType: ['package', 'hotel', 'flight', 'activity', 'other'].includes(extracted.travelType) ? extracted.travelType : 'other',
    nights: Number.isInteger(extracted.nights) ? extracted.nights : null,
    days: Number.isInteger(extracted.days) ? extracted.days : null,
    inclusions: Array.isArray(extracted.inclusions) ? extracted.inclusions.filter(Boolean) : [],
    exclusions: Array.isArray(extracted.exclusions) ? extracted.exclusions.filter(Boolean) : [],
    cancellationPolicy: String(extracted.cancellationPolicy || '').trim(),
  };
  const name = String(extracted.name || '').trim();
  const provider = String(extracted.provider || '').trim();
  const product = {
    id: productId, connectKind: 'travel', name, provider, detailUrl: url,
    affiliateUrlRaw: '', profileKey: '', eligibility: 'unknown', variants, facts, travelDetails,
    shoppingDetails: null, images: [],
  };
  const missingFields = [];
  if (!name) missingFields.push('name');
  if (!provider) missingFields.push('provider');
  if (!travelDetails.destination) missingFields.push('destination');
  if (travelDetails.travelType === 'other') missingFields.push('travelType');
  if (travelDetails.nights == null) missingFields.push('nights');
  if (travelDetails.days == null) missingFields.push('days');
  if (!travelDetails.inclusions.length) missingFields.push('inclusions');
  if (!travelDetails.exclusions.length) missingFields.push('exclusions');
  if (!travelDetails.cancellationPolicy) missingFields.push('cancellationPolicy');
  if (!variants.length) missingFields.push('price');
  if (variants.some((variant) => !variant.departureDate)) missingFields.push('departureDate');
  if (variants.some((variant) => variant.adults == null && variant.children == null)) missingFields.push('travelerCount');
  if (variants.some((variant) => !variant.roomBasis)) missingFields.push('roomBasis');
  const sourceText = visible.join('\n').slice(0, MAX_SOURCE_EXCERPT);
  const source = {
    id: sourceId, url, accessLevel: 'full-page', publishedAt: null, collectedAt,
    excerpt: sourceText || name || url,
  };
  return {
    product,
    sources: [source],
    fieldEvidence,
    missingFields: [...new Set(missingFields)],
    warnings: uniqueWarnings(warnings),
    collectedAt,
  };
}

function extractTravelProduct({ html, url, collectedAt = new Date().toISOString() } = {}) {
  const checked = validateTravelProductUrl(url);
  if (!checked.valid) throw new ProductImportError(checked.error, checked.kind);
  if (typeof html !== 'string' || !html.trim()) throw new ProductImportError('상품 페이지 내용을 읽지 못했습니다.', 'invalid_content');
  const $ = cheerio.load(html);
  const nextData = safeJson($('#__NEXT_DATA__').text());
  const visible = textLines($);
  const warnings = [];
  const record = nextData ? naverRecord(nextData, url) : null;
  let extracted;
  if (record) {
    extracted = extractNaverData(record, visible, warnings);
  } else {
    const candidates = [];
    $('script[type="application/ld+json"]').each((_, element) => {
      const data = safeJson($(element).text());
      if (data) candidates.push(...jsonLdProducts(data));
      else warnings.push('일부 JSON-LD 자료를 읽을 수 없어 건너뛰었습니다.');
    });
    const selected = selectJsonLdProduct(candidates, url);
    if (candidates.length && !selected) warnings.push('상품 자료가 있으나 이 URL에 해당하는 상품을 특정하지 못했습니다.');
    extracted = selected
      ? parseJsonLdData(selected, visible, warnings, $)
      : {
          name: $('h1').first().text().replace(/\s+/g, ' ').trim(),
          provider: '', destination: findLabelValue($, ['여행지', '목적지', '여행 지역', '방문 지역']),
          travelType: mapTravelType(findLabelValue($, ['여행 유형', '상품 유형', '여행 형태'])) || 'other',
          ...parseDuration(visible.join(' ')),
          inclusions: listFromSection($, ['포함사항', '포함 항목', '포함 내역'], /^포함(?:사항)?\s*[:：]\s*(.+)$/),
          exclusions: listFromSection($, ['불포함사항', '불포함 항목', '불포함 내역'], /^불포함(?:사항)?\s*[:：]\s*(.+)$/),
          cancellationPolicy: sectionText($, ['취소 및 환불', '취소 규정', '환불 규정']),
          variants: [], fieldEvidence: [],
        };
    if (!extracted.name) extracted.name = $('h1').first().text().replace(/\s+/g, ' ').trim();
    if (!extracted.provider) extracted.provider = findLabelValue($, ['판매사', '여행사', '제공사', '공급자']);
    if (!extracted.destination) extracted.destination = findLabelValue($, ['여행지', '목적지', '여행 지역', '방문 지역']);
    if (!extracted.travelType || extracted.travelType === 'other') {
      const type = mapTravelType(findLabelValue($, ['여행 유형', '상품 유형', '여행 형태']));
      if (type) extracted.travelType = type;
    }
    if (!extracted.fieldEvidence.length) {
      const evidenceValues = [
        ['name', extracted.name], ['provider', extracted.provider], ['destination', extracted.destination],
        ['travelType', extracted.travelType === 'other' ? '' : extracted.travelType], ['nights', extracted.nights], ['days', extracted.days],
        ['inclusions', (extracted.inclusions || []).join('\n')], ['exclusions', (extracted.exclusions || []).join('\n')],
        ['cancellationPolicy', extracted.cancellationPolicy],
      ];
      extracted.fieldEvidence = evidenceValues.filter(([, value]) => value !== undefined && value !== null && String(value).trim())
        .map(([field, value]) => ({ field, value, excerpt: sourceExcerpt(visible, [String(value).split('\n')[0]]) || String(value).slice(0, 520) }));
    }
  }
  if (!extracted || (!extracted.name && !extracted.provider && !visible.length)) {
    warnings.push('페이지에서 상품 정보를 확인하지 못했습니다.');
  }
  return buildImportedData({ extracted: extracted || {}, url, collectedAt, visible, warnings });
}

const SHORTLINK_HOSTS = new Set(['naver.me']);

function createTravelProductImporter({ fetchHtml = fetchPublicHtml, resolveUrl, now = () => new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_HTML_BYTES } = {}) {
  if (typeof fetchHtml !== 'function') throw new TypeError('fetchHtml 함수가 필요합니다.');
  return async function importProduct({ url, collectedAt } = {}) {
    try {
      const checked = validateTravelProductUrl(url);
      if (!checked.valid) throw new ProductImportError(checked.error, checked.kind);
      let fetchUrl = url;
      let issuedUrl = '';
      let resolutionChain = null;
      if (SHORTLINK_HOSTS.has(checked.hostname)) {
        if (typeof resolveUrl !== 'function') {
          throw new ProductImportError('발급된 링크 주소를 확인할 수 없습니다. 상품 상세 URL을 직접 입력해 주세요.', 'shortlink_unsupported');
        }
        let resolved;
        try {
          resolved = await timeoutPromise(Promise.resolve(resolveUrl(url)), timeoutMs, '발급 링크 주소 확인 시간이 초과되었습니다.');
        } catch (error) {
          if (error instanceof ProductImportError) throw error;
          throw new ProductImportError('발급된 링크가 가리키는 상품 페이지를 확인하지 못했습니다.', 'redirect', error);
        }
        const resolvedFinalUrl = resolved && typeof resolved === 'object' ? resolved.finalUrl : resolved;
        const resolvedChecked = validateTravelProductUrl(resolvedFinalUrl);
        if (!resolvedChecked.valid) throw new ProductImportError('발급된 링크가 가리키는 주소를 확인하지 못했습니다.', 'redirect');
        resolutionChain = (resolved && typeof resolved === 'object' && Array.isArray(resolved.chain) && resolved.chain.length)
          ? resolved.chain
          : [url, resolvedFinalUrl];
        issuedUrl = url;
        fetchUrl = resolvedFinalUrl;
      }
      const response = await fetchHtml(fetchUrl, { timeoutMs, maxBytes });
      if (!response || typeof response !== 'object') throw new ProductImportError('상품 페이지를 읽지 못했습니다.', 'invalid_content');
      const status = Number(response.status || 0);
      if (status >= 300 && status < 400) throw new ProductImportError('상품 페이지가 다른 주소로 이동해 수집을 중단했습니다.', 'redirect');
      if (status && (status < 200 || status >= 300)) throw new ProductImportError(`상품 페이지 응답이 HTTP ${status}입니다.`, status === 403 || status === 429 ? 'blocked' : 'http_error');
      if (response.finalUrl && response.finalUrl !== fetchUrl) throw new ProductImportError('상품 페이지가 다른 주소로 이동해 수집을 중단했습니다.', 'redirect');
      const timestamp = collectedAt == null ? now().toISOString() : collectedAt;
      if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new ProductImportError('수집 시각 형식이 올바르지 않습니다.', 'invalid_input');
      const imported = extractTravelProduct({ html: response.html, url: fetchUrl, collectedAt: timestamp });
      if (issuedUrl) {
        imported.product.affiliateUrlRaw = issuedUrl;
        imported.resolution = { issuedUrl, finalUrl: fetchUrl, chain: resolutionChain };
      }
      if (/검색\s*서비스\s*이용이\s*제한(?:되었습니다|되어|됩니다)|접근이\s*제한(?:되었습니다|되어|됩니다)/i.test(imported.sources[0].excerpt)) {
        throw new ProductImportError('사이트가 페이지 수집을 제한했습니다.', 'blocked');
      }
      return { ok: true, imported };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : '상품 페이지를 가져오지 못했습니다.', kind: error && error.kind || 'collection_failed' };
    }
  };
}

module.exports = {
  ProductImportError,
  validateTravelProductUrl,
  fetchPublicHtml,
  extractTravelProduct,
  createTravelProductImporter,
  isPublicIp,
  SHORTLINK_HOSTS,
};
