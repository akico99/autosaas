'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDraftText, postToDraftText, ensureImageSlots } = require('../../src/topics/draftText');
const drafts = require('../../src/topics/drafts');

const SAMPLE = [
  '제목: 인터넷사주, 처음 볼 때 확인할 3가지',
  '요약: 만세력 계산과 결과 형태를 먼저 보세요.',
  '',
  '인터넷사주를 고를 때 많이들 헷갈립니다.',
  '두 줄로 쓴 문단입니다.',
  '',
  '## 만세력 계산이 맞는지',
  '[사진: compat-1]',
  '본문 문단입니다.',
  '',
  '> 사주는 참고 자료입니다.',
  '',
  '| 기준 | 설명 |',
  '|---|---|',
  '| 상담사 | 없음 |',
  '',
  'Q. 무료로 볼 수 있나요?',
  'A. 오늘의 운세는 무료입니다.',
  '---',
  '[사진: 리포트 화면]',
  '태그: #사주 #인터넷사주',
].join('\n');

test('원고 텍스트를 블록 구조로 나눈다', () => {
  const { post, warnings } = parseDraftText(SAMPLE, { knownAssetIds: ['compat-1'] });
  assert.deepEqual(warnings, []);
  assert.equal(post.title, '인터넷사주, 처음 볼 때 확인할 3가지');
  assert.equal(post.description, '만세력 계산과 결과 형태를 먼저 보세요.');
  assert.deepEqual(post.hashtags, ['사주', '인터넷사주']);
  assert.deepEqual(post.blocks.map((block) => block.kind), ['text', 'heading', 'image', 'text', 'quote', 'table', 'qna', 'hr', 'image']);
  assert.equal(post.blocks[0].text, '인터넷사주를 고를 때 많이들 헷갈립니다. 두 줄로 쓴 문단입니다.');
  assert.equal(post.blocks[2].assetId, 'compat-1');
  assert.deepEqual(post.blocks[5].columns, ['기준', '설명']);
  assert.deepEqual(post.blocks[5].rows, [['상담사', '없음']]);
  assert.equal(post.blocks[6].answer, '오늘의 운세는 무료입니다.');
  assert.equal(post.blocks[8].assetId, undefined);
  assert.equal(post.blocks[8].imageHint, '리포트 화면');
});

test('텍스트로 바꿨다가 다시 읽어도 같은 원고가 된다', () => {
  const first = parseDraftText(SAMPLE, { knownAssetIds: ['compat-1'] }).post;
  const second = parseDraftText(postToDraftText(first), { knownAssetIds: ['compat-1'] }).post;
  assert.deepEqual(second, first);
});

test('제목 표시가 없으면 첫 줄을 제목으로 쓰고, 본문이 없으면 경고한다', () => {
  const titled = parseDraftText('사주궁합 보는 기준\n\n첫 문단입니다.');
  assert.equal(titled.post.title, '사주궁합 보는 기준');
  assert.equal(titled.post.blocks[0].text, '첫 문단입니다.');
  assert.ok(parseDraftText('제목: 제목만').warnings.includes('본문 문단이 없습니다.'));
  assert.ok(parseDraftText('').warnings.includes('제목이 없습니다.'));
});

test('사진 표시가 없으면 앞쪽 소제목 앞에 사진 자리를 넣는다', () => {
  const { post } = parseDraftText('제목: t\n\n문단\n\n## 하나\n가\n\n## 둘\n나\n\n## 셋\n다');
  const slotted = ensureImageSlots(post, { maxImages: 2 });
  assert.deepEqual(slotted.blocks.map((block) => block.kind), ['text', 'image', 'heading', 'text', 'image', 'heading', 'text', 'heading', 'text']);
  assert.equal(ensureImageSlots(slotted).blocks.filter((block) => block.kind === 'image').length, 2);
});

test('보관함은 최신 원고를 앞에 두고 수정·삭제한다', () => {
  let store = drafts.emptyStore();
  const first = drafts.addDraft(store, { topicId: 'saju', profileKey: 'saju-a', keyword: '인터넷사주', purpose: 'search', status: 'review' }, { now: 1000 });
  const second = drafts.addDraft(first.store, { topicId: 'saju', profileKey: 'saju-a', keyword: '재회사주', purpose: 'home', source: 'import' }, { now: 2000 });
  store = second.store;
  assert.deepEqual(drafts.listDrafts(store, 'saju').map((draft) => draft.keyword), ['재회사주', '인터넷사주']);
  assert.equal(second.draft.source, 'import');
  const updated = drafts.updateDraft(store, first.draft.id, { status: 'ready', injectedAt: 'x' }, { now: 3000 });
  assert.equal(updated.draft.status, 'ready');
  assert.equal(updated.draft.keyword, '인터넷사주');
  assert.equal(drafts.removeDraft(updated.store, first.draft.id).drafts.length, 1);
  assert.throws(() => drafts.removeDraft(updated.store, 'none'));
});

test('보관함은 최대 개수를 넘기면 오래된 원고부터 뺀다', () => {
  let store = drafts.emptyStore();
  for (let index = 0; index < drafts.MAX_DRAFTS + 5; index += 1) store = drafts.addDraft(store, { topicId: 'saju', keyword: 'k' + index }, { now: index }).store;
  assert.equal(store.drafts.length, drafts.MAX_DRAFTS);
  assert.equal(store.drafts[0].keyword, 'k' + (drafts.MAX_DRAFTS + 4));
});

test('키워드 목록은 중복을 빼고 최대 개수까지만 쓴다', () => {
  const result = drafts.parseKeywordList('인터넷사주, 재회사주\n인터넷사주\n\n사주궁합', { max: 2 });
  assert.deepEqual(result.keywords, ['인터넷사주', '재회사주']);
  assert.equal(result.dropped, 1);
});
