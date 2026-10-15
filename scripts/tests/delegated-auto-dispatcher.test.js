'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDelegatedAutoDispatcher } = require('../../electron/delegatedAutoDispatcher');

class FakeWebContents extends EventEmitter {
  constructor(url, loading = false) { super(); this.url = url; this.loading = loading; this.sent = []; }
  getURL() { return this.url; }
  isLoadingMainFrame() { return this.loading; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  finishLoad(url = this.url) { this.url = url; this.loading = false; this.emit('did-finish-load'); }
}
class FakeWindow extends EventEmitter {
  constructor(url, options = {}) { super(); this.webContents = new FakeWebContents(url, !!options.loading); this.loads = []; this.destroyed = false; }
  isDestroyed() { return this.destroyed; }
  loadURL(url) { this.loads.push(url); if (this.failLoad) return Promise.reject(new Error('fixture load failure')); this.webContents.url = url; this.webContents.loading = true; setImmediate(() => this.webContents.finishLoad(url)); return Promise.resolve(); }
}
function flush() { return new Promise((resolve) => setImmediate(resolve)); }
const appUrl = 'http://127.0.0.1:19356/app/app.html';

 test('a scheduled request on the login page loads app.html and dispatches once without auto=1', async () => {
  const win = new FakeWindow('http://127.0.0.1:19356/app/login.html');
  const dispatched = [];
  const states = [];
  const dispatcher = createDelegatedAutoDispatcher({ getWindow: () => win, getAppUrl: () => appUrl, onStateChange: (state) => states.push(state), onDispatch: (kind) => dispatched.push(kind) });
  assert.equal(dispatcher.request('connect'), true);
  assert.equal(dispatcher.request('connect'), false, 'a duplicate scheduled launch is coalesced while pending');
  await flush(); await flush();
  assert.deepEqual(win.loads, [appUrl]);
  assert.equal(win.loads.some((url) => /[?&]auto=1/.test(url)), false, 'the navigation itself cannot launch a duplicate auto run');
  assert.deepEqual(win.webContents.sent, [{ channel: 'run-auto', payload: { kind: 'connect' } }]);
  assert.deepEqual(dispatched, ['connect']);
  assert.equal(dispatcher.getState().active, true);
  dispatcher.complete();
  assert.equal(dispatcher.getState().active, false);
});

test('a scheduled request on the active app renderer dispatches once without navigation', () => {
  const win = new FakeWindow(appUrl);
  const dispatcher = createDelegatedAutoDispatcher({ getWindow: () => win, getAppUrl: () => appUrl });
  assert.equal(dispatcher.request('search'), true);
  assert.equal(dispatcher.request('search'), false);
  assert.equal(win.loads.length, 0, 'the active editor is preserved');
  assert.deepEqual(win.webContents.sent, [{ channel: 'run-auto', payload: { kind: 'search' } }]);
  dispatcher.complete();
});

test('a scheduled request waits for an active app renderer to finish loading', () => {
  const win = new FakeWindow(appUrl, { loading: true });
  const dispatcher = createDelegatedAutoDispatcher({ getWindow: () => win, getAppUrl: () => appUrl });
  dispatcher.request('connect');
  assert.equal(win.webContents.sent.length, 0);
  win.webContents.finishLoad();
  assert.deepEqual(win.webContents.sent, [{ channel: 'run-auto', payload: { kind: 'connect' } }]);
  dispatcher.complete();
});

test('an app.html?auto=1 renderer is already running and receives no delegated duplicate', () => {
  const win = new FakeWindow(appUrl + '?auto=1&kind=connect');
  const dispatcher = createDelegatedAutoDispatcher({ getWindow: () => win, getAppUrl: () => appUrl });
  dispatcher.request('connect');
  assert.equal(win.loads.length, 0);
  assert.equal(win.webContents.sent.length, 0, 'the existing auto=1 launch is not started a second time');
  assert.equal(dispatcher.getState().active, false, 'the redundant delegated state is cleared');
});

test('a failed login-page navigation clears delegated state', async () => {
  const win = new FakeWindow('http://127.0.0.1:19356/app/login.html');
  win.failLoad = true;
  const dispatcher = createDelegatedAutoDispatcher({ getWindow: () => win, getAppUrl: () => appUrl });
  dispatcher.request('connect');
  await flush();
  assert.equal(dispatcher.getState().active, false);
  assert.equal(win.webContents.sent.length, 0);
});
