'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedConnectSender } = require('../../electron/trustedConnectSender');

function setup(url = 'http://127.0.0.1:47318/app/app.html') {
  const mainFrame = { url, parent: null };
  mainFrame.top = mainFrame;
  const sender = { mainFrame };
  const mainWindow = { webContents: sender, isDestroyed: () => false };
  return { mainFrame, sender, mainWindow, event: { sender, senderFrame: mainFrame } };
}

test('trusts the actual Electron mainFrame shape without an isMainFrame property', () => {
  const context = setup();
  assert.equal('isMainFrame' in context.mainFrame, false);
  assert.equal(isTrustedConnectSender(context.event, { mainWindow: context.mainWindow, appPort: 47318 }), true);
});

test('rejects same-URL subframes and frame impostors even if they claim isMainFrame', () => {
  const context = setup();
  const subframe = { url: context.mainFrame.url, parent: context.mainFrame, top: context.mainFrame, isMainFrame: true };
  assert.equal(isTrustedConnectSender({ sender: context.sender, senderFrame: subframe }, { mainWindow: context.mainWindow, appPort: 47318 }), false);
  const impostor = { url: context.mainFrame.url, parent: null, top: null };
  assert.equal(isTrustedConnectSender({ sender: context.sender, senderFrame: impostor }, { mainWindow: context.mainWindow, appPort: 47318 }), false);
});

test('requires the exact renderer, local HTTP origin, port, and app path', () => {
  const context = setup();
  assert.equal(isTrustedConnectSender({ ...context.event, sender: { mainFrame: context.mainFrame } }, { mainWindow: context.mainWindow, appPort: 47318 }), false);
  for (const url of [
    'https://127.0.0.1:47318/app/app.html',
    'http://localhost:47318/app/app.html',
    'http://127.0.0.1:47319/app/app.html',
    'http://127.0.0.1:47318/app/login.html',
    'not a URL',
  ]) {
    context.mainFrame.url = url;
    assert.equal(isTrustedConnectSender(context.event, { mainWindow: context.mainWindow, appPort: 47318 }), false, url);
  }
});

test('rejects missing frames and destroyed windows', () => {
  const context = setup();
  assert.equal(isTrustedConnectSender({ sender: context.sender }, { mainWindow: context.mainWindow, appPort: 47318 }), false);
  assert.equal(isTrustedConnectSender(context.event, { mainWindow: { ...context.mainWindow, isDestroyed: () => true }, appPort: 47318 }), false);
});
