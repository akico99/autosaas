'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { after, before, test } = require('node:test');
const { _electron } = require('playwright');
const { grabTitleSnippetPairs } = require('../src/scrape/markup');

const fixtureRoot = path.join(__dirname, 'fixtures', 'rendered-collector');
const pagesRoot = path.join(fixtureRoot, 'pages');
const collectorModule = path.resolve(__dirname, '..', 'electron', 'renderedCollector.js');
let electronApp;
let isolatedUserData;
let localServer;
let localOrigin;
const STARTUP_TIMEOUT_MS = 20000;
const SHUTDOWN_TIMEOUT_MS = 5000;

function diagnostic(message) {
  const debug = String(process.env.DEBUG || '');
  if (process.env.RENDERED_COLLECTOR_DEBUG === '1' || debug.split(',').some((item) => item.trim() === 'pw:browser')) {
    console.error(`[rendered-collector fixture] ${message}`);
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function stopOwnedElectronProcess(electronProcess) {
  if (!electronProcess || !electronProcess.pid
      || electronProcess.exitCode !== null || electronProcess.signalCode !== null) return;
  diagnostic(`Electron shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; stopping only Playwright-owned PID ${electronProcess.pid} and its child tree`);
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(electronProcess.pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    if (result.error) diagnostic(`taskkill failed: ${result.error.message}`);
    else if (result.status !== 0) diagnostic(`taskkill exited ${result.status}: ${(result.stderr || '').trim()}`);
  } else {
    electronProcess.kill('SIGKILL');
  }
  try {
    await withTimeout(once(electronProcess, 'exit'), 3000, 'Electron process exit');
  } catch (error) {
    diagnostic(error.message);
  }
}

function localPage(name) {
  return pathToFileURL(path.join(pagesRoot, name)).href;
}

async function collect(request) {
  return electronApp.evaluate(async (_electron, input) => {
    const fixture = globalThis.__renderedCollectorFixture;
    if (!fixture || typeof fixture.collect !== 'function') {
      throw new Error('Rendered collector fixture did not register its main-process entry point');
    }
    return fixture.collect(input);
  }, request);
}

before(async () => {
  let phase = 'creating isolated profile';
  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'rendered-collector-profile-'));
  diagnostic(`isolated profile created; fixture root is ${fixtureRoot}`);
  phase = 'starting local HTTP fixture server';
  localServer = http.createServer((request, response) => {
    if (request.url === '/status/429') {
      response.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Too many requests at the local fixture.');
      return;
    }
    if (request.url === '/status/500') {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Internal server error at the local fixture.');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Unknown local fixture route.');
  });
  await new Promise((resolve, reject) => {
    localServer.once('error', reject);
    localServer.listen(0, '127.0.0.1', resolve);
  });
  const address = localServer.address();
  localOrigin = `http://127.0.0.1:${address.port}`;
  diagnostic(`local HTTP fixture listening at ${localOrigin}`);
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  delete electronEnv.NODE_OPTIONS;
  Object.assign(electronEnv, {
    RENDERED_FIXTURE_USER_DATA: isolatedUserData,
    RENDERED_COLLECTOR_MODULE: collectorModule,
    RENDERED_FIXTURE_HTTP_ORIGIN: localOrigin,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  });
  phase = 'launching the installed Electron package through Playwright';
  diagnostic(`${phase}; timeout=${STARTUP_TIMEOUT_MS}ms; Playwright loader enabled`);
  try {
    // Let Playwright resolve this project's installed Electron package. Supplying
    // executablePath bypasses its loader that synchronizes Electron app readiness.
    electronApp = await _electron.launch({
      args: [fixtureRoot],
      cwd: fixtureRoot,
      env: electronEnv,
      timeout: STARTUP_TIMEOUT_MS,
    });
  } catch (error) {
    diagnostic(`${phase} failed:\n${error.stack || error}`);
    throw error;
  }
  const electronProcess = electronApp.process();
  diagnostic(`Electron application initialized; owned PID=${electronProcess && electronProcess.pid}`);
  electronApp.on('console', (message) => diagnostic(`Electron console ${message.type()}: ${message.text()}`));
  phase = 'checking Electron fixture bootstrap';
  try {
    const appState = await withTimeout(electronApp.evaluate(({ app, BrowserWindow }) => ({
      ready: app.isReady(),
      appPath: app.getAppPath(),
      fixtureReady: Boolean(globalThis.__renderedCollectorFixture),
      windows: BrowserWindow.getAllWindows().length,
    })), 5000, 'Electron fixture bootstrap check');
    diagnostic(`Electron fixture bootstrap state=${JSON.stringify(appState)}`);
    assert.equal(appState.ready, true, 'Electron did not finish app startup');
    assert.equal(appState.fixtureReady, true, 'Fixture main process did not register collector entry point');
    assert.equal(path.resolve(appState.appPath), path.resolve(fixtureRoot), 'Electron loaded an unexpected app path');
  } catch (error) {
    diagnostic(`${phase} failed: ${error.stack || error}`);
    throw error;
  }
  diagnostic('Electron fixture main-process entry point is ready');
}, { timeout: 28000 });

after(async () => {
  if (electronApp) {
    const electronProcess = electronApp.process();
    try {
      await withTimeout(electronApp.close(), SHUTDOWN_TIMEOUT_MS, 'Electron application close');
      diagnostic('Electron application closed cleanly');
    } catch (error) {
      diagnostic(error.message);
      await stopOwnedElectronProcess(electronProcess);
    }
    electronApp = undefined;
  }
  if (localServer) {
    localServer.closeAllConnections();
    try {
      await withTimeout(new Promise((resolve) => localServer.close(resolve)), 2000, 'Local fixture server close');
    } catch (error) {
      diagnostic(error.message);
    }
  }
  const ownedProfile = isolatedUserData
    && path.resolve(path.dirname(isolatedUserData)).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase()
    && path.basename(isolatedUserData).startsWith('rendered-collector-profile-');
  if (ownedProfile) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.rmSync(isolatedUserData, { recursive: true, force: true });
        diagnostic('isolated Electron profile removed');
        isolatedUserData = undefined;
        break;
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 3) {
          diagnostic(`isolated profile cleanup failed (${error.code || 'error'}): ${error.message}`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
}, { timeout: 15000 });

test('waits for delayed local article cards and returns the complete JSON array', async () => {
  const response = await collect({
    url: localPage('delayed-cards.html'),
    extractJs: "JSON.stringify(Array.from(document.querySelectorAll('#cards article'), (card) => card.innerText.trim()))",
    waitMs: 2500,
    options: {
      timeoutMs: 2500,
      pollIntervalMs: 40,
      readyScript: "document.querySelectorAll('#cards article').length === 2",
    },
  });

  assert.equal(response.ok, true, response.error && response.error.message);
  assert.deepEqual(JSON.parse(response.result), ['Local article one', 'Local article two']);
  assert.equal(response.windowsAfter, 0);
  assert.equal(path.resolve(response.userDataPath), path.resolve(isolatedUserData));
});

test('keeps a delayed SDS snippet linked to its own card when an earlier card has no snippet', async () => {
  const response = await collect({
    url: localPage('delayed-sds-cards.html'),
    extractJs: "JSON.stringify(Array.from(document.querySelectorAll('.result-card'), (card) => card.outerHTML))",
    waitMs: 2500,
    options: {
      timeoutMs: 2500,
      pollIntervalMs: 40,
      readyScript: "document.querySelectorAll('.result-card').length === 2",
    },
  });

  assert.equal(response.ok, true, response.error && response.error.message);
  const renderedCards = JSON.parse(response.result);
  assert.equal(renderedCards.length, 2);
  const pairs = grabTitleSnippetPairs(renderedCards.join(''), {
    sourceType: 'news-snippet',
    collectedAt: '2026-10-05T00:00:00.000Z',
  });

  assert.deepEqual(pairs, ['Second SDS article — Summary belonging only to the second article.']);
  assert.equal(pairs.sources.length, 1);
  assert.equal(pairs.sources[0].url, 'https://news.example.com/article/second');
});

test('times out on a local page that never produces results', async () => {
  const response = await collect({
    url: localPage('empty.html'),
    extractJs: "JSON.stringify(Array.from(document.querySelectorAll('#cards article'), (card) => card.innerText))",
    waitMs: 250,
    options: { timeoutMs: 250, pollIntervalMs: 25 },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'RENDERED_READINESS_TIMEOUT');
  assert.equal(response.windowsAfter, 0);
});

test('detects local restriction text before extraction and preserves status 403', async () => {
  const response = await collect({
    url: localPage('restricted.html'),
    extractJs: "throw new Error('restriction page extraction must not run')",
    waitMs: 500,
    options: { timeoutMs: 500, pollIntervalMs: 25 },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'NAVER_SEARCH_BLOCKED');
  assert.equal(response.error.status, 403);
  assert.equal(response.error.kind, 'blocked');
  assert.equal(response.windowsAfter, 0);
});

test('returns valid plain text from a local article page', async () => {
  const response = await collect({
    url: localPage('valid.html'),
    extractJs: "document.querySelector('article').innerText.trim()",
    waitMs: 1000,
    options: { timeoutMs: 1000, pollIntervalMs: 25 },
  });

  assert.equal(response.ok, true, response.error && response.error.message);
  assert.equal(response.result, 'Local fixture article\n\nRendered extraction is available.');
  assert.equal(response.windowsAfter, 0);
});

test('rejects local navigation failures and still closes the collector window', async () => {
  const missingPath = path.join(pagesRoot, 'missing-local-fixture.html');
  const response = await collect({
    url: pathToFileURL(missingPath).href,
    extractJs: "document.body.innerText",
    waitMs: 1000,
    options: { timeoutMs: 1000 },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'RENDERED_NAVIGATION_FAILED');
  assert.equal(response.windowsAfter, 0);
});

test('preserves a local main-frame HTTP 429 response without relying on page text', async () => {
  const response = await collect({
    url: `${localOrigin}/status/429`,
    extractJs: 'document.body.innerText',
    waitMs: 1000,
    options: { timeoutMs: 1000 },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.status, 429);
  assert.equal(response.error.kind, 'blocked');
  assert.equal(response.error.code, 'NAVER_SEARCH_BLOCKED');
  assert.equal(response.windowsAfter, 0);
});

test('preserves a local main-frame HTTP 500 response as a load error', async () => {
  const response = await collect({
    url: `${localOrigin}/status/500`,
    extractJs: 'document.body.innerText',
    waitMs: 1000,
    options: { timeoutMs: 1000 },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.status, 500);
  assert.equal(response.error.kind, 'load_error');
  assert.equal(response.error.code, 'RENDERED_HTTP_ERROR');
  assert.equal(response.windowsAfter, 0);
});
