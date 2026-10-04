'use strict';

const cleanDisplay = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
const cleanHeader = (value) => cleanDisplay(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const keywordKey = (value) => cleanDisplay(value).normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
const path = require('node:path');
const ExcelJS = require('exceljs');

const SAJU_TERMS = /사주|명리|만세력|운세|궁합|토정비결|팔자/;
const SAJU_SEED = /사주|명리|만세력|운세|궁합|토정비결|팔자/;
const OLD_YEAR = /(?:19|20)\d{2}/g;
const OFF_TOPIC = /꿈해몽|꿈풀이|타로|신점|무속|무당|점집/;
const PLACE_OR_SERVICE = /철학관|사주카페|상담소|작명소|역술원|점집|방문상담|(?<!비)대면상담/;
const REGIONS = /서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|수원|성남|용인|고양|화성|청주|천안|전주|포항|창원|김해|파주|일산/;
const BRAND_QUERY = /사주의신|사주24/;
const CELEBRITY_QUERY = /연예인|아이돌|유명인|배우|가수|방송인/;
const KNOWN_PERSON_NAMES = ['카리나', '아이유', '김연아', '유재석'];

function metricValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cleanDisplay(value);
  if (!text) return null;
  if (/^<\s*10$/i.test(text)) return '<10';
  const numeric = text.replace(/,/g, '');
  return /^\d+(?:\.\d+)?$/.test(numeric) ? Number(numeric) : null;
}

function findSearchAdsHeader(rows) {
  const limit = Math.min(rows.length, 30);
  for (let start = 0; start < limit; start++) {
    const headerRows = rows.slice(start, Math.min(limit, start + 3));
    const width = Math.max(0, ...headerRows.map((row) => row.length));
    const indexes = Array.from({ length: width }, (_, column) => headerRows.map((row) => cleanHeader(row[column])));
    const locate = (predicate) => {
      for (let column = 0; column < indexes.length; column++) {
        const rowOffset = indexes[column].findIndex(predicate);
        if (rowOffset >= 0) return { column, rowOffset };
      }
      return null;
    };
    const keyword = locate((h) => /^(연관키워드|키워드)$/.test(h));
    const pc = locate((h) => /^(월간검색수\(pc\)|월간검색수pc)$/.test(h));
    const mobile = locate((h) => /^(월간검색수\(모바일\)|월간검색수모바일)$/.test(h));
    if (keyword && pc && mobile) {
      const finalHeaderRow = start + Math.max(keyword.rowOffset, pc.rowOffset, mobile.rowOffset);
      return { rowIndex: finalHeaderRow, keyword: keyword.column, pc: pc.column, mobile: mobile.column };
    }
  }
  throw new Error('네이버 검색광고 엑셀에서 키워드와 PC·모바일 월간검색수 열을 찾지 못했습니다.');
}

function parseSearchAdsRows(rawRows, { sourceFileName = '', importedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(rawRows) || !rawRows.length) throw new Error('검색광고 엑셀에 읽을 행이 없습니다.');
  const rows = rawRows.map((row) => Array.isArray(row) ? row : []);
  const header = findSearchAdsHeader(rows);
  const parsed = [];
  for (const [offset, row] of rows.slice(header.rowIndex + 1).entries()) {
    const keyword = cleanDisplay(row[header.keyword]);
    if (!keyword) continue;
    const monthlyPc = metricValue(row[header.pc]);
    const monthlyMobile = metricValue(row[header.mobile]);
    parsed.push({
      keyword,
      monthlyPc,
      monthlyMobile,
      monthlyTotal: (typeof monthlyPc === 'number' && typeof monthlyMobile === 'number')
        ? monthlyPc + monthlyMobile
        : null,
      sources: ['search-ads-xlsx'],
      sourceRow: header.rowIndex + offset + 2,
    });
  }
  return { rows: parsed, sourceFileName: cleanDisplay(sourceFileName), importedAt };
}

function defaultYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 9999 ? year : new Date().getFullYear();
}

function classifyKeyword(keyword, seed, { currentYear } = {}) {
  const display = cleanDisplay(keyword);
  const key = keywordKey(display);
  const seedDisplay = cleanDisplay(seed);
  const seedNormalized = keywordKey(seedDisplay);
  const year = defaultYear(currentYear);
  const isSajuSeed = SAJU_SEED.test(seedNormalized);
  const hasSajuAnchor = /사주|명리|만세력|팔자/.test(seedNormalized);
  const hasSeed = !!seedNormalized && key.includes(seedNormalized);
  const hasSajuTopic = SAJU_TERMS.test(key);
  const intents = [];
  const addIntent = (intent) => { if (!intents.includes(intent)) intents.push(intent); };
  if (/무료|공짜/.test(key)) addIntent('무료');
  if (/유료|비용|가격|상담료/.test(key)) addIntent('유료');
  if (/ai|인공지능|챗gpt|chatgpt/.test(key)) addIntent('AI');
  if (/온라인|인터넷|비대면|전화|화상|앱|어플|사이트|홈페이지/.test(key)) addIntent('온라인');
  if (REGIONS.test(display) || PLACE_OR_SERVICE.test(display) || /방문|(?<!비)대면/.test(display)) addIntent('오프라인/지역');
  if (/상담|철학관|사주카페|작명소|역술원/.test(display)) addIntent('상담');

  let category = '관련 키워드';
  if (/연애|결혼|애정|재회|배우자/.test(key)) category = '연애·결혼';
  else if (/궁합|관계/.test(key)) category = '궁합·관계';
  else if (/직업|취업|직장|사업|진로|이직|창업|합격|시험/.test(key)) category = '직업·사업';
  else if (/재물|금전|돈|복권|재테크/.test(key)) category = '재물';
  else if (/오행|명리|음양|십성|육친|용신|격국|천간|지지|만세력/.test(key)) category = '오행·명리 개념';
  else if (/상담|철학관|사주카페|작명소|역술원|사이트|앱|어플|도우미|무료|유료|가격|비용|추천|후기|예약|온라인|비대면|전화|ai|인공지능|이용|조회|플랫폼|홈페이지/.test(key)) category = '상담·이용';
  else if (/신년|오늘|내일|올해|내년|년운|월운|토정비결/.test(key)) category = '시기·연도별';
  else if (/사주|팔자/.test(key)) category = '일반 사주';
  else if (/운세/.test(key)) category = '일반 운세';

  let relation = 'related';
  if (seedNormalized && (hasSeed || (isSajuSeed && /사주|명리|만세력|팔자/.test(key)))) relation = 'primary';
  else if (isSajuSeed && /궁합/.test(key)) relation = 'related';
  else if (isSajuSeed && /운세|토정비결/.test(key)) relation = 'broad';
  else if (seedNormalized && key === seedNormalized) relation = 'exact';

  let excludeReason = '';
  let reviewNote = '';
  if (!display) excludeReason = '키워드가 비어 있음';
  if (!excludeReason && seedNormalized && key === seedNormalized) excludeReason = '기준 키워드 자체';
  if (!excludeReason && isSajuSeed && !hasSajuTopic) excludeReason = '기준 주제와 무관한 키워드';
  if (!excludeReason && isSajuSeed && /음식.*궁합|궁합.*음식/.test(key) && !/음식/.test(seedNormalized)) excludeReason = '기준 주제와 무관한 키워드';
  if (!excludeReason && isSajuSeed && OFF_TOPIC.test(display) && !hasSajuTopic) excludeReason = '기준 주제와 무관한 키워드';
  if (!excludeReason && isSajuSeed && BRAND_QUERY.test(key)) excludeReason = '경쟁 브랜드 검색어';
  const knownPerson = isSajuSeed && KNOWN_PERSON_NAMES.find((name) => key.includes(keywordKey(name)));
  if (!excludeReason && isSajuSeed && (knownPerson || (CELEBRITY_QUERY.test(display) && !seedNormalized.includes('연예인')))) {
    excludeReason = '연예인·인물 검색어';
  }
  if (knownPerson || (isSajuSeed && CELEBRITY_QUERY.test(display))) reviewNote = '인물·연예인 검색어';
  if (!reviewNote && /도우미|사주24|사주의신|플랫폼/.test(key)) reviewNote = '서비스명/브랜드일 수 있음';
  if (!excludeReason && isSajuSeed && REGIONS.test(display) && PLACE_OR_SERVICE.test(display) && !hasSajuTopic) excludeReason = '지역 업체 검색어만 포함';
  const allowedSajuAdjacent = hasSajuAnchor && !hasSeed && hasSajuTopic;
  if (!excludeReason && seedNormalized && !hasSeed && !allowedSajuAdjacent) {
    excludeReason = '기준 키워드와 직접 연결되지 않은 검색어';
  }
  if (!excludeReason) {
    const years = [...display.matchAll(OLD_YEAR)].map((m) => Number(m[0]));
    if (years.some((candidateYear) => candidateYear < year)) excludeReason = '오래된 연도 검색어';
  }

  if (!intents.length) intents.push('일반 탐색');
  return {
    category,
    intents,
    relation,
    excluded: !!excludeReason,
    excludeReason: excludeReason || null,
    reviewNote: reviewNote || null,
  };
}

function normalizedMetric(value) {
  return metricValue(value);
}

function mergeKeywordCandidates(seed, importedRows = [], autocompleteKeywords = []) {
  const rows = new Map();
  const add = (raw, source) => {
    const keyword = cleanDisplay(raw && typeof raw === 'object' ? raw.keyword || raw.kw : raw);
    const key = keywordKey(keyword);
    if (!key) return;
    const rawPc = raw && typeof raw === 'object' ? raw.monthlyPc : null;
    const rawMobile = raw && typeof raw === 'object' ? raw.monthlyMobile : null;
    const monthlyPc = normalizedMetric(rawPc);
    const monthlyMobile = normalizedMetric(rawMobile);
    const existing = rows.get(key);
    if (existing) {
      if (typeof existing.monthlyPc !== 'number' && monthlyPc !== null) existing.monthlyPc = monthlyPc;
      if (typeof existing.monthlyMobile !== 'number' && monthlyMobile !== null) existing.monthlyMobile = monthlyMobile;
      if (!existing.sources.includes(source)) existing.sources.push(source);
      existing.monthlyTotal = (typeof existing.monthlyPc === 'number' && typeof existing.monthlyMobile === 'number')
        ? existing.monthlyPc + existing.monthlyMobile
        : null;
      return;
    }
    const classification = classifyKeyword(keyword, seed);
    rows.set(key, {
      keyword,
      keywordKey: key,
      monthlyPc,
      monthlyMobile,
      monthlyTotal: (typeof monthlyPc === 'number' && typeof monthlyMobile === 'number') ? monthlyPc + monthlyMobile : null,
      sources: [source],
      ...classification,
    });
  };

  for (const raw of Array.isArray(importedRows) ? importedRows : []) add(raw, 'search-ads-xlsx');
  for (const raw of Array.isArray(autocompleteKeywords) ? autocompleteKeywords : []) add(raw, 'naver-autocomplete');
  return [...rows.values()];
}

const RELATION_ORDER = { exact: 0, primary: 0, related: 1, broad: 2 };

function selectKeywordReportRows(candidates, { seed = '', count = 30, excludeTerms = [], currentYear } = {}) {
  const requestedCount = Number(count);
  if (![30, 50, 100].includes(requestedCount)) throw new Error('키워드 수는 30, 50, 100 중에서 선택해 주세요.');
  const excludeKeys = (Array.isArray(excludeTerms) ? excludeTerms : String(excludeTerms || '').split(/[,，\n]/))
    .map(keywordKey).filter(Boolean);
  const classify = (row) => {
    const key = keywordKey(row && row.keyword);
    const dynamic = classifyKeyword(row && row.keyword, seed, { currentYear });
    const manualMatch = excludeKeys.find((term) => key.includes(term));
    if (manualMatch) return { ...row, ...dynamic, excluded: true, excludeReason: `사용자 제외어: ${manualMatch}` };
    const monthlyPc = normalizedMetric(row && row.monthlyPc);
    const monthlyMobile = normalizedMetric(row && row.monthlyMobile);
    return {
      ...row,
      ...dynamic,
      keywordKey: key,
      monthlyPc,
      monthlyMobile,
      monthlyTotal: (typeof monthlyPc === 'number' && typeof monthlyMobile === 'number') ? monthlyPc + monthlyMobile : null,
    };
  };
  const classified = (Array.isArray(candidates) ? candidates : []).map(classify);
  const unique = new Map();
  for (const row of classified) {
    if (!row.keywordKey || row.excluded || unique.has(row.keywordKey)) continue;
    unique.set(row.keywordKey, row);
  }
  const relationRank = (relation) => (Object.prototype.hasOwnProperty.call(RELATION_ORDER, relation) ? RELATION_ORDER[relation] : 1);
  const totalRank = (row) => (typeof row.monthlyTotal === 'number' ? row.monthlyTotal : -1);
  const eligible = [...unique.values()].sort((a, b) =>
    relationRank(a.relation) - relationRank(b.relation)
    || totalRank(b) - totalRank(a));
  const selected = eligible.slice(0, requestedCount);
  return {
    rows: selected,
    requestedCount,
    selectedCount: selected.length,
    availableCount: eligible.length,
    shortfall: Math.max(0, requestedCount - selected.length),
    excludedCount: classified.filter((row) => row.excluded).length,
  };
}

async function readSearchAdsWorkbook(filePath, { importedAt = new Date().toISOString(), sourceFileName } = {}) {
  if (!filePath) throw new Error('검색광고 엑셀 파일을 선택해 주세요.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(String(filePath));
  let lastParseError;
  for (const sheet of workbook.worksheets) {
    const rawRows = [];
    sheet.eachRow({ includeEmpty: true }, (row) => rawRows.push(row.values.slice(1)));
    if (!rawRows.length) continue;
    try {
      return {
        ...parseSearchAdsRows(rawRows, {
          sourceFileName: sourceFileName || path.basename(String(filePath)),
          importedAt,
        }),
        sourceSheetName: sheet.name,
      };
    } catch (error) {
      lastParseError = error;
    }
  }
  throw lastParseError || new Error('검색광고 엑셀에서 읽을 수 있는 시트를 찾지 못했습니다.');
}

function metricForExport(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^<\s*10$/.test(value.trim())) return '<10';
  return null;
}

function sourceLabel(sources) {
  const labels = {
    'search-ads-xlsx': '네이버 검색광고 엑셀',
    'naver-autocomplete': '네이버 자동완성',
  };
  const values = (Array.isArray(sources) ? sources : []).map((source) => labels[source] || String(source));
  return [...new Set(values)].join(', ');
}

function importedDateInSeoul(value) {
  if (!value) return '기록 없음';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '기록 없음';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

async function buildKeywordReportWorkbook(rows, metadata = {}) {
  if (!Array.isArray(rows)) throw new Error('내보낼 키워드 행이 올바르지 않습니다.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'blog-auto';
  workbook.subject = '네이버 키워드 월간 검색량과 관련 주제';
  workbook.title = `${cleanDisplay(metadata.seed) || '키워드'} 키워드 조사 결과`;
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('연관 키워드', { views: [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }] });
  sheet.columns = [
    { header: '키워드', key: 'keyword', width: 30 },
    { header: '월간 검색수 (PC)', key: 'monthlyPc', width: 19 },
    { header: '월간 검색수 (모바일)', key: 'monthlyMobile', width: 21 },
    { header: '월간 검색 합계', key: 'monthlyTotal', width: 19 },
    { header: '분류', key: 'category', width: 20 },
    { header: '검색 의도', key: 'intents', width: 32 },
    { header: '원본', key: 'sources', width: 34 },
    { header: '검토 메모', key: 'reviewNote', width: 32 },
  ];
  sheet.getRow(1).height = 25;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B6EF2' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  for (const raw of rows) {
    const monthlyPc = metricForExport(raw && raw.monthlyPc);
    const monthlyMobile = metricForExport(raw && raw.monthlyMobile);
    const monthlyTotal = (typeof monthlyPc === 'number' && typeof monthlyMobile === 'number')
      ? monthlyPc + monthlyMobile
      : null;
    sheet.addRow({
      keyword: cleanDisplay(raw && raw.keyword),
      monthlyPc,
      monthlyMobile,
      monthlyTotal,
      category: cleanDisplay(raw && raw.category),
      intents: Array.isArray(raw && raw.intents) && raw.intents.length ? raw.intents.join(', ') : '일반 탐색',
      sources: sourceLabel(raw && raw.sources),
      reviewNote: cleanDisplay(raw && raw.reviewNote),
    });
  }
  for (const column of ['monthlyPc', 'monthlyMobile', 'monthlyTotal']) sheet.getColumn(column).numFmt = '#,##0';
  sheet.autoFilter = { from: 'A1', to: `H${Math.max(1, rows.length + 1)}` };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true };
  });

  const guide = workbook.addWorksheet('안내', { views: [{ state: 'frozen', ySplit: 0 }] });
  guide.columns = [{ width: 25 }, { width: 100 }];
  const importedAt = cleanDisplay(metadata.importedAt);
  const periodNote = cleanDisplay(metadata.periodLabel)
    || '원본의 월간 검색량 기준이며, 집계 시작일과 종료일은 원본 파일에 표시되지 않았습니다.';
  guide.addRows([
    ['기준 키워드', cleanDisplay(metadata.seed)],
    ['요청 키워드 수', Number(metadata.requestedCount) || rows.length],
    ['선정 키워드 수', rows.length],
    ['검색량 출처', metadata.sourceFileName ? '네이버 검색광고 키워드 도구에서 가져온 파일' : '검색광고 엑셀 미가져옴 (검색량 미제공)'],
    ['가져온 날짜', importedDateInSeoul(importedAt)],
    ['가져온 파일', cleanDisplay(metadata.sourceFileName) || '없음'],
    ['검색량 기준 기간', periodNote],
    ['자동완성 후보', metadata.autocompleteEnabled ? '네이버 자동완성 후보 포함 (검색량은 제공하지 않음)' : '미포함'],
    ['후보 수', Number(metadata.availableCount) || 0],
    ['선정 부족 수', Number(metadata.shortfall) || 0],
    ['검색량 집계 안내', 'PC와 모바일이 모두 숫자일 때만 합계를 계산했습니다. <10은 원본 그대로 보존했으며 합계는 제공하지 않습니다. 빈칸은 검색량 데이터가 없음을 뜻합니다.'],
    ['분류 안내', '분류와 검색 의도는 키워드 문구를 바탕으로 한 편집용 규칙 추정입니다. 네이버 공식 분류나 자연 검색 순위·성과 예측이 아닙니다.'],
    ['선별 기준', '기준 키워드와 가까운 관련 주제를 먼저 배치하고, 같은 관련도 안에서는 숫자로 확인된 월간 검색 합계가 높은 순서로 정렬했습니다.'],
    ['제외어', (Array.isArray(metadata.excludeTerms) ? metadata.excludeTerms : []).map(cleanDisplay).filter(Boolean).join(', ') || '없음'],
  ]);
  guide.getColumn(1).font = { bold: true };
  guide.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });
  return workbook.xlsx.writeBuffer();
}

module.exports = {
  parseSearchAdsRows,
  classifyKeyword,
  mergeKeywordCandidates,
  selectKeywordReportRows,
  readSearchAdsWorkbook,
  buildKeywordReportWorkbook,
};
