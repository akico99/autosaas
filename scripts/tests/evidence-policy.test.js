const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Keep every test in this file offline, even if a future path forgets to inject its runner.
let blockedRunnerCalls = 0;
const scrapeHealthRecords = [];
const testScrapeHealth = {
  reset() { scrapeHealthRecords.length = 0; },
  record(...record) { scrapeHealthRecords.push(record); },
  report() { return { ok: true, broken: [] }; },
};
const originalLoad = Module._load;
Module._load = function loadWithClaudeGuard(request, parent, isMain) {
  if (request === './runClaude' && parent && /[\\/]src[\\/]generator[\\/]/.test(parent.filename)) {
    return { runClaude: async () => { blockedRunnerCalls++; throw new Error('Unexpected real-model call in evidence-policy test'); } };
  }
  if (request === '../scrape/health' && parent && /[\\/]src[\\/]generator[\\/]generateSearchPost\.js$/.test(parent.filename)) {
    return testScrapeHealth;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  buildSearchBrief,
  collectOriginalSources,
  isValidUserSource,
  isInstitutionPage,
} = require('../../src/generator/searchBrief');
const { buildSearchUserPrompt } = require('../../src/generator/buildSearchPrompt');
const { generateSearchPost } = require('../../src/generator/generateSearchPost');
const { factCheckPost } = require('../../src/generator/factCheck');

Module._load = originalLoad;

const USER_TEXT = '청년 지원금은 신청 자격을 갖춘 청년에게 정해진 기간 동안 지급하는 제도입니다. 신청은 온라인 접수 페이지에서 진행하며 제출 서류와 심사 일정은 지역별 공고에 따릅니다.';
const INSTITUTION_TEXT = '지원 대상은 공고일 기준 해당 지역에 거주하는 청년이며, 신청 기간 안에 온라인 신청서와 증빙 서류를 제출해야 합니다. 선정 결과와 지급 일정은 담당 기관이 별도로 안내합니다.';
const ARTICLE_TEXT = '시와 담당 기관은 올해 청년 지원금 신청을 다음 달부터 접수한다고 밝혔습니다. 지원 대상은 거주 요건을 충족하는 청년이며, 신청자는 온라인으로 증빙 자료를 제출해야 합니다. 구체적인 일정과 지급 기준은 공고문에 안내됐습니다.';

test('user source evidence requires an actual HTTP URL and meaningful source text', () => {
  assert.equal(isValidUserSource({ url: 'https://example.org/article', text: USER_TEXT }), true);
  assert.equal(isValidUserSource({ url: 'javascript:alert(1)', text: USER_TEXT }), false);
  assert.equal(isValidUserSource({ url: 'https://example.org/article', text: '   ' }), false);
  assert.equal(isValidUserSource({ url: 'https://example.org/article', title: '청년 지원금 안내', text: '청년 지원금 안내' }), false);
  assert.equal(isValidUserSource({ url: 'https://user:pass@example.org/article', text: USER_TEXT }), false);
  assert.equal(isValidUserSource({ url: 'https://example.org/article', text: USER_TEXT, contentKind: 'snippet' }), false);
  assert.equal(isValidUserSource({ url: 'https://example.org/article', text: USER_TEXT, kind: 'search-summary' }), false);
  assert.equal(isValidUserSource({ url: 'https://example.org/article', text: USER_TEXT, original: false }), false);

  const blockedLinkOnly = buildSearchBrief({
    keyword: '오늘 이슈', topic: 'broadcast', searchBlocked: true,
    source: { url: 'https://example.org/article' },
  });
  assert.ok(blockedLinkOnly.preHoldReasons.includes('네이버 검색 제한으로 근거 자료를 가져오지 못함'));
  assert.ok(blockedLinkOnly.preHoldReasons.includes('최신 이슈 글인데 확인한 기사·뉴스 자료가 없음'));
});

test('institution evidence validates hostname, body, and institution provenance', () => {
  assert.equal(isInstitutionPage({ url: 'https://benefits.go.kr/guide', text: INSTITUTION_TEXT }), true);
  assert.equal(isInstitutionPage({ url: 'https://benefits.go.kr/guide', text: INSTITUTION_TEXT, contentKind: 'snippet' }), false);
  assert.equal(isInstitutionPage({ url: 'https://benefits.go.kr/guide', text: INSTITUTION_TEXT, kind: 'search-summary' }), false);
  assert.equal(isInstitutionPage({ url: 'https://benefits.go.kr/guide', text: INSTITUTION_TEXT, sourceType: 'institution-page-brief' }), false);
  assert.equal(isInstitutionPage({ url: 'https://benefits.go.kr/guide', text: INSTITUTION_TEXT, original: false }), false);
  assert.equal(isInstitutionPage({ url: 'https://benefits.go.kr.attacker.example/guide', text: INSTITUTION_TEXT }), false);
  assert.equal(isInstitutionPage({ url: 'https://fake.example/?next=benefits.go.kr', text: INSTITUTION_TEXT }), false);
  assert.equal(isInstitutionPage({ url: 'https://community.or.kr/guide', text: INSTITUTION_TEXT }), false);
  assert.equal(isInstitutionPage({
    url: 'https://community.or.kr/guide', text: INSTITUTION_TEXT,
    official: true, publisher: '지역청년지원센터', sourceType: 'institution-page',
  }), true);
  assert.equal(isInstitutionPage({ url: 'https://benefits.go.kr/empty', text: ' ' }), false);

  const summaryOnly = buildSearchBrief({
    keyword: '청년 지원금 신청', topic: 'society', searchBlocked: true,
    officialFacts: { brief: 'AI 브리핑에 있는 청년 지원금 요약 내용입니다.'.repeat(4), pages: [] },
  });
  assert.equal(summaryOnly.evidence.official, false);
  assert.ok(summaryOnly.preHoldReasons.includes('네이버 검색 제한으로 근거 자료를 가져오지 못함'));

  const sameHostSummary = {
    url: 'https://benefits.go.kr/youth', title: '청년 지원 안내 요약',
    text: INSTITUTION_TEXT, sourceType: 'institution-page', contentKind: 'summary',
  };
  assert.equal(collectOriginalSources({ officialFacts: { pages: [sameHostSummary] } }).length, 0);
  const institutionMetadata = require('../../src/generator/searchBrief').collectSourceMetadata({
    officialFacts: { pages: [
      { url: sameHostSummary.url, title: '기관 원문', text: INSTITUTION_TEXT },
      sameHostSummary,
    ] },
  });
  assert.equal(institutionMetadata.find((item) => item.contentKind === 'summary').original, false);
});

test('blocked search permits an original institution page and retains its provenance', () => {
  const officialFacts = {
    brief: '검색 브리핑 요약은 탐색 자료입니다.'.repeat(5),
    pages: [{ url: 'https://benefits.go.kr/youth', title: '청년 지원 안내', text: INSTITUTION_TEXT }],
  };
  const brief = buildSearchBrief({
    keyword: '청년 지원금 신청', topic: 'society', searchBlocked: true, officialFacts,
  });
  assert.equal(brief.evidence.official, true);
  assert.equal(brief.preHoldReasons.includes('네이버 검색 제한으로 근거 자료를 가져오지 못함'), false);
  assert.ok(brief.warnings.some((warning) => /검색 제한/.test(warning)));
  assert.equal(collectOriginalSources({ officialFacts }).length, 1);
  const metadata = require('../../src/generator/searchBrief').collectSourceMetadata({ officialFacts });
  assert.equal(metadata[0].sourceType, 'institution-page');
  assert.equal(metadata[0].original, true);
});

test('news excerpts do not satisfy latest-issue evidence, while sourced article bodies do', () => {
  const snippets = ['기관이 지원 계획을 발표했다는 검색 결과 요약'];
  snippets.sources = [{ url: 'https://news.example/story', title: '지원 계획', kind: 'search-snippet', text: snippets[0] }];
  const articles = [{ title: '청년 지원금 접수 시작', body: ARTICLE_TEXT }];
  articles.sources = [{ url: 'https://news.example/article/42', title: '청년 지원금 접수 시작', sourceType: 'news-article', kind: 'article-body' }];

  const brief = buildSearchBrief({
    keyword: '오늘 이슈', topic: 'broadcast', searchBlocked: true,
    keywordFacts: snippets, newsArticles: articles,
  });
  assert.equal(brief.evidence.newsOriginals, 1);
  assert.equal(brief.preHoldReasons.includes('네이버 검색 제한으로 근거 자료를 가져오지 못함'), false);
  assert.equal(brief.preHoldReasons.includes('최신 이슈 글인데 확인한 기사·뉴스 자료가 없음'), false);
  assert.equal(collectOriginalSources({ keywordFacts: snippets, newsArticles: articles }).length, 1);

  const sourcedSnippet = [{ title: '지원 계획', body: '기관이 지원 계획을 발표했다는 검색 결과 발췌문입니다.'.repeat(3) }];
  sourcedSnippet.sources = [{
    url: 'https://news.example/article/42', title: '지원 계획', sourceType: 'news-article',
    kind: 'article-body', contentKind: 'snippet',
  }];
  const snippetOnly = buildSearchBrief({
    keyword: '오늘 이슈', topic: 'broadcast', newsArticles: sourcedSnippet,
  });
  assert.equal(snippetOnly.evidence.newsOriginals, 0);
  assert.ok(snippetOnly.preHoldReasons.includes('최신 이슈 글인데 확인한 기사·뉴스 자료가 없음'));

  const summaryObject = [{
    url: 'https://news.example/article/summary', title: '지원 계획 요약',
    sourceType: 'news-article', kind: 'news-article-snippet', contentKind: 'summary',
    body: '검색 결과에 표시된 지원 계획의 짧은 요약이며 기사 본문은 수집되지 않았습니다.'.repeat(2),
  }];
  const summaryOnlyArticle = buildSearchBrief({
    keyword: '오늘 이슈', topic: 'broadcast', newsArticles: summaryObject,
  });
  assert.equal(summaryOnlyArticle.evidence.newsOriginals, 0);
  assert.ok(summaryOnlyArticle.preHoldReasons.includes('최신 이슈 글인데 확인한 기사·뉴스 자료가 없음'));
  assert.equal(collectOriginalSources({ newsArticles: summaryObject }).length, 0);
  const summaryPrompt = buildSearchUserPrompt({ topicKey: 'broadcast', keyword: '오늘 이슈', newsArticles: summaryObject });
  assert.match(summaryPrompt, /검색 제목·발췌 — 원문 확인 전의 탐색 자료/);
  assert.doesNotMatch(summaryPrompt, /기사 원문 본문 — 검색 발췌가 아닌 URL이 확인된 기사 본문/);

  const sourcedArticles = [{ url: 'https://news.example/article/42', title: '청년 지원금 접수 시작', body: ARTICLE_TEXT }];
  sourcedArticles.sources = [{
    url: sourcedArticles[0].url, title: sourcedArticles[0].title,
    sourceType: 'news-article', kind: 'article-body', contentKind: 'body',
  }];
  const articlePrompt = buildSearchUserPrompt({ topicKey: 'broadcast', keyword: '오늘 이슈', newsArticles: sourcedArticles });
  assert.match(articlePrompt, /기사 원문 본문 — 검색 발췌가 아닌 URL이 확인된 기사 본문/);
  assert.match(articlePrompt, /https:\/\/news\.example\/article\/42/);
});

test('experience posts still require experience input when an original link is available', () => {
  const brief = buildSearchBrief({
    keyword: '온라인 사주 후기', topic: 'daily', searchBlocked: true,
    source: { url: 'https://example.org/review', text: USER_TEXT },
  });
  assert.ok(brief.preHoldReasons.includes('후기 글인데 직접 경험 입력(리뷰 장소·내돈내산·경험 메모)이 없음'));
});

test('search prompt separates discovery summaries from verified institution pages', () => {
  const prompt = buildSearchUserPrompt({
    topicKey: 'society', keyword: '청년 지원금 신청',
    officialFacts: {
      brief: 'AI 브리핑 검색 요약입니다. 원문이 아닙니다.'.repeat(4),
      pages: [
        { url: 'https://benefits.go.kr/youth', title: '청년 지원 안내', text: INSTITUTION_TEXT },
        { url: 'https://benefits.go.kr.attacker.example/fake', title: '가짜 기관 페이지', text: '가짜 본문'.repeat(20) },
      ],
    },
    keywordFacts: ['검색 결과 제목과 발췌문'],
  });
  assert.match(prompt, /탐색용 검색 요약/);
  assert.match(prompt, /기관 도메인 원문/);
  assert.match(prompt, /검색 제목·발췌/);
  assert.doesNotMatch(prompt, /공식 정보 \(최우선 근거\)|실제 근거\(뉴스 제목들\)/);
  assert.doesNotMatch(prompt, /benefits\.go\.kr\.attacker/);
});

test('strict evidence holds before Claude runs when required originals are absent', async () => {
  let modelCalls = 0;
  const result = await generateSearchPost({
    topic: 'broadcast', strictEvidence: true,
    source: { url: 'https://example.org/article', title: '오늘 이슈' },
    run: async () => { modelCalls++; return { text: '' }; },
  });
  assert.equal(result.status, 'hold');
  assert.equal(result.attempts, 0);
  assert.equal(modelCalls, 0);
  assert.equal(blockedRunnerCalls, 0);
  assert.deepEqual(result.meta.sources.map(({ url, original }) => ({ url, original })), [
    { url: 'https://example.org/article', original: false },
  ]);
});

test('generation restores official-facts failure diagnostics after resetting collection health', async () => {
  const result = await generateSearchPost({
    topic: 'broadcast', strictEvidence: true,
    officialFacts: {
      brief: '', pages: [],
      error: { kind: 'rate_limited', status: 429, code: 'NAVER_SEARCH_RATE_LIMITED', message: 'rate limited' },
    },
  });
  assert.equal(result.status, 'hold');
  assert.equal(result.attempts, 0);
  assert.equal(blockedRunnerCalls, 0);
  const record = scrapeHealthRecords.find(([source]) => source === 'official-facts');
  assert.ok(record);
  assert.deepEqual(record[2], {
    query: undefined, blocked: true, status: 429,
    errorKind: 'rate_limited', errorCode: 'NAVER_SEARCH_RATE_LIMITED', resultKind: 'error',
  });
});

test('fact checking receives only original user and institution sources as verified evidence', async () => {
  let factCheckPrompt = '';
  const result = await factCheckPost({
    post: { title: '지원금', blocks: [{ kind: 'text', text: '지원금 사실 설명입니다. '.repeat(25) }] },
    originalSources: [
      { url: 'https://example.org/article', title: '사용자 원문', text: USER_TEXT, sourceType: 'user-source' },
      { url: 'https://benefits.go.kr/youth', title: '기관 원문', text: INSTITUTION_TEXT, sourceType: 'institution-page' },
      { url: 'https://benefits.go.kr.attacker.example/fake', title: '가짜 기관', text: '가짜 원문'.repeat(20), sourceType: 'institution-page' },
      { url: 'https://news.example/summary', title: '기사 검색 요약', text: ARTICLE_TEXT, sourceType: 'news-article', kind: 'search-result', contentKind: 'body' },
    ],
    officialFacts: { brief: 'AI 요약은 확인된 원문이 아닙니다.'.repeat(4), pages: [] },
    facts: ['검색 결과에서 본 제목 요약'],
    run: async ({ user }) => { factCheckPrompt = user; return { text: '{"claims":[]}' }; },
  });
  assert.equal(result.ran, true);
  assert.match(factCheckPrompt, /사용자 원문/);
  assert.match(factCheckPrompt, /기관 원문/);
  assert.doesNotMatch(factCheckPrompt, /가짜 기관/);
  assert.doesNotMatch(factCheckPrompt, /기사 검색 요약/);
  assert.match(factCheckPrompt, /원문 근거가 아님/);
  assert.match(factCheckPrompt, /AI 요약은 확인된 원문이 아닙니다/);
});

test('fact checking keeps home-generator article sidecar originals without caller-supplied originalSources', async () => {
  let factCheckPrompt = '';
  const articles = [{ title: '기사 원문', body: ARTICLE_TEXT, url: 'https://news.example/home-article' }];
  articles.sources = [{
    url: articles[0].url, title: articles[0].title, text: ARTICLE_TEXT,
    sourceType: 'news-article', kind: 'article-body', contentKind: 'body',
  }];
  const result = await factCheckPost({
    post: { title: '이슈 정리', blocks: [{ kind: 'text', text: '기사에 담긴 사실을 정리합니다. '.repeat(30) }] },
    articles,
    run: async ({ user }) => { factCheckPrompt = user; return { text: '{"claims":[]}' }; },
  });
  assert.equal(result.ran, true);
  assert.match(factCheckPrompt, /기사 원문\(기사 원문\)/);
  assert.match(factCheckPrompt, /https:\/\/news\.example\/home-article/);
  assert.doesNotMatch(factCheckPrompt, /출처 URL이 확인되지 않아 원문 근거가 아님/);
});

test('legacy source sidecars and gathered keywordSources preserve provenance without invented URLs', () => {
  const keywordFacts = ['기사 요약 발췌'];
  keywordFacts.sources = [{ url: 'https://news.example/story', title: '기사 원문', sourceType: 'news-article', kind: 'article-body', text: ARTICLE_TEXT }];
  const collected = collectOriginalSources({
    keywordFacts,
    keywordSources: [
      { title: '기관 자료', url: 'https://agency.go.kr/page', sourceType: 'institution-page', text: INSTITUTION_TEXT },
      { title: 'URL 없는 텍스트', sourceType: 'news-article', text: ARTICLE_TEXT },
    ],
  });
  assert.deepEqual(collected.map((item) => item.url).sort(), [
    'https://agency.go.kr/page', 'https://news.example/story',
  ]);
  assert.ok(collected.every((item) => /^https?:\/\//.test(item.url)));

  const sameUrl = ['검색 결과 요약', '기사 원문 본문'];
  sameUrl.sources = [
    { url: 'https://news.example/shared', title: '요약', sourceType: 'news-article', kind: 'news-article-snippet', contentKind: 'snippet', text: '검색 결과에 표시된 내용의 요약으로 기사 본문을 대체할 수 없습니다.'.repeat(2) },
    { url: 'https://news.example/shared', title: '기사', sourceType: 'news-article', kind: 'article-body', contentKind: 'body', text: ARTICLE_TEXT },
  ];
  const metadata = require('../../src/generator/searchBrief').collectSourceMetadata({ keywordFacts: sameUrl });
  assert.equal(metadata.length, 2);
  const snippetMetadata = metadata.find((item) => item.contentKind === 'snippet');
  const articleMetadata = metadata.find((item) => item.contentKind === 'body');
  assert.equal(snippetMetadata.kind, 'news-article-snippet');
  assert.equal(snippetMetadata.original, false);
  assert.equal(articleMetadata.kind, 'article-body');
  assert.equal(articleMetadata.original, true);
});
