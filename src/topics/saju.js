'use strict';

const siteUrl = 'https://sajuotter.com';

const serviceFacts = [
  '상담사 없이 AI가 만세력 계산부터 풀이 리포트까지 만든다. 결제 후 최대 10분 안에 PDF로 받는다.',
  '무료 서비스: 오늘의 운세, 인생 그래프, 사주 도감, 내 오행 밸런스, 사주 속 귀인, 타고난 매력, 2026년 신년운세.',
  '유료 주제별 심층 리딩은 3,900원이며 내 사주 첫 풀이, 재물운, 직업·적성운(5년 이직 타임라인), 애정·결혼운, 대인관계·인복, 건강운을 제공한다.',
  '궁합은 재회 관점을 포함해 4,900원이다.',
  '날짜 리포트는 이사·개업·결혼·임신출산을 다루며 3,900원이다.',
  '평생사주 리포트는 100페이지이며 14,900원이다.',
  '콘텐츠는 명리학적 경향에 근거한 참고 자료이며 의학·법·재정 조언을 대체하지 않는다.',
].join('\n');

const products = [
  { key: 'intro', label: '내 사주 첫 풀이', price: '3,900원', url: `${siteUrl}/quick.html?topic=intro`, tags: ['intro', '사주풀이', '사주보기', '인터넷사주', 'AI사주'], fitsIntents: ['howto', 'definition', 'service'] },
  { key: 'wealth', label: '재물운 심층 리딩', price: '3,900원', url: `${siteUrl}/quick.html?topic=wealth`, tags: ['wealth', '재물운', '돈'], fitsIntents: ['howto', 'service'] },
  { key: 'career', label: '직업·적성운 심층 리딩', price: '3,900원', url: `${siteUrl}/quick.html?topic=career`, tags: ['career', '직업', '적성', '이직'], fitsIntents: ['howto', 'service'] },
  { key: 'love', label: '애정·결혼운 심층 리딩', price: '3,900원', url: `${siteUrl}/quick.html?topic=love`, tags: ['love', '연애', '애정', '결혼'], fitsIntents: ['howto', 'service'] },
  { key: 'relationship', label: '대인관계·인복 심층 리딩', price: '3,900원', url: `${siteUrl}/quick.html?topic=relationship`, tags: ['relationship', '대인관계', '인복'], fitsIntents: ['howto', 'service'] },
  { key: 'health', label: '건강운 심층 리딩', price: '3,900원', url: `${siteUrl}/quick.html?topic=health`, tags: ['health', '건강'], fitsIntents: ['howto', 'service'] },
  { key: 'compat', label: '궁합 리포트', price: '4,900원', url: `${siteUrl}/compat.html`, tags: ['compat', '궁합', '재회', '사주궁합', '무료사주궁합'], fitsIntents: ['compare', 'howto', 'service'] },
  { key: 'moving', label: '이사 날짜 리포트', price: '3,900원', url: `${siteUrl}/date-select.html?occasion=moving`, tags: ['date', '이사', '택일'], fitsIntents: ['howto', 'service'] },
  { key: 'opening', label: '개업 날짜 리포트', price: '3,900원', url: `${siteUrl}/date-select.html?occasion=opening`, tags: ['date', '개업', '택일'], fitsIntents: ['howto', 'service'] },
  { key: 'wedding', label: '결혼 날짜 리포트', price: '3,900원', url: `${siteUrl}/date-select.html?occasion=wedding`, tags: ['date', '결혼', '택일'], fitsIntents: ['howto', 'service'] },
  { key: 'birth', label: '임신출산 날짜 리포트', price: '3,900원', url: `${siteUrl}/date-select.html?occasion=birth`, tags: ['date', '임신', '출산', '택일'], fitsIntents: ['howto', 'service'] },
  { key: 'lifetime', label: '평생사주 100페이지', price: '14,900원', url: `${siteUrl}/lifetime-report.html`, tags: ['lifetime', '평생사주'], fitsIntents: ['howto', 'service'] },
  { key: 'free-today', label: '오늘의 운세·2026년 신년운세', price: '', url: `${siteUrl}/today-fortune.html`, tags: ['free-today', '무료', '운세', '2026년'], fitsIntents: ['howto', 'service'] },
  { key: 'free-balance', label: '내 오행 밸런스', price: '', url: `${siteUrl}/free.html?kind=balance`, tags: ['free-balance', '무료', '오행'], fitsIntents: ['howto', 'service'] },
  { key: 'free-noble', label: '사주 속 귀인', price: '', url: `${siteUrl}/free.html?kind=noble`, tags: ['free-noble', '무료', '귀인'], fitsIntents: ['howto', 'service'] },
  { key: 'free-charm', label: '타고난 매력', price: '', url: `${siteUrl}/free.html?kind=charm`, tags: ['free-charm', '무료', '매력'], fitsIntents: ['howto', 'service'] },
  { key: 'life-graph', label: '인생 그래프', price: '', url: `${siteUrl}/life-graph.html`, tags: ['life-graph', '무료', '인생 그래프'], fitsIntents: ['howto', 'service'] },
  { key: 'field-guide', label: '사주 도감', price: '', url: `${siteUrl}/field-guide.html`, tags: ['field-guide', '무료', '사주 도감'], fitsIntents: ['definition', 'howto'] },
  { key: 'services', label: '서비스 전체 보기', price: '', url: `${siteUrl}/services.html`, tags: ['services', '사주사이트', '인터넷사주'], fitsIntents: ['compare', 'howto', 'service'] },
];

const writingRules = [
  '단정·공포를 조장하지 않는다. “이 사주는 이혼한다”, “큰일 난다”처럼 말하지 말고 “경향”, “참고”라고 표현한다.',
  '건강·법률·투자 결정을 사주로 권하지 않는다.',
  '가격·기능은 serviceFacts에 있는 내용만 쓴다. 없는 할인·이벤트·적중률·이용자 수를 만들지 않는다.',
  '서비스는 독자의 질문에 실제로 답하는 지점에서 본문 흐름에 맞게 최대 2회 언급한다. 첫 언급에 운영자 표시 문장을 쓴다.',
  '무료 진입 서비스를 먼저 안내하고, 유료 서비스는 “더 깊게 보려면”으로 연결한다.',
  '경쟁 서비스를 비방하지 않는다. 비교가 필요하면 상담사 여부·결과 형태·가격대 기준으로 일반화한다.',
];

const keywordPlan = [
  { keyword: '인터넷사주', monthly: 38380, product: 'intro', intentHint: 'service', blogSlot: 'high', serpNote: '문서 영역 블로그 비중 높음(15/25), 이용 후기형 글 다수, 플레이스·상담 영역 있음', observedAt: '2026-10-05' },
  { keyword: '재회사주', monthly: 2790, product: 'compat', intentHint: 'howto', blogSlot: 'high', serpNote: '블로그 비중 높음(13/25), 재회 시기·구조 설명형 글', observedAt: '2026-10-05' },
  { keyword: '사주궁합', monthly: 8430, product: 'compat', intentHint: 'service', blogSlot: 'mid', serpNote: '블로그·카페·지식iN 혼합, 상담 영역 있음', observedAt: '2026-10-05' },
  { keyword: '무료사주궁합', monthly: 5700, product: 'compat', intentHint: 'service', blogSlot: 'mid', serpNote: 'AI 브리핑 있음, 웹사이트 비중 높음', observedAt: '2026-10-05' },
  { keyword: 'AI사주', monthly: 5760, product: 'intro', intentHint: 'compare', blogSlot: 'mid', serpNote: '첫 문서가 경쟁 서비스 사이트, 영상 많음', observedAt: '2026-10-05' },
  { keyword: '사주사이트', monthly: 10010, product: 'services', intentHint: 'service', blogSlot: 'mid', serpNote: '첫 문서가 경쟁 사이트, 카페 비중 있음', observedAt: '2026-10-05' },
  { keyword: '무료사주', monthly: 30880, product: 'free-balance', intentHint: 'service', blogSlot: 'low', serpNote: '웹사이트·지식iN 비중 높음', observedAt: '2026-10-05' },
  { keyword: '사주풀이', monthly: 10550, product: 'intro', intentHint: 'howto', blogSlot: 'low', serpNote: '첫 문서가 만세력 사이트', observedAt: '2026-10-05' },
  { keyword: '사주보기', monthly: 5440, product: 'intro', intentHint: 'howto', blogSlot: 'low', serpNote: 'AI 브리핑, 만세력 사이트', observedAt: '2026-10-05' },
  { keyword: '연애사주', monthly: 3130, product: 'love', intentHint: 'howto', blogSlot: 'low', serpNote: '첫 문서가 경쟁 사이트, 쇼핑 영역', observedAt: '2026-10-05' },
];

const capturePages = [
  { id: 'home', path: '/', caption: '사주보는 수달 홈', tags: ['intro', 'home'] },
  { id: 'services', path: '/services.html', caption: '서비스 안내', tags: ['services'] },
  { id: 'compat', path: '/compat.html', caption: '궁합 리포트', tags: ['compat', '궁합', '재회'] },
  ...['intro', 'love', 'wealth', 'career'].map((topic) => ({ id: `quick-${topic}`, path: `/quick.html?topic=${topic}`, caption: `주제별 심층 리딩 ${topic}`, tags: [topic, 'quick'] })),
  { id: 'lifetime', path: '/lifetime-report.html', caption: '평생사주 리포트', tags: ['lifetime'] },
  { id: 'webtoon-lifetime', path: '/webtoon/lifetime.html', caption: '평생사주 안내', tags: ['lifetime', 'webtoon'] },
  { id: 'today-fortune', path: '/today-fortune.html', caption: '오늘의 운세', tags: ['free-today', '운세'] },
  { id: 'free-balance', path: '/free.html?kind=balance', caption: '내 오행 밸런스', tags: ['free-balance', '무료'] },
  { id: 'life-graph', path: '/life-graph.html', caption: '인생 그래프', tags: ['life-graph', '무료'] },
  { id: 'date-wedding', path: '/date-select.html?occasion=wedding', caption: '결혼 날짜 리포트', tags: ['date', 'wedding'] },
];

const saju = {
  id: 'saju', label: '사주보는 수달', enabled: true, siteUrl, domains: ['sajuotter.com'], serviceFacts, products,
  writingRules,
  keywordPlan,
  capturePages,
};

module.exports = { saju };
