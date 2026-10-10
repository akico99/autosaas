'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quickPost = require('../../src/connect/quickPost');

test('keyword JSON parsing strips fences, trims reasons, and fills missing suggestions', () => {
  const parsed = quickPost.parseKeywordsResponse('```json\n{"keywords":[{"keyword":"부산 대마도 여행","reason":"목적지를 함께 찾는 검색어라 좋아요. 이 문장은 길어요."},{"keyword":"대마도 배편"}]}\n```', '대마도 1박2일 패키지');
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].keyword, '부산 대마도 여행');
  assert.ok(parsed[0].reason.length <= 40);
  assert.ok(parsed[2].keyword);
});

test('keyword fallback derives three phrases from the page title on malformed output', () => {
  const title = '부산 출발 대마도 1박2일 패키지 여행';
  const keywords = quickPost.parseKeywordsResponse('not json', title);
  assert.equal(keywords.length, 3);
  assert.ok(keywords.every((item) => item.keyword.length > 0));
  assert.ok(keywords.some((item) => /대마도/.test(item.keyword)));
});

test('post assembly adds disclosure, exact issued links, title keyword, and capped asset mapping', () => {
  const issuedUrl = 'https://naver.me/AbC?from=connect%2F42';
  const assets = Array.from({ length: 8 }, (_, i) => ({ id: `img-${i + 1}`, path: `C:/photos/${i + 1}.jpg`, caption: '대마도 상품' }));
  const generated = JSON.stringify({ title: '대마도 여행 정보 https://wrong.example/', blocks: [
    { kind: 'text', text: '대마도 일정과 가격을 살펴봅니다. https://wrong.example/path. 자세한 주소 naver.me/wrong.' },
    ...Array.from({ length: 8 }, () => ({ kind: 'image' })),
    { kind: 'heading', text: '포함 내역' }, { kind: 'text', text: '식사와 이동 정보를 확인합니다.' },
    { kind: 'link', text: '모델이 만든 링크', href: 'https://wrong.example' },
  ] });
  const { post, assets: assigned } = quickPost.assemblePost({ generated, keyword: '대마도 패키지 여행', kind: 'travel', issuedUrl, assets, title: '대마도 상품' });
  assert.ok(post.title.includes('대마도 패키지 여행'));
  assert.match(post.blocks[0].text, /여행 커넥트 활동/);
  const links = post.blocks.filter((block) => block.kind === 'link');
  assert.equal(links.length, 2);
  assert.ok(links.every((block) => block.href === issuedUrl));
  const images = post.blocks.filter((block) => block.kind === 'image');
  assert.equal(images.length, 6);
  assert.deepEqual(images.map((block) => block.assetId), assigned.map((asset) => asset.id));
  assert.equal(assigned.length, 6);
  assert.ok(post.blocks.every((block) => !JSON.stringify(block).includes('wrong.example')));
  assert.ok(post.blocks.filter((block) => block.kind !== 'link').every((block) => !JSON.stringify(block).includes('naver.me/wrong')));
});

test('post assembly supplies up to three image blocks and shopping disclosure', () => {
  const { post, assets } = quickPost.assemblePost({
    generated: { title: '상품 소개', blocks: [{ kind: 'text', text: '소개입니다.' }] },
    keyword: '무선 이어폰 추천', kind: 'shopping', issuedUrl: 'https://smartstore.naver.com/store/products/7',
    assets: [{ id: 'img-1', path: 'one.jpg' }, { id: 'img-2', path: 'two.jpg' }, { id: 'img-3', path: 'three.jpg' }, { id: 'img-4', path: 'four.jpg' }],
  });
  assert.match(post.blocks[0].text, /쇼핑 커넥트 활동/);
  assert.equal(post.blocks.filter((block) => block.kind === 'image').length, 3);
  assert.equal(assets.length, 3);
  assert.equal(post.blocks[2].kind, 'link');
  assert.equal(post.blocks.at(-1).href, 'https://smartstore.naver.com/store/products/7');
});

test('kind detection distinguishes travel Naver pages from shopping', () => {
  assert.equal(quickPost.detectKind('https://pkgtour.naver.com/products/123'), 'travel');
  assert.equal(quickPost.detectKind('https://www.naver.com/travel/hotels/123'), 'travel');
  assert.equal(quickPost.detectKind('https://smartstore.naver.com/shop/products/123'), 'shopping');
});

test('mobile formatting wraps lines near 20 chars, keeps paragraphs short, and highlights marked text', () => {
  const blocks = quickPost.formatTextBlocks('부산에서 출발해 1박 2일 동안 대마도 이즈하라를 둘러보는 일정입니다. ==온천욕과 BBQ 특식이 포함돼 있어 따로 챙길 비용이 적습니다.== 출발 확정 상품이라 일정이 취소될 걱정도 덜 수 있습니다. 가격은 작성 시점 기준입니다.');
  assert.ok(blocks.length >= 2);
  for (const block of blocks) {
    const lines = block.text.split('\n');
    assert.ok(lines.length <= quickPost.LAYOUT.maxParagraphLines);
    assert.ok(lines.every((line) => line.length <= quickPost.LAYOUT.lineChars || !line.includes(' ')), lines.join('|'));
    assert.ok(!block.text.includes('=='));
  }
  const html = blocks.map((block) => block.html).join('');
  assert.match(html, /background-color:#fff5b1/);
  assert.equal((html.match(/<span/g) || []).length, (html.match(/<\/span>/g) || []).length);
});

test('title always carries a number, preferring the page price', () => {
  assert.equal(quickPost.ensureTitleNumber('대마도 여행 1박 2일 정리', '229,000 원', 4), '대마도 여행 1박 2일 정리');
  assert.match(quickPost.ensureTitleNumber('대마도 온천 여행 정리', '229,000 원', 4), /229,000원/);
  assert.match(quickPost.ensureTitleNumber('이어폰 고르는 법', '', 5), /핵심 5가지/);
});

test('selling layout: hook, summary box, three button links, image captions, plain headings', () => {
  const issuedUrl = 'https://naver.me/Test';
  const generated = { title: '대마도 온천 여행 정리', blocks: [
    { kind: 'text', text: '부산에서 1박 2일, 22만 원대로 온천까지 가능할까요?' },
    { kind: 'summary', title: '한눈에 보기', items: ['가격 229,000원부터', '1박 2일 일정', '==온천욕 포함==', 'BBQ 특식'] },
    { kind: 'image', caption: '이즈하라 시내 풍경' },
    ...[1, 2, 3, 4].flatMap((n) => [{ kind: 'heading', text: `==소제목 ${n}==` }, { kind: 'text', text: `본문 ${n} 내용입니다.` }]),
    { kind: 'qna', question: '취소는?', answer: '출발 7일 전까지 규정에 따라 환불됩니다. 자세한 기준은 상품 페이지에서 확인하세요.' },
  ] };
  const { post } = quickPost.assemblePost({ generated, keyword: '대마도 온천 여행', kind: 'travel', issuedUrl, assets: [{ id: 'img-1', path: 'a.jpg' }], title: '대마도', priceText: '229,000 원' });
  assert.ok(post.blocks[0]._disclosure);
  assert.match(post.blocks[1].text, /22만 원대/);
  assert.match(post.blocks[2].text, /^한눈에 보기/);
  assert.equal(post.blocks[3].kind, 'link');
  const links = post.blocks.filter((block) => block.kind === 'link');
  assert.equal(links.length, 3);
  assert.ok(links.every((block) => block.href === issuedUrl && block.btn === true));
  const imageIndex = post.blocks.findIndex((block) => block.kind === 'image');
  assert.match(post.blocks[imageIndex + 1].text, /이즈하라/);
  assert.ok(post.blocks.filter((block) => block.kind === 'heading').every((block) => !block.text.includes('==')));
  assert.match(post.title, /\d/);
  const qna = post.blocks.find((block) => block.kind === 'qna');
  assert.ok(qna.answer.split('\n').every((line) => line.length <= quickPost.LAYOUT.lineChars + 6));
});

test('page text cleanup drops leading navigation and caps length to save tokens', () => {
  const raw = 'Naver 로그인 더보기 여행상품 메뉴 '.repeat(5) + '부산출발 대마도 2일 1명부터출발확정 상품 설명 ' + '일정 안내 '.repeat(2000);
  const cleaned = quickPost.cleanPageText(raw, '부산출발 대마도 2일 1명부터출발확정');
  assert.ok(cleaned.startsWith('부산출발 대마도 2일'));
  assert.ok(cleaned.length <= 4000);
  assert.ok(quickPost.buildKeywordPrompt({ title: '부산출발 대마도 2일', summary: raw, priceText: '' }).length < 2200);
});
