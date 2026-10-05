'use strict';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15000;
const PAGE_STATE_SCRIPT = "JSON.stringify((function(){var body=(document.body&&document.body.innerText)||'';var h=document.querySelector('h1,h2,[role=heading]');return {bodyText:body,title:document.title||'',heading:h&&h.innerText||''};})())";
const READINESS_METADATA_KEYS = new Set([
  'error', 'status', 'code', 'kind', 'message', 'ok', 'success', 'requestId', 'source', 'url', 'retryAfter', 'count',
]);
const RESTRICTION_PATTERN = /검색\s*서비스\s*이용이\s*제한(?:되었습니다|되어|됩니다)/i;

class RenderedCollectorError extends Error {
  constructor(message, { code, status, kind, cause } = {}) {
    super(message);
    this.name = 'RenderedCollectorError';
    if (code) this.code = code;
    if (status !== undefined) this.status = status;
    if (kind) this.kind = kind;
    if (cause) this.cause = cause;
  }
}

function asCollectorError(message, code, kind, cause, status) {
  const detail = cause && cause.message ? `: ${cause.message}` : '';
  return new RenderedCollectorError(`${message}${detail}`, { code, kind, cause, status });
}

function hasMeaningfulOutput(value, seen = new Set()) {
  if (value === null || value === undefined || typeof value === 'boolean') return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return false;
    try {
      return hasMeaningfulOutput(JSON.parse(trimmed), seen);
    } catch (error) {
      return true;
    }
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulOutput(item, seen));
  return Object.entries(value)
    .some(([key, item]) => !READINESS_METADATA_KEYS.has(key) && hasMeaningfulOutput(item, seen));
}

function findExplicitError(value, seen = new Set()) {
  if (typeof value === 'string') {
    try { return findExplicitError(JSON.parse(value), seen); } catch (error) { return null; }
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findExplicitError(item, seen);
      if (found) return found;
    }
    return null;
  }
  const status = Number(value.status);
  if (value.blocked === true || value.kind === 'blocked' || status === 403 || status === 429) {
    return { blocked: true, status: status === 429 ? 429 : 403, message: value.message || value.error };
  }
  if (value.error !== undefined && value.error !== null && value.error !== '' && value.error !== false) {
    return { message: typeof value.error === 'string' ? value.error : 'Extraction returned an error payload' };
  }
  if (value.ok === false || value.success === false) {
    return { message: value.message || 'Extraction returned an unsuccessful result' };
  }
  for (const item of Object.values(value)) {
    const found = findExplicitError(item, seen);
    if (found) return found;
  }
  return null;
}

function isRestrictedPage(pageState) {
  let info = pageState;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch (error) { info = { bodyText: info }; }
  }
  const bodyText = typeof info === 'object' && info ? String(info.bodyText || '') : String(info || '');
  const title = typeof info === 'object' && info ? String(info.title || '') : '';
  const heading = typeof info === 'object' && info ? String(info.heading || '') : '';
  if (!RESTRICTION_PATTERN.test(`${title}\n${heading}\n${bodyText}`)) return false;
  return bodyText.trim().length <= 1200 || RESTRICTION_PATTERN.test(`${title}\n${heading}`);
}

function blockedError(status, message = 'Rendered page reports restricted search access') {
  return new RenderedCollectorError(message, {
    code: 'NAVER_SEARCH_BLOCKED',
    status,
    kind: 'blocked',
  });
}

function httpStatusError(status, statusText = '') {
  if (status === 403 || status === 429) {
    return blockedError(status, `Rendered navigation returned HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
  }
  return new RenderedCollectorError(
    `Rendered navigation returned HTTP ${status}${statusText ? ` ${statusText}` : ''}`,
    { code: 'RENDERED_HTTP_ERROR', status, kind: 'load_error' },
  );
}

function extractionError(result) {
  const error = findExplicitError(result);
  if (!error) return null;
  if (error.blocked) return blockedError(error.status || 403, String(error.message || 'Rendered extraction reports restricted search access'));
  return new RenderedCollectorError(`Rendered extraction returned an error payload${error.message ? `: ${error.message}` : ''}`, {
    code: 'RENDERED_EXTRACTION_FAILED',
    kind: 'parse_error',
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(operation, timeoutMs, makeError) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(makeError()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function finiteTimeout(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function createRenderedCollector({ BrowserWindow } = {}) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('createRenderedCollector requires an Electron BrowserWindow constructor');
  }

  return async function scrapeRendered(
    url,
    extractJs,
    waitMs = 3500,
    partition = 'persist:naver',
    ua,
    options = {},
  ) {
    const config = options && typeof options === 'object' ? options : {};
    const timeoutMs = finiteTimeout(config.timeoutMs, finiteTimeout(waitMs, 3500));
    const navigationTimeoutMs = finiteTimeout(config.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS);
    const pollIntervalMs = Math.max(1, finiteTimeout(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS));
    const readyScript = config.readyScript;
    if (readyScript !== undefined && typeof readyScript !== 'string') {
      throw new TypeError('readyScript must be a JavaScript expression string');
    }

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        offscreen: false,
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    let navigationStatus = 0;
    let navigationStatusText = '';
    let navigationFailure = null;
    const onNavigate = (_event, _navigationUrl, status, statusText) => {
      if (Number.isFinite(status) && status > 0) {
        navigationStatus = status;
        navigationStatusText = statusText || '';
      }
    };
    const onFailLoad = (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame) navigationFailure = { errorCode, errorDescription, validatedUrl };
    };
    if (typeof win.webContents.on === 'function') {
      win.webContents.on('did-navigate', onNavigate);
      win.webContents.on('did-fail-load', onFailLoad);
    }

    try {
      try {
        await withTimeout(
          () => win.loadURL(url, { userAgent: ua || DEFAULT_USER_AGENT }),
          navigationTimeoutMs,
          () => new RenderedCollectorError(`Rendered navigation timed out for ${url}`, {
            code: 'RENDERED_NAVIGATION_TIMEOUT',
            kind: 'timeout',
          }),
        );
      } catch (error) {
        if (error instanceof RenderedCollectorError) throw error;
        if (navigationStatus === 403 || navigationStatus === 429) {
          throw httpStatusError(navigationStatus, navigationStatusText);
        }
        if (navigationStatus >= 400) throw httpStatusError(navigationStatus, navigationStatusText);
        const failureText = navigationFailure && navigationFailure.errorDescription;
        const cause = failureText ? new Error(failureText, { cause: error }) : error;
        throw asCollectorError(`Rendered navigation failed for ${url}`, 'RENDERED_NAVIGATION_FAILED', 'load_error', cause);
      }
      if (navigationStatus >= 400) throw httpStatusError(navigationStatus, navigationStatusText);

      const deadline = Date.now() + timeoutMs;
      let firstCheck = true;
      while (firstCheck || Date.now() <= deadline) {
        firstCheck = false;
        const remainingMs = Math.max(0, deadline - Date.now());
        const bodyText = await withTimeout(
          () => win.webContents.executeJavaScript(PAGE_STATE_SCRIPT),
          remainingMs,
          () => new RenderedCollectorError(`Rendered readiness timed out for ${url}`, {
            code: 'RENDERED_READINESS_TIMEOUT',
            kind: 'timeout',
          }),
        );
        if (isRestrictedPage(bodyText)) {
          throw blockedError(403);
        }

        if (readyScript !== undefined) {
          let ready;
          try {
            ready = await withTimeout(
              () => win.webContents.executeJavaScript(readyScript),
              Math.max(0, deadline - Date.now()),
              () => new RenderedCollectorError(`Rendered readiness timed out for ${url}`, {
                code: 'RENDERED_READINESS_TIMEOUT',
                kind: 'timeout',
              }),
            );
          } catch (error) {
            if (error instanceof RenderedCollectorError) throw error;
            throw asCollectorError('Rendered readiness check failed', 'RENDERED_READINESS_FAILED', 'parse_error', error);
          }

          if (ready) {
            let result;
            try {
              result = await withTimeout(
                () => win.webContents.executeJavaScript(extractJs),
                Math.max(0, deadline - Date.now()),
                () => new RenderedCollectorError(`Rendered extraction timed out for ${url}`, {
                  code: 'RENDERED_EXTRACTION_TIMEOUT',
                  kind: 'timeout',
                }),
              );
            } catch (error) {
              if (error instanceof RenderedCollectorError) throw error;
              throw asCollectorError('Rendered extraction failed', 'RENDERED_EXTRACTION_FAILED', 'parse_error', error);
            }
            const explicitError = extractionError(result);
            if (explicitError) throw explicitError;
            if (hasMeaningfulOutput(result) || config.allowEmpty === true) return result;
          }
        } else {
          let result;
          try {
            result = await withTimeout(
              () => win.webContents.executeJavaScript(extractJs),
              Math.max(0, deadline - Date.now()),
              () => new RenderedCollectorError(`Rendered readiness timed out for ${url}`, {
                code: 'RENDERED_READINESS_TIMEOUT',
                kind: 'timeout',
              }),
            );
          } catch (error) {
            if (error instanceof RenderedCollectorError) throw error;
            throw asCollectorError('Rendered extraction failed', 'RENDERED_EXTRACTION_FAILED', 'parse_error', error);
          }
          const explicitError = extractionError(result);
          if (explicitError) throw explicitError;
          if (hasMeaningfulOutput(result)) return result;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(pollIntervalMs, remaining));
      }

      throw new RenderedCollectorError(`Rendered readiness timed out for ${url}`, {
        code: 'RENDERED_READINESS_TIMEOUT',
        kind: 'timeout',
      });
    } finally {
      try {
        if (typeof win.webContents.removeListener === 'function') {
          win.webContents.removeListener('did-navigate', onNavigate);
          win.webContents.removeListener('did-fail-load', onFailLoad);
        }
      } catch (error) { /* the webContents may already be gone */ }
      try { win.destroy(); } catch (error) { /* the window may already be gone */ }
    }
  };
}

module.exports = { createRenderedCollector, RenderedCollectorError };
