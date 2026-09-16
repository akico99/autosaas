// 텍스트카드 썸네일 생성기 (1:1 정사각).
//
// 사용자 규칙:
//  - 대표 썸네일은 반드시 1:1(1080×1080).
//  - 배경색·글씨색(+강조색)만 지정하면 개별 맞춤 카드가 된다(풀 커스텀 아님).
//  - 글자는 최대 3줄.
//  - 글씨체 4종 중 선택: 깔끔(pretendard) / 둥근(round) / 귀여운(cute) / 임팩트(impact).
//
// 출력은 SVG 문자열. 실제 네이버 업로드용 PNG로는 이후 래스터화한다(폰트 임베드 필요).

// 글씨체 4종. family는 웹폰트(구글폰트/jsdelivr)에서 로드되는 이름.
// 글씨체. src는 렌더/래스터화 시 폰트를 어떻게 로드하는지(임베드용 메타).
const FONTS = {
  pretendard: {
    label: '깔끔(프리텐다드)',
    family: "'Pretendard','Noto Sans KR',sans-serif",
    weight: 700,
    w: { ko: 0.864, en: 0.615, sp: 0.23 }, // 실측 글자폭 비율(em): 한글/영숫자/공백
    src: { type: 'cdn', css: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css' },
  },
  round: {
    label: '둥근',
    family: "'Jua',sans-serif",
    weight: 400,
    w: { ko: 0.828, en: 0.576, sp: 0.3 },
    src: { type: 'google', spec: 'Jua' },
  },
  cute: {
    label: '귀여운(밑미)',
    family: "'MitmiFont',cursive",
    weight: 400,
    w: { ko: 0.661, en: 0.363, sp: 0.3 },
    src: { type: 'url', woff2: 'https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_2402_1@1.0/Ownglyph_meetme-Rg.woff2' },
  },
  konkon: {
    label: '콘콘체',
    family: "'OngleipKonkon',cursive",
    weight: 400,
    w: { ko: 0.76, en: 0.495, sp: 0.3 },
    src: { type: 'url', woff2: 'https://cdn.jsdelivr.net/gh/projectnoonnu/2412-1@1.0/Ownglyph_corncorn-Rg.woff2' },
  },
  clipart: {
    // 클립아트코리아 Bold. jsdelivr 웹폰트(로컬 파일 없이 로드) — 미리보기·웹 렌더 편함.
    // 로컬 .otf(assets/fonts/)는 PNG 래스터화 임베드용으로 보관.
    label: '클립아트코리아',
    family: "'ClipArtKorea',sans-serif",
    weight: 700,
    w: { ko: 0.983, en: 0.611, sp: 0.26 },
    src: { type: 'url', woff2: 'https://cdn.jsdelivr.net/gh/projectnoonnu/2511-2@1.0/Clipartkorea-Bold.woff2' },
    localFile: 'assets/fonts/Clipartkorea-Bold.otf',
  },
  slim: {
    // 카페24 프로 슬림(Regular 400) — 얇고 깔끔. KBL(너무 두꺼움) 대체. jsdelivr 웹폰트.
    label: '슬림(카페24)',
    family: "'Cafe24ProSlim',sans-serif",
    weight: 400,
    w: { ko: 0.7, en: 0.517, sp: 0.2 },
    src: { type: 'url', woff2: 'https://cdn.jsdelivr.net/gh/projectnoonnu/2511-1@1.0/Cafe24PROSlim-Regular.woff2' },
  },
};

// 주어진 글씨체를 브라우저/래스터화에서 로드하는 @font-face 또는 @import CSS를 만든다.
// baseUrl: 로컬 폰트 파일을 가리킬 접두사(예: '' 이면 상대경로, 'file://...' 등).
function fontFaceCss(fontKey, baseUrl = '') {
  const f = FONTS[fontKey];
  if (!f) return '';
  const s = f.src || {};
  if (s.type === 'cdn') return `@import url("${s.css}");`;
  if (s.type === 'google') return `@import url("https://fonts.googleapis.com/css2?family=${s.spec.replace(/ /g, '+')}&display=swap");`;
  if (s.type === 'url') {
    const fam = f.family.split(',')[0].replace(/'/g, '');
    return `@font-face{font-family:'${fam}';src:url('${s.woff2}') format('woff2');font-display:swap;}`;
  }
  if (s.type === 'local') {
    const fam = f.family.split(',')[0].replace(/'/g, '');
    return `@font-face{font-family:'${fam}';src:url('${baseUrl}${s.file}') format('opentype');font-display:swap;}`;
  }
  return '';
}

// 색 기본값(지정 안 하면 이 값). 지정하면 그 색으로 맞춤.
const DEFAULTS = {
  bgColor: '#0E1626', // 배경색
  textColor: '#FFFFFF', // 글씨색
  highlightColor: '#F5C24B', // 강조색(숫자·핵심어)
  font: 'pretendard',
  fontScale: 1, // 글씨 크기 배율(1=자동, 1.2=20% 크게). 사용자 조절용.
  highlight: [], // 강조할 단어(토큰) 목록. 비우면 자동(아래 옵션).
  autoHighlightDigits: true, // 숫자 포함 단어 자동 강조. 사용자가 직접 고르면 false.
  highlightStyle: 'color', // 'color'=글씨색만 / 'bar'=단어 뒤에 자막바(색 박스) 깔기.
  subText: '', // 큰 글씨 아래 작은 서브 문구(블로그 이름·부제 등). 비우면 없음.
  subFont: null, // 서브 문구 글씨체(키). null이면 큰 글씨와 동일.
  subTextColor: null, // 서브 문구 색. null이면 큰 글씨색과 동일.
  bgImage: null, // 배경 사진(data URL 또는 경로). 있으면 꽉 채워 깔고 어둡게 덮음.
  bgDim: 0.42, // 배경 사진 위 어둡게 덮는 정도(0~1). 글씨 가독성용.
  letterSpacing: -0.04, // 자간(em). 음수면 글자 사이 좁아짐. 전체 텍스트에 적용.
  maxLines: 3,
  size: 1080,
};

// 색 조합(팔레트). 사용자가 palette 키로 고름.
// 방향(사용자 결정): 어두운 배경은 블랙 하나만, 나머지는 은은한 "종이 톤"(크림·아이보리·
// 오트밀·세이지·더스티블루 등) — 어두운색끼리 비슷해지는 문제 해결. 글씨는 어두운색, 강조는 포인트색.
const PALETTES = {
  black: { label: '블랙·노랑', bgColor: '#141414', textColor: '#FFFFFF', highlightColor: '#FFD84D' },
  paperNavy: { label: '종이·남색금', bgColor: '#ECE9E1', textColor: '#1B2A4A', highlightColor: '#C79A2E' },
  ivoryRed: { label: '아이보리·빨강', bgColor: '#F7F3E9', textColor: '#2B2A26', highlightColor: '#C0392B' },
  creamOrange: { label: '크림·오렌지', bgColor: '#F4EDE0', textColor: '#3A2E1F', highlightColor: '#E8590C' },
  oatBlue: { label: '오트밀·블루', bgColor: '#EAE7DB', textColor: '#2A2F36', highlightColor: '#1E6FE0' },
  kraftBrown: { label: '크라프트·브라운', bgColor: '#E7D8BE', textColor: '#3D2F1B', highlightColor: '#9A4A1E' },
  sageGreen: { label: '세이지·그린', bgColor: '#E4EBDD', textColor: '#2E3A28', highlightColor: '#2F7D3A' },
  dustyBlue: { label: '더스티블루·남색', bgColor: '#E1E8EE', textColor: '#24303B', highlightColor: '#1C6DB0' },
  blushWine: { label: '블러시·와인', bgColor: '#F6E7E7', textColor: '#4A2A2A', highlightColor: '#B0304A' },
  lavender: { label: '라벤더·퍼플', bgColor: '#EAE6F2', textColor: '#322A48', highlightColor: '#6C4AB6' },
  mistGray: { label: '미스트그레이·오렌지', bgColor: '#EAEAE6', textColor: '#2C2C2A', highlightColor: '#E8590C' },
  sandRust: { label: '샌드·러스트', bgColor: '#EFE3D2', textColor: '#3A2C1C', highlightColor: '#C1440E' },
  mintTeal: { label: '민트·틸', bgColor: '#E0EFE8', textColor: '#1F3A32', highlightColor: '#0CA678' },
  butterBlack: { label: '버터·블랙', bgColor: '#F5EBC8', textColor: '#34301F', highlightColor: '#1A1A1A' },
};

// palette 키 + 개별 색 지정을 합쳐 최종 색을 정한다(개별 지정이 팔레트보다 우선).
function resolveColors(opts) {
  const pal = PALETTES[opts.palette] || {};
  return {
    bgColor: opts.bgColor || pal.bgColor || DEFAULTS.bgColor,
    textColor: opts.textColor || pal.textColor || DEFAULTS.textColor,
    highlightColor: opts.highlightColor || pal.highlightColor || DEFAULTS.highlightColor,
  };
}

function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 텍스트를 단어 경계에서 최대 maxLines줄로 "고르게" 나눈다(길이 균형).
// 모델이 줄을 안 나눠줬을 때만 쓰는 폴백.
function balancedWrap(text, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [text];
  const total = text.length;
  const wantLines = Math.min(maxLines, Math.max(1, Math.round(total / 9)));
  if (wantLines <= 1) return [text];
  const target = total / wantLines;
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length >= target && lines.length < wantLines - 1) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// 줄 나누기: 모델이 \n으로 끊어준 "자연스러운 어절 단위"를 최우선 존중한다.
//  - 2~maxLines줄이면 그대로 사용(가장 보기 좋음)
//  - 한 줄만 왔으면 균형 분할(폴백)
//  - maxLines보다 많으면 전체를 균형 분할해 맞춤
function splitLines(thumbnailText, maxLines) {
  const segs = String(thumbnailText || '')
    .split(/\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (segs.length === 0) return [];
  if (segs.length > maxLines) return balancedWrap(segs.join(' '), maxLines);
  if (segs.length === 1) return balancedWrap(segs[0], maxLines);
  return segs; // 모델이 나눈 자연스러운 줄 그대로
}

// 한 줄을 하이라이트 tspan으로 쪼갬.
//  - highlightWords: 강조할 단어(토큰) 목록. 정확히 일치하는 토큰을 강조색으로.
//  - autoDigits: true면 숫자 포함 토큰도 자동 강조(사용자가 직접 고르면 false로 끔).
function renderLineTspans(line, highlightWords, highlightColor, autoDigits) {
  const hw = highlightWords || [];
  return line
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok)) return escXml(tok);
      const isHi = hw.indexOf(tok) !== -1 || (autoDigits && /\d/.test(tok));
      return isHi
        ? `<tspan fill="${escXml(highlightColor)}" font-weight="800">${escXml(tok)}</tspan>`
        : escXml(tok);
    })
    .join('');
}

const DEFAULT_W = { ko: 0.9, en: 0.56, sp: 0.3 };

// 글자 하나의 폭. 폰트별 실측 비율(w)을 곱한다(자막바 위치·크기 계산용).
function charWidth(ch, fs, w) {
  const r = w || DEFAULT_W;
  if (ch === ' ') return fs * r.sp;
  return ch.charCodeAt(0) < 128 ? fs * r.en : fs * r.ko;
}

// 한 줄의 폭을 em(글씨크기=1 기준) 단위로. 폰트별 실측 비율 + 자간 반영 → 크기 자동맞춤에 사용.
function lineEmWidth(line, w, lsEm) {
  const r = w || DEFAULT_W;
  let em = 0;
  for (const ch of line) {
    em += ch === ' ' ? r.sp : ch.charCodeAt(0) < 128 ? r.en : r.ko;
  }
  em += Math.max(0, line.length - 1) * (lsEm || 0); // 자간
  return em;
}

// 배경색(강조색) 위에 얹을 글씨색: 밝으면 검정, 어두우면 흰색.
function contrastColor(hex) {
  const c = String(hex).replace('#', '');
  if (c.length < 6) return '#FFFFFF';
  const r = parseInt(c.substr(0, 2), 16);
  const g = parseInt(c.substr(2, 2), 16);
  const b = parseInt(c.substr(4, 2), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#141414' : '#FFFFFF';
}

// 연속된 강조 토큰(사이 공백 포함)을 하나의 구간으로 병합한다.
// 예: "이렇게 될"이 둘 다 강조면 두 개가 아니라 하나의 자막바로.
function highlightRuns(list) {
  const runs = [];
  let start = null;
  let end = null;
  for (const s of list) {
    if (s.hl) {
      if (start === null) start = s.x;
      end = s.x + s.w;
    } else if (/^\s+$/.test(s.text)) {
      // 공백은 그냥 통과(뒤에 강조 토큰이 이어지면 자연히 병합됨)
    } else {
      if (start !== null) {
        runs.push([start, end]);
        start = null;
      }
    }
  }
  if (start !== null) runs.push([start, end]);
  return runs;
}

// 한 줄을 토큰(공백 포함) 단위로 나누고 각 토큰의 x위치·폭·강조여부를 추정한다(자막바 배치용).
function measureSegs(line, fs, isHi, wr, lsPx) {
  const ls = lsPx || 0;
  const parts = line.split(/(\s+)/).filter((p) => p !== '');
  let x = 0;
  const list = [];
  for (const p of parts) {
    let w = 0;
    for (const ch of p) w += charWidth(ch, fs, wr);
    w += Math.max(0, p.length - 1) * ls; // 토큰 내부 자간
    const hl = /^\s+$/.test(p) ? false : isHi(p);
    list.push({ text: p, hl, x, w });
    x += w + ls; // 토큰 사이 자간
  }
  return { list, width: x - ls };
}

/**
 * 텍스트카드 썸네일 SVG를 만든다.
 * @param {object} opts
 * @param {string} opts.thumbnailText - 카드 문구
 * @param {string[]} [opts.highlight] - 강조할 단어(없으면 숫자 자동 강조)
 * @param {string} [opts.bgColor]     - 배경색 (기본 남색)
 * @param {string} [opts.textColor]   - 글씨색 (기본 흰색)
 * @param {string} [opts.highlightColor] - 강조색 (기본 금색)
 * @param {'pretendard'|'round'|'cute'|'impact'} [opts.font] - 글씨체 (기본 pretendard)
 * @param {string} [opts.watermark]   - 우하단 워터마크
 * @param {number} [opts.size]        - 한 변 px (기본 1080)
 * @returns {string} SVG
 */
function makeThumbnailSvg(opts = {}) {
  const o = { ...DEFAULTS, ...opts, ...resolveColors(opts) };
  const font = FONTS[o.font] || FONTS.pretendard;

  const lines = splitLines(o.thumbnailText, o.maxLines);
  const n = Math.max(lines.length, 1);
  const fw = font.w || DEFAULT_W; // 이 폰트의 실측 글자폭 비율

  // 글씨 크기 = "가장 긴 줄이 카드 폭에 꽉 차도록" 자동 계산(폰트별 실측폭 기준).
  // 폰트크기 ≈ 사용가능폭 / 가장 긴 줄의 em폭. 콘덴스드는 더 크게, 넓은 폰트는 더 작게 나옴.
  const margin = 64;
  const avail = o.size - margin * 2;
  const MAX_FONT = Math.round(o.size * 0.16); // 한 변의 16%까지(너무 커지는 것 방지)
  const MIN_FONT = 44;
  const lsEm = o.letterSpacing || 0;
  const maxEm = lines.reduce((m, l) => Math.max(m, lineEmWidth(l, fw, lsEm)), 0.5);
  let fontSize = Math.floor((avail / maxEm) * 0.98);
  fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, fontSize));
  // 사용자 글씨 크기 조절(배율). 위로는 한 변의 26%까지 허용(넘치면 미리보기로 보고 조절).
  fontSize = Math.round(fontSize * (o.fontScale || 1));
  fontSize = Math.max(MIN_FONT, Math.min(Math.round(o.size * 0.26), fontSize));
  const lsPx = Math.round(fontSize * lsEm); // 자간(px)

  // 세로 정렬(라인박스 기반) — 글씨 크기가 커져도 전체가 항상 정중앙에 오게 계산한다.
  // 각 줄을 lineHeight 높이의 박스로 보고, 큰글씨+서브를 합친 블록을 카드 정중앙에 놓는다.
  const lineHeight = Math.round(fontSize * 1.3);
  const subText = (o.subText || '').trim();
  const subFontSize = Math.round(o.size * 0.045); // 약 49px
  const subLineH = subText ? Math.round(subFontSize * 1.3) : 0;
  const subGap = subText ? Math.round(fontSize * 0.35) : 0;

  const blockH = lineHeight * n + subGap + subLineH; // 전체 글씨 블록 높이
  const top = Math.round(o.size / 2 - blockH / 2); // 블록 상단(정중앙 기준)
  const baseOffset = Math.round(fontSize * 0.98); // 라인박스 상단 → 베이스라인
  const pad = 96;

  const hw = o.highlight || [];
  const isHi = (tok) =>
    hw.indexOf(tok) !== -1 || (o.autoHighlightDigits && /\d/.test(tok));
  const barMode = o.highlightStyle === 'bar';
  const barText = contrastColor(o.highlightColor); // 자막바 위 글씨색

  const textEls = lines
    .map((line, i) => {
      const y = top + baseOffset + i * lineHeight;
      if (!barMode) {
        return `  <text x="${o.size / 2}" y="${y}" text-anchor="middle" font-family="${font.family}" font-size="${fontSize}" font-weight="${font.weight}" letter-spacing="${lsPx}" fill="${escXml(o.textColor)}">${renderLineTspans(line, o.highlight, o.highlightColor, o.autoHighlightDigits)}</text>`;
      }
      // 자막바 모드: 강조 구간 뒤에 각진 색 박스를 깔고, 글씨를 대비색으로.
      // 붙어있는 강조 단어(사이 공백 포함)는 하나의 바로 병합. 모서리는 각짐(rx 없음).
      const segs = measureSegs(line, fontSize, isHi, fw, lsPx);
      const x0 = o.size / 2 - segs.width / 2;
      const padX = Math.round(fontSize * 0.16);
      const barH = Math.round(fontSize * 1.16);
      const barTop = y - Math.round(fontSize * 0.9);
      const bars = highlightRuns(segs.list)
        .map(
          ([a, b]) =>
            `  <rect x="${Math.round(x0 + a - padX)}" y="${barTop}" width="${Math.round(b - a + 2 * padX)}" height="${barH}" fill="${escXml(o.highlightColor)}"/>`,
        )
        .join('\n');
      const tsp = segs.list
        .map(
          (s) =>
            `<tspan x="${Math.round(x0 + s.x)}" fill="${s.hl ? barText : escXml(o.textColor)}">${escXml(s.text)}</tspan>`,
        )
        .join('');
      const textEl = `  <text y="${y}" text-anchor="start" font-family="${font.family}" font-size="${fontSize}" font-weight="${font.weight}" letter-spacing="${lsPx}">${tsp}</text>`;
      return bars + '\n' + textEl;
    })
    .join('\n');

  // 서브 문구: 큰 글씨 블록 아래, 가운데, 작게. 글씨체·색 따로 지정 가능.
  const subFont = FONTS[o.subFont] || font;
  const subColor = o.subTextColor || o.textColor;
  const subLsPx = Math.round(subFontSize * lsEm);
  const subEl = subText
    ? `  <text x="${o.size / 2}" y="${top + lineHeight * n + subGap + Math.round(subFontSize * 0.98)}" text-anchor="middle" font-family="${subFont.family}" font-size="${subFontSize}" font-weight="400" letter-spacing="${subLsPx}" fill="${escXml(subColor)}">${escXml(subText)}</text>`
    : '';

  const wm = o.watermark
    ? `  <text x="${o.size - pad}" y="${o.size - 64}" text-anchor="end" font-family="sans-serif" font-size="30" fill="${escXml(o.textColor)}" opacity="0.5">ⓒ ${escXml(o.watermark)}</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${o.size}" height="${o.size}" viewBox="0 0 ${o.size} ${o.size}">`,
    `  <rect width="${o.size}" height="${o.size}" fill="${escXml(o.bgColor)}"/>`,
    // ★배경 사진(bgImage=data URL 또는 경로)이 있으면 꽉 채워 깔고, 글씨 가독성을 위해 어둡게 덮는다.
    o.bgImage ? `  <image href="${escXml(o.bgImage)}" x="0" y="0" width="${o.size}" height="${o.size}" preserveAspectRatio="xMidYMid slice"/>` : '',
    o.bgImage ? `  <rect width="${o.size}" height="${o.size}" fill="rgba(0,0,0,${o.bgDim == null ? 0.42 : o.bgDim})"/>` : '',
    `  <rect x="${pad}" y="${Math.round(o.size * 0.16)}" width="120" height="10" rx="5" fill="${escXml(o.highlightColor)}"/>`,
    textEls,
    subEl,
    wm,
    '</svg>',
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = { makeThumbnailSvg, splitLines, balancedWrap, FONTS, PALETTES, DEFAULTS, fontFaceCss };
