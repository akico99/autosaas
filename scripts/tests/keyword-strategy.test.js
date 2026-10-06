'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildKeywordStrategy, homefeedGuidance, classifyTitles, blogSlotFrom } = require('../../src/topics/keywordStrategy');
const { addManualStat, createEntry } = require('../../src/performance/tracker');

function item(title, sourceType, domain) { return { title, sourceType, domain: domain || (sourceType === '블로그' ? 'blog.naver.com' : 'example.com') }; }

const OBS = {
  measured: true,
  blocks: [
    { blockOrder: 1, blockName: '검색광고', blockKind: 'ad', items: [item('광고 제목', '웹')] },
    { blockOrder: 2, blockName: '브랜드 콘텐츠', blockKind: 'brand-content', items: [item('브랜드 사주 추천 후기', '블로그')] },
    { blockOrder: 3, blockName: '관련문서', blockKind: 'related-docs', items: [
      item('사주GPT 무료 AI 사주', '웹', 'www.sajugpt.co.kr'),
      item('재회사주 솔직 후기, 다시 연락 왔어요', '블로그'),
      item('재회사주 직접 받아봤어요 후기', '블로그'),
      item('재회운 보는 방법 정리', '카페', 'cafe.naver.com'),
    ] },
    { blockOrder: 4, blockName: '운세/타로/작명 상담', blockKind: 'content', items: [] },
  ],
  siteFound: null,
};

test('통합검색 관찰에서 블로그 자리·상위 형식·경쟁 사이트를 읽는다', () => {
  const strategy = buildKeywordStrategy({ keyword: '재회사주', observation: OBS, now: new Date('2026-10-06T00:00:00Z') });
  assert.equal(strategy.source, 'live');
  assert.equal(strategy.blogSlot, 'mid');
  assert.equal(strategy.dominantFormat, 'review');
  assert.equal(strategy.competitorFirst, true);
  assert.deepEqual(strategy.competitorSites, ['www.sajugpt.co.kr']);
  assert.ok(!strategy.topTitles.includes('브랜드 사주 추천 후기'), '브랜드 콘텐츠는 상위 글 형식 계산에서 뺀다');
  assert.match(strategy.promptBlock, /사용 안내형/);
  assert.match(strategy.promptBlock, /유료 상담 영역/);
  assert.match(strategy.promptBlock, /재회사주/);
  assert.ok(strategy.warnings.some((w) => /sajugpt/.test(w)));
});

test('카페 이름 라벨·무관한 제목은 빼고 한글 도메인은 읽을 수 있게 바꾼다', () => {
  const obs = { measured: true, siteFound: null, blocks: [
    { blockOrder: 1, blockName: '관련문서', blockKind: 'related-docs', items: [
      item('사주', '웹', 'xn--vf4b25m.com'),
      item('리그오브레전드 한국커뮤니티 - LoLKor', '카페', 'cafe.naver.com'),
      item('오늘 점심 메뉴 고민되네요', '블로그'),
      item('재회 사주 보고 온 이야기', '블로그'),
    ] },
  ] };
  const strategy = buildKeywordStrategy({ keyword: '재회사주', observation: obs });
  assert.deepEqual(strategy.topTitles, ['재회 사주 보고 온 이야기']);
  assert.deepEqual(strategy.competitorSites, ['사주.com']);
  assert.ok(strategy.warnings.some((w) => w.includes('사주.com')));
  assert.ok(!strategy.promptBlock.includes('LoLKor'));
});

test('관찰을 못 하면 저장된 주제 분석으로, 그것도 없으면 경고만 남긴다', () => {
  const saved = buildKeywordStrategy({ keyword: '연애사주', observation: { measured: false }, plan: { blogSlot: 'low', serpNote: '첫 문서가 경쟁 사이트', observedAt: '2026-10-05T10:00:00Z' } });
  assert.equal(saved.source, 'saved');
  assert.match(saved.promptBlock, /2026-10-05/);
  assert.ok(saved.warnings.length === 1);
  const none = buildKeywordStrategy({ keyword: 'x', observation: null, plan: null });
  assert.equal(none.source, 'none');
  assert.equal(none.promptBlock, '');
});

test('제목 형식은 충분히 많을 때만 한 형식으로 본다', () => {
  assert.equal(classifyTitles(['사주 뜻', '궁합 방법', '추천 모음']).dominant, 'mixed');
  assert.equal(classifyTitles(['A 후기', 'B 후기', '사주 뜻']).dominant, 'review');
});

test('블로그 진입 가능성은 블로그 글이 처음 나오는 영역 순서로 정한다', () => {
  assert.equal(blogSlotFrom([{ blockOrder: 1, items: [item('a', '블로그')] }]), 'high');
  assert.equal(blogSlotFrom([{ blockOrder: 6, items: [item('a', '블로그')] }]), 'low');
  assert.equal(blogSlotFrom([{ blockOrder: 1, items: [item('a', '웹')] }]), 'low');
});

test('홈판 기준은 공포·단정 훅을 금지하고 키워드를 넣는다', () => {
  const guide = homefeedGuidance('재회사주');
  assert.match(guide, /재회사주/);
  assert.match(guide, /공포 조장/);
});

test('홈판 조회수는 0 이상의 정수만 기록한다', () => {
  const entry = createEntry({ keyword: '재회사주', topic: 'saju', purpose: 'home' });
  assert.equal(entry.purpose, 'home');
  const once = addManualStat(entry, { views: '1,234', at: '2026-10-07T00:00:00Z' });
  assert.deepEqual(once.manualStats, [{ at: '2026-10-07T00:00:00Z', views: 1234 }]);
  assert.throws(() => addManualStat(entry, { views: '-1' }));
  assert.throws(() => addManualStat(entry, { views: 'abc' }));
});
