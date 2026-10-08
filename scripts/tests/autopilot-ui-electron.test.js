'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const root = path.join(__dirname, '..', '..');
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8' };
const files = {
  '/app/connect-ui-fixture.html': 'scripts/tests/fixtures/connect-ui.html',
  '/app/travel-connect.html': 'app/travel-connect.html',
  '/app/travel-connect.css': 'app/travel-connect.css',
  '/app/travel-connect.js': 'app/travel-connect.js',
  '/src/connect/policy.js': 'src/connect/policy.js',
  '/src/topics/publishPlan.js': 'src/topics/publishPlan.js',
  '/src/topics/editorGuard.js': 'src/topics/editorGuard.js',
  '/src/topics/editorDelivery.js': 'src/topics/editorDelivery.js',
  '/src/topics/travelConnect.js': 'src/topics/travelConnect.js',
};

async function withAutopilotPage(run) {
  const server = http.createServer((req, res) => {
    const relative = files[new URL(req.url, 'http://localhost').pathname];
    if (!relative) { res.writeHead(404); res.end('missing'); return; }
    const file = path.join(root, relative);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    if (relative === 'scripts/tests/fixtures/connect-ui.html') {
      const appHtml = fs.readFileSync(path.join(root, 'app/app.html'), 'utf8');
      const appCss = appHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
      res.end(fs.readFileSync(file, 'utf8').replace('</head>', '<style>' + appCss + '</style></head>'));
    } else fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-ui-electron-'));
  const mainJs = `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'user-data'));app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,cb)=>{const u=new URL(d.url);cb({cancel:!(u.hostname==='127.0.0.1'||u.hostname==='localhost'||u.protocol==='data:'||u.protocol==='file:')});});const w=new BrowserWindow({show:false,width:1280,height:980,webPreferences:{nodeIntegration:true,contextIsolation:false}});w.loadURL('http://127.0.0.1:${port}/app/connect-ui-fixture.html');});`;
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'autopilot-ui-fixture', version: '1.0.0', main: 'main.js' }));
  fs.writeFileSync(path.join(temp, 'main.js'), mainJs);
  let electronApp;
  try {
    const electronEnv = { ...process.env };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    delete electronEnv.NODE_OPTIONS;
    Object.assign(electronEnv, { ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' });
    electronApp = await _electron.launch({ args: [temp], cwd: temp, env: electronEnv, timeout: 20000 });
    const page = await electronApp.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForSelector('#topic-travel-tab', { timeout: 10000 });
    await page.locator('#topic-travel-tab').click({ timeout: 10000 });
    await page.waitForFunction(() => { const e = document.getElementById('tc-pane'); return e && getComputedStyle(e).display !== 'none'; }, { timeout: 10000 });
    await page.waitForSelector('#tc-autopilot', { timeout: 10000 });
    await run(page, pageErrors);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (electronApp) await electronApp.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function freshProduct(overrides) {
  return Object.assign({
    id: 'auto-product-1',
    connectKind: 'travel',
    name: '대마도 1박 2일 패키지',
    provider: '노랑풍선',
    detailUrl: 'https://pkgtour.naver.com/products/verygoodtour/APP7579%7CWE35-20261101',
    affiliateUrlRaw: 'https://naver.me/issued-link',
    eligibility: 'verified',
    variants: [{ id: 'auto-variant-1', currency: 'KRW', amountMinor: 229000, priceCheckedAt: new Date().toISOString(), options: ['11월 1일 출발'], departureDate: '2026-11-01', roomBasis: null }],
    facts: [],
    travelDetails: { destination: '일본 대마도', travelType: 'package', nights: 1, days: 2 },
  }, overrides || {});
}

test('autopilot card: issued link flow collects seed keywords, picks a keyword, and calls generate with the current profile and travel topic', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    const product = freshProduct();
    await page.evaluate((product) => {
      window.fixtureCalls.autoImportCalls = [];
      window.fixtureCalls.keywordSeeds = [];
      window.fixtureCalls.generateCalls = [];
      window.api.connectAutoImport = async (request) => {
        window.fixtureCalls.autoImportCalls.push(request);
        return { ok: true, product, variantIds: [product.variants[0].id], seeds: ['대마도 여행', '대마도 패키지'], warnings: [] };
      };
      window.api.connectPrepareKeywords = async (request) => {
        window.fixtureCalls.keywordSeeds.push(request.seed);
        if (request.seed === '대마도 여행') {
          return { ok: true, rows: [
            { keyword: '대마도 여행', monthlyTotal: 12000, volumeStatus: 'confirmed', fit: 'conditional', observation: { status: 'blog-area' } },
            { keyword: '대마도 패키지', monthlyTotal: 4000, volumeStatus: 'confirmed', fit: 'unfit', observation: { status: 'none' } },
          ] };
        }
        return { ok: true, rows: [
          { keyword: '대마도 패키지', monthlyTotal: 4300, volumeStatus: 'confirmed', fit: 'fit', observation: { status: 'blog-area' } },
        ] };
      };
      window.api.generateTopic = async (request) => {
        window.fixtureCalls.generateCalls.push(request);
        return { ok: true, stage: 'saved', draftSaved: true, draftId: 'auto-draft-1', draft: { id: 'auto-draft-1' }, status: 'review', holdReasons: [], reviewReasons: ['상품 내용의 문장을 직접 검수하세요.'] };
      };
    }, product);

    await page.locator('#tc-auto-url').fill('https://naver.me/issued-link', { timeout: 10000 });
    await page.locator('#tc-auto-start').click({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.tc-auto-keyword-btn').length > 0, { timeout: 10000 });

    const seedsCalled = await page.evaluate(() => window.fixtureCalls.keywordSeeds);
    assert.deepEqual(seedsCalled, ['대마도 여행', '대마도 패키지'], 'both seeds from the autoImport response are queried in order');

    const keywordLabels = await page.locator('.tc-auto-keyword-btn b').allTextContents();
    assert.deepEqual(keywordLabels, ['대마도 패키지', '대마도 여행'], 'duplicate keywords keep the better fit and all candidates sort by fit before display');
    assert.equal(await page.locator('#tc-profile').inputValue(), 'travel-connect-a', 'the sole existing profile is selected by default');

    await page.locator('#tc-profile').evaluate((select) => { select.innerHTML = '<option value="">여행 프로필이 없습니다</option>'; });
    await page.locator('.tc-auto-keyword-btn').first().click({ timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('tc-auto-status').textContent.includes('프로필 추가'), { timeout: 10000 });
    assert.equal(await page.locator('#tc-profile-form').isVisible(), true, 'the profile form opens when a profile is needed');
    assert.equal((await page.evaluate(() => window.fixtureCalls.generateCalls)).length, 0, 'generation does not start without a profile');
    await page.locator('#tc-profile').evaluate((select) => { select.innerHTML = '<option value="travel-connect-a">여행 블로그 프로필</option>'; });

    await page.locator('.tc-auto-keyword-btn[data-tc-auto-keyword="대마도 패키지"]').click({ timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('tc-auto-result') && document.getElementById('tc-auto-result').hidden === false, { timeout: 10000 });

    const generateCalls = await page.evaluate(() => window.fixtureCalls.generateCalls);
    assert.equal(generateCalls.length, 1);
    assert.equal(generateCalls[0].keyword, '대마도 패키지');
    assert.deepEqual(generateCalls[0].productIds, [product.id]);
    assert.deepEqual(generateCalls[0].variantIds, [product.variants[0].id]);
    assert.equal(generateCalls[0].experience, '');
    assert.equal(generateCalls[0].travelTopic, await page.locator('#tc-travel-topic').inputValue());
    assert.equal(generateCalls[0].profileKey, await page.locator('#tc-profile').inputValue());

    const resultText = await page.locator('#tc-auto-result').innerText();
    assert.match(resultText, /검수 필요/);
    assert.match(resultText, /완료/);
    assert.ok(await page.locator('#tc-auto-view-drafts').isVisible());
  });
});

test('autopilot card: a non-issued link stops the flow at the resolve stage with a retry-able message', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    await page.evaluate(() => {
      window.fixtureCalls.autoImportCalls = [];
      window.api.connectAutoImport = async (request) => {
        window.fixtureCalls.autoImportCalls.push(request);
        return { ok: false, error: '브랜드커넥트에서 발급한 링크를 넣어 주세요.', kind: 'not_issued_link', stage: 'resolve' };
      };
    });

    await page.locator('#tc-auto-url').fill('https://pkgtour.naver.com/products/some-product', { timeout: 10000 });
    await page.locator('#tc-auto-start').click({ timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('tc-auto-status').textContent.includes('발급 링크 확인이 필요합니다'), { timeout: 10000 });

    const statusText = await page.locator('#tc-auto-status').textContent();
    assert.match(statusText, /발급 링크 확인이 필요합니다\./);
    assert.ok(await page.locator('#tc-auto-start').isEnabled(), 'the start button is re-enabled so the user can retry');
    assert.equal(await page.locator('.tc-step-error').count(), 1, 'the resolve stage is marked as the failing step');

    const calls = await page.evaluate(() => window.fixtureCalls.autoImportCalls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://pkgtour.naver.com/products/some-product');
  });
});

test('autopilot card: a keyword-collection failure leaves the flow retry-able, and a second attempt succeeds', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    const product = freshProduct({ id: 'auto-product-2', detailUrl: 'https://pkgtour.naver.com/products/retry-product' });
    await page.evaluate((product) => {
      window.fixtureCalls.autoImportCalls = 0;
      window.fixtureCalls.keywordCalls = 0;
      window.api.connectAutoImport = async () => {
        window.fixtureCalls.autoImportCalls += 1;
        return { ok: true, product, variantIds: [product.variants[0].id], seeds: ['대마도 여행'], warnings: [] };
      };
      window.api.connectPrepareKeywords = async () => {
        window.fixtureCalls.keywordCalls += 1;
        if (window.fixtureCalls.keywordCalls === 1) return { ok: false, error: '검색광고 확인 실패' };
        return { ok: true, rows: [{ keyword: '대마도 여행', monthlyTotal: 9000, volumeStatus: 'confirmed', fit: 'fit', observation: { status: 'blog-area' } }] };
      };
    }, product);

    await page.locator('#tc-auto-url').fill('https://naver.me/retry-link', { timeout: 10000 });
    await page.locator('#tc-auto-start').click({ timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('tc-auto-status').textContent.includes('추천 키워드를 가져오지 못했습니다'), { timeout: 10000 });
    assert.match(await page.locator('#tc-auto-status').textContent(), /검색광고 확인 실패/, 'the actual preparation error is shown');
    assert.equal(await page.locator('#tc-auto-summary').isVisible(), true, 'the successfully saved product remains visible after keyword preparation fails');
    assert.equal(await page.locator('#tc-products').locator('[data-tc-product]').count(), 3, 'the saved product remains in the catalog');
    assert.ok(await page.locator('#tc-auto-start').isEnabled(), 'the start button re-enables after a keyword-collection failure so the user can retry');
    assert.equal(await page.locator('.tc-auto-keyword-btn').count(), 0);

    await page.locator('#tc-auto-start').click({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.tc-auto-keyword-btn').length > 0, { timeout: 10000 });

    const autoImportCalls = await page.evaluate(() => window.fixtureCalls.autoImportCalls);
    const keywordCalls = await page.evaluate(() => window.fixtureCalls.keywordCalls);
    assert.equal(autoImportCalls, 2, 'retrying re-runs the full autoImport step, not a partial resume');
    assert.equal(keywordCalls, 2);
    const keywordLabels = await page.locator('.tc-auto-keyword-btn b').allTextContents();
    assert.deepEqual(keywordLabels, ['대마도 여행']);
  });
});

test('autopilot card: fit ranking happens before the ten-keyword limit', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    const product = freshProduct({ id: 'auto-product-rank' });
    await page.evaluate((product) => {
      window.api.connectAutoImport = async () => ({ ok: true, product, variantIds: [product.variants[0].id], seeds: ['대마도 여행'], warnings: [] });
      window.api.connectPrepareKeywords = async () => ({ ok: true, rows: [
        ...Array.from({ length: 10 }, (_, index) => ({ keyword: '조건불일치 ' + index, fit: 'unfit' })),
        { keyword: '조건부 키워드', fit: 'conditional' },
        { keyword: '상품 적합 키워드', fit: 'fit' },
      ] });
    }, product);

    await page.locator('#tc-auto-url').fill('https://naver.me/rank-before-limit');
    await page.locator('#tc-auto-start').click();
    await page.waitForFunction(() => document.querySelectorAll('.tc-auto-keyword-btn').length === 10);
    const labels = await page.locator('.tc-auto-keyword-btn b').allTextContents();
    assert.equal(labels[0], '상품 적합 키워드');
    assert.equal(labels[1], '조건부 키워드');
    assert.equal(labels.includes('조건불일치 9'), false, 'the weakest item is excluded only after all results are ranked');
  });
});

test('autopilot card: a stale price triggers connectRefreshProduct before generate runs', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    const fixedNow = Date.parse('2026-10-08T00:00:00.000Z');
    const stale = new Date(fixedNow - 6 * 60 * 60 * 1000).toISOString();
    const staleProduct = freshProduct({ id: 'auto-product-3', detailUrl: 'https://pkgtour.naver.com/products/stale-product' });
    staleProduct.variants[0].priceCheckedAt = stale;
    const refreshedProduct = freshProduct({ id: 'auto-product-3', detailUrl: 'https://pkgtour.naver.com/products/stale-product' });
    refreshedProduct.variants[0].priceCheckedAt = new Date().toISOString();
    refreshedProduct.variants[0].amountMinor = 235000;

    await page.evaluate(({ staleProduct, refreshedProduct, fixedNow }) => {
      Date.now = () => fixedNow;
      window.fixtureCalls.refreshCalls = [];
      window.fixtureCalls.generateCalls = [];
      window.api.connectAutoImport = async () => ({ ok: true, product: staleProduct, variantIds: [staleProduct.variants[0].id], seeds: ['대마도 여행'], warnings: [] });
      window.api.connectPrepareKeywords = async () => ({ ok: true, rows: [{ keyword: '대마도 여행', monthlyTotal: 9000, volumeStatus: 'confirmed', fit: 'fit', observation: { status: 'blog-area' } }] });
      window.api.connectRefreshProduct = async (request) => {
        window.fixtureCalls.refreshCalls.push(request);
        return { ok: true, product: refreshedProduct, variantIds: [refreshedProduct.variants[0].id], seeds: ['대마도 여행'], warnings: [] };
      };
      window.api.generateTopic = async (request) => {
        window.fixtureCalls.generateCalls.push(request);
        return { ok: true, draftId: 'auto-draft-2', draft: { id: 'auto-draft-2' }, status: 'ready', holdReasons: [], reviewReasons: [] };
      };
    }, { staleProduct, refreshedProduct, fixedNow });

    await page.locator('#tc-auto-url').fill('https://naver.me/stale-link', { timeout: 10000 });
    await page.locator('#tc-auto-start').click({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.tc-auto-keyword-btn').length > 0, { timeout: 10000 });

    await page.locator('.tc-auto-keyword-btn').first().click({ timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('tc-auto-result') && document.getElementById('tc-auto-result').hidden === false, { timeout: 10000 });

    const refreshCalls = await page.evaluate(() => window.fixtureCalls.refreshCalls);
    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0].productId, 'auto-product-3');

    const generateCalls = await page.evaluate(() => window.fixtureCalls.generateCalls);
    assert.equal(generateCalls.length, 1);
    assert.deepEqual(generateCalls[0].variantIds, [refreshedProduct.variants[0].id]);
  });
});

test('autopilot card: missing selections and future price timestamps both force a refresh', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    const fixedNow = Date.parse('2026-10-08T00:00:00.000Z');
    const missingSelectionProduct = freshProduct({ id: 'auto-product-6', variants: [
      { id: 'unselected-variant', currency: 'KRW', amountMinor: 229000, priceCheckedAt: new Date(fixedNow).toISOString(), departureDate: '2026-11-01', options: ['출발'] },
    ] });
    const futurePriceProduct = freshProduct({ id: 'auto-product-7', variants: [
      { id: 'future-variant', currency: 'KRW', amountMinor: 229000, priceCheckedAt: new Date(fixedNow + 60 * 60 * 1000).toISOString(), departureDate: '2026-11-01', options: ['출발'] },
    ] });
    const refreshedProduct = freshProduct({ id: 'auto-product-6', variants: [
      { id: 'replacement-variant', currency: 'KRW', amountMinor: 235000, priceCheckedAt: new Date(fixedNow).toISOString(), departureDate: '2026-11-01', options: ['출발'] },
    ] });
    await page.evaluate(({ missingSelectionProduct, futurePriceProduct, refreshedProduct, fixedNow }) => {
      Date.now = () => fixedNow;
      window.fixtureCalls.autoImportCalls = 0;
      window.fixtureCalls.refreshCalls = [];
      window.fixtureCalls.generateCalls = [];
      window.api.connectAutoImport = async () => {
        window.fixtureCalls.autoImportCalls += 1;
        if (window.fixtureCalls.autoImportCalls === 1) return { ok: true, product: missingSelectionProduct, variantIds: ['missing-selected-variant'], seeds: ['대마도 여행'], warnings: [] };
        return { ok: true, product: futurePriceProduct, variantIds: ['future-variant'], seeds: ['대마도 여행'], warnings: [] };
      };
      window.api.connectPrepareKeywords = async () => ({ ok: true, rows: [{ keyword: '대마도 여행', fit: 'fit' }] });
      window.api.connectRefreshProduct = async ({ productId }) => {
        window.fixtureCalls.refreshCalls.push(productId);
        if (productId === 'auto-product-6') return { ok: true, product: refreshedProduct, variantIds: ['replacement-variant'], warnings: [] };
        return { ok: true, product: futurePriceProduct, variantIds: ['future-variant'], warnings: [] };
      };
      window.api.generateTopic = async (request) => {
        window.fixtureCalls.generateCalls.push(request);
        return { ok: true, draftId: 'auto-draft-edge-' + window.fixtureCalls.generateCalls.length, draft: { id: 'auto-draft-edge' }, status: 'ready', holdReasons: [], reviewReasons: [] };
      };
    }, { missingSelectionProduct, futurePriceProduct, refreshedProduct, fixedNow });

    await page.locator('#tc-auto-url').fill('https://naver.me/missing-selection');
    await page.locator('#tc-auto-start').click();
    await page.waitForFunction(() => document.querySelectorAll('.tc-auto-keyword-btn').length === 1);
    await page.locator('.tc-auto-keyword-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('#tc-auto-result:not([hidden])').length === 1);
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.refreshCalls), ['auto-product-6'], 'an absent selected option is refreshed');
    assert.deepEqual((await page.evaluate(() => window.fixtureCalls.generateCalls[0])).variantIds, ['replacement-variant'], 'generation uses the refreshed selected option');

    await page.locator('#tc-auto-url').fill('https://naver.me/future-price');
    await page.locator('#tc-auto-start').click();
    await page.waitForFunction(() => window.fixtureCalls.autoImportCalls === 2 && document.querySelectorAll('.tc-auto-keyword-btn').length === 1);
    await page.locator('.tc-auto-keyword-btn').click();
    await page.waitForFunction(() => window.fixtureCalls.generateCalls.length === 2);
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.refreshCalls), ['auto-product-6', 'auto-product-7'], 'a future checkedAt timestamp is treated as stale');
    assert.equal(await page.evaluate(() => window.fixtureCalls.generateCalls.length), 2);
  });
});

test('autopilot card: the issued link stays locked during import and duplicate starts do not overlap', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    const product = freshProduct({ id: 'auto-product-4', detailUrl: 'https://pkgtour.naver.com/products/locked-link' });
    await page.evaluate((product) => {
      window.fixtureCalls.autoImportCalls = [];
      window.fixtureCalls.resolveAutoImport = null;
      window.api.connectAutoImport = async (request) => {
        window.fixtureCalls.autoImportCalls.push(request);
        return new Promise((resolve) => { window.fixtureCalls.resolveAutoImport = () => resolve({ ok: true, product, variantIds: [product.variants[0].id], seeds: ['대마도 여행'], warnings: [] }); });
      };
      window.api.connectPrepareKeywords = async () => ({ ok: true, rows: [{ keyword: '대마도 여행', fit: 'fit' }] });
    }, product);

    await page.locator('#tc-auto-url').fill('https://naver.me/locked-link', { timeout: 10000 });
    await page.locator('#tc-auto-start').click({ timeout: 10000 });
    await page.waitForFunction(() => typeof window.fixtureCalls.resolveAutoImport === 'function', { timeout: 10000 });
    assert.equal(await page.locator('#tc-auto-url').isDisabled(), true, 'the URL cannot change while its import is in flight');
    assert.equal(await page.locator('#tc-auto-start').isDisabled(), true);

    await page.evaluate(() => document.getElementById('tc-auto-start').click());
    assert.equal((await page.evaluate(() => window.fixtureCalls.autoImportCalls)).length, 1, 'a duplicate start does not issue another import');

    await page.evaluate(() => window.fixtureCalls.resolveAutoImport());
    await page.waitForFunction(() => document.querySelectorAll('.tc-auto-keyword-btn').length === 1, { timeout: 10000 });
    assert.equal(await page.locator('#tc-auto-url').isDisabled(), false, 'the URL is available again after import and keyword preparation finish');
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.autoImportCalls), [{ url: 'https://naver.me/locked-link' }]);
  });
});

test('autopilot card: a writing failure releases the keyword controls so the user can retry', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    const product = freshProduct({ id: 'auto-product-5', detailUrl: 'https://pkgtour.naver.com/products/generation-retry' });
    await page.evaluate((product) => {
      window.fixtureCalls.generateCalls = 0;
      window.fixtureCalls.autoImportCalls = 0;
      window.fixtureCalls.resolveGeneration = null;
      window.api.connectAutoImport = async () => { window.fixtureCalls.autoImportCalls += 1; return { ok: true, product, variantIds: [product.variants[0].id], seeds: ['대마도 여행'], warnings: [] }; };
      window.api.connectPrepareKeywords = async () => ({ ok: true, rows: [{ keyword: '대마도 여행', fit: 'fit' }] });
      window.api.generateTopic = async () => {
        window.fixtureCalls.generateCalls += 1;
        if (window.fixtureCalls.generateCalls === 1) return new Promise((resolve, reject) => { window.fixtureCalls.resolveGeneration = () => reject(new Error('fixture generation failure')); });
        return { ok: true, draftId: 'auto-draft-retry', draft: { id: 'auto-draft-retry' }, status: 'ready', holdReasons: [], reviewReasons: [] };
      };
    }, product);

    await page.locator('#tc-auto-url').fill('https://naver.me/generation-retry', { timeout: 10000 });
    await page.locator('#tc-auto-start').click({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.tc-auto-keyword-btn').length === 1, { timeout: 10000 });

    await page.locator('.tc-auto-keyword-btn').click({ timeout: 10000 });
    await page.waitForFunction(() => typeof window.fixtureCalls.resolveGeneration === 'function', { timeout: 10000 });
    assert.equal(await page.locator('#tc-auto-start').isDisabled(), true, 'a new import is disabled while generation is active');
    assert.equal(await page.locator('#tc-auto-url').isDisabled(), true, 'the issued link stays locked while generation is active');
    await page.evaluate(() => document.getElementById('tc-auto-start').click());
    assert.equal(await page.evaluate(() => window.fixtureCalls.autoImportCalls), 1, 'a programmatic duplicate start cannot replace the active run');
    await page.evaluate(() => window.fixtureCalls.resolveGeneration());
    await page.waitForFunction(() => document.getElementById('tc-auto-status').textContent.includes('fixture generation failure'), { timeout: 10000 });
    assert.equal(await page.locator('.tc-auto-keyword-btn').isDisabled(), false, 'keyword controls are restored after a thrown generation error');
    assert.equal(await page.locator('#tc-auto-start').isDisabled(), false);
    assert.equal(await page.locator('#tc-auto-url').isDisabled(), false);

    await page.locator('.tc-auto-keyword-btn').click({ timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('tc-auto-result') && document.getElementById('tc-auto-result').hidden === false, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.fixtureCalls.generateCalls), 2);
    assert.match(await page.locator('#tc-auto-result').innerText(), /준비됨/);
  });
});

test('autopilot card: a custom keyword uses the inferred travel topic and reports an empty generation as not created', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    const product = freshProduct();
    await page.evaluate((product) => {
      window.fixtureCalls.generateCalls = [];
      window.api.connectAutoImport = async () => ({ ok: true, product, variantIds: [product.variants[0].id], seeds: ['대마도 여행'], warnings: [] });
      window.api.connectPrepareKeywords = async () => ({ ok: true, rows: [{ keyword: '대마도 여행', fit: 'fit' }] });
      window.api.generateTopic = async (request) => {
        window.fixtureCalls.generateCalls.push(request);
        return { ok: true, post: null, draft: null, draftSaved: false, stage: 'write', status: 'hold', holdReasons: ['원고를 만들지 못했습니다.'] };
      };
    }, product);

    await page.locator('#tc-auto-url').fill('https://naver.me/custom-topic');
    await page.locator('#tc-auto-start').click();
    await page.waitForFunction(() => document.querySelectorAll('.tc-auto-keyword-btn').length > 0);
    assert.equal(await page.locator('#tc-travel-topic').inputValue(), 'worldtravel');

    await page.locator('#tc-auto-keyword-input').fill('부산 대마도 1박2일');
    await page.locator('#tc-auto-custom-generate').click();
    await page.waitForFunction(() => document.getElementById('tc-auto-result') && !document.getElementById('tc-auto-result').hidden);
    assert.equal(await page.evaluate(() => window.fixtureCalls.generateCalls[0].keyword), '부산 대마도 1박2일');
    assert.equal(await page.evaluate(() => window.fixtureCalls.generateCalls[0].travelTopic), 'worldtravel');
    assert.match(await page.locator('#tc-auto-result').innerText(), /작성하지 못/);
    assert.match(await page.locator('#tc-auto-status').innerText(), /원고 작성 실패/);
    assert.doesNotMatch(await page.locator('#tc-auto-status').innerText(), /보관함에 저장했습니다/);
    assert.equal(await page.locator('#tc-auto-view-drafts').count(), 0);
  });
});

test('autopilot card: an older empty draft is shown as an uncreated request with delete only', { timeout: 30000 }, async () => {
  await withAutopilotPage(async (page) => {
    await page.evaluate(() => {
      window.api.topicDraftsList = async () => ({ ok: true, drafts: [{ id: 'empty-old-draft', keyword: '대마도 여행', status: 'hold', holdReasons: ['부산출발 대마도: 예약 가능 여부를 근거로 확인해야 합니다.'], result: { post: null }, text: '' }] });
    });
    await page.locator('#tc-drafts-refresh').click();
    await page.waitForFunction(() => document.querySelector('#tc-drafts .tc-draft'));
    const row = page.locator('#tc-drafts .tc-draft');
    assert.match(await row.innerText(), /작성하지 못한 요청/);
    assert.match(await row.innerText(), /다시 누르면 자동으로 확인/);
    assert.doesNotMatch(await row.innerText(), /예약 가능 여부/);
    assert.deepEqual(await row.locator('[data-tc-act]').evaluateAll((buttons) => buttons.map((button) => button.dataset.tcAct)), ['delete']);
  });
});
