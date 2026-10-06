'use strict';

const FORBIDDEN_CAPTURE_PATH = /(?:^|\/)(?:mypage|my-page|profiles?|pay|payment|login|signin)(?:\/|$|[.?#])/i;

function validateCapturePages(topic) {
  const pages = Array.isArray(topic && topic.capturePages) ? topic.capturePages : [];
  return pages.map((page) => {
    const value = String(page && page.path || '');
    if (!value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value) || FORBIDDEN_CAPTURE_PATH.test(value)) {
      throw new Error(`허용되지 않는 캡처 경로: ${value}`);
    }
    const url = new URL(value, topic.siteUrl);
    const allowed = new Set((topic.domains || []).map((domain) => String(domain).toLowerCase()));
    if (url.protocol !== 'https:' || !allowed.has(url.hostname.toLowerCase())) throw new Error(`허용되지 않는 캡처 URL: ${value}`);
    return { ...page, url: url.toString() };
  });
}

function usageAge(record, now) {
  const time = Date.parse(record && record.at);
  return Number.isFinite(time) ? (now - time) / 86400000 : Infinity;
}

function assetScore(asset, productKey, keyword, hint) {
  const terms = [productKey, ...(String(keyword || '').toLowerCase().split(/\s+/)), ...(String(hint || '').toLowerCase().split(/\s+/))].filter(Boolean);
  const tags = (asset.tags || []).map((tag) => String(tag).toLowerCase());
  const caption = String(asset.caption || '').toLowerCase();
  return terms.reduce((score, term) => score + (tags.some((tag) => tag.includes(term) || term.includes(tag)) ? 3 : caption.includes(term) ? 1 : 0), 0);
}

function resolveTopicImageAssets(post, assets, { productKey, keyword, blogKey, now = Date.now(), usage = [], maxImages = Infinity } = {}) {
  const source = Array.isArray(assets) ? assets.filter((asset) => asset && asset.id && asset.path) : [];
  const used = new Set();
  const ids = [];
  const paths = [];
  const blocks = (Array.isArray(post && post.blocks) ? post.blocks : []).map((original) => {
    if (!original || original.kind !== 'image') return original;
    if (ids.length >= maxImages) return null;
    const ranked = source.map((asset, index) => {
      const recentElsewhere = usage.some((record) => record.assetId === asset.id && record.blogKey !== blogKey && usageAge(record, now) <= 14);
      const baseScore = assetScore(asset, productKey, keyword, original.imageHint);
      return { asset, index, baseScore, score: baseScore - (recentElsewhere ? 100 : 0) };
    }).filter(({ asset }) => !used.has(asset.id));
    const candidates = ranked.filter((item) => item.baseScore > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    if (!candidates.length) return null;
    const requested = candidates.find(({ asset }) => asset.id === original.assetId);
    const chosen = (requested && requested.score >= (candidates[0].score - 50) ? requested : null) || candidates[0];
    used.add(chosen.asset.id);
    ids.push(chosen.asset.id);
    paths.push(chosen.asset.path);
    return { ...original, assetId: chosen.asset.id };
  }).filter(Boolean);
  return { post: { ...post, blocks }, assetIds: ids, assetPaths: paths, assets: ids.map((id) => source.find((asset) => asset.id === id)) };
}

module.exports = { validateCapturePages, resolveTopicImageAssets };
