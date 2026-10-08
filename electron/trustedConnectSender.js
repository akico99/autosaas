'use strict';

function isTrustedConnectSender(event, { mainWindow, appPort } = {}) {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || !event || event.sender !== mainWindow.webContents) return false;
    const sender = event.sender;
    const senderFrame = event.senderFrame;
    if (!senderFrame || senderFrame !== sender.mainFrame) return false;
    const url = new URL(senderFrame.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && Number(url.port) === Number(appPort) && url.pathname === '/app/app.html';
  } catch (_) { return false; }
}

module.exports = { isTrustedConnectSender };
