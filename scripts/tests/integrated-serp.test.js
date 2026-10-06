'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseIntegratedSerp, collectIntegratedSerp, analyzeTopicKeywordPlan, saveTopicSerpSnapshot } = require('../../src/keyword/integratedSerp');

const FIXTURE = '<html><body><div id="main_pack">'
  + '<script>ignored()</script><div id="snb">검색 옵션</div><div class="sp_page">페이지 이동</div>'
  + '<section><h2>검색광고</h2><a href="https://shop.example/item">사주 상담 비교 기준을 자세히 살펴보는 방법</a><a href="https://ader.naver.com/click">광고 추적 링크 제외</a></section>'
  + '<div class="place-app-root"><h2><span class="title">플레이스</span><button>안내</button></h2><a href="https://sajuotter.com/services.html">사주보는 수달 공식 서비스와 이용방법 자세히 확인하기</a></div>'
  + '<div class="spw_fsolid"><h2>VIEW <button>MY</button></h2><a href="https://blog.naver.com/writer">수달 블로그</a>'
  + '<a href="https://blog.naver.com/writer/224012345678">사주 궁합에서 확인할 관계 흐름과 기준</a>'
  + '<a href="https://help.naver.com/notice">네이버 도움말 링크 제외</a><a href="https://keep.naver.com/save">네이버 Keep 링크 제외</a></div>'
  + '<div class="_fe_view_root"><h3><span class="sds-comps-text-title">브랜드 콘텐츠</span><button>안내</button></h3>'
  + '<a href="https://sajuotter.com/">사주보는 수달에서 살펴보는 풀이 기준과 이용 안내</a></div>'
  + '<div><h2>동영상 <button>새 창 열림</button></h2><a href="https://tv.naver.com/v/123">사주 풀이 기준을 설명하는 영상 살펴보기</a></div>'
  + '<div><a href="https://unknown.example/">제목 없는 분류 안 되는 링크</a></div>'
  + '</div></body></html>';

test('integrated SERP parser classifies blocks, preserves order, and marks site and published-post hits', () => {
  const result = parseIntegratedSerp(FIXTURE, {
    domains: ['sajuotter.com'],
    trackedPost: { blogId: 'writer', logNo: '224012345678' },
  });

  assert.deepEqual(result.blocks.map(({ blockOrder, blockName, blockKind }) => ({ blockOrder, blockName, blockKind })), [
    { blockOrder: 1, blockName: '검색광고', blockKind: 'ad' },
    { blockOrder: 2, blockName: '플레이스', blockKind: 'place' },
    { blockOrder: 3, blockName: '관련문서', blockKind: 'related-docs' },
    { blockOrder: 4, blockName: '브랜드 콘텐츠', blockKind: 'brand-content' },
    { blockOrder: 5, blockName: '동영상', blockKind: 'content' },
  ]);
  assert.equal(result.blocks[2].items[0].sourceLabel, '수달 블로그');
  assert.equal(result.blocks[2].items[0].sourceType, '블로그');
  assert.equal(result.blocks[4].items[0].sourceType, '영상');
  assert.equal(result.blocks.flatMap((block) => block.items).some((item) => /help\.naver|keep\.naver|ader\.naver/.test(item.url)), false);
  assert.deepEqual(result.postFound, {
    blockOrder: 3, blockName: '관련문서', blockKind: 'related-docs', positionInBlock: 1, overallDocPosition: 3,
  });
  assert.deepEqual(result.siteFound, { blockName: '플레이스', positionInBlock: 1 });
});

test('integrated SERP parser falls back to place-root parent and does not consume order for unclassified blocks', () => {
  const result = parseIntegratedSerp('<html><body><div id="wrap"><div class="unclassified"><a href="https://example.com/a">제목 없는 결과 링크</a></div>'
    + '<div id="place-app-root"><h2>플레이스 상세</h2><strong>주소</strong><strong>전화번호</strong><a href="https://sajuotter.com/page">사주 서비스 장소 안내와 풀이 정보를 자세히 확인하기</a></div>'
    + '<div><h2>웹 자료</h2><a href="https://example.com/page">사주를 설명하는 웹 자료를 충분히 읽고 확인하는 방법</a></div></div></body></html>', { domains: ['sajuotter.com'] });
  assert.deepEqual(result.blocks.map((block) => [block.blockOrder, block.blockName, block.blockKind]), [
    [1, '업체 상세정보', 'place-detail'], [2, '웹 자료', 'content'],
  ]);
  assert.deepEqual(result.siteFound, { blockName: '업체 상세정보', positionInBlock: 1 });
  assert.equal(result.blocks[1].items[0].sourceType, '웹');
});

test('rendered integrated collection uses guarded cache key and logged-out rendered-search partition', async () => {
  const calls = [];
  const result = await collectIntegratedSerp('사주 궁합', {
    domains: ['sajuotter.com'],
    searchUrl: (keyword) => 'https://search.naver.com/search.naver?where=nexearch&query=' + encodeURIComponent(keyword),
    userAgent: 'fixture-mobile-agent',
    runGuardedSearch: async (key, fetcher) => { calls.push(['guard', key]); return fetcher(); },
    scrapeRendered: async (...args) => { calls.push(['render', ...args]); return FIXTURE; },
  });
  assert.equal(result.measured, true);
  assert.deepEqual(calls[0], ['guard', 'https://search.naver.com/search.naver?where=nexearch&query=%EC%82%AC%EC%A3%BC%20%EA%B6%81%ED%95%A9']);
  assert.equal(calls[1][1], 'https://search.naver.com/search.naver?where=nexearch&query=%EC%82%AC%EC%A3%BC%20%EA%B6%81%ED%95%A9');
  assert.equal(calls[1][2], 'document.documentElement.outerHTML');
  assert.equal(calls[1][4], 'persist:naver-search');
  assert.equal(calls[1][5], 'fixture-mobile-agent');
  assert.match(calls[1][6].readyScript, /#main_pack/);
  assert.equal(calls[1][6].timeoutMs, 12000);
});

test('topic keyword analysis waits 15 to 25 seconds between queries and stops immediately on a block', async () => {
  const calls = [];
  const waits = [];
  const topic = { id: 'saju', keywordPlan: [{ keyword: '첫 키워드', blogSlot: 'low' }, { keyword: '둘째 키워드', blogSlot: 'mid' }, { keyword: '셋째 키워드', blogSlot: 'high' }] };
  const result = await analyzeTopicKeywordPlan(topic, {
    collect: async (keyword) => {
      calls.push(keyword);
      if (keyword === '둘째 키워드') return { measured: false, blocked: true, reason: 'blocked', blocks: [] };
      return { measured: true, blocked: false, observedAt: '2026-10-06T00:00:00.000Z', blocks: [
        { blockOrder: 1, blockName: '검색광고', blockKind: 'ad', items: [] },
        { blockOrder: 2, blockName: 'VIEW', blockKind: 'related-docs', items: [{ sourceType: '블로그' }] },
      ], siteFound: null };
    },
    sleep: async (ms) => waits.push(ms),
    random: () => 0.5,
  });
  assert.deepEqual(calls, ['첫 키워드', '둘째 키워드']);
  assert.deepEqual(waits, [20000]);
  assert.equal(result.blocked, true);
  assert.equal(result.observations.length, 2);
  assert.equal(result.keywordPlan[0].blogSlot, 'high');
  assert.equal(result.keywordPlan[1].blogSlot, 'mid');
  assert.equal(result.keywordPlan[2].blogSlot, 'high');
  assert.match(result.keywordPlan[0].serpNote, /검색광고.*VIEW/);
});

test('topic SERP analysis snapshot is saved under its date-specific filename', () => {
  const writes = [];
  const fakeFs = {
    mkdirSync(directory) { writes.push(['mkdir', directory]); },
    writeFileSync(file, content) { writes.push(['write', file, JSON.parse(content)]); },
    renameSync(from, to) { writes.push(['rename', from, to]); },
  };
  const saved = saveTopicSerpSnapshot('C:\\userData\\topic-assets\\saju', {
    dateKey: '20261006', keywordPlan: [], observations: [], blocked: false,
  }, { fs: fakeFs });
  assert.equal(saved, 'C:\\userData\\topic-assets\\saju\\topic-serp-20261006.json');
  assert.equal(writes[1][1], saved + '.tmp');
  assert.deepEqual(writes[2], ['rename', saved + '.tmp', saved]);
});
