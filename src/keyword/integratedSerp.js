'use strict';

const cheerio = require('cheerio');
const fsDefault = require('node:fs');
const pathDefault = require('node:path');

const SKIP_CHILD_CLASS_HINTS = [
  '_scrollLog', 'ban_whale_download', '_fe_whale_banner_bottom',
  'api_sc_page_wrap', 'sp_page', 'ct_feed_wrap',
];
const EXCLUDED_HOSTS = ['ader.naver.com', 'help.naver.com', 'm.keep.naver.com', 'keep.naver.com'];
const EXTRACT_HTML = 'document.documentElement.outerHTML';
const READY_SERP = '(function(){var r=document.querySelector("#main_pack");if(!r||!r.children.length)return false;var t=(r.innerText||"").replace(/\\s+/g," ").trim();return t.length>=40||r.querySelectorAll("a[href]").length>0;})()';

function normalizeText(value) {
  return String(value || '').replace(/새 창 열림|새창 열림/g, '').replace(/\s+/g, ' ').trim();
}

function getClassList($, element) {
  return String($(element).attr('class') || '').split(/\s+/).filter(Boolean);
}

function firstHeading($, container) {
  for (const tag of ['h2', 'h3', 'strong']) {
    const heading = $(container).find(tag).first();
    if (!heading.length) continue;
    const titleElement = [heading[0], ...heading.find('*').toArray()]
      .find((element) => getClassList($, element).some((name) => name.includes('title')));
    if (titleElement) {
      const directText = $(titleElement).contents().filter((_, node) => node.type === 'text').first().text();
      const direct = normalizeText(directText);
      if (direct) return direct;
    }
    const text = normalizeText(heading.text());
    if (text) return text;
  }
  return '';
}

function findRoot($) {
  const main = $('#main_pack').first();
  if (main.length) return main;
  const place = $('.place-app-root, #place-app-root').first();
  if (place.length && place.parent().length) return place.parent();
  const body = $('body').first();
  return body.length ? body : $.root();
}

function topLevelBlocks($, root) {
  return root.children().toArray().filter((element) => {
    const tag = String(element.name || '').toLowerCase();
    if (['script', 'style', 'link'].includes(tag)) return false;
    const classes = getClassList($, element);
    if (classes.some((name) => SKIP_CHILD_CLASS_HINTS.some((hint) => name.includes(hint)))) return false;
    if ($(element).attr('id') === 'snb') return false;
    const text = normalizeText($(element).text());
    if (!text) return false;
    if (!$(element).find('h2,h3,strong').length && $(element).find('a[href]').length <= 3
      && /^(?:검색\s*옵션|페이지\s*(?:이동|\d+)|이전\s*페이지|다음\s*페이지|브라우저\s*안내)/.test(text)) return false;
    return true;
  });
}

function classifyBlock($, element) {
  const classes = getClassList($, element);
  const id = String($(element).attr('id') || '');
  if (classes.includes('place-app-root') || id === 'place-app-root') {
    const labels = new Set($(element).find('strong').toArray().map((label) => normalizeText($(label).text())));
    if (labels.has('주소') && labels.has('전화번호')) return { blockName: '업체 상세정보', blockKind: 'place-detail' };
    const heading = firstHeading($, element);
    if (heading.startsWith('새로 오픈했어요')) return { blockName: '새로 오픈했어요', blockKind: 'place' };
    return { blockName: heading || '플레이스', blockKind: 'place' };
  }
  if (String(element.name || '').toLowerCase() === 'section' && classes.length === 0) {
    return { blockName: '검색광고', blockKind: 'ad' };
  }
  if (classes.includes('spw_fsolid')) return { blockName: '관련문서', blockKind: 'related-docs' };
  if (classes.includes('_fe_view_root')) return { blockName: firstHeading($, element) || '브랜드 콘텐츠', blockKind: 'brand-content' };
  const heading = firstHeading($, element);
  return heading ? { blockName: heading, blockKind: 'content' } : { blockName: '기타', blockKind: 'unknown' };
}

function isExcludedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return EXCLUDED_HOSTS.some((excluded) => host === excluded || host.endsWith('.' + excluded));
}

function sourceTypeFor(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'blog.naver.com' || host.endsWith('.blog.naver.com')) return '블로그';
  if (host === 'cafe.naver.com' || host.endsWith('.cafe.naver.com')) return '카페';
  if (host === 'kin.naver.com' || host.endsWith('.kin.naver.com')) return '지식iN';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be'
    || host === 'tv.naver.com' || host.endsWith('.tv.naver.com')
    || host === 'clip.naver.com' || host.endsWith('.clip.naver.com')
    || host === 'chzzk.naver.com' || host.endsWith('.chzzk.naver.com')) return '영상';
  return host === 'naver.com' || host.endsWith('.naver.com') ? '네이버기타' : '웹';
}

function isReplyText(text) {
  return text.startsWith('RE') && text.length > 2 && !/\s|\d/.test(text[2]);
}

function extractItems($, element) {
  const byHref = new Map();
  const order = [];
  let sourceLabel = '';
  for (const anchor of $(element).find('a[href]').toArray()) {
    if ($(anchor).attr('data-heatmap-target') === '.sublink') continue;
    const rawUrl = String($(anchor).attr('href') || '').trim();
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    let parsed;
    try { parsed = new URL(rawUrl); } catch (_) { continue; }
    if (isExcludedHost(parsed.hostname)) continue;
    const clone = $(anchor).clone();
    clone.find('.place_blind').remove();
    const text = normalizeText(clone.text());
    if (!text || isReplyText(text)) continue;
    const hasMark = clone.find('mark').length > 0;
    const depth = parsed.pathname.split('/').filter(Boolean).length;
    const rootLike = depth <= 1 && text.length <= 20 && !parsed.search && !hasMark;
    if (rootLike) {
      sourceLabel = text;
      continue;
    }
    if (text.length < 8) continue;
    if (!byHref.has(rawUrl)) {
      byHref.set(rawUrl, { title: text, url: rawUrl, parsed, hasMark });
      order.push(rawUrl);
    } else if (hasMark && !byHref.get(rawUrl).hasMark) {
      byHref.set(rawUrl, { title: text, url: rawUrl, parsed, hasMark });
    }
  }

  const seenTitles = new Set();
  const items = [];
  for (const href of order) {
    const row = byHref.get(href);
    if (seenTitles.has(row.title)) continue;
    seenTitles.add(row.title);
    items.push({
      title: row.title,
      url: row.url,
      domain: row.parsed.hostname.toLowerCase(),
      sourceType: sourceTypeFor(row.parsed.hostname),
      sourceLabel: sourceLabel || row.parsed.hostname.toLowerCase(),
    });
  }
  return items;
}

function matchesSite(item, domains) {
  const host = String(item && item.domain || '').toLowerCase();
  return (Array.isArray(domains) ? domains : []).some((domain) => {
    const normalized = String(domain || '').toLowerCase().replace(/^\.+|\.+$/g, '');
    return normalized && (host === normalized || host.endsWith('.' + normalized));
  });
}

function matchesPost(item, trackedPost) {
  if (!trackedPost || !trackedPost.blogId || !trackedPost.logNo) return false;
  if (!['blog.naver.com', 'm.blog.naver.com'].includes(item.domain)) return false;
  let url;
  try { url = new URL(item.url); } catch (_) { return false; }
  const parts = url.pathname.split('/').filter(Boolean);
  return String(parts[0] || '') === String(trackedPost.blogId) && String(parts[1] || '') === String(trackedPost.logNo);
}

function parseIntegratedSerp(html, { domains = [], trackedPost = null } = {}) {
  const $ = cheerio.load(Buffer.isBuffer(html) ? html.toString('utf8') : String(html || ''));
  const root = findRoot($);
  const children = topLevelBlocks($, root);
  const blocks = [];
  const items = [];
  const postHits = [];
  const siteHits = [];
  let blockOrder = 0;

  for (const element of children) {
    const classification = classifyBlock($, element);
    if (classification.blockKind === 'unknown') continue;
    blockOrder += 1;
    const block = { blockOrder, ...classification, items: [] };
    for (const item of extractItems($, element)) {
      const positionInBlock = block.items.length + 1;
      const observed = { ...item, blockOrder, blockName: block.blockName, blockKind: block.blockKind, positionInBlock, overallDocPosition: items.length + 1 };
      block.items.push(observed);
      items.push(observed);
      const hit = {
        blockOrder, blockName: block.blockName, blockKind: block.blockKind,
        positionInBlock, overallDocPosition: observed.overallDocPosition,
      };
      if (matchesPost(item, trackedPost)) postHits.push(hit);
      if (matchesSite(item, domains)) siteHits.push(hit);
    }
    blocks.push(block);
  }

  const warnings = [];
  if (!blocks.length) warnings.push('통합검색 블록을 추출하지 못했습니다. 네이버 DOM 변경 또는 차단 여부를 확인하세요.');
  else if (blocks.length < 3) warnings.push(`통합검색 블록이 ${blocks.length}개뿐입니다. 파서 결과를 확인하세요.`);
  const site = siteHits[0] || null;
  return {
    measured: blocks.length > 0,
    blocked: false,
    blocks,
    items,
    postHits,
    siteHits,
    postFound: postHits[0] || null,
    siteFound: site ? { blockName: site.blockName, positionInBlock: site.positionInBlock } : null,
    warnings,
  };
}

async function collectIntegratedSerp(keyword, {
  runGuardedSearch,
  scrapeRendered,
  searchUrl,
  userAgent,
  domains = [],
  trackedPost = null,
} = {}) {
  const query = String(keyword || '').trim();
  if (!query) return { measured: false, blocked: false, reason: '키워드가 비어 있음', blocks: [], postFound: null, siteFound: null };
  if (typeof runGuardedSearch !== 'function' || typeof scrapeRendered !== 'function' || typeof searchUrl !== 'function') {
    throw new TypeError('통합검색 수집에는 guard, 렌더 수집기, 검색 URL 빌더가 필요합니다.');
  }
  const url = searchUrl(query);
  const response = await runGuardedSearch(url, async () => {
    const rendered = await scrapeRendered(url, EXTRACT_HTML, 0, 'persist:naver-search', userAgent, { readyScript: READY_SERP, timeoutMs: 12000 });
    if (rendered && typeof rendered === 'object' && !Buffer.isBuffer(rendered)) {
      if (rendered.error) {
        const status = Number(rendered.status) || undefined;
        const kind = rendered.kind || (status === 429 ? 'rate_limited' : status === 403 ? 'blocked' : 'render_error');
        throw Object.assign(new Error(String(rendered.error)), { status, kind, code: rendered.code });
      }
      if (rendered.body != null) return { status: Number(rendered.status) || 200, body: rendered.body };
    }
    return { status: 200, body: Buffer.isBuffer(rendered) ? rendered : String(rendered || '') };
  });
  const body = response && response.body != null ? response.body : '';
  return parseIntegratedSerp(body, { domains, trackedPost });
}

function slotForObservation(result, priorSlot) {
  if (!result || !result.measured) return priorSlot;
  const blogBlock = (result.blocks || []).find((block) => (block.items || []).some((item) => item.sourceType === '블로그'));
  if (!blogBlock) return 'low';
  if (Number(blogBlock.blockOrder) <= 2) return 'high';
  if (Number(blogBlock.blockOrder) <= 5) return 'mid';
  return 'low';
}

function noteForObservation(result) {
  if (!result || !result.measured) return result && result.reason ? `관찰 실패: ${result.reason}` : '관찰 결과 없음';
  const blocks = (result.blocks || []).slice(0, 8).map((block) => {
    const blogCount = (block.items || []).filter((item) => item.sourceType === '블로그').length;
    return `${block.blockOrder} ${block.blockName}${blogCount ? ` (블로그 ${blogCount})` : ''}`;
  });
  if (result.siteFound) blocks.push(`사이트 자체 노출 ${result.siteFound.blockName} ${result.siteFound.positionInBlock}위`);
  return blocks.join(' · ') || '인식한 블록 없음';
}

function isBlocked(errorOrResult) {
  const value = errorOrResult || {};
  return value.blocked === true || value.code === 'NAVER_SEARCH_BLOCKED' || value.code === 'NAVER_SEARCH_RATE_LIMITED'
    || value.kind === 'blocked' || value.kind === 'rate_limited';
}

async function analyzeTopicKeywordPlan(topic, { collect, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random, now = () => new Date() } = {}) {
  if (!topic || !Array.isArray(topic.keywordPlan)) throw new TypeError('키워드 계획이 필요합니다.');
  if (typeof collect !== 'function') throw new TypeError('SERP 관찰 함수를 주입해야 합니다.');
  const keywordPlan = topic.keywordPlan.map((entry) => ({ ...entry }));
  const observations = [];
  let blocked = false;
  for (let index = 0; index < keywordPlan.length; index += 1) {
    if (index > 0) {
      const value = Number(random());
      const fraction = Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0.5;
      await sleep(15000 + Math.floor(fraction * 10001));
    }
    const plan = keywordPlan[index];
    let result;
    try { result = await collect(plan.keyword, plan); }
    catch (error) {
      if (isBlocked(error)) {
        blocked = true;
        observations.push({ keyword: plan.keyword, measured: false, blocked: true, reason: String(error && error.message || '검색 제한') });
        break;
      }
      result = { measured: false, blocked: false, reason: String(error && error.message || '수집 실패'), blocks: [] };
    }
    if (isBlocked(result)) {
      blocked = true;
      observations.push({ keyword: plan.keyword, measured: false, blocked: true, reason: String(result.reason || '검색 제한') });
      break;
    }
    const observedAt = now().toISOString();
    const observation = {
      keyword: plan.keyword, measured: !!(result && result.measured), blocked: false,
      observedAt, reason: result && result.reason || '',
      blocks: (result && result.blocks || []).map((block) => ({
        blockOrder: block.blockOrder, blockName: block.blockName, blockKind: block.blockKind,
        itemCount: (block.items || []).length,
        blogCount: (block.items || []).filter((item) => item.sourceType === '블로그').length,
      })),
      siteFound: result && result.siteFound || null,
    };
    observations.push(observation);
    if (observation.measured) {
      keywordPlan[index] = {
        ...plan,
        blogSlot: slotForObservation(result, plan.blogSlot),
        serpNote: noteForObservation(result),
        observedAt: observedAt.slice(0, 10),
      };
    }
  }
  return { topicId: topic.id || '', observedAt: now().toISOString(), blocked, keywordPlan, observations };
}

function saveTopicSerpSnapshot(directory, snapshot, { fs = fsDefault, path = pathDefault } = {}) {
  const dateKey = String(snapshot && snapshot.dateKey || '').replace(/\D/g, '').slice(0, 8);
  if (!dateKey || dateKey.length !== 8) throw new Error('SERP 저장 날짜가 올바르지 않습니다.');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `topic-serp-${dateKey}.json`);
  fs.writeFileSync(file + '.tmp', JSON.stringify(snapshot, null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
  return file;
}

module.exports = {
  parseIntegratedSerp, collectIntegratedSerp, analyzeTopicKeywordPlan,
  saveTopicSerpSnapshot, EXTRACT_HTML, READY_SERP,
};
