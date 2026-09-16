// 키워드 롱테일 확장 — 네이버 자동완성(공개 엔드포인트) 기반.
//
// ★배포 안전: 인증/개발자키/로그인 전부 불필요(공개 HTTP). Node 기본 모듈만 사용.
//   엔드포인트: ac.search.naver.com/nx/ac (검색창 자동완성과 동일)
//
// 용도: 씨앗 키워드 → 사람들이 실제로 검색하는 세부(롱테일) 키워드 대량 수집.
//   여기서 나온 후보를 radar.js가 "빈틈(문서수)"로 점수 매겨 선점 키워드를 고른다.

const https = require('https');

/** 자동완성 1회 호출 → 롱테일 후보 배열 반환. */
function fetchAutocomplete(query) {
  return new Promise((resolve) => {
    const url =
      'https://ac.search.naver.com/nx/ac?q=' +
      encodeURIComponent(query) +
      '&st=100&r_format=json&r_enc=UTF-8&frm=nv&ans=2';
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const items = (data.items && data.items[0]) || [];
            const flat = (x) =>
              typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(flat) : [];
            const kws = [];
            for (const it of items) {
              const s = flat(it);
              if (s[0]) kws.push(s[0].trim());
            }
            resolve(kws);
          } catch {
            resolve([]); // 파싱 실패해도 파이프라인은 계속
          }
        });
      },
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 씨앗 키워드들을 롱테일로 확장한다.
 * @param {string[]} seeds        - 씨앗 키워드(1개 이상)
 * @param {object}   [opts]
 * @param {number}   [opts.rounds=2]     - 확장 라운드(2면 씨앗→1차→2차)
 * @param {string[]} [opts.modifiers=[]] - 붙여볼 수식어(검색용 액션 인텐트 등: 신청/조회/비교…)
 * @param {number}   [opts.maxCandidates=120] - 최대 후보 수(과도한 호출 방지)
 * @param {number}   [opts.delayMs=120] - 호출 간 간격(예의상 딜레이)
 * @returns {Promise<string[]>} 중복 제거된 롱테일 키워드 목록
 */
async function expandKeywords(
  seeds,
  { rounds = 2, modifiers = [], maxCandidates = 120, delayMs = 120 } = {},
) {
  const seen = new Set();
  const result = [];
  const add = (kw) => {
    const k = (kw || '').trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      result.push(k);
    }
  };

  // 확장 큐: 씨앗 + (씨앗 + 수식어) 조합을 시드로.
  let frontier = [];
  for (const s of seeds) {
    add(s);
    frontier.push(s);
    for (const m of modifiers) frontier.push(`${s} ${m}`);
  }

  for (let r = 0; r < rounds && result.length < maxCandidates; r++) {
    const next = [];
    for (const q of frontier) {
      if (result.length >= maxCandidates) break;
      const kws = await fetchAutocomplete(q);
      await sleep(delayMs);
      for (const kw of kws) {
        const before = seen.size;
        add(kw);
        if (seen.size > before) next.push(kw); // 새로 나온 것만 다음 라운드로
      }
    }
    frontier = next;
  }

  return result.slice(0, maxCandidates);
}

module.exports = { expandKeywords, fetchAutocomplete };
