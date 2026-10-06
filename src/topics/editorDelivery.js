'use strict';

function topicEditorPayload({ post, assets, purpose, keyword } = {}) {
  return {
    post,
    keyword: String(keyword || ''),
    photos: (Array.isArray(assets) ? assets : []).map((asset) => String(asset && asset.path || '')).filter(Boolean),
    purpose: purpose === 'home' ? 'home' : 'search',
  };
}

async function injectTopicPost({ post, assets, purpose, keyword, finishGen, setPhotos, setImageMode } = {}) {
  if (typeof finishGen !== 'function') throw new Error('글 주입 함수를 제공해야 합니다.');
  const payload = topicEditorPayload({ post, assets, purpose, keyword });
  if (typeof setPhotos === 'function') setPhotos(payload.photos.slice());
  if (typeof setImageMode === 'function') setImageMode(payload.purpose);
  await finishGen(payload.post, payload.keyword, [], null, { search: payload.purpose === 'search' });
  return payload;
}

const editorDelivery = { topicEditorPayload, injectTopicPost };
if (typeof module !== 'undefined' && module.exports) module.exports = editorDelivery;
if (typeof window !== 'undefined') window.topicEditorDelivery = editorDelivery;
