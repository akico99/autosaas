// ★네이버·외부 사이트 "마크업 의존부"를 한 곳에 모은 파일.
//
// 왜 한 파일인가:
//   네이버가 검색결과·랭킹 페이지의 클래스명을 바꾸면 수집이 전부 조용히 0건이 된다
//   (각 수집 함수가 catch → [] 라 에러도 안 난다). 셀렉터가 여기저기 박혀 있으면
//   "어디가 깨졌는지" 찾는 데만 한참 걸린다. 그래서 깨질 수 있는 것은 전부 여기 둔다.
//
// 깨졌을 때 고치는 순서:
//   1) `npm run doctor` 로 어느 소스가 0건인지 확인 (scripts/doctor.js)
//   2) 아래 상수 중 그 소스의 셀렉터를 실제 페이지에서 다시 찾아 고친다
//      (구조 파악용 덤프 스크립트 DISCOVER_DUMP 를 쓰면 리스트 후보가 나온다)
//   3) 고친 뒤 다시 doctor 로 확인
//
// 종류:
//   A. HTML 정규식 — Node에서 받은 HTML 문자열을 직접 파싱 (검색결과·기사)
//   B. 페이지 실행 스크립트 — Electron 숨은 창에서 executeJavaScript 로 실행 (JS 렌더 페이지)

// ─────────────────────────────────────────────────────────────
// A. HTML 정규식
// ─────────────────────────────────────────────────────────────
const cheerio = require('cheerio');

// 네이버 통합검색(뉴스·블로그) 결과의 텍스트 컴포넌트 클래스.
// 예) <span class="sds-comps-text sds-comps-text-type-headline1 ...">제목</span>
//     headline1 = 제목 / body1 = 요약 스니펫
// ★네이버가 디자인 시스템(sds)을 갈아엎으면 여기부터 깨진다.
const SDS_TEXT_CLASS = 'sds-comps-text-type-';

// HTML 엔티티·태그를 걷어낸 순수 텍스트.
function decodeText(s) {
  return String(s || '').replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** 검색결과 HTML에서 특정 타입(headline1/body1 등) 텍스트를 순서대로 뽑는다. */
function grabSds(html, type, max = 10) {
  const re = new RegExp('<span[^>]*' + SDS_TEXT_CLASS + type + '[^>]*>([\\s\\S]*?)</span>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    const t = decodeText(m[1]);
    if (t) out.push(t);
  }
  return out;
}

const HEADLINE_SELECTOR = 'span[class*="sds-comps-text-type-headline1"]';
const BODY_SELECTOR = 'span[class*="sds-comps-text-type-body1"]';
const CARD_SELECTOR = '.sds-comps-vertical-layout, .sds-comps-base-layout';

function readAbsoluteHref($, element) {
  const raw = $(element).closest('a[href]').attr('href');
  if (!raw || !/^https?:\/\//i.test(raw.trim())) return null;
  try {
    const parsed = new URL(raw.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (parsed.hostname === 'search.naver.com') return null;
    return { raw: raw.trim(), parsed };
  } catch (_) { return null; }
}

function sourceUrlAllowed(url, sourceType) {
  if (!url) return false;
  if (sourceType === 'blog-snippet') {
    if (!['blog.naver.com', 'm.blog.naver.com'].includes(url.hostname)) return false;
    if (/^\/(?:PostView\.naver)$/i.test(url.pathname)) return !!(url.searchParams.get('blogId') && url.searchParams.get('logNo'));
    return /^\/[A-Za-z0-9_-]+\/\d{6,}\/?$/.test(url.pathname);
  }
  if (sourceType !== 'news-snippet') return false;
  const hostname = url.hostname.toLowerCase();
  const disallowed = /(?:^|\.)(?:blog\.naver\.com|cafe\.naver\.com|kin\.naver\.com|map\.naver\.com|shopping\.naver\.com|smartstore\.naver\.com|namu\.wiki|wikipedia\.org|youtube\.com|tiktok\.com|instagram\.com|facebook\.com)$/i;
  if (disallowed.test(hostname) || hostname === 'search.naver.com') return false;
  const knownNaverArticle = hostname === 'n.news.naver.com' && /(?:^|\/)mnews\/article\/\d{2,4}\/\d{6,}/i.test(url.pathname);
  const articlePath = /(?:^|\/)(?:article|news|story|press|report|read|view)(?:[./_-]|$)/i.test(url.pathname);
  return knownNaverArticle || articlePath;
}

function hasAdMarker($, card) {
  let scope = $(card);
  while (scope.length && !scope.is('body, html')) {
    if (scope.find(HEADLINE_SELECTOR).length > 1) break;
    const marker = scope.find('[aria-label*="광고"], [class*="ad-badge"], [class*="advert"], [data-ad]');
    if (marker.length > 0 || scope.find('[class*="badge"], [class*="label"]').toArray().some((item) => /^광고$/.test($(item).text().trim()))) return true;
    scope = scope.parent();
  }
  return false;
}

function parseSearchCards(html, { max = 8, minSnippet = 20, sourceType = 'news-snippet', collectedAt = new Date().toISOString() } = {}) {
  const $ = cheerio.load(String(html || ''));
  const observedAt = Number.isFinite(Date.parse(collectedAt)) ? new Date(collectedAt).toISOString() : new Date().toISOString();
  const headlines = $(HEADLINE_SELECTOR).toArray();
  const seen = new Set();
  const sources = [];

  for (const headline of headlines) {
    if (sources.length >= max) break;
    const title = $(headline).text().replace(/\s+/g, ' ').trim();
    const titleLink = readAbsoluteHref($, headline);
    if (!title || !titleLink || !sourceUrlAllowed(titleLink.parsed, sourceType)) continue;

    let card = $(headline).parent();
    let source = null;
    while (card.length && !card.is('body, html')) {
      if (card.is(CARD_SELECTOR)) {
        const cardHeadlines = card.find(HEADLINE_SELECTOR);
        if (cardHeadlines.length === 1 && !hasAdMarker($, card)) {
          const snippets = card.find(BODY_SELECTOR).toArray();
          for (const snippet of snippets) {
            const snippetLink = readAbsoluteHref($, snippet);
            const text = $(snippet).text().replace(/\s+/g, ' ').trim();
            if ((!snippetLink || snippetLink.raw === titleLink.raw) && text.length >= minSnippet) {
              source = {
                url: titleLink.raw,
                title,
                text: text.slice(0, 2000),
                sourceType,
                kind: 'search-snippet',
                contentKind: 'snippet',
                collectedAt: observedAt,
              };
              break;
            }
          }
        }
        if (source) break;
      }
      card = card.parent();
    }
    if (!source) continue;
    const key = `${source.url}\n${source.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }

  const noResultText = $('.not_found02').toArray().map((element) => $(element).text()).join(' ');
  const explicitNoResults = headlines.length === 0 && /검색\s*결과가\s*없습니다|검색결과가\s*없습니다|결과가\s*없습니다/.test(noResultText);
  const resultKind = sources.length ? 'ok' : explicitNoResults ? 'no_results' : 'parser_mismatch';
  return { sources, resultKind, parserMismatch: resultKind === 'parser_mismatch', observedAt };
}

function attachSourceMetadata(array, parsed) {
  Object.defineProperties(array, {
    sources: { value: parsed.sources, enumerable: false, configurable: true },
    resultKind: { value: parsed.resultKind, enumerable: false, configurable: true },
    parserMismatch: { value: parsed.parserMismatch, enumerable: false, configurable: true },
  });
  return array;
}

/** Return legacy title/snippet strings while retaining verified card provenance on `.sources`. */
function grabTitleSnippetPairs(html, { max = 8, snippetLen = 180, minSnippet = 20, sourceType = 'news-snippet', collectedAt } = {}) {
  const parsed = parseSearchCards(html, { max, minSnippet, sourceType, collectedAt });
  const out = parsed.sources.map((source) => `${source.title} — ${source.text.slice(0, snippetLen)}`);
  return attachSourceMetadata(out, parsed);
}

/** Unverified SERP observation text; intentionally carries no source records. */
function grabObservedTitleSnippetPairs(html, { max = 6, snippetLen = 120, minSnippet = 1 } = {}) {
  const $ = cheerio.load(String(html || ''));
  const out = [];
  const seen = new Set();
  for (const headline of $(HEADLINE_SELECTOR).toArray()) {
    const title = $(headline).text().replace(/\s+/g, ' ').trim();
    if (!title || seen.has(title)) continue;
    let scope = $(headline).parent();
    while (scope.length && !scope.is('html')) {
      const titles = scope.find(HEADLINE_SELECTOR);
      const bodies = scope.find(BODY_SELECTOR);
      if (titles.length === 1 && bodies.length === 1) {
        const snippet = bodies.first().text().replace(/\s+/g, ' ').trim();
        if (snippet.length >= minSnippet) {
          seen.add(title);
          out.push(`${title} — ${snippet.slice(0, snippetLen)}`);
        }
        break;
      }
      scope = scope.parent();
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Title-only legacy reference list, restricted to explicit blog-host cards. */
function grabCardTitles(html, max = 16) {
  const $ = cheerio.load(String(html || ''));
  const out = [];
  const seen = new Set();
  for (const headline of $(HEADLINE_SELECTOR).toArray()) {
    const title = $(headline).text().replace(/\s+/g, ' ').trim();
    const link = readAbsoluteHref($, headline);
    if (!title || !link || !['blog.naver.com', 'm.blog.naver.com'].includes(link.parsed.hostname)) continue;
    let card = $(headline).parent();
    let validCard = false;
    while (card.length && !card.is('body, html')) {
      if (card.is(CARD_SELECTOR) && card.find(HEADLINE_SELECTOR).length === 1 && sourceUrlAllowed(link.parsed, 'blog-snippet')) {
        validCard = !hasAdMarker($, card);
        if (validCard) break;
      }
      card = card.parent();
    }
    if (!validCard || seen.has(title)) continue;
    seen.add(title);
    out.push(title);
    if (out.length >= max) break;
  }
  return out;
}

// 네이버 기사 링크(스포츠·연예·일반)에서 oid/aid + 종류를 뽑는 정규식.
// 예) https://n.news.naver.com/mnews/article/001/0012345678
//     https://m.sports.naver.com/wfootball/article/477/0000123456
// ★주소 체계가 바뀌면 기사 본문·기사 이미지 수집이 동시에 죽는다.
const ARTICLE_LINK_RE = /https?:\/\/(?:m\.)?(sports|entertain|n)\.(?:news\.)?naver\.com\/[a-z]*\/?(?:mnews\/)?article\/(\d{2,4})\/(\d{6,})/gi;

/** 검색결과 HTML → [{oid, aid, kind}] (중복 제거). kind = sports|entertain|news */
function grabArticleRefs(html, max = 8) {
  const $ = cheerio.load(String(html || ''));
  const seen = new Set();
  const items = [];
  for (const anchor of $('a[href]').toArray()) {
    if (items.length >= max) break;
    const href = $(anchor).attr('href');
    if (!href || !/^https?:\/\//i.test(href)) continue;
    let parsed;
    try { parsed = new URL(href); } catch (_) { continue; }
    const hostname = parsed.hostname.toLowerCase();
    const kind = hostname.endsWith('sports.naver.com') && (hostname === 'sports.naver.com' || hostname === 'm.sports.naver.com')
      ? 'sports'
      : hostname === 'entertain.naver.com' || hostname === 'm.entertain.naver.com'
        ? 'entertain'
        : hostname === 'n.news.naver.com' ? 'news' : null;
    const match = parsed.pathname.match(/(?:^|\/)(?:mnews\/)?article\/(\d{2,4})\/(\d{6,})(?:\/|$)/i);
    if (!kind || !match) continue;
    const key = match[1] + '/' + match[2];
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ oid: match[1], aid: match[2], kind, url: href });
  }
  return items;
}

// 기사 본문 영역(일반뉴스 모바일). 스포츠·연예는 api-gw JSON을 쓰므로 정규식 불필요.
const ARTICLE_BODY_RE = /<article[^>]*id=["']dic_area["'][^>]*>([\s\S]*?)<\/article>/i;
const ARTICLE_TITLE_RE = /<h2[^>]*id=["']title_area["'][^>]*>([\s\S]*?)<\/h2>/i;

// 검색 URL 빌더 — 쿼리 파라미터가 바뀌면 여기만 고친다.
const searchUrl = {
  news: (q) => 'https://search.naver.com/search.naver?where=news&sort=1&query=' + encodeURIComponent(q),
  blog: (q) => 'https://search.naver.com/search.naver?where=blog&query=' + encodeURIComponent(q),
  integrated: (q) => 'https://search.naver.com/search.naver?where=nexearch&query=' + encodeURIComponent(q),
};

const SERP_SECTION_RULES = [
  { key: 'aiBriefing', pattern: /AI\s*브리핑/ },
  { key: 'dictionary', pattern: /국어사전|어학사전|영어사전|지식백과|백과사전/ },
  { key: 'ads', pattern: /관련 광고|파워링크/ },
  { key: 'brandContent', pattern: /브랜드 콘텐츠/ },
  { key: 'shopping', pattern: /가격비교|플러스 스토어|쇼핑/ },
  { key: 'expertService', pattern: /상담|엑스퍼트/ },
  { key: 'news', pattern: /뉴스/ },
  { key: 'kin', pattern: /지식iN/ },
  { key: 'popularPosts', pattern: /인기글/ },
  { key: 'image', pattern: /^이미지$/ },
  { key: 'video', pattern: /동영상|클립/ },
];

/** 통합검색 HTML에서 섹션 제목과 블로그 문서 참조만 관찰한다. */
function parseSerpSections(html) {
  const source = String(html || '');
  const $ = cheerio.load(source);
  const sections = [];
  const seenSections = new Set();
  const headingRe = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  let match;
  while ((match = headingRe.exec(source)) && sections.length < 20) {
    const heading = decodeText(match[1]);
    if (!heading || /\s검색 결과$/.test(heading) || seenSections.has(heading)) continue;
    seenSections.add(heading);
    sections.push(heading);
  }

  const blogRefs = [];
  const seenBlogs = new Set();
  const blogRe = /https?:\/\/(?:m\.)?blog\.naver\.com\/([A-Za-z0-9_-]+)\/(\d{9,})(?=[/?#"'\s]|$)/gi;
  while ((match = blogRe.exec(source)) && blogRefs.length < 30) {
    const blogId = match[1];
    const logNo = match[2];
    const key = blogId + '/' + logNo;
    if (seenBlogs.has(key)) continue;
    seenBlogs.add(key);
    blogRefs.push({ blogId, logNo, url: 'https://blog.naver.com/' + key });
  }

  const placeLinks = /(?:pcmap\.)?place\.naver\.com|map\.naver\.com/i.test(source);
  const kinLinks = /kin\.naver\.com\/qna/i.test(source);
  const noResultText = $('.not_found02, #main_pack .no_result, #main_pack .not_found').toArray()
    .map((element) => $(element).text()).join(' ');
  const explicitNoResults = /검색\s*결과가\s*없습니다|검색결과가\s*없습니다|결과가\s*없습니다/.test(noResultText);
  const resultKind = sections.length || blogRefs.length || placeLinks || kinLinks ? 'ok' : explicitNoResults ? 'no_results' : 'parser_mismatch';
  return {
    sections,
    blogRefs,
    placeLinks,
    kinLinks,
    resultKind,
  };
}

// ─────────────────────────────────────────────────────────────
// B. 페이지 실행 스크립트 (Electron 숨은 창 executeJavaScript)
// ─────────────────────────────────────────────────────────────

// 정부·공식 사이트에서 본문 이미지 후보를 크기순으로. (로고·아이콘·배너는 이름으로 제외)
const OFFICIAL_IMG_EXTRACT = "(function(){function abs(u){try{return new URL(u,location.href).href;}catch(e){return u;}}var out=[],seen={};[].slice.call(document.querySelectorAll('img')).forEach(function(i){var s=i.currentSrc||i.src||i.getAttribute('data-src')||'';if(!s||/^data:/.test(s))return;var w=i.naturalWidth||i.width||0,h=i.naturalHeight||i.height||0;if(w&&h&&(w<220||h<160))return;if(/logo|icon|sprite|banner|btn[_-]|button|favicon|profile|thumb_s|blank|spacer|footer|header_/i.test(s))return;var u=abs(s);if(seen[u])return;seen[u]=1;out.push({url:u,w:w,h:h});});out.sort(function(a,b){return (b.w*b.h)-(a.w*a.h);});return JSON.stringify(out.slice(0,8));})()";

// Pexels(무료 스톡) 검색결과에서 원본 이미지 URL. ★images.pexels.com 주소 패턴 의존.
const PEXELS_EXTRACT = "(function(){var seen={},out=[];[].slice.call(document.querySelectorAll('img')).forEach(function(i){var s=i.src||i.getAttribute('data-src')||i.getAttribute('srcset')||'';var m=s.match(/https:\\/\\/images\\.pexels\\.com\\/photos\\/\\d+\\/[^\"'?\\s]+\\.(?:jpe?g|png)/i);if(!m)return;var u=m[0];if(seen[u])return;seen[u]=1;out.push(u+'?auto=compress&cs=tinysrgb&w=1200');});return JSON.stringify(out.slice(0,20));})()";

// 네이버 이미지검색 결과 → 원본 URL(프록시 주소에서 src= 파라미터를 풀어냄). ★search.pstatic.net 패턴 의존.
const NAVER_IMG_EXTRACT = "(function(){function dec(u){try{var m=u.match(/[?&]src=([^&]+)/);return m?decodeURIComponent(m[1]):u;}catch(e){return u;}}var seen={},out=[];[].slice.call(document.querySelectorAll('img')).forEach(function(i){var s=i.src||i.getAttribute('data-src')||'';if(!/search\\.pstatic\\.net\\/common/.test(s))return;var u=dec(s);if(seen[u])return;seen[u]=1;var host=(u.match(/^https?:\\/\\/([^\\/]+)/)||[''])[1]||'';out.push({url:u,host:host,proxy:s});});return JSON.stringify(out.slice(0,30));})()";

// 연예·스포츠 인기 랭킹(모바일). ★클래스명이 NewsList_news_list__* / NewsRanking_news_list__* 형태라 부분일치로 잡는다.
const ENT_URL = 'https://m.entertain.naver.com/ranking';
const SPT_URL = 'https://m.sports.naver.com/ranking/index?type=popular';
const ENT_EXTRACT = "(function(){var out=[],seen={};document.querySelectorAll('[class*=\"NewsList_news_list\"] li').forEach(function(li){var t=(li.textContent||'').replace(/\\s+/g,' ').trim().replace(/^\\d+위\\s*/,'').trim();if(t&&t.length>5&&!seen[t]){seen[t]=1;out.push(t.slice(0,70));}});return JSON.stringify({items:out.slice(0,12)});})()";
const SPT_EXTRACT = "(function(){var out=[],seen={};document.querySelectorAll('[class*=\"NewsRanking_news_list\"] li').forEach(function(li){var t=(li.textContent||'').replace(/\\s+/g,' ').trim().replace(/^\\d+\\.?\\s*/,'').trim();if(t&&t.length>5&&!seen[t]){seen[t]=1;out.push(t.slice(0,70));}});return JSON.stringify({items:out.slice(0,12)});})()";

// ★구조 파악용 덤프 — 셀렉터가 깨졌을 때 "지금 이 페이지에 어떤 리스트가 있는지" 후보를 뽑아본다.
//   깨진 페이지에 이걸 실행해 새 클래스명을 찾은 뒤 위 상수를 고친다.
const DISCOVER_DUMP = "(function(){var out=[];document.querySelectorAll('ol,ul').forEach(function(l){var lis=l.querySelectorAll('li');if(lis.length>=5&&lis.length<=30){out.push({cls:(l.className||'').toString().slice(0,60),count:lis.length,sample:[].slice.call(lis).slice(0,3).map(function(li){return (li.textContent||'').replace(/\\s+/g,' ').trim().slice(0,45);})});}});return JSON.stringify(out.slice(0,10),null,1);})()";

module.exports = {
  // A
  SDS_TEXT_CLASS, decodeText, grabSds, parseSearchCards, grabTitleSnippetPairs, grabObservedTitleSnippetPairs, grabCardTitles, attachSourceMetadata,
  ARTICLE_LINK_RE, grabArticleRefs, ARTICLE_BODY_RE, ARTICLE_TITLE_RE, searchUrl,
  SERP_SECTION_RULES, parseSerpSections,
  // B
  OFFICIAL_IMG_EXTRACT, PEXELS_EXTRACT, NAVER_IMG_EXTRACT,
  ENT_URL, SPT_URL, ENT_EXTRACT, SPT_EXTRACT, DISCOVER_DUMP,
};
