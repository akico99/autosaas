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
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      mainWindow = this;
      this.webContents = new EventEmitter();
      this.webContents.id = 1;
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
      return { ...originalLoad.call(this, request, parent, isMain), generateSearchPost: async () => { travelModelCalls += 1; throw new Error('import unexpectedly invoked the model'); } };
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
    for (const channel of ['connect:catalog', 'connect:saveProduct', 'connect:prepareKeywords', 'connect:prepareDelivery']) assert.ok(channels.has(channel), channel);

    const trustedEvent = { sender: mainWindow.webContents, senderFrame: { isMainFrame: true, url: 'http://127.0.0.1:47318/app/app.html' } };
    const untrustedEvent = { sender: { isDestroyed: () => false }, senderFrame: { isMainFrame: true, url: 'http://127.0.0.1:47318/app/app.html' } };
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
    assert.ok(imported.draft.holdReasons.some((reason) => reason.includes('예약 가능 여부를 근거로 확인')));
    assert.ok(imported.draft.holdReasons.some((reason) => reason.includes('최근 24시간 안의 가격 확인')));
    assert.equal(imported.draft.result.post.blocks.some((block) => block.kind === 'link'), false);
    assert.equal(imported.draft.result.post.blocks.some((block) => block.kind === 'text' && block.text.includes('제휴')) , false);
    assert.equal(travelModelCalls, 0);

    const batch = channels.get('topicDrafts:generate')(trustedEvent, { topicId: 'travel-connect', profileKey: 'travel-a', keywords: '다낭', productIds: ['p1'], variantIds: [] });
    const deniedCancel = await channels.get('topicDrafts:cancel')(untrustedEvent);
    assert.equal(deniedCancel.ok, false);
    await batch;
  } finally {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
