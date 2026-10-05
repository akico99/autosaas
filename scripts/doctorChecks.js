'use strict';

async function runChecks(checks, {
  isSearchBlocked = () => false,
  healthSnapshot = () => ({}),
  getBlockState = () => ({ message: '' }),
  now = () => Date.now(),
} = {}) {
  const rows = [];
  for (const check of checks) {
    const startedAt = now();
    if (check.requiresSearchGuard && isSearchBlocked()) {
      const block = getBlockState();
      rows.push({ id: check.id, label: check.label, n: 0, state: 'BLOCKED', ms: now() - startedAt, err: block.message || '', sample: '', status: block.status || null, errorKind: block.kind || 'blocked' });
      continue;
    }
    let value = [], err = '', runError = null;
    try { value = await check.run(); } catch (error) { runError = error; err = error && error.message || String(error); }
    const health = healthSnapshot()[check.id] || {};
    const n = Array.isArray(value) ? value.length
      : value && Array.isArray(value.items) ? value.items.length
        : value && Array.isArray(value.sections) ? value.sections.length + (Array.isArray(value.topDocs) ? value.topDocs.length : 0) : 0;
    const isBlocked = !err && (health.blocked || value && value.blocked);
    const resultKind = health.resultKind || (err ? 'error' : n ? 'ok' : 'empty');
    const state = isBlocked ? 'BLOCKED'
      : resultKind === 'parser_mismatch' ? 'PARSER_MISMATCH'
        : err || health.errorKind || runError && runError.kind ? 'ERROR'
          : n === 0 ? 'EMPTY'
            : n < check.min ? 'WARN' : 'OK';
    const first = Array.isArray(value) ? value[0] : null;
    const sample = !first ? '' : String(typeof first === 'string' ? first : (first.title || first.keyword || JSON.stringify(first))).replace(/\s+/g, ' ').slice(0, 52);
    rows.push({
      id: check.id, label: check.label, n, state, ms: now() - startedAt,
      err: err || (health.errorKind && health.errorKind !== 'empty' ? health.errorKind : ''),
      sample,
      status: Number(health.status || (runError && runError.status)) || null,
      errorKind: health.errorKind || runError && runError.kind || '',
      resultKind,
    });
  }
  return rows;
}

module.exports = { runChecks };
