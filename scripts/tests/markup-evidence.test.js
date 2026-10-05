const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../../src/scrape/markup');
const guard = require('../../src/scrape/naverSearchGuard');
const trends = require('../../src/keyword/trends');
const health = require('../../src/scrape/health');
const { collectKeywordSources } = require('../../src/generator/generatePost');

const collectedAt = '2026-10-05T00:00:00.000Z';
const blogUrl = 'https://blog.naver.com/officialblog/224012345678';

function card({ url, title, snippet, bodyHref = url }) {
  return '<div class="sds-comps-base-layout sds-comps-vertical-layout result-card">'
    + '<div class="sds-comps-vertical-layout"><a href="' + url + '"><span class="sds-comps-text sds-comps-text-type-headline1">' + title + '</span></a></div>'
    + (snippet ? '<div class="sds-comps-vertical-layout"><a href="' + bodyHref + '"><span class="sds-comps-text sds-comps-text-type-body1">' + snippet + '</span></a></div>' : '')
    + '</div>';
}

test('search snippets stay bound to their own card and require matching explicit source URLs', () => {
  const html = '<section data-name="blog">'
    + card({
      url: blogUrl,
      title: '청년 도약계좌 신청 조건',
      snippet: '2026년 가입 기준과 신청 기간을 안내합니다. 서민금융진흥원 공지와 함께 준비할 서류를 자세히 설명합니다.',
    })
    + card({
      url: 'https://blog.naver.com/another/224012345679',
      title: '요약이 없는 다음 카드',
      snippet: '',
    })
    + card({
      url: 'https://blog.naver.com.attacker.example/fake/224012345670',
      title: '위장 도메인 카드',
      snippet: '이 내용은 위장된 블로그 URL에 연결되어 있으므로 수집하면 안 됩니다.'.repeat(2),
    })
    + card({
      url: 'https://blog.naver.com/target/224012345671',
      bodyHref: 'https://blog.naver.com/other/224012345672',
      title: '링크가 다른 요약',
      snippet: '다른 카드의 링크를 사용하므로 이 요약도 해당 제목의 근거가 아닙니다.'.repeat(2),
    })
    + '</section>';

  const parsed = M.parseSearchCards(html, { sourceType: 'blog-snippet', collectedAt });
  assert.equal(parsed.resultKind, 'ok');
  assert.equal(parsed.sources.length, 1);
  assert.deepEqual(parsed.sources[0], {
    url: blogUrl,
    title: '청년 도약계좌 신청 조건',
    text: '2026년 가입 기준과 신청 기간을 안내합니다. 서민금융진흥원 공지와 함께 준비할 서류를 자세히 설명합니다.',
    sourceType: 'blog-snippet',
    kind: 'search-snippet',
    contentKind: 'snippet',
    collectedAt,
  });

  const compatible = M.grabTitleSnippetPairs(html, { sourceType: 'blog-snippet', collectedAt });
  assert.deepEqual(compatible, ['청년 도약계좌 신청 조건 — 2026년 가입 기준과 신청 기간을 안내합니다. 서민금융진흥원 공지와 함께 준비할 서류를 자세히 설명합니다.']);
  assert.equal(Object.prototype.propertyIsEnumerable.call(compatible, 'sources'), false);
  assert.equal(compatible.sources[0].url, blogUrl);
});

test('normal empty results differ from parser mismatch and never invent a source URL', () => {
  const noResults = M.parseSearchCards('<div class="not_found02">검색 결과가 없습니다.</div>', { sourceType: 'news-snippet', collectedAt });
  assert.equal(noResults.resultKind, 'no_results');
  assert.deepEqual(noResults.sources, []);

  const unsupported = M.parseSearchCards('<div><span class="sds-comps-text-type-headline1">제목만 있는 낯선 구조</span></div>', { sourceType: 'news-snippet', collectedAt });
  assert.equal(unsupported.resultKind, 'parser_mismatch');
  assert.deepEqual(unsupported.sources, []);

  const unrelatedEmptyNotice = M.parseSearchCards('<div><span class="sds-comps-text-type-headline1">지원 결과 제목</span></div><aside>검색 결과가 없습니다.</aside>', { sourceType: 'news-snippet', collectedAt });
  assert.equal(unrelatedEmptyNotice.resultKind, 'parser_mismatch');
  assert.deepEqual(unrelatedEmptyNotice.sources, []);

  const unsupportedSerp = M.parseSerpSections('<div class="unrecognized-result">새 검색 결과 레이아웃</div><aside>검색 결과가 없습니다.</aside>');
  assert.equal(unsupportedSerp.resultKind, 'parser_mismatch');
});

test('news snippets require article-shaped sources and linked card ancestry, excluding ads and unrelated sections', () => {
  const newsUrl = 'https://press.example.com/article/2026/123456/official-report';
  const plainSummaryCard = '<div class="sds-comps-base-layout sds-comps-vertical-layout result-card">'
    + '<div class="sds-comps-vertical-layout"><a href="' + newsUrl + '"><span class="sds-comps-text-type-headline1">정부 발표 내용 정리</span></a></div>'
    + '<div class="sds-comps-vertical-layout"><span class="sds-comps-text-type-body1">기관 발표의 주요 일정과 지원 대상, 신청 절차를 기사 원문을 바탕으로 설명합니다.</span></div></div>';
  const invalid = card({
    url: 'https://shopping.naver.com/product/12345',
    title: '쇼핑 섹션 제목',
    snippet: '검색 결과의 다른 섹션 내용이 뉴스 기사로 승격되지 않도록 검증합니다.'.repeat(2),
  }) + card({
    url: 'https://namu.wiki/w/News',
    title: '위키 문서',
    snippet: '위키 문서 내용은 뉴스 검색 스니펫으로 분류하지 않습니다.'.repeat(2),
  });
  assert.equal(M.parseSearchCards(invalid, { sourceType: 'news-snippet', collectedAt }).resultKind, 'parser_mismatch');

  const adWrapped = '<div class="result-shell"><span class="ad-badge">광고</span>'
    + card({ url: newsUrl, title: '광고 뉴스 카드', snippet: '광고로 표시된 카드라서 사실 근거로 수집하지 않아야 합니다.'.repeat(2) })
    + '</div>';
  const parsed = M.parseSearchCards(plainSummaryCard + adWrapped, { sourceType: 'news-snippet', collectedAt });
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.sources[0].url, newsUrl);
  assert.equal(parsed.sources[0].text, '기관 발표의 주요 일정과 지원 대상, 신청 절차를 기사 원문을 바탕으로 설명합니다.');
});

test('news article refs come from explicit supported anchors and keep their original URLs', () => {
  const url = 'https://n.news.naver.com/mnews/article/001/0012345678?sid=100';
  const refs = M.grabArticleRefs('<a href="' + url + '">기사</a><a href="https://search.naver.com/search.naver?query=article/001/0012345678">검색</a>');
  assert.deepEqual(refs, [{ oid: '001', aid: '0012345678', kind: 'news', url }]);
});

test('article bodies retain the fetched article URL and never fall back across sports namespaces', async () => {
  const calls = [];
  const bodyHtml = '<h2 id="title_area">원문 기사 제목</h2><article id="dic_area">' + '확인된 일반 뉴스 본문입니다. '.repeat(12) + '</article>';
  const news = await trends._fetchArticleBodyForTest('001', '0012345678', 'news', {
    fetchBuffer: async (url) => { calls.push(url); return Buffer.from(bodyHtml); },
  });
  assert.equal(news.url, 'https://n.news.naver.com/mnews/article/001/0012345678');
  assert.match(news.body, /확인된 일반 뉴스 본문/);
  assert.deepEqual(calls, ['https://n.news.naver.com/mnews/article/001/0012345678']);

  calls.length = 0;
  const sports = await trends._fetchArticleBodyForTest('477', '0000123456', 'sports', {
    sourceUrl: 'https://m.sports.naver.com/wfootball/article/477/0000123456',
    fetchBuffer: async (url) => { calls.push(url); throw new Error('fixture API unavailable'); },
  });
  assert.equal(sports, null);
  assert.deepEqual(calls, ['https://api-gw.sports.naver.com/news/article/477/0000123456']);

  guard._resetForTest();
  guard._setTransportForTest(async () => ({
    status: 200,
    body: '<a href="https://n.news.naver.com/mnews/article/001/0012345678">뉴스 기사 링크</a>',
  }));
  const articles = await trends.fetchNewsArticles('provenance fixture', {
    fetchArticleBody: async () => ({ title: '원문 기사 제목', body: '실제로 확인한 본문입니다. '.repeat(12), url: 'https://n.news.naver.com/mnews/article/001/0012345678', collectedAt }),
  });
  assert.equal(articles[0].url, 'https://n.news.naver.com/mnews/article/001/0012345678');
  assert.equal(articles.sources[0].url, articles[0].url);
  guard._resetForTest();
});

test('legacy trend arrays expose distinct snippet provenance without promoting it to article body', async () => {
  const html = card({
    url: blogUrl,
    title: '블로그 참고 제목',
    snippet: '작성자가 확인한 방문 경험과 이용 시간 정보를 정리한 블로그 검색 요약입니다.',
  });
  guard._resetForTest();
  guard._setClockForTest(() => Date.parse(collectedAt));
  health.reset();
  guard._setTransportForTest(async () => ({ status: 200, body: Buffer.from(html) }));
  const facts = await trends.fetchBlogFacts('metadata fixture');
  assert.equal(facts[0], '블로그 참고 제목 — 작성자가 확인한 방문 경험과 이용 시간 정보를 정리한 블로그 검색 요약입니다.');
  assert.equal(facts.sources[0].sourceType, 'blog-snippet');
  assert.equal(facts.sources[0].kind, 'search-snippet');
  assert.equal(facts.sources[0].contentKind, 'snippet');
  assert.equal(facts.sources[0].url, blogUrl);
  assert.equal(facts.sources[0].collectedAt, collectedAt);
  guard._resetForTest();
  health.reset();
});

test('keyword context metadata carries only source records for facts actually selected', () => {
  const blogSource = {
    url: blogUrl, title: '지원 신청 안내', text: '블로그 요약 본문',
    sourceType: 'blog-snippet', kind: 'search-snippet', contentKind: 'snippet', collectedAt,
  };
  const newsSource = {
    url: 'https://news.example.com/article/2026/123456', title: '지원 기사', text: '뉴스 요약 본문',
    sourceType: 'news-snippet', kind: 'search-snippet', contentKind: 'snippet', collectedAt,
  };
  const blogFacts = ['지원 신청 안내 — 블로그 요약 본문'];
  Object.defineProperty(blogFacts, 'sources', { value: [blogSource] });
  const newsFacts = ['지원 기사 — 뉴스 요약 본문'];
  Object.defineProperty(newsFacts, 'sources', { value: [newsSource] });

  assert.deepEqual(collectKeywordSources(
    ['지원 신청 안내 — 블로그 요약 본문', '선택되지 않은 텍스트'],
    [newsFacts], [blogFacts],
  ), [blogSource]);
});
