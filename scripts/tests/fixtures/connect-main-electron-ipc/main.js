'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http');
const path = require('node:path');
const repo = process.env.CONNECT_TEST_REPO;
const profile = process.env.CONNECT_TEST_PROFILE;
const { createConnectIpcHandlers, createConnectService } = require(path.join(repo, 'src/connect/service'));
const { isTrustedConnectSender } = require(path.join(repo, 'electron/trustedConnectSender'));
const productUrl = 'https://pkgtour.naver.com/products/verygoodtour/APP7579%7CWE35-20261103';
const imported = {
  product: { id: 'fixture-travel-product', name: 'Electron fixture 여행 상품' },
  sources: [{ id: 'fixture-source', url: productUrl, accessLevel: 'public-page', collectedAt: '2026-10-08T00:00:00.000Z', excerpt: 'fixture source excerpt' }],
  fieldEvidence: [{ field: 'name', sourceId: 'fixture-source', excerpt: 'Electron fixture 여행 상품' }],
  missingFields: ['price'], warnings: [], collectedAt: '2026-10-08T00:00:00.000Z',
};

app.setPath('userData', profile);

let mainWindow = null;
let appPort = 0;
const server = http.createServer((request, response) => {
  if (request.url === '/app/app.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end('<!doctype html><meta charset="utf-8"><iframe src="/app/app.html?frame=child"></iframe>');
  }
  if (request.url === '/app/app.html?frame=child') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end('<!doctype html><meta charset="utf-8">child frame');
  }
  response.writeHead(404);
  response.end('not found');
});

const service = createConnectService({
  catalogFile: path.join(profile, 'connect', 'catalog.json'),
  productImporter: async ({ url }) => url === productUrl
    ? { ok: true, imported }
    : { ok: false, error: 'unexpected fixture URL' },
});

app.whenReady().then(() => {
  server.listen(0, '127.0.0.1', () => {
    appPort = server.address().port;
    createConnectIpcHandlers({
      ipcMain,
      isTrustedSender: (event) => isTrustedConnectSender(event, { mainWindow, appPort }),
      service,
    });
    mainWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(repo, 'electron/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const mainFrame = mainWindow.webContents.mainFrame;
        let subframe = null;
        for (let attempt = 0; attempt < 40 && !subframe; attempt += 1) {
          subframe = mainFrame.frames.find((frame) => frame.url.endsWith('/app/app.html?frame=child')) || null;
          if (!subframe) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!subframe) throw new Error('Electron did not create the localhost iframe.');
        const subframeDenied = !isTrustedConnectSender({ sender: mainWindow.webContents, senderFrame: subframe }, { mainWindow, appPort });
        const result = await mainWindow.webContents.executeJavaScript(
          `window.api.connectImportProduct({ url: ${JSON.stringify(productUrl)} })`,
        );
        process.stdout.write('CONNECT_IPC_RESULT ' + JSON.stringify({
          result,
          subframeDenied,
          mainFrameHasIsMainFrame: 'isMainFrame' in mainFrame,
        }) + '\n');
        if (!result || !result.ok || !result.imported) process.exitCode = 1;
      } catch (error) {
        process.stderr.write((error && error.stack || String(error)) + '\n');
        process.exitCode = 1;
      } finally {
        try { mainWindow.destroy(); } catch (_) {}
        server.close(() => app.quit());
      }
    });
    mainWindow.loadURL(`http://127.0.0.1:${appPort}/app/app.html`);
  });
});

app.on('window-all-closed', () => app.quit());
