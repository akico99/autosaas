const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../../src/scrape/naverSearchGuard');
const health = require('../../src/scrape/health');
const { parseSerpSections, SERP_SECTION_RULES } = require('../../src/scrape/markup');
const { observeSerp } = require('../../src/keyword/serpObserve');
const { buildSearchBrief } = require('../../src/generator/searchBrief');
const { buildSearchUserPrompt } = require('../../src/generator/buildSearchPrompt');
const tracker = require('../../src/performance/tracker');
const trends = require('../../src/keyword/trends');

const SERP_COMPAT = '<html><h2>사주 궁합 검색 결과</h2><h2>사주궁합 관련 광고</h2><h2>브랜드 콘텐츠</h2><h2>이미지</h2><h2>네이버 가격비교</h2><h2>네이버플러스 스토어</h2><h2>운세/타로/작명 상담</h2>'
  + '<a href="https://blog.naver.com/nomadyoon/224012345678">글</a></html>';
const SERP_DEFINITION = '<html><h2>사주 뜻 검색 결과</h2><h2>국어사전</h2><h2>AI 브리핑</h2><h2>네이버 가격비교</h2>'
  + '<span class="sds-comps-text-type-headline1">사주 뜻 풀이</span><span class="sds-comps-text-type-body1">쉽게 구분하는 의미와 쓰임 예시를 설명합니다.</span></html>';

test('isBlockPage recognizes 403 and the restriction text only', () => {
  assert.equal(guard.isBlockPage(403, 'anything'), true);
  assert.equal(guard.isBlockPage(200, '검색 서비스 이용이 제한되었습니다'), true);
  assert.equal(guard.isBlockPage(200, '일반 검색 결과'), false);
});

test('guardedSearchFetch caches success and holds requests after repeated blocks', async () => {
  guard._resetForTest();
  let now = Date.UTC(2026, 9, 4);
  guard._setClockForTest(() => now);
  let calls = 0;
  guard._setTransportForTest(async () => { calls++; return { status: 200, body: Buffer.from('ok') }; });
  const url = 'https://search.naver.com/search.naver?query=cache-test';
  await guard.guardedSearchFetch(url);
  await guard.guardedSearchFetch(url);
  assert.equal(calls, 1);

  guard._resetForTest();
  guard._setClockForTest(() => now);
  calls = 0;
  guard._setTransportForTest(async () => {
    calls++;
    return { status: 403, body: Buffer.from('검색 서비스 이용이 제한되었습니다') };
  });
  const blockedUrl = 'https://search.naver.com/search.naver?query=blocked-test';
  await assert.rejects(guard.guardedSearchFetch(blockedUrl), guard.NaverSearchBlockedError);
  await assert.rejects(guard.guardedSearchFetch(blockedUrl), guard.NaverSearchBlockedError);
  assert.equal(calls, 1);
  now += 31 * 60 * 1000;
  await assert.rejects(guard.guardedSearchFetch(blockedUrl), guard.NaverSearchBlockedError);
  assert.equal(calls, 2);
  const state = guard.getBlockState();
  assert.equal(state.blocked, true);
  assert.equal(new Date(state.blockedUntil).getTime() - now, 2 * 60 * 60 * 1000);
  guard._resetForTest();
});

test('runGuardedSearch caches a nonblocked result by key', async () => {
  guard._resetForTest();
  let calls = 0;
  const fetchRendered = async () => {
    calls++;
    return { status: 200, body: '{"brief":"fixture"}' };
  };
  await guard.runGuardedSearch('rendered:cache-fixture', fetchRendered);
  await guard.runGuardedSearch('rendered:cache-fixture', fetchRendered);
  assert.equal(calls, 1);
  guard._resetForTest();
});

test('runGuardedSearch records a blocked body and skips later callbacks while blocked', async () => {
  guard._resetForTest();
  let calls = 0;
  const blockedFetch = async () => {
    calls++;
    return { status: 200, body: '검색 서비스 이용이 제한되었습니다' };
  };
  await assert.rejects(guard.runGuardedSearch('rendered:blocked-fixture', blockedFetch), guard.NaverSearchBlockedError);
  assert.equal(guard.isSearchBlocked(), true);
  await assert.rejects(guard.runGuardedSearch('rendered:other-fixture', blockedFetch), guard.NaverSearchBlockedError);
  assert.equal(calls, 1);
  guard._resetForTest();
});

test('parseSerpSections preserves distinct section order and deduplicates blog references', () => {
  const html = '<h2>사주 궁합 검색 결과</h2><h2>국어사전</h2><h2> AI <b>브리핑</b> </h2><h2>국어사전</h2>'
    + '<a href="https://blog.naver.com/nomadyoon/224012345678">a</a>'
    + '<a href="https://m.blog.naver.com/nomadyoon/224012345678">duplicate</a>'
    + '<a href="http://blog.naver.com/another_id/224012345679">b</a>'
    + '<a href="https://map.naver.com/p/entry/place/123">map</a><a href="https://kin.naver.com/qna/detail.naver">kin</a>';
  const parsed = parseSerpSections(html);
  assert.deepEqual(parsed.sections, ['국어사전', 'AI 브리핑']);
  assert.deepEqual(parsed.blogRefs, [
    { blogId: 'nomadyoon', logNo: '224012345678', url: 'https://blog.naver.com/nomadyoon/224012345678' },
    { blogId: 'another_id', logNo: '224012345679', url: 'https://blog.naver.com/another_id/224012345679' },
  ]);
  assert.equal(parsed.placeLinks, true);
  assert.equal(parsed.kinLinks, true);
  assert.deepEqual(SERP_SECTION_RULES.map((rule) => rule.key), [
    'aiBriefing', 'dictionary', 'ads', 'brandContent', 'shopping', 'expertService',
    'news', 'kin', 'popularPosts', 'image', 'video',
  ]);
});

test('observeSerp classifies synthetic sections and returns a blocked result without network access', async () => {
  health.reset();
  let fetches = 0;
  const observed = await observeSerp('사주 뜻 fixture', {
    fetch: async () => { fetches++; return { status: 200, body: Buffer.from(SERP_DEFINITION) }; },
  });
  assert.equal(observed.measured, true);
  assert.equal(observed.flags.dictionary, true);
  assert.equal(observed.flags.aiBriefing, true);
  assert.equal(observed.firstSections[0], 'dictionary');
  assert.equal(observed.topDocs.length, 1);
  await observeSerp('사주 뜻 fixture', { fetch: async () => { throw new Error('cache miss'); } });
  assert.equal(fetches, 1);

  const blocked = await observeSerp('차단 fixture', {
    fetch: async () => { throw new guard.NaverSearchBlockedError(); },
  });
  assert.deepEqual({ measured: blocked.measured, blocked: blocked.blocked, reason: blocked.reason }, {
    measured: false, blocked: true, reason: 'blocked',
  });
});

test('buildSearchBrief calibrates only ambiguous intent and carries SERP notes and failure warnings', async () => {
  const serviceSerp = await observeSerp('사주 궁합 fixture', {
    fetch: async () => ({ status: 200, body: Buffer.from(SERP_COMPAT) }),
  });
  const calibrated = buildSearchBrief({ keyword: '사주 궁합', topic: 'daily', serp: serviceSerp });
  assert.equal(calibrated.intent, 'service');
  assert.match(calibrated.reason, /운세\/타로\/작명 상담/);
  assert.ok(calibrated.serp.notes.some((note) => note.includes('광고·브랜드 콘텐츠')));

  const fixed = buildSearchBrief({ keyword: '사주 보는 법', topic: 'daily', serp: serviceSerp });
  assert.equal(fixed.intent, 'howto');
  const unavailable = buildSearchBrief({ keyword: '사주 궁합', topic: 'daily', serp: { measured: false, blocked: true, reason: 'blocked' } });
  assert.ok(unavailable.warnings.includes('검색 결과 관찰 실패 — 의도 보정 없이 작성'));
});

test('buildSearchBrief holds drafts when search is blocked', () => {
  const brief = buildSearchBrief({
    keyword: '청년 지원금', topic: 'society', searchBlocked: true,
    source: {
      url: 'https://example.org/support',
      title: '청년 지원금 안내',
      text: '청년 지원금의 신청 자격과 지급 일정, 신청 절차를 안내하는 원문 본문입니다.'.repeat(2),
    },
  });
  assert.equal(brief.evidence.searchBlocked, true);
  assert.ok(brief.warnings.some((warning) => /검색 제한/.test(warning)));
  assert.equal(brief.preHoldReasons.includes('네이버 검색 제한으로 근거 자료를 가져오지 못함'), false);
});

test('tracker matches exact and close titles once, excluding posts published before generation', () => {
  const generatedAt = '2026-01-01T00:00:00.000Z';
  const entries = [
    tracker.createEntry({ keyword: '사주 뜻', topic: 'daily', intent: 'definition', status: 'ready', title: '사주 뜻 풀이', generatedAt }),
    tracker.createEntry({ keyword: '지원금', topic: 'society', intent: 'howto', status: 'review', title: '청년지원금신청방법', generatedAt }),
    tracker.createEntry({ keyword: '이전 발행', topic: 'society', intent: 'general', status: 'ready', title: '이전 발행 글', generatedAt }),
    tracker.createEntry({ keyword: '중복', topic: 'daily', intent: 'general', status: 'hold', title: '같은 제목', generatedAt }),
    tracker.createEntry({ keyword: '중복2', topic: 'daily', intent: 'general', status: 'hold', title: '같은 제목', generatedAt }),
  ];
  const posts = [
    { title: '사주 뜻 풀이!', url: 'https://blog.naver.com/nomadyoon/224012345678', addDate: '2026-01-03T00:00:00Z' },
    { title: '청년지원금신청방법은', url: 'https://blog.naver.com/nomadyoon/224012345679', addDate: Date.parse('2026-01-04T00:00:00Z') },
    { title: '이전 발행 글', url: 'https://blog.naver.com/nomadyoon/224012345680', addDate: '2025-12-31T00:00:00Z' },
    { title: '같은 제목', url: 'https://blog.naver.com/nomadyoon/224012345681' },
  ];
  const linked = tracker.matchPublished(entries, posts);
  assert.equal(linked[0].logNo, '224012345678');
  assert.equal(linked[1].logNo, '224012345679');
  assert.equal(linked[2].url, null);
  assert.equal(Number(!!linked[3].url) + Number(!!linked[4].url), 1);
  assert.equal(entries.every((entry) => entry.url === null), true);
});

test('tracker validates manual links, due checks, ranks, replacement, and summaries', () => {
  const publishedAt = Date.UTC(2026, 0, 1);
  const base = tracker.createEntry({ keyword: '사주 뜻', topic: 'daily', intent: 'definition', status: 'ready', title: '사주 뜻 풀이', generatedAt: '2025-12-30T00:00:00Z' });
  const linked = tracker.linkManually({ ...base, publishedAt: new Date(publishedAt).toISOString() }, 'https://m.blog.naver.com/nomadyoon/224012345678');
  assert.equal(linked.blogId, 'nomadyoon');
  assert.equal(linked.logNo, '224012345678');
  assert.equal(linked.linkedBy, 'manual');
  assert.throws(() => tracker.linkManually(base, 'https://example.com/post'), /URL|주소/);

  const due = tracker.dueChecks([linked], publishedAt + 30 * 86400000);
  assert.deepEqual(due, [{ id: linked.id, dueDay: 28 }]);
  assert.equal(tracker.findRank([
    { blogId: 'x', logNo: '1' }, { blogId: 'nomadyoon', logNo: '224012345678' },
  ], 'nomadyoon', '224012345678'), 2);
  assert.equal(tracker.findRank([], 'nomadyoon', '0'), null);

  const firstCheck = tracker.addCheck(linked, { at: '2026-01-29T00:00:00Z', dueDay: 1, blogTabRank: 12, measured: true });
  const replaced = tracker.addCheck(firstCheck, { at: '2026-01-30T00:00:00Z', dueDay: 1, blogTabRank: 4, measured: true });
  assert.equal(replaced.checks.length, 1);
  assert.equal(replaced.checks[0].blogTabRank, 4);

  const second = { ...linked, id: linked.id + '-2', intent: 'howto', statusAtGen: 'review', checks: [{ dueDay: 3, measured: true, blogTabRank: 12 }] };
  const summary = tracker.summarize([replaced, second]);
  assert.deepEqual(summary.byIntent.definition, { tracked: 1, linked: 1, checked: 1, found: 1, top10: 1, medianBestRank: 4 });
  assert.deepEqual(summary.byStatus.review, { tracked: 1, linked: 1, checked: 1, found: 1, top10: 0, medianBestRank: 12 });
});

test('health reports a blocked source without a markup-change message', () => {
  health.reset();
  health.record('news-headlines', 0, { query: 'fixture', blocked: true });
  const result = health.report();
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.match(result.message, /네이버 검색/);
  assert.equal(result.message.includes('구조'), false);
});

test('trend collectors convert a guarded search block into an empty result and blocked health state', async () => {
  guard._resetForTest();
  health.reset();
  guard._setTransportForTest(async () => ({ status: 403, body: Buffer.from('검색 서비스 이용이 제한되었습니다') }));
  assert.deepEqual(await trends.fetchNewsHeadlines('합성 차단 키워드'), []);
  assert.equal(health.snapshot()['news-headlines'].blocked, true);
  guard._resetForTest();
  health.reset();
});

test('search prompt includes observed results only when measured', async () => {
  const serp = await observeSerp('사주 뜻 prompt fixture', {
    fetch: async () => ({ status: 200, body: Buffer.from(SERP_DEFINITION) }),
  });
  const measured = buildSearchBrief({ keyword: '사주 뜻', topic: 'daily', serp });
  const prompt = buildSearchUserPrompt({ topicKey: 'daily', keyword: '사주 뜻', brief: measured });
  assert.ok(prompt.includes('[검색 결과 관찰'));
  assert.ok(prompt.includes('국어사전'));
  const unmeasured = buildSearchBrief({ keyword: '사주 뜻', topic: 'daily', serp: { measured: false, reason: 'offline' } });
  const noObservation = buildSearchUserPrompt({ topicKey: 'daily', keyword: '사주 뜻', brief: unmeasured });
  assert.equal(noObservation.includes('[검색 결과 관찰'), false);
});

test.after(() => {
  guard._resetForTest();
  health.reset();
});
