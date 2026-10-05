const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyIntent,
  buildSearchBrief,
  filterAutocomplete,
} = require('../../src/generator/searchBrief');
const {
  checkRequiredAnswers,
  detectExperienceClaims,
} = require('../../src/generator/searchContentCheck');
const {
  validateSearchPost,
  pickBestCandidate,
  computeSearchStatus,
} = require('../../src/generator/generateSearchPost');
const { getSearchTopic } = require('../../src/generator/searchTopics');
const {
  buildSearchSystemPrompt,
  buildSearchUserPrompt,
} = require('../../src/generator/buildSearchPrompt');

test('classifyIntent distinguishes the required search intents', () => {
  assert.equal(classifyIntent({ keyword: '사주 뜻' }).intent, 'definition');
  assert.equal(classifyIntent({ keyword: '메타버스란' }).intent, 'definition');
  assert.equal(classifyIntent({ keyword: '용어 정의' }).intent, 'definition');
  assert.equal(classifyIntent({ keyword: '사주 보는 법' }).intent, 'howto');
  assert.equal(classifyIntent({ keyword: '무료 사주 사이트' }).intent, 'service');
  assert.equal(classifyIntent({ keyword: '온라인 사주 후기' }).intent, 'experience');
  assert.deepEqual(classifyIntent({ keyword: '사주 궁합', topic: 'daily' }), {
    intent: 'general', ambiguous: true, reason: '검색 의도를 키워드에서 특정하지 못함',
  });
  assert.equal(classifyIntent({ keyword: '아이폰 17 vs 갤럭시' }).intent, 'compare');
  assert.equal(classifyIntent({ keyword: '아이폰 VS 갤럭시', topic: 'society', newsCount: 1 }).intent, 'compare');
  assert.equal(classifyIntent({ keyword: '이란 이스라엘 휴전', topic: 'society', newsCount: 1 }).intent, 'news');
  assert.equal(classifyIntent({ keyword: '정의당 대표', topic: 'society', newsCount: 1 }).intent, 'news');
  assert.equal(classifyIntent({ keyword: '성수 맛집' }).intent, 'place');
  assert.equal(classifyIntent({ keyword: '맛집', review: { places: [{}] } }).intent, 'experience');
});

test('filterAutocomplete excludes candidates with a different intent and keeps at most three', () => {
  const result = filterAutocomplete(
    '사주 뜻',
    ['사주 뜻 풀이', '사주 보는 법', '무료 사주 사이트', '사주 뜻 한자'],
    'definition',
  );
  assert.deepEqual(result.selected, ['사주 뜻 풀이', '사주 뜻 한자']);
  assert.deepEqual(result.excluded, ['사주 보는 법', '무료 사주 사이트']);
});

test('buildSearchBrief holds unsupported experience and news drafts', () => {
  const experience = buildSearchBrief({ keyword: '온라인 사주 후기', topic: 'daily' });
  assert.ok(experience.preHoldReasons.includes('후기 글인데 직접 경험 입력(리뷰 장소·내돈내산·경험 메모)이 없음'));

  const news = buildSearchBrief({ keyword: '오늘 이슈', topic: 'broadcast' });
  assert.ok(news.preHoldReasons.includes('최신 이슈 글인데 확인한 기사·뉴스 자료가 없음'));

  const headlinesOnly = buildSearchBrief({
    keyword: '오늘 이슈', topic: 'broadcast', searchBlocked: true,
    keywordFacts: ['오늘 이슈 관련 검색 결과 제목과 짧은 요약'],
    newsArticles: [{ title: '오늘 이슈', body: '검색 화면에서 확인한 발췌문입니다.'.repeat(8) }],
  });
  assert.ok(headlinesOnly.preHoldReasons.includes('최신 이슈 글인데 확인한 기사·뉴스 자료가 없음'));
});

test('validateSearchPost rejects an unrelated title even when the body is long and structured', () => {
  const brief = buildSearchBrief({ keyword: '청년 지원금', topic: 'society' });
  const post = {
    title: '무관한 제목',
    description: '검색 결과에 표시될 설명입니다.',
    blocks: Array.from({ length: 4 }, (_, index) => ({
      kind: 'heading', text: `일반 항목 ${index + 1}`,
    })).flatMap((heading) => [heading, {
      kind: 'text', text: '청년 지원금과 관계없는 반복 문장입니다. '.repeat(40),
    }]),
  };

  const validation = validateSearchPost(post, getSearchTopic('society'), brief, {
    keyword: '청년 지원금', experienceInput: false,
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.severe.some((issue) => issue.includes('제목에 메인 키워드')));
});

test('checkRequiredAnswers reports uncovered answers and contains model failures', async () => {
  const brief = { requiredAnswers: [{ id: 'meaning', label: '핵심 의미를 앞부분에서 정의' }] };
  const post = { title: '제목', blocks: [{ kind: 'text', text: '본문' }] };
  const missing = await checkRequiredAnswers({
    post,
    brief,
    run: async () => ({ text: '{"items":[{"id":"meaning","covered":false,"blocks":[],"note":"정의가 없음"}]}' }),
  });
  assert.deepEqual(missing.missing, [{ id: 'meaning', label: '핵심 의미를 앞부분에서 정의' }]);

  const failed = await checkRequiredAnswers({ post, brief, run: async () => { throw new Error('offline'); } });
  assert.equal(failed.ran, false);
  assert.deepEqual(failed.missing, []);
});

test('detectExperienceClaims finds first-person claims without flagging attributed reviews', () => {
  const claims = detectExperienceClaims({
    title: '후기 정리',
    blocks: [
      { kind: 'text', text: '제가 직접 가보니 좋았어요.' },
      { kind: 'quote', text: '후기를 보면 맛있다고 하더라고요.' },
      { kind: 'qna', question: '이 제품을 구매했나요?', answer: '내돈내산입니다.' },
    ],
  });
  assert.equal(claims.length, 2);
  assert.equal(claims[0].blockIndex, 0);
  assert.match(claims[0].text, /제가 직접 가보니/);
  assert.match(claims[1].text, /내돈내산/);
});

test('pickBestCandidate prefers fewer severe and missing issues over a longer body', () => {
  const short = {
    validation: { severe: [], warnings: [], bodyLength: 800 },
    contentCheck: { missing: [] },
  };
  const long = {
    validation: { severe: ['제목 오류'], warnings: [], bodyLength: 2200 },
    contentCheck: { missing: [] },
  };
  assert.equal(pickBestCandidate([long, short]), short);
});

test('computeSearchStatus holds high fact-check findings and reviews incomplete checks', () => {
  const base = {
    brief: { preHoldReasons: [], ambiguous: false, warnings: [] },
    validation: { severe: [], warnings: [] },
    contentCheck: { ran: true, missing: [] },
    factCheck: { ran: true, issues: [], highCount: 0 },
  };
  assert.equal(computeSearchStatus({ ...base, factCheck: { ran: true, issues: [], highCount: 1 } }).status, 'hold');
  assert.equal(computeSearchStatus({ ...base, contentCheck: { ran: false, missing: [] } }).status, 'review');
  assert.equal(computeSearchStatus(base).status, 'ready');
});

test('search prompts use the brief and avoid superseded ranking claims', () => {
  const brief = buildSearchBrief({ keyword: '청년 지원금', topic: 'society' });
  const prompt = buildSearchSystemPrompt('society') + '\n' + buildSearchUserPrompt({
    topicKey: 'society', keyword: '청년 지원금', brief,
  });
  for (const obsolete of [
    '색인에서 제거',
    '상위노출 글 평균',
    '검색 노출 저하·저품질·제재',
    '훨씬 더 길게',
    '메인 단독 제목은 경쟁이 치열해',
  ]) assert.equal(prompt.includes(obsolete), false, obsolete);
  assert.ok(prompt.includes('[원고 기획'));
});
