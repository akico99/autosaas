'use strict';

function topicEditorPayload({ post, assets, purpose, keyword } = {}) {
  return {
    post,
    keyword: String(keyword || ''),
    photos: (Array.isArray(assets) ? assets : []).map((asset) => String(asset && asset.path || '')).filter(Boolean),
    purpose: purpose === 'home' ? 'home' : 'search',
  };
}

async function injectTopicPost({ post, assets, purpose, keyword, connectKind, beforeInject, finishGen, setPhotos, setImageMode } = {}) {
  if (typeof finishGen !== 'function') throw new Error('글 주입 함수를 제공해야 합니다.');
  const payload = topicEditorPayload({ post, assets, purpose, keyword });
  const target = typeof window !== 'undefined' ? window : {};
  const doc = typeof document !== 'undefined' ? document : null;
  const keys = ['_myPhotos', '_placePhotos', '_genType', '_genCtx', '_topicTabActive', '_topicId', '_reviewDiscType', '_reviewDiscItem'];
  const previous = Object.fromEntries(keys.map((key) => [key, target[key]]));
  const segmentState = ['#img-s', '#img-home'].map((selector) => {
    const root = doc && doc.querySelector(selector);
    return root ? [selector, [...root.querySelectorAll('.s')].map((item) => item.classList.contains('on'))] : [selector, null];
  });
  try {
    if (connectKind) { target._topicId = 'travel-connect'; target._topicTabActive = true; target._genCtx = 'search'; target._reviewDiscType = null; target._reviewDiscItem = ''; }
    if (typeof setPhotos === 'function') setPhotos(payload.photos.slice());
    if (typeof setImageMode === 'function') setImageMode(payload.purpose);
    const gen = await finishGen(payload.post, payload.keyword, [], null, {
      search: payload.purpose === 'search', strictInject: true,
      ...(connectKind ? { connectKind } : {}), ...(typeof beforeInject === 'function' ? { beforeInject } : {}),
    });
    if (gen && gen.ok === false) throw new Error(gen.error || '에디터에 원고를 넣지 못했습니다.');
    return payload;
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete target[key];
      else target[key] = previous[key];
    }
    for (const [selector, state] of segmentState) {
      if (!state) continue;
      const root = doc && doc.querySelector(selector), items = root && [...root.querySelectorAll('.s')];
      if (items) items.forEach((item, index) => item.classList.toggle('on', !!state[index]));
    }
    try { if (typeof target._refreshThumbSaved === 'function') target._refreshThumbSaved(); } catch (_) {}
  }
}

const editorDelivery = { topicEditorPayload, injectTopicPost };
if (typeof module !== 'undefined' && module.exports) module.exports = editorDelivery;
if (typeof window !== 'undefined') window.topicEditorDelivery = editorDelivery;
