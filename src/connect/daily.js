'use strict';

// MODEL_ROLES are part of the UI contract. Code owns deterministic pipeline work;
// models only perform page understanding, ranking, planning, and prose generation.
const MODEL_ROLES = Object.freeze({
  code: 'Scheduling, link resolution, page collection, image download, formatting, editor save, queue, Telegram send, and report text.',
  haiku: 'Thinking off: extract page facts and three keywords; rank public best-list candidates for discovery.',
  opus: 'Thinking on: choose the strongest keyword among three candidates and plan the title, hook, and sections.',
  sonnet: 'Thinking off: write the post body from the approved plan and page facts.',
});

function pickDailyItems(queue, targets = { travel: 2, shopping: 2 }) {
  const pending = (Array.isArray(queue) ? queue : []).filter((item) => item.status === 'queued').slice().sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')));
  const picked = []; const counts = { travel: 0, shopping: 0 }; const total = (targets.travel || 0) + (targets.shopping || 0);
  for (const item of pending) {
    if (picked.length >= total) break;
    if (item.kind === 'travel' || item.kind === 'shopping') {
      if (counts[item.kind] < (targets[item.kind] || 0)) { picked.push(item); counts[item.kind] += 1; }
    } else picked.push(item);
  }
  return picked;
}

function queueCounts(queue) {
  const counts = { travel: 0, shopping: 0, unknown: 0 };
  for (const item of Array.isArray(queue) ? queue : []) if (item.status === 'queued') {
    if (item.kind === 'travel' || item.kind === 'shopping') counts[item.kind] += 1; else counts.unknown += 1;
  }
  return counts;
}

function addQueueUrls(items, urls, { id = () => require('node:crypto').randomUUID(), now = () => new Date().toISOString(), maxPending = 50 } = {}) {
  const result = (Array.isArray(items) ? items : []).slice();
  const existing = new Set(result.filter((item) => item.status !== 'done').map((item) => item.url)); let added = 0;
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = String(raw || '').trim(); if (!url || existing.has(url)) continue;
    let parsed; try { parsed = new URL(url); } catch (_) { continue; }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) continue;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^127\.|^10\.|^192\.168\.|^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) continue;
    if (result.filter((item) => item.status === 'queued').length >= maxPending) break;
    result.push({ id: id(), url, addedAt: now(), kind: null, status: 'queued' }); existing.add(url); added += 1;
  }
  return { items: result, added };
}

function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function buildReport({ results = [], discovery = {}, queueLeft = [] } = {}, now = new Date()) {
  results = Array.isArray(results) ? results : [];
  discovery = discovery && typeof discovery === 'object' ? discovery : {};
  queueLeft = queueLeft && typeof queueLeft === 'object' ? queueLeft : [];
  const date = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const lines = [`📝 오늘의 커넥트 원고 (${date})`];
  for (const result of results) {
    // The renderer's dailyReport contract uses { ok: true, draftTitle }.
    const ok = result.ok === true || result.status === 'done' || result.status === 'success' || result.status === 'ok';
    const kind = result.kind === 'travel' ? '여행' : result.kind === 'shopping' ? '쇼핑' : '미분류';
    lines.push(`${ok ? '✅' : '❌'} ${kind} · ${escapeHtml(result.draftTitle || result.title || result.error || '원고 처리 실패')}${result.keyword ? ` · ${escapeHtml(result.keyword)}` : ''}`);
  }
  const counts = Array.isArray(queueLeft) ? queueCounts(queueLeft) : { travel: queueLeft.travel || 0, shopping: queueLeft.shopping || 0, unknown: queueLeft.unknown || 0 };
  const total = counts.travel + counts.shopping + counts.unknown;
  lines.push(`남은 대기 링크 ${total}개 (여행 ${counts.travel} / 쇼핑 ${counts.shopping} / 미분류 ${counts.unknown})`);
  lines.push('🔎 내일 발급하면 좋은 상품');
  for (const [kind, label] of [['travel', '여행'], ['shopping', '쇼핑']]) for (const item of (discovery[kind] || []).slice(0, 3)) {
    lines.push(`• ${label}: ${escapeHtml(item.name || '')}${item.price ? ` · ${escapeHtml(item.price)}` : ''}${item.why ? ` · ${escapeHtml(item.why)}` : ''}${item.keyword ? ` · 추천 키워드 ${escapeHtml(item.keyword)}` : ''}`);
  }
  const target = 4; if (results.length < target) lines.push(`대기 링크가 부족해 ${results.length}편만 만들었습니다. 브랜드커넥트에서 링크를 발급해 앱 대기열에 넣어 주세요.`);
  return lines.join('\n').replace(/\n/g, '<br>');
}

module.exports = { MODEL_ROLES, pickDailyItems, queueCounts, addQueueUrls, buildReport };
