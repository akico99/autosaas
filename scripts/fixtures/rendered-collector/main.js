'use strict';

const path = require('node:path');
const { app, BrowserWindow } = require('electron');
console.log('[rendered-collector fixture] main process module loaded');

const userDataPath = process.env.RENDERED_FIXTURE_USER_DATA;
if (!userDataPath || !path.isAbsolute(userDataPath)) {
  throw new Error('The rendered collector fixture requires an isolated absolute userData path');
}
app.setPath('userData', userDataPath);

const collectorModule = process.env.RENDERED_COLLECTOR_MODULE;
if (!collectorModule || !path.isAbsolute(collectorModule)) {
  throw new Error('The rendered collector fixture requires the local collector module path');
}
const { createRenderedCollector } = require(collectorModule);
const scrapeRendered = createRenderedCollector({ BrowserWindow });

async function collectFixture(request) {
  await app.whenReady();
  let target;
  try {
    target = new URL(request.url);
  } catch (error) {
    return { ok: false, error: { message: 'Fixture accepts local file URLs only', code: 'FIXTURE_URL_REJECTED' } };
  }
  const isFixtureServer = target.protocol === 'http:'
    && target.origin === process.env.RENDERED_FIXTURE_HTTP_ORIGIN;
  if (target.protocol !== 'file:' && !isFixtureServer) {
    return { ok: false, error: { message: 'Fixture accepts local file URLs only', code: 'FIXTURE_URL_REJECTED' } };
  }

  try {
    const result = await scrapeRendered(
      request.url,
      request.extractJs,
      request.waitMs,
      request.partition || `rendered-fixture-${process.pid}`,
      request.ua,
      request.options || {},
    );
    return {
      ok: true,
      result,
      windowsAfter: BrowserWindow.getAllWindows().length,
      userDataPath: app.getPath('userData'),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: error.message,
        code: error.code,
        status: error.status,
        kind: error.kind,
      },
      windowsAfter: BrowserWindow.getAllWindows().length,
      userDataPath: app.getPath('userData'),
    };
  }
}

globalThis.__renderedCollectorFixture = Object.freeze({ collect: collectFixture });
app.whenReady().then(() => {
  console.log('[rendered-collector fixture] Electron app is ready for local collector calls');
}).catch((error) => {
  console.error(`[rendered-collector fixture] app startup failed: ${error.stack || error}`);
});

app.on('window-all-closed', () => {});
