'use strict';

// 원고 보관함 — 미리 만든 원고와 불러온 원고를 저장해 두고 나중에 에디터에 넣는다.
// 파일 입출력은 호출측(main)이 한다. 여기는 데이터만 다룬다.

const crypto = require('node:crypto');

const MAX_DRAFTS = 200;

function emptyStore() { return { version: 1, drafts: [] }; }

function normalizeStore(data) {
  const drafts = data && Array.isArray(data.drafts) ? data.drafts.filter((draft) => draft && draft.id) : [];
  return { version: 1, drafts };
}

function newDraftId(now) {
  return String(now || Date.now()) + '-' + crypto.randomBytes(4).toString('hex');
}

function addDraft(store, draft, { now = Date.now() } = {}) {
  const base = normalizeStore(store);
  const entry = {
    id: draft.id || newDraftId(now),
    topicId: draft.topicId,
    profileKey: draft.profileKey,
    keyword: draft.keyword,
    purpose: draft.purpose === 'home' ? 'home' : 'search',
    productKey: draft.productKey || '',
    source: draft.source === 'import' ? 'import' : 'ai',
    createdAt: new Date(now).toISOString(),
    updatedAt: null,
    injectedAt: null,
    status: draft.status || 'review',
    holdReasons: draft.holdReasons || [],
    reviewReasons: draft.reviewReasons || [],
    result: draft.result || null,
  };
  return { store: { version: 1, drafts: [entry].concat(base.drafts).slice(0, MAX_DRAFTS) }, draft: entry };
}

function updateDraft(store, id, patch, { now = Date.now() } = {}) {
  const base = normalizeStore(store);
  let updated = null;
  const list = base.drafts.map((draft) => {
    if (draft.id !== id) return draft;
    updated = Object.assign({}, draft, patch, { id: draft.id, updatedAt: new Date(now).toISOString() });
    return updated;
  });
  if (!updated) throw new Error('원고를 찾지 못했습니다.');
  return { store: { version: 1, drafts: list }, draft: updated };
}

function removeDraft(store, id) {
  const base = normalizeStore(store);
  const list = base.drafts.filter((draft) => draft.id !== id);
  if (list.length === base.drafts.length) throw new Error('원고를 찾지 못했습니다.');
  return { version: 1, drafts: list };
}

function listDrafts(store, topicId) {
  return normalizeStore(store).drafts.filter((draft) => !topicId || draft.topicId === topicId);
}

function parseKeywordList(text, { max = 10 } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\n,]+/)) {
    const keyword = raw.trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
  }
  return { keywords: out.slice(0, max), dropped: Math.max(0, out.length - max) };
}

module.exports = { MAX_DRAFTS, emptyStore, normalizeStore, addDraft, updateDraft, removeDraft, listDrafts, parseKeywordList };
