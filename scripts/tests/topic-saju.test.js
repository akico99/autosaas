const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { saju, mujusky, TOPICS } = require('../../src/topics');
const { ctaUrl, buildTopicContext, topicEvidenceForIntent } = require('../../src/topics/topicContext');
const { checkTopicPost } = require('../../src/topics/postCheck');
const { findKeywordConflict, normalizeKeyword } = require('../../src/topics/keywordLog');
const { DEFAULT_PROFILES, writeTopicProfiles, readTopicProfiles } = require('../../src/topics/profiles');
const { resolveTopicImageAssets, validateCapturePages } = require('../../src/topics/assets');
const { topicEditorPayload, injectTopicPost } = require('../../src/topics/editorDelivery');
const { captureTopicSite, createTopicCaptureSession } = require('../../electron/siteCapture');
const { buildSearchUserPrompt } = require('../../src/generator/buildSearchPrompt');
const { buildUserPrompt } = require('../../src/generator/buildPrompt');

test('topic registry has the enabled saju setup and disabled mujusky placeholder', () => {
  assert.equal(TOPICS.saju, saju);
  assert.equal(saju.id, 'saju');
  assert.equal(saju.label, '사주보는 수달');
  assert.equal(saju.siteUrl, 'https://sajuotter.com');
  assert.deepEqual(saju.domains, ['sajuotter.com']);
  assert.equal(mujusky.enabled, false);
  assert.ok(saju.products.length >= 15);
  for (const product of saju.products) {
    assert.equal(new URL(product.url).hostname, 'sajuotter.com');
    if (product.price) assert.match(product.price, /^\d{1,2}(,\d{3})원$/);
    assert.ok(Array.isArray(product.tags));
    assert.ok(Array.isArray(product.fitsIntents));
  }
});

test('ctaUrl adds the requested Naver blog UTM values without dropping existing query data', () => {
  const product = saju.products.find((item) => item.key === 'compat');
  const url = new URL(ctaUrl(product, { blogKey: 'saju-b', keyword: '재회사주 궁합' }));
  assert.equal(url.origin, 'https://sajuotter.com');
  assert.equal(url.pathname, '/compat.html');
  assert.equal(url.searchParams.get('utm_source'), 'naver_blog');
  assert.equal(url.searchParams.get('utm_medium'), 'organic');
  assert.equal(url.searchParams.get('utm_campaign'), 'saju-b');
  assert.equal(url.searchParams.get('utm_content'), '재회사주 궁합');
});

test('buildTopicContext supplies disclosure, safety rules, evidence, and relevant asset metadata', () => {
  const profile = DEFAULT_PROFILES[1];
  const context = buildTopicContext({
    topic: saju,
    profile,
    keyword: '재회사주',
    productKey: 'compat',
    purpose: 'search',
    assets: [
      { id: 'compat-shot', path: 'C:\\assets\\compat.png', caption: '궁합 결과 리포트', tags: ['compat', '재회', '궁합'] },
      { id: 'unrelated', path: 'C:\\assets\\menu.png', caption: '스키장 메뉴판', tags: ['ski', 'restaurant'] },
    ],
  });
  assert.match(context.promptBlock, /\[주제 탭: 사주보는 수달\]/);
  assert.match(context.promptBlock, /제가 운영하는 사주보는 수달/);
  assert.match(context.promptBlock, /경향|참고/);
  assert.match(context.promptBlock, /의학·법·재정/);
  assert.match(context.promptBlock, /무료/);
  assert.match(context.promptBlock, /더 깊게 보려면/);
  assert.deepEqual(context.assetCatalog.map((asset) => asset.id), ['compat-shot']);
  assert.equal(context.evidenceSource.sourceType, 'user-source');
  assert.equal(context.evidenceSource.contentKind, 'service-facts');
  assert.equal(context.evidenceSource.url, saju.siteUrl);
  assert.match(context.evidenceSource.text, /3,900원/);
});

test('service-fact evidence is never counted as an original source for latest-issue intent', () => {
  const evidence = buildTopicContext({ topic: saju, profile: DEFAULT_PROFILES[0], keyword: '사주사이트', productKey: 'services' }).evidenceSource;
  assert.deepEqual(topicEvidenceForIntent(evidence, 'news'), []);
  assert.deepEqual(topicEvidenceForIntent(evidence, 'service'), [evidence]);
});

test('topic post checks review missing disclosure, repeated brand names, and unsupported prices', () => {
  const context = { topic: saju, product: saju.products.find((item) => item.key === 'compat') };
  const valid = {
    title: '재회사주 궁합은 무엇을 볼까',
    blocks: [{ kind: 'text', text: '제가 운영하는 사주보는 수달에서는 상담사 없이 AI가 풀이 리포트를 만듭니다. 궁합 심층 리딩은 4,900원입니다.' }],
  };
  assert.equal(checkTopicPost(valid, context).status, 'ready');
  assert.equal(checkTopicPost({ ...valid, blocks: [{ kind: 'text', text: '상담사 없이 AI가 풀이 리포트를 만듭니다.' }] }, context).status, 'review');
  assert.equal(checkTopicPost({ ...valid, blocks: [{ kind: 'text', text: '제가 운영하는 사주보는 수달에서는 안내합니다. 사주보는 수달은 AI 풀이를 제공합니다. 사주보는 수달에서 확인하세요.' }] }, context).status, 'review');
  assert.equal(checkTopicPost({ ...valid, blocks: [{ kind: 'text', text: '제가 운영하는 사주보는 수달에서는 5,000원에 제공합니다.' }] }, context).status, 'review');
});

test('topic post checks hold customer-perspective and forbidden claims', () => {
  const context = { topic: saju, product: saju.products.find((item) => item.key === 'intro') };
  for (const text of [
    '제가 운영하는 사주보는 수달에서는 저는 직접 결제해봤습니다.',
    '제가 운영하는 사주보는 수달에서는 내돈내산 경험을 전합니다.',
    '제가 운영하는 사주보는 수달에서는 솔직 후기입니다.',
    '제가 운영하는 사주보는 수달에서는 별점과 만족도 5점을 확인했습니다.',
    '제가 운영하는 사주보는 수달에서는 적중률 100%로 무조건 맞히며 큰일을 막아드립니다.',
    '제가 운영하는 사주보는 수달에서는 이 운세를 무시하면 큰일 납니다.',
  ]) {
    const result = checkTopicPost({ title: '사주 정보', blocks: [{ kind: 'text', text }] }, context);
    assert.equal(result.status, 'hold');
    assert.ok(result.holdReasons.length > 0);
  }
  for (const text of [
    '제가 운영하는 사주보는 수달에서는 후기만 보고 고르지 말고 기준을 비교해 보세요.',
    '제가 운영하는 사주보는 수달에서는 큰일을 걱정하는 분께 참고 정보를 안내합니다.',
    '제가 운영하는 사주보는 수달에서는 큰일을 막아준다고 단정하지 않습니다.',
  ]) {
    assert.equal(checkTopicPost({ title: '사주 정보', blocks: [{ kind: 'text', text }] }, context).status, 'ready');
  }
});

test('topic post checks inspect qna, table, and quote text as part of the post body', () => {
  const context = { topic: saju, product: saju.products.find((item) => item.key === 'intro') };
  const disclosure = '제가 운영하는 사주보는 수달에서는';
  const posts = [
    { blocks: [{ kind: 'qna', question: disclosure + ' 어떤 정보를 볼 수 있나요?', answer: '무료 메뉴를 볼 수 있습니다.' }] },
    { blocks: [{ kind: 'qna', question: '어떤 정보를 볼 수 있나요?', answer: disclosure + ' 무료 메뉴를 안내합니다.' }] },
    { blocks: [{ kind: 'table', caption: disclosure, columns: ['질문', '답'], rows: [['서비스', '안내']] }] },
    { blocks: [{ kind: 'table', caption: '표 제목', columns: [disclosure, '답'], rows: [['서비스', '안내']] }] },
    { blocks: [{ kind: 'table', caption: '표 제목', columns: ['질문', '답'], rows: [[disclosure, '안내']] }] },
    { blocks: [{ kind: 'quote', text: disclosure + ' 경향과 참고 내용을 정리합니다.' }] },
  ];
  for (const post of posts) assert.equal(checkTopicPost(post, context).status, 'ready');
});

test('keyword log distinguishes 30-day cross-blog and 14-day same-blog conflicts', () => {
  const now = Date.parse('2026-10-06T00:00:00.000Z');
  const records = [
    { topicId: 'saju', blogKey: 'saju-a', keyword: '재회사주', at: new Date(now - 29 * 86400000).toISOString() },
    { topicId: 'saju', blogKey: 'saju-b', keyword: '사주풀이', at: new Date(now - 13 * 86400000).toISOString() },
    { topicId: 'saju', blogKey: 'saju-c', keyword: '무료사주', at: new Date(now - 31 * 86400000).toISOString() },
  ];
  assert.equal(normalizeKeyword(' 재회 사주 '), '재회사주');
  assert.equal(findKeywordConflict(records, { topicId: 'saju', blogKey: 'saju-c', keyword: '재회 사주', now }).kind, 'different-blog');
  assert.equal(findKeywordConflict(records, { topicId: 'saju', blogKey: 'saju-b', keyword: '사주 풀이', now }).kind, 'same-blog');
  assert.equal(findKeywordConflict(records, { topicId: 'saju', blogKey: 'saju-b', keyword: '무료 사주', now }), null);
});

test('topic asset mapping honors requested ids, replaces missing ids, and prevents repeated assets', () => {
  const assets = [
    { id: 'compat-a', path: 'C:\\assets\\a.png', caption: '궁합 결과', tags: ['compat', '재회'] },
    { id: 'compat-b', path: 'C:\\assets\\b.png', caption: '인연 풀이', tags: ['compat', '궁합'] },
    { id: 'free-c', path: 'C:\\assets\\c.png', caption: '무료 오행', tags: ['free-balance', '오행'] },
  ];
  const post = { blocks: [
    { kind: 'image', assetId: 'compat-a', imageHint: '궁합' },
    { kind: 'image', assetId: 'missing', imageHint: '궁합' },
    { kind: 'image', assetId: 'compat-a', imageHint: '재회' },
  ] };
  const resolved = resolveTopicImageAssets(post, assets, { productKey: 'compat', keyword: '재회사주', blogKey: 'saju-a' });
  assert.deepEqual(resolved.assetIds, ['compat-a', 'compat-b']);
  assert.deepEqual(resolved.assetPaths, ['C:\\assets\\a.png', 'C:\\assets\\b.png']);
  assert.equal(resolved.post.blocks.filter((block) => block.kind === 'image').length, 2);
});

test('topic asset mapping deprioritizes an asset recently used by another blog', () => {
  const now = Date.parse('2026-10-06T00:00:00.000Z');
  const assets = [
    { id: 'recent', path: 'C:\\assets\\recent.png', caption: '궁합 결과', tags: ['compat', '재회'] },
    { id: 'fresh', path: 'C:\\assets\\fresh.png', caption: '궁합 풀이', tags: ['compat', '재회'] },
  ];
  const resolved = resolveTopicImageAssets({ blocks: [{ kind: 'image', assetId: 'recent', imageHint: '재회' }] }, assets, {
    productKey: 'compat', keyword: '재회사주', blogKey: 'saju-b', now,
    usage: [{ assetId: 'recent', blogKey: 'saju-a', at: new Date(now - 4 * 86400000).toISOString() }],
  });
  assert.deepEqual(resolved.assetIds, ['fresh']);
});

test('topic editor handoff sends mapped photos through an injected finishGen fake', async () => {
  const calls = [];
  const post = { title: '사주 정보', blocks: [] };
  const payload = topicEditorPayload({ post, keyword: '사주풀이', purpose: 'search', assets: [{ path: 'C:\\framed\\one.png' }] });
  assert.deepEqual(payload.photos, ['C:\\framed\\one.png']);
  await injectTopicPost({
    post, keyword: '사주풀이', purpose: 'search', assets: [{ path: 'C:\\framed\\one.png' }],
    setPhotos: (photos) => calls.push(['photos', photos]),
    setImageMode: (mode) => calls.push(['mode', mode]),
    finishGen: async (...args) => calls.push(['finish', ...args]),
  });
  assert.equal(calls[0][0], 'photos');
  assert.deepEqual(calls[0][1], ['C:\\framed\\one.png']);
  assert.deepEqual(calls[1], ['mode', 'search']);
  assert.equal(calls[2][0], 'finish');
  assert.deepEqual(calls[2].slice(1), [post, '사주풀이', [], null, { search: true }]);
});

test('topic profile persistence writes through a temporary file and renames atomically', () => {
  let writePath = '';
  let renamed = null;
  const fakeFs = {
    mkdirSync() {},
    writeFileSync(file) { writePath = file; },
    renameSync(from, to) { renamed = [from, to]; },
  };
  const file = 'C:\\userData\\topic-profiles.json';
  const saved = writeTopicProfiles(file, { profiles: DEFAULT_PROFILES }, { fs: fakeFs });
  assert.equal(writePath, file + '.tmp');
  assert.deepEqual(renamed, [file + '.tmp', file]);
  assert.equal(saved.profiles.length, 3);
});

test('capture paths reject account, profile, payment, and login routes', () => {
  assert.throws(() => validateCapturePages({ ...saju, capturePages: [{ id: 'pay', path: '/pay' }] }), /허용되지 않는/);
  assert.throws(() => validateCapturePages({ ...saju, capturePages: [{ id: 'profile', path: '/profiles' }] }), /허용되지 않는/);
  assert.equal(validateCapturePages(saju).length, saju.capturePages.length);
});

test('site capture uses injected sessions, deduplicates adjacent slices, and writes a manifest', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-saju-capture-'));
  const loaded = [];
  const scrolled = [];
  let closed = false;
  let screenshotCount = 0;
  try {
    const result = await captureTopicSite({
      ...saju,
      capturePages: [
        { id: 'home', path: '/', caption: '서비스 소개', tags: ['intro'] },
      ],
    }, {
      outDir,
      date: new Date('2026-10-06T03:00:00.000Z'),
      sleep: async () => {},
      createSession: async (options) => {
        assert.equal(options.partition, 'persist:topic-capture');
        assert.equal(options.viewport.width, 412);
        assert.equal(options.viewport.height, 915);
        assert.equal(options.deviceScaleFactor, 2);
        return {
          load: async (url) => { loaded.push(url); },
          inspect: async () => ({ status: 200, title: '사주보는 수달', text: '서비스 소개 화면', viewportHeight: 915, scrollHeight: 10000 }),
          screenshot: async () => Buffer.from('synthetic-image-pixels-' + (++screenshotCount)),
          scrollBy: async (amount) => { scrolled.push(amount); },
          close: async () => { closed = true; },
        };
      },
    });
    assert.equal(loaded[0], 'https://sajuotter.com/');
    assert.equal(scrolled.length, 2);
    assert.equal(screenshotCount, 3);
    assert.equal(result.items.length, 3);
    assert.equal(result.items[0].id, 'home-1');
    assert.equal(result.items[0].sha1, crypto.createHash('sha1').update('synthetic-image-pixels-1').digest('hex'));
    assert.equal(fs.existsSync(path.join(outDir, 'manifest.json')), true);
    assert.equal(closed, true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('Electron topic capture session hides scrollbars on load and crops the screenshot to the painted viewport', async () => {
  const { EventEmitter } = require('node:events');
  let options;
  let zoom = null;
  let destroyed = false;
  const calls = [];
  class FakeBrowserWindow extends EventEmitter {
    constructor(input) {
      super();
      options = input;
      this.webContents = new EventEmitter();
      this.webContents.setUserAgent = (agent) => calls.push(['ua', agent]);
      this.webContents.setZoomFactor = (factor) => { zoom = factor; calls.push(['zoom', factor]); };
      this.webContents.executeJavaScript = async (script) => {
        calls.push(['script', script]);
        if (script.includes('requestAnimationFrame')) return { cw: 404, ih: 915 };
        return { title: 'Fixture', text: 'Fixture body', viewportHeight: 915, scrollHeight: 915, blocked: false };
      };
      this.webContents.insertCSS = async (css) => { calls.push(['css', css]); return 'css-key'; };
      this.webContents.capturePage = async (rect) => { calls.push(['screenshot', rect]); return { toPNG: () => Buffer.from('pixels') }; };
    }
    loadURL() { setImmediate(() => this.webContents.emit('did-finish-load')); return Promise.resolve(); }
    isDestroyed() { return destroyed; }
    destroy() { destroyed = true; this.emit('closed'); }
  }
  const session = createTopicCaptureSession({
    partition: 'persist:topic-capture', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, userAgent: 'fixture-agent',
  }, { BrowserWindow: FakeBrowserWindow });
  assert.equal(options.width, 824);
  assert.equal(options.height, 1830);
  await session.load('https://example.invalid/fixture');
  assert.equal(zoom, 2);
  assert.deepEqual(calls.slice(-2).map((call) => call[0]), ['zoom', 'css']);
  assert.match(calls[calls.length - 1][1], /::-webkit-scrollbar\{display:none!important\}/);
  await session.screenshot();
  assert.deepEqual(calls.slice(-2).map((call) => call[0]), ['script', 'screenshot']);
  assert.match(calls[calls.length - 2][1], /requestAnimationFrame/);
  assert.deepEqual(calls[calls.length - 1][1], { x: 0, y: 0, width: 808, height: 1830 });
  assert.equal(calls.filter((call) => call[0] === 'css').length, 1);
  await session.close();
  assert.equal(destroyed, true);
});

test('topic prompt builders keep their pre-topic snapshots when topicContext is omitted', () => {
  const oldRandom = Math.random;
  Math.random = () => 0.25;
  try {
    const search = buildSearchUserPrompt({ topicKey: 'society', keyword: '사주 뜻' });
    const home = buildUserPrompt({ keyword: '사주 뜻', typeLabel: '사주·운세형' });
    assert.equal(search.length, 2116);
    assert.equal(crypto.createHash('sha256').update(search).digest('hex'), '29ddf62b1d7306f473504041894031f2de484470e7954f97e7b291d4dd492235');
    assert.equal(home.length, 3017);
    assert.equal(crypto.createHash('sha256').update(home).digest('hex'), '29431f92a62678ad3767c6291846703ffe6eb2937dfc96417597630166d2c3bf');
  } finally {
    Math.random = oldRandom;
  }
});
