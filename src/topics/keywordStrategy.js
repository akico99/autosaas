'use strict';

const { domainToUnicode } = require('url');

// 키워드 원고 전략 — 그 키워드의 통합검색 관찰 결과를 "이 원고를 어떻게 쓸지" 지시로 바꾼다.
// 관찰은 지금 무엇이 위에 있는지를 알려 줄 뿐 왜 위에 있는지는 알려 주지 않는다.
// 그래서 여기 지시는 상위 글과 같은 질문에 더 낫게 답하도록 형식을 맞추는 수준이며, 노출을 보장하지 않는다.

const FORMAT_RULES = [
  ['review', /후기|리뷰|내돈내산|솔직|다녀왔|봤어요|해봤|받아봤|이용기/],
  ['recommend', /추천|순위|\bbest\b|top\s*\d|모음|총정리|잘\s*보는\s*곳/i],
  ['howto', /방법|보는\s*법|하는\s*법|순서|가이드|따라\s*하|꿀팁|팁/],
  ['definition', /뜻|의미|이란|란\?|개념|정리해/],
  ['compare', /비교|차이|vs/i],
];

const FORMAT_LABEL = {
  review: '이용 후기형',
  recommend: '추천·모음형',
  howto: '방법·안내형',
  definition: '뜻·개념 설명형',
  compare: '비교형',
  mixed: '여러 형식 혼합',
};

const FORMAT_GUIDE = {
  review: '상위 블로그 글은 이용 후기형이 많다. 운영자는 고객 후기를 쓸 수 없으므로, 실제 화면 캡처로 처음 입력부터 결과를 받기까지의 과정을 보여 주는 사용 안내형으로 같은 궁금증(어떻게 진행되는지, 얼마나 걸리는지, 결과에서 무엇을 알 수 있는지)에 답한다.',
  recommend: '상위 글은 추천·모음형이 많다. 특정 서비스 칭찬 대신 고르는 기준(만세력 계산 여부, 상담사 여부, 결과 형태, 가격대)을 표로 정리하고, 그 기준에 비춰 운영 중인 서비스의 특징을 운영자 표시와 함께 한 번만 설명한다.',
  howto: '상위 글은 방법·안내형이 많다. 번호 단계로 따라 할 수 있게 쓰고, 단계마다 맞는 화면 캡처를 붙인다.',
  definition: '상위 글은 뜻·개념 설명형이 많다. 첫 문단에서 정의하고, 예시와 헷갈리는 개념과의 차이를 덧붙인다.',
  compare: '상위 글은 비교형이 많다. 같은 기준으로 비교한 표를 넣고 상황별로 어떤 선택이 맞는지 정리한다.',
  mixed: '상위 글 형식이 섞여 있다. 검색 의도 기준에 맞춰 핵심 질문에 먼저 답한다.',
};

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function classifyTitles(titles) {
  const counts = {};
  for (const title of titles) {
    for (const [key, pattern] of FORMAT_RULES) {
      if (pattern.test(title)) { counts[key] = (counts[key] || 0) + 1; break; }
    }
  }
  const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const top = ranked[0];
  const dominant = top && counts[top] >= 2 && counts[top] >= Math.ceil(titles.length / 3) ? top : 'mixed';
  return { dominant, counts };
}

function blogSlotFrom(blocks) {
  // 검색광고·유료 브랜드 콘텐츠 안의 블로그 글은 일반 블로그가 들어갈 자리가 아니므로 뺀다.
  const blogBlock = blocks.find((block) => block.blockKind !== 'ad' && block.blockKind !== 'brand-content' && (block.items || []).some((item) => item.sourceType === '블로그'));
  if (!blogBlock) return 'low';
  if (Number(blogBlock.blockOrder) <= 2) return 'high';
  if (Number(blogBlock.blockOrder) <= 5) return 'mid';
  return 'low';
}

const SLOT_LABEL = { high: '높음', mid: '보통', low: '낮음' };

// 'xn--...' 형태의 한글 도메인을 사람이 읽을 수 있게 바꾼다.
function readableDomain(domain) {
  const raw = String(domain || '').trim();
  if (!raw) return '';
  try { return domainToUnicode(raw) || raw; } catch (_) { return raw; }
}

// 키워드의 핵심어 — 띄어쓰기 단위와, 붙여 쓴 4자 이상 낱말의 앞뒤 2자.
function keywordCores(keyword) {
  const compact = String(keyword || '').replace(/\s+/g, '').toLowerCase();
  const cores = new Set(compact ? [compact] : []);
  for (const token of String(keyword || '').toLowerCase().split(/\s+/)) {
    if (token.length >= 2) cores.add(token);
    if (token.length >= 4) { cores.add(token.slice(0, 2)); cores.add(token.slice(-2)); }
  }
  return [...cores];
}

// 카페 이름 같은 출처 라벨("리그오브레전드 한국커뮤니티 - LoLKor")이나 키워드와 무관한 제목은 뺀다.
function isRelevantTitle(title, cores) {
  if (/^[^-]{1,40}\s-\s[A-Za-z0-9 ._]+$/.test(title)) return false;
  if (!cores.length) return true;
  const compact = title.replace(/\s+/g, '').toLowerCase();
  return cores.some((core) => compact.includes(core));
}

function buildKeywordStrategy({ keyword, observation, plan, now = new Date() } = {}) {
  const warnings = [];
  const lines = [];
  const measured = !!(observation && observation.measured && Array.isArray(observation.blocks) && observation.blocks.length);
  if (!measured) {
    const saved = plan && (plan.serpNote || plan.blogSlot);
    if (saved) {
      const slot = plan.blogSlot || 'mid';
      if (slot === 'low') warnings.push('저장된 분석 기준 이 키워드는 통합검색에서 블로그 자리가 뒤쪽이라 노출 가능성이 낮습니다.');
      lines.push('[키워드 원고 전략 — 저장된 통합검색 분석(' + String(plan.observedAt || '').slice(0, 10) + ') 기준]');
      lines.push('- 블로그 진입 가능성: ' + (SLOT_LABEL[slot] || slot));
      if (plan.serpNote) lines.push('- 관찰 메모: ' + plan.serpNote);
      lines.push('- 지금 검색 화면은 확인하지 못했다. 메모와 검색 의도 기준을 함께 따른다.');
      return { measured: false, source: 'saved', blogSlot: slot, dominantFormat: null, warnings, promptBlock: lines.join('\n') };
    }
    return { measured: false, source: 'none', blogSlot: null, dominantFormat: null, warnings: ['통합검색 화면을 확인하지 못해 키워드 전략 없이 작성했습니다.'], promptBlock: '' };
  }

  const blocks = observation.blocks;
  const kinds = new Set(blocks.map((block) => block.blockKind));
  const names = blocks.map((block) => String(block.blockName || ''));
  const aiBriefing = names.some((name) => /AI\s*브리핑/.test(name));
  const expert = names.some((name) => /상담|엑스퍼트/.test(name));
  const blogSlot = blogSlotFrom(blocks);
  const docItems = blocks.filter((block) => block.blockKind === 'related-docs' || (block.blockKind === 'content' && /인기글|관련문서/.test(String(block.blockName))))
    .flatMap((block) => block.items || []);
  const writtenItems = docItems.filter((item) => item.sourceType === '블로그' || item.sourceType === '카페');
  const cores = keywordCores(keyword);
  const topTitles = writtenItems.map((item) => String(item.title || '').trim())
    .filter((title) => title.length >= 6 && isRelevantTitle(title, cores)).slice(0, 8);
  const { dominant, counts } = classifyTitles(topTitles);
  const titleMedian = median(topTitles.map((title) => title.length));
  const firstDocBlock = blocks.find((block) => block.blockKind === 'related-docs' && (block.items || []).length);
  const firstDoc = firstDocBlock && firstDocBlock.items[0];
  const competitorFirst = !!(firstDoc && firstDoc.sourceType === '웹');
  const competitorSites = [...new Set(docItems.filter((item) => item.sourceType === '웹').map((item) => readableDomain(item.domain)).filter(Boolean))].slice(0, 4);
  const siteFound = observation.siteFound || null;

  if (blogSlot === 'low') warnings.push('이 키워드는 지금 통합검색에서 블로그 자리가 뒤쪽이라 노출 가능성이 낮습니다.');
  if (competitorFirst) warnings.push('첫 문서 자리를 서비스 사이트(' + readableDomain(firstDoc.domain) + ')가 차지하고 있습니다.');

  lines.push('[키워드 원고 전략 — ' + now.toISOString().slice(0, 10) + ' 통합검색 관찰 기준, "' + keyword + '"]');
  lines.push('- 화면 구성(위에서부터): ' + names.slice(0, 8).join(' > '));
  lines.push('- 블로그 진입 가능성: ' + SLOT_LABEL[blogSlot] + (kinds.has('ad') ? ' · 검색광고 있음' : '') + (kinds.has('brand-content') ? ' · 브랜드 콘텐츠 있음' : '') + (expert ? ' · 유료 상담 영역 있음' : ''));
  lines.push('- 상위 블로그·카페 글 형식: ' + FORMAT_LABEL[dominant] + (Object.keys(counts).length ? ' (' + Object.keys(counts).map((key) => FORMAT_LABEL[key] + ' ' + counts[key]).join(', ') + ')' : ''));
  lines.push('- 형식 지시: ' + FORMAT_GUIDE[dominant]);
  if (aiBriefing) lines.push('- 검색 결과에 AI 브리핑이 있다. 요약만으로 끝나지 않게 조건별 예시, 실제 화면, 헷갈리는 차이를 더한다.');
  if (competitorFirst) lines.push('- 첫 문서 자리에 다른 서비스 사이트가 있다. 경쟁 서비스를 언급하거나 비방하지 않고, 독자가 서비스를 고를 때 쓸 수 있는 기준으로 설명한다.');
  if (expert) lines.push('- 유료 상담 영역이 함께 노출되는 키워드다. 상담 광고처럼 보이지 않게, 정보 설명을 먼저 하고 서비스 안내는 짧게 한다.');
  if (titleMedian) lines.push('- 제목: 메인 키워드 "' + keyword + '"를 앞쪽에 두고 ' + Math.max(15, titleMedian - 6) + '~' + (titleMedian + 6) + '자 안팎으로 쓴다(상위 글 중앙값 ' + titleMedian + '자). 아래 제목은 참고만 하고 문장을 베끼지 않는다.');
  if (topTitles.length) lines.push('- 상위 글 제목: ' + topTitles.slice(0, 6).map((title) => '「' + title + '」').join(' '));
  if (siteFound) lines.push('- 운영 중인 사이트가 이미 ' + siteFound.blockName + ' ' + siteFound.positionInBlock + '번째에 노출되고 있다. 사이트 소개를 반복하지 말고 사이트가 다루지 않는 설명을 보탠다.');

  return {
    measured: true, source: 'live', blogSlot, dominantFormat: dominant, aiBriefing, competitorFirst, competitorSites,
    topTitles: topTitles.slice(0, 6), titleMedian, warnings, promptBlock: lines.join('\n'),
  };
}

// 홈판용 사주 기준 — 홈판은 검색이 아니라 추천이라 통합검색 분석이 맞지 않는다.
// 아래는 앱의 제작 기본값이며, 홈판 노출 데이터로 검증된 기준이 아니다. 조회수 기록으로 조정한다.
function homefeedGuidance(keyword) {
  return [
    '[홈판용 사주 원고 기준 — 앱 기본값, 조회수 기록으로 조정]',
    '- 홈판은 검색이 아니라 추천이다. 제목과 대표 이미지 문구가 클릭을 결정한다.',
    '- 키워드 "' + keyword + '"에 맞는 각도 하나만 고른다: 시기형(이번 주·이번 달·절기·새해 흐름), 띠·일간별 성향형, 관계 상황형 질문(연락·재회·궁합), 일과 돈의 흐름형.',
    '- 제목 훅은 궁금증·공감·의외성으로 만든다. 공포 조장, 단정적 예언, "무조건" 같은 표현은 쓰지 않는다.',
    '- 대표 이미지 문구는 12자 안팎으로, 키워드의 핵심어를 넣는다.',
    '- 첫 세 문장 안에 독자의 상황에 공감하고 이 글에서 알 수 있는 것을 말한다.',
    '- 서비스 안내는 본문 흐름상 필요한 곳에서 한 번, 마지막 링크에서 한 번만 한다.',
  ].join('\n');
}

module.exports = { buildKeywordStrategy, homefeedGuidance, classifyTitles, blogSlotFrom, FORMAT_LABEL };
