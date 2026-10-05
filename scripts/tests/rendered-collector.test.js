'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRenderedCollector } = require('../../electron/renderedCollector');

function makeBrowserWindow(state) {
  class FakeBrowserWindow {
    constructor(options) {
      state.options = options;
      state.destroyed = false;
      state.destroyCalls = 0;
      state.extractionCalls = 0;
      state.readyCalls = 0;
      this.webContents = {
        executeJavaScript: async (script) => {
          if (script === state.extractJs) {
            state.extractionCalls += 1;
            if (state.extractionError) throw state.extractionError;
            if (state.extractionResults.length > 1) return state.extractionResults.shift();
            return state.extractionResults[0];
          }
          if (script === state.readyScript) {
            state.readyCalls += 1;
            if (state.readyResults.length > 1) return state.readyResults.shift();
            return state.readyResults[0];
          }
          return state.bodyText || '';
        },
      };
    }

    async loadURL(url, options) {
      state.url = url;
      state.loadOptions = options;
      if (state.loadError) throw state.loadError;
      if (state.loadDelay) await new Promise((resolve) => setTimeout(resolve, state.loadDelay));
    }

    destroy() {
      state.destroyed = true;
      state.destroyCalls += 1;
    }
  }

  return FakeBrowserWindow;
}

test('waits for meaningful legacy JSON extraction output and returns it unchanged', async () => {
  const state = {
    extractJs: 'extract-json',
    extractionResults: ['', '[]', '[{"title":"Local article"}]'],
    readyResults: [],
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  const result = await scrape('file:///fixture.html', state.extractJs, 150, 'fixture', 'test-ua', {
    pollIntervalMs: 1,
  });

  assert.equal(result, '[{"title":"Local article"}]');
  assert.equal(state.extractionCalls, 3);
  assert.equal(state.destroyCalls, 1);
  assert.equal(state.loadOptions.userAgent, 'test-ua');
});

test('uses an explicit ready script and returns meaningful structured output', async () => {
  const state = {
    extractJs: 'extract-json',
    readyScript: 'results-ready',
    extractionResults: ['{"status":200,"items":[{"title":"Ready article"}]}'],
    readyResults: [false, false, true],
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  const result = await scrape('file:///fixture.html', state.extractJs, 150, 'fixture', undefined, {
    readyScript: state.readyScript,
    pollIntervalMs: 1,
  });

  assert.equal(result, '{"status":200,"items":[{"title":"Ready article"}]}');
  assert.equal(state.readyCalls, 3);
  assert.equal(state.extractionCalls, 1);
});

test('rejects an explicit error payload instead of reporting it as collected content', async () => {
  const state = {
    extractJs: 'extract-error',
    extractionResults: ['{"error":"upstream failed"}'],
    readyResults: [],
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  await assert.rejects(
    scrape('file:///error.html', state.extractJs, 100, 'fixture', undefined, {
      timeoutMs: 25,
      pollIntervalMs: 1,
    }),
    (error) => error.code === 'RENDERED_EXTRACTION_FAILED' && error.kind === 'parse_error',
  );
  assert.equal(state.extractionCalls, 1);
});

test('metadata-only JSON does not satisfy inferred readiness', async () => {
  const state = {
    extractJs: 'extract-metadata',
    extractionResults: ['{"status":200,"items":[]}'],
    readyResults: [],
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  await assert.rejects(
    scrape('file:///empty.html', state.extractJs, 25, 'fixture', undefined, {
      timeoutMs: 25,
      pollIntervalMs: 1,
    }),
    (error) => error.code === 'RENDERED_READINESS_TIMEOUT' && error.kind === 'timeout',
  );
  assert.ok(state.extractionCalls >= 2);
});

test('rejects explicit blocked extraction payloads with status 403', async () => {
  const state = {
    extractJs: 'extract-blocked',
    extractionResults: ['{"blocked":true,"status":403,"items":[]}'],
    readyResults: [],
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  await assert.rejects(
    scrape('file:///blocked.json', state.extractJs, 100, 'fixture', undefined, {
      timeoutMs: 100,
      pollIntervalMs: 1,
    }),
    (error) => error.code === 'NAVER_SEARCH_BLOCKED' && error.status === 403 && error.kind === 'blocked',
  );
});

test('does not accept an empty extraction after readyScript unless allowEmpty is explicit', async () => {
  const state = {
    extractJs: 'extract-empty',
    readyScript: 'results-ready',
    extractionResults: ['[]'],
    readyResults: [true],
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  await assert.rejects(
    scrape('file:///empty.html', state.extractJs, 20, 'fixture', undefined, {
      readyScript: state.readyScript,
      timeoutMs: 20,
      pollIntervalMs: 1,
    }),
    (error) => error.code === 'RENDERED_READINESS_TIMEOUT',
  );

  const emptyAllowedState = { ...state, extractionResults: ['[]'], readyResults: [true] };
  const allowEmpty = createRenderedCollector({ BrowserWindow: makeBrowserWindow(emptyAllowedState) });
  const result = await allowEmpty('file:///empty.html', state.extractJs, 100, 'fixture', undefined, {
    readyScript: state.readyScript,
    allowEmpty: true,
    timeoutMs: 100,
    pollIntervalMs: 1,
  });
  assert.equal(result, '[]');
});

test('reports restriction pages before running extraction and retains the guard signal', async () => {
  const state = {
    extractJs: 'must-not-run',
    bodyText: '검색 서비스 이용이 제한되었습니다.',
    extractionResults: ['unexpected'],
    readyResults: [],
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  await assert.rejects(
    scrape('file:///restricted.html', state.extractJs, 50, 'fixture', undefined, { pollIntervalMs: 1 }),
    (error) => error.status === 403 && error.kind === 'blocked' && error.code === 'NAVER_SEARCH_BLOCKED',
  );
  assert.equal(state.extractionCalls, 0);
  assert.equal(state.destroyCalls, 1);
});

test('rejects navigation failures and always destroys the created window', async () => {
  const state = {
    extractJs: 'extract',
    extractionResults: ['ok'],
    readyResults: [],
    loadError: new Error('fixture navigation failed'),
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  await assert.rejects(
    scrape('file:///missing.html', state.extractJs, 50, 'fixture'),
    (error) => /fixture navigation failed/.test(error.message) && error.kind === 'load_error',
  );
  assert.equal(state.destroyCalls, 1);
});

test('keeps navigation time separate from the legacy readiness wait', async () => {
  const state = {
    extractJs: 'extract',
    extractionResults: ['article body'],
    readyResults: [],
    loadDelay: 40,
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  const result = await scrape('file:///slow-local-load.html', state.extractJs, 10, 'fixture');

  assert.equal(result, 'article body');
  assert.equal(state.destroyCalls, 1);
});

test('times out when no readiness signal or meaningful output appears', async () => {
  const state = {
    extractJs: 'extract-empty',
    extractionResults: ['[]'],
    readyResults: [],
  };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  await assert.rejects(
    scrape('file:///empty.html', state.extractJs, 20, 'fixture', undefined, {
      timeoutMs: 20,
      pollIntervalMs: 1,
    }),
    (error) => error.code === 'RENDERED_READINESS_TIMEOUT' && error.kind === 'timeout',
  );
  assert.equal(state.destroyCalls, 1);
});

test('creates isolated windows with context isolation and sandbox enabled', async () => {
  const state = { extractJs: 'extract', extractionResults: ['text'], readyResults: [] };
  const scrape = createRenderedCollector({ BrowserWindow: makeBrowserWindow(state) });

  await scrape('file:///valid.html', state.extractJs, 100, 'fixture-partition');

  assert.equal(state.options.show, false);
  assert.equal(state.options.webPreferences.partition, 'fixture-partition');
  assert.equal(state.options.webPreferences.contextIsolation, true);
  assert.equal(state.options.webPreferences.sandbox, true);
});
