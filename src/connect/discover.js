'use strict';

function candidateLines(text, max = 30) {
  return String(text || '').split(/[\r\n]+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length >= 5 && line.length <= 180 && !/로그인|회원가입|고객센터|네이버\s*페이/.test(line)).slice(0, max);
}
function parseDiscoveryResponse(text) {
  try {
    const clean = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let value; try { value = JSON.parse(clean); } catch (_) { const start = clean.indexOf('{'); const end = clean.lastIndexOf('}'); if (start < 0 || end <= start) throw _; value = JSON.parse(clean.slice(start, end + 1)); }
    const cleanItems = (items) => (Array.isArray(items) ? items : []).slice(0, 3).map((x) => ({ name: String(x.name || '').slice(0, 120), price: String(x.price || '').slice(0, 40), why: String(x.why || '').slice(0, 30), keyword: String(x.keyword || '').slice(0, 80) })).filter((x) => x.name);
    return { travel: cleanItems(value.travel), shopping: cleanItems(value.shopping) };
  } catch (_) { return { travel: [], shopping: [] }; }
}
module.exports = { candidateLines, parseDiscoveryResponse };
