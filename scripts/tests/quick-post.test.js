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
