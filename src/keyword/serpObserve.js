const M = require('../scrape/markup');
const health = require('../scrape/health');
const { guardedSearchFetch, NaverSearchBlockedError, isBlockPage } = require('../scrape/naverSearchGuard');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function classifySection(section) {
  const text = String(section || '');
  const rule = M.SERP_SECTION_RULES.find((item) => item.pattern.test(text));
  return rule ? rule.key : null;
}

function flagsFor(parsed) {
  const flags = {
    aiBriefing: false, dictionary: false, ads: false, brandContent: false, shopping: false,
    expertService: false, news: false, kin: false, popularPosts: false, image: false,
    video: false, place: false,
  };
  const classifications = (parsed.sections || []).map(classifySection);
  classifications.forEach((key) => { if (key && Object.prototype.hasOwnProperty.call(flags, key)) flags[key] = true; });
  flags.place = !!parsed.placeLinks || (parsed.sections || []).some((section) => /플레이스|지도/.test(section));
  flags.kin = flags.kin || !!parsed.kinLinks;
  return { flags };
}

function responseParts(response) {
  if (response && typeof response === 'object' && ('body' in response || 'status' in response)) {
    return { status: Number(response.status) || 0, body: response.body };
  }
  return { status: 200, body: response };
}

function cacheResult(key, result, now) {
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}

async function observeSerp(keyword, { fetch = guardedSearchFetch } = {}) {
  const query = String(keyword || '').trim();
  const now = Date.now();
  const cached = cache.get(query);
  if (cached && cached.expiresAt > now) {
    health.record('serp', cached.result.measured ? cached.result.sections.length : 0, {
      query, blocked: cached.result.blocked === true,
    });
    return cached.result;
  }
  if (cached) cache.delete(query);
  if (!query) {
    const result = { measured: false, blocked: false, reason: '키워드가 비어 있음' };
    health.record('serp', 0, { query, blocked: false });
    return result;
  }

  try {
    const response = responseParts(await fetch(M.searchUrl.integrated(query)));
    if (isBlockPage(response.status, response.body)) throw new NaverSearchBlockedError();
    if (response.status !== 200) throw new Error('HTTP ' + (response.status || '오류'));
    const html = Buffer.isBuffer(response.body) ? response.body.toString('utf8') : String(response.body || '');
    const parsed = M.parseSerpSections(html);
    const { flags } = flagsFor(parsed);
    const result = {
      measured: true,
      observedAt: new Date().toISOString(),
      query,
      sections: parsed.sections,
      flags,
      firstSections: parsed.sections.slice(0, 3).map(classifySection).filter(Boolean),
      blogRefs: parsed.blogRefs,
      topDocs: M.grabTitleSnippetPairs(html, { max: 6, snippetLen: 120 }),
    };
    health.record('serp', result.sections.length, { query });
    return cacheResult(query, result, now);
  } catch (error) {
    const blocked = error instanceof NaverSearchBlockedError || error && error.code === 'NAVER_SEARCH_BLOCKED';
    const result = blocked
      ? { measured: false, blocked: true, reason: 'blocked' }
      : { measured: false, blocked: false, reason: String(error && error.message || error || '검색 결과 관찰 실패') };
    health.record('serp', 0, { query, blocked });
    return result;
  }
}

function _resetForTest() { cache.clear(); }

module.exports = { observeSerp, _resetForTest };
