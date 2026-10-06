'use strict';

const { isValidHttpUrl } = require('../generator/searchBrief');

function ctaUrl(product, ctx = {}) {
  if (!product || !product.url) throw new Error('연결 상품 URL이 없습니다.');
  const url = new URL(product.url);
  const query = [...url.searchParams.entries()].filter(([key]) => !key.startsWith('utm_'))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  query.push(`utm_source=${encodeURIComponent('naver_blog')}`);
  query.push(`utm_medium=${encodeURIComponent('organic')}`);
  query.push(`utm_campaign=${encodeURIComponent(String(ctx.blogKey || 'unknown'))}`);
  query.push(`utm_content=${encodeURIComponent(String(ctx.keyword || ''))}`);
  url.search = `?${query.join('&')}`;
  return url.toString();
}

function scoreAsset(asset, product, keyword) {
  const terms = new Set([...(product && product.tags || []), ...(keyword || '').toLowerCase().split(/\s+/)]);
  return (asset.tags || []).reduce((score, tag) => score + (terms.has(String(tag).toLowerCase()) ? 2 : 0), 0)
    + (terms.has(String(asset.caption || '').toLowerCase()) ? 1 : 0);
}

function topicEvidenceForIntent(evidenceSource, intent) {
  return evidenceSource && intent !== 'news' ? [evidenceSource] : [];
}

function buildTopicContext({ topic, profile, keyword, productKey, purpose, assets, blogKey } = {}) {
  if (!topic || !Array.isArray(topic.products)) throw new Error('주제 설정이 올바르지 않습니다.');
  const product = topic.products.find((item) => item.key === productKey) || topic.products[0];
  if (!product) throw new Error('연결 상품이 없습니다.');
  const selectedAssets = (Array.isArray(assets) ? assets : []).filter((asset) => asset && asset.id)
    .map((asset) => ({ id: String(asset.id), caption: String(asset.caption || ''), tags: Array.isArray(asset.tags) ? asset.tags.map(String) : [], score: scoreAsset(asset, product, keyword) }))
    .filter((asset) => asset.score > 0)
    .sort((a, b) => b.score - a.score).slice(0, 24).map(({ score, ...asset }) => asset);
  const disclosureLine = `제가 운영하는 ${topic.label}에서는`;
  const currentProfile = profile || {};
  const trackingUrl = ctaUrl(product, { blogKey: blogKey || currentProfile.key, keyword });
  const promptBlock = [
    `[주제 탭: ${topic.label}]`,
    `- 글쓴이: ${currentProfile.persona || '서비스를 운영하며 사주를 쉽게 설명하는 운영자'}`,
    `- 말투: ${currentProfile.toneHint || '담백하고 알기 쉬운 설명체'}`,
    `- 집중 분야: ${currentProfile.focus || '기초 명리·사주풀이'}`,
    '- 서비스 사실(확인된 내용만 사용):',
    topic.serviceFacts,
    `- 연결 상품: ${product.label}${product.price ? ` / ${product.price}` : ' / 무료'} / ${product.url}`,
    `- 글 마지막 링크 블록의 추적 URL: ${trackingUrl}`,
    '- 작성 규칙:',
    ...(topic.writingRules || []),
    `- 서비스 첫 언급에 운영자 표시 문장을 자연스럽게 포함한다: “${disclosureLine} …”`,
    `- CTA는 글 마지막에 연결 링크를 한 번만 배치한다: ${product.label}`,
    '- 무료 진입 서비스를 먼저 알려주고 유료 상품은 “더 깊게 보려면”이라는 흐름으로 안내한다.',
    '- 아래 사진 목록에서 본문 흐름에 맞는 사진만 고르고 image 블록에 assetId와 imageHint를 지정한다. 5장 참조를 목표로 하되 없는 사진을 만들거나 억지로 채우지 않는다.',
    `- 사진 목록: ${selectedAssets.length ? JSON.stringify(selectedAssets) : '현재 사용 가능한 사진 없음'}`,
    `- 목적: ${purpose || 'search'}`,
  ].join('\n');
  const evidenceSource = {
    url: topic.siteUrl,
    title: `${topic.label} 서비스 안내(사용자 제공 서비스 사실)`,
    text: topic.serviceFacts,
    sourceType: 'user-source',
    contentKind: 'service-facts',
    collectedAt: new Date().toISOString(),
  };
  if (!isValidHttpUrl(evidenceSource.url)) throw new Error('주제 근거 URL이 올바르지 않습니다.');
  return { promptBlock, product, ctaUrl: trackingUrl, disclosureLine, assetCatalog: selectedAssets, evidenceSource };
}

module.exports = { ctaUrl, buildTopicContext, topicEvidenceForIntent };
