'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { normalizeConnectProduct, writeConnectCatalog } = require('../../src/connect/products');

test('main app.whenReady startup registers travel IPC without a catalog initializer TDZ', async () => {
  const originalLoad = Module._load;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-auto-connect-startup-'));
  const channels = new Map();
  const appEvents = new Map();
  const paths = new Map([['appData', temp], ['downloads', temp]]);
  let readyCallback;
  let mainWindow;
  let travelModelCalls = 0;
  let repairImported = null;
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      mainWindow = this;
      this.webContents = new EventEmitter();
      this.webContents.id = 1;
      const mainFrame = { url: 'http://127.0.0.1:47318/app/app.html', parent: null };
      mainFrame.top = mainFrame;
      this.webContents.mainFrame = mainFrame;
      this.webContents.send = () => {};
      this.webContents.openDevTools = () => {};
      this.loadURL = () => Promise.resolve();
    }
    isDestroyed() { return false; }
    show() {}
    destroy() {}
    static getAllWindows() { return []; }
  }
  const app = {
    setPath: (name, value) => paths.set(name, value),
    getPath: (name) => paths.get(name) || temp,
    setName() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: (callback) => { readyCallback = callback; } }),
    on: (name, callback) => appEvents.set(name, callback),
    quit() {}, exit() {},
  };
  const sessionObject = { cookies: { get: async () => [], set: async () => {} }, clearStorageData: async () => {} };
  const electron = {
    app, BrowserWindow: FakeWindow,
    ipcMain: { handle: (name, handler) => channels.set(name, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    session: { fromPartition: () => sessionObject }, clipboard: { writeText() {} },
    webContents: { fromId: () => null, getAllWebContents: () => [] }, shell: { openExternal: async () => {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, powerSaveBlocker: { start: () => 1 },
  };
  const http = {
    createServer: () => ({
      once() { return this; },
      listen(_port, _host, callback) { callback(); },
      address: () => ({ port: 47318 }),
    }),
  };
  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;
  global.setInterval = () => 0;
  global.setTimeout = () => 0;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === '../src/generator/generateSearchPost' && parent && parent.filename.endsWith(path.join('electron', 'main.js'))) {
      return { ...originalLoad.call(this, request, parent, isMain), generateSearchPost: async () => { travelModelCalls += 1; if (repairImported) return { post: null, status: 'hold', holdReasons: ['테스트 작성 중단'] }; throw new Error('import unexpectedly invoked the model'); } };
    }
    if (request === '../src/connect/productImport' && parent && parent.filename.endsWith(path.join('electron', 'main.js'))) {
      const actual = originalLoad.call(this, request, parent, isMain);
      return { ...actual, createTravelProductImporter: (options) => { const importer = actual.createTravelProductImporter(options); return (input) => repairImported ? Promise.resolve({ ok: true, imported: repairImported }) : importer(input); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const mainPath = path.join(__dirname, '..', '..', 'electron', 'main.js');
    const mainModule = new Module(mainPath, module);
    mainModule.filename = mainPath;
    mainModule.paths = Module._nodeModulePaths(path.dirname(mainPath));
    const source = fs.readFileSync(mainPath, 'utf8');
    const mainRequire = (request) => request === 'http' ? http : mainModule.require(request);
    const compiled = new Function('require', 'module', 'exports', '__filename', '__dirname', source);
    compiled(mainRequire, mainModule, mainModule.exports, mainPath, path.dirname(mainPath));
    assert.equal(typeof readyCallback, 'function');
    await readyCallback();
    for (const channel of ['connect:catalog', 'connect:saveProduct', 'connect:prepareKeywords', 'connect:prepareDelivery', 'connect:importProduct']) assert.ok(channels.has(channel), channel);

    const trustedEvent = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
    const untrustedEvent = { sender: { isDestroyed: () => false }, senderFrame: { isMainFrame: true, url: 'http://127.0.0.1:47318/app/app.html' } };
    const unsafeImport = await channels.get('connect:importProduct')(trustedEvent, { url: 'http://127.0.0.1/private' });
    assert.equal(unsafeImport.kind, 'private_target', 'documented WebFrameMain mainFrame identity should pass sender validation before URL validation');
    const deniedSubframe = await channels.get('connect:importProduct')({
      sender: mainWindow.webContents,
      senderFrame: { isMainFrame: true, url: trustedEvent.senderFrame.url, parent: trustedEvent.senderFrame, top: trustedEvent.senderFrame },
    }, { url: 'http://127.0.0.1/private' });
    assert.equal(deniedSubframe.error, '허용되지 않은 IPC 발신자입니다.');
    const userData = paths.get('userData');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'topic-drafts.json'), JSON.stringify({ version: 1, drafts: [{ id: 'travel-draft', topicId: 'travel-connect', status: 'review', result: { connect: {} } }] }));

    assert.equal((await channels.get('topicDrafts:list')(untrustedEvent, 'travel-connect')).ok, false);
    assert.equal((await channels.get('topicDrafts:delete')(untrustedEvent, { id: 'travel-draft' })).ok, false);
    assert.equal((await channels.get('topicDrafts:markInjected')(untrustedEvent, { id: 'travel-draft' })).ok, false);
    assert.equal((await channels.get('topicDrafts:import')(untrustedEvent, { topicId: 'travel-connect' })).ok, false);
    assert.equal((await channels.get('topicDrafts:generate')(untrustedEvent, { topicId: 'travel-connect' })).ok, false);

    const product = normalizeConnectProduct({
      id: 'travel-import-p1', connectKind: 'travel', name: '제주 패키지', provider: '여행사',
      detailUrl: 'https://provider.example/trips/jeju', affiliateUrlRaw: 'https://affiliate.example/trips/jeju?issued=1',
      profileKey: 'travel-a', eligibility: 'unknown',
      variants: [{ id: 'travel-import-v1', currency: 'KRW', amountMinor: 990000, priceCheckedAt: '2020-01-01T00:00:00.000Z', options: ['기본'], departureDate: '2027-03-01', adults: 2, children: 0, roomBasis: '2인 1실' }],
      facts: [], travelDetails: { destination: '제주', travelType: 'package', nights: 2, days: 3, inclusions: [], exclusions: [], cancellationPolicy: '' }, images: [],
    });
    writeConnectCatalog(path.join(userData, 'connect', 'catalog.json'), { version: 1, products: [product], sources: [] });
    fs.writeFileSync(path.join(userData, 'topic-profiles.json'), JSON.stringify({ profiles: [{ key: 'travel-a', topicId: 'travel-connect', name: '여행', persona: '정보 운영자', toneHint: '차분한 설명체' }] }));
    const imported = await channels.get('topicDrafts:import')(trustedEvent, {
      topicId: 'travel-connect', profileKey: 'travel-a', keyword: '제주 패키지', productIds: ['travel-import-p1'],
      variantIds: ['travel-import-v1'], travelTopic: 'domestictravel', text: '# 직접 작성한 여행 원고\n\n저자가 직접 작성한 본문입니다.',
    });
    assert.equal(imported.ok, true, imported.error);
    assert.equal(imported.draft.status, 'hold');
    assert.equal(imported.draft.result.post.title, '직접 작성한 여행 원고');
    assert.ok(imported.draft.result.post.blocks.some((block) => block.kind === 'text' && block.text.includes('저자가 직접 작성한 본문')));
    assert.equal(imported.draft.result.connect.productSnapshots[0].id, 'travel-import-p1');
    assert.ok(imported.draft.holdReasons.some((reason) => reason.includes('발급 링크 확인이 필요')));
    assert.ok(imported.draft.holdReasons.some((reason) => reason.includes('최근 24시간 안의 가격 확인')));
    assert.equal(imported.draft.result.post.blocks.some((block) => block.kind === 'link'), false);
    assert.equal(imported.draft.result.post.blocks.some((block) => block.kind === 'text' && block.text.includes('제휴')) , false);
    assert.equal(travelModelCalls, 0);

    const beforeAttempt = JSON.parse(fs.readFileSync(path.join(userData, 'topic-drafts.json'), 'utf8')).drafts.length;
    const notCreated = await channels.get('generate:topic')(trustedEvent, {
      topicId: 'travel-connect', profileKey: 'travel-a', keyword: '제주 패키지', productIds: ['travel-import-p1'], variantIds: ['travel-import-v1'], travelTopic: 'domestictravel',
    });
    assert.equal(notCreated.post, null);
    assert.equal(notCreated.stage, 'prepare');
    assert.equal(notCreated.draftSaved, false);
    assert.equal(notCreated.draft, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'topic-drafts.json'), 'utf8')).drafts.length, beforeAttempt);
    assert.equal(travelModelCalls, 0);

    const batch = channels.get('topicDrafts:generate')(trustedEvent, { topicId: 'travel-connect', profileKey: 'travel-a', keywords: '다낭', productIds: ['p1'], variantIds: [] });
    const deniedCancel = await channels.get('topicDrafts:cancel')(untrustedEvent);
    assert.equal(deniedCancel.ok, false);
    await batch;

    // Full main IPC path: legacy stored product -> issued-link repair -> writer.
    const { extractTravelProduct } = require('../../src/connect/productImport');
    const { buildAutoImportSave } = require('../../src/connect/autoPipeline');
    const detailUrl = 'https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101';
    repairImported = extractTravelProduct({ html: fs.readFileSync(path.join(__dirname, 'fixtures/travel-product-import/naver-ybtour-product.html'), 'utf8'), url: detailUrl, collectedAt: new Date().toISOString() });
    repairImported.resolution = { issuedUrl: 'https://naver.me/GdTuMXPg', finalUrl: detailUrl, chain: ['https://naver.me/GdTuMXPg', 'https://brandconnect.naver.com/connect/issued', detailUrl] };
    const built = buildAutoImportSave({ imported: repairImported, catalog: { products: [], sources: [] } });
    const legacy = normalizeConnectProduct({ ...built.product, eligibility: 'unknown', facts: built.product.facts.filter((fact) => fact.field !== 'eligibility') }, { sources: built.sources });
    writeConnectCatalog(path.join(userData, 'connect/catalog.json'), { version: 1, products: [legacy], sources: built.sources });
    const beforeRepairAttempt = JSON.parse(fs.readFileSync(path.join(userData, 'topic-drafts.json'), 'utf8')).drafts.length;
    const repairedRequest = await channels.get('generate:topic')(trustedEvent, { topicId: 'travel-connect', profileKey: 'travel-a', keyword: '부산 대마도 1박2일', productIds: [legacy.id], variantIds: [legacy.variants[0].id], travelTopic: 'worldtravel' });
    assert.equal(travelModelCalls, 1, 'the repaired registration must pass preflight and reach the injected writer');
    assert.equal(repairedRequest.stage, 'write');
    assert.equal(repairedRequest.draftSaved, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'connect/catalog.json'), 'utf8')).products[0].eligibility, 'verified');
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'topic-drafts.json'), 'utf8')).drafts.length, beforeRepairAttempt);
  } finally {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
