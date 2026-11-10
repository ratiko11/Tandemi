// Runs Tandemi's merge on every real conflicting file and compares the result with what the humans committed.
// usage: node score.js <engine dir> <out.json> cases/*.jsonl
'use strict';
const fs = require('fs');
const path = require('path');
const [engine, out, ...inputs] = process.argv.slice(2);
const MERGE = require(path.join(engine, 'merge.js'));
const PER_MERGE = 20; // so one giant sync merge doesn't count more than many normal ones

const ws = (s) => String(s).replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
const tok = (s) => String(s).replace(/\s+/g, '');
const lines = (s) => String(s).replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
function diffCount(x, y) { // lines only in x, lines only in y (as multisets)
  const m = new Map(); for (const l of lines(x)) m.set(l, (m.get(l) || 0) + 1);
  let onlyY = 0; for (const l of lines(y)) { const c = m.get(l); if (c) m.set(l, c - 1); else onlyY++; }
  let onlyX = 0; for (const c of m.values()) onlyX += c; return [onlyX, onlyY];
}
function tandemi(file, base, a, b) {
  const n = (x) => String(x).replace(/\r\n/g, '\n');
  base = n(base); a = n(a); b = n(b);
  if (a === base) return { result: b, conflicts: 0, method: 'one side' };
  if (b === base) return { result: a, conflicts: 0, method: 'one side' };
  if (a === b) return { result: a, conflicts: 0, method: 'same' };
  const t0 = Date.now();
  const r = MERGE.merge(file, base, a, b);
  const ms = Date.now() - t0;
  if (r.conflicts.length) return { result: null, conflicts: r.conflicts.length, method: r.method, error: r.error, ms, labels: r.conflicts.map(c => c.label) };
  return { result: MERGE.fill(r.template, r.conflicts), conflicts: 0, method: r.method, error: r.error, ms };
}

(async () => {
  const cases = [];
  for (const f of inputs) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) cases.push(JSON.parse(l));
  const perMerge = new Map();
  const use = cases.filter(c => { const k = c.repo + c.merge; const n = (perMerge.get(k) || 0) + 1; perMerge.set(k, n); return n <= PER_MERGE; });
  await MERGE.prepare(use.map(c => c.file));
  const rows = [];
  for (const c of use) {
    let t; try { t = tandemi(c.file, c.base_, c.a, c.b); } catch (e) { t = { result: null, conflicts: -1, method: 'crash', error: e.message }; }
    const row = { repo: c.repo, merge: c.merge.slice(0, 10), file: c.file, code: c.code, method: t.method, error: t.error || null, conflicts: t.conflicts, ms: t.ms || 0, labels: t.labels };
    const humanTookA = ws(c.human) === ws(c.a), humanTookB = ws(c.human) === ws(c.b);
    row.humanTook = humanTookA ? 'A' : humanTookB ? 'B' : 'mix';
    if (t.result != null) {
      row.outcome = t.result === c.human.replace(/\r\n/g, '\n') ? 'same' : ws(t.result) === ws(c.human) ? 'same-ws' : tok(t.result) === tok(c.human) ? 'same-tokens' : 'different';
      if (row.outcome === 'different') { const [onlyT, onlyH] = diffCount(t.result, c.human); row.onlyTandemi = onlyT; row.onlyHuman = onlyH; }
    } else row.outcome = t.conflicts < 0 ? 'crash' : 'conflict';
    rows.push(row);
  }
  fs.writeFileSync(out, JSON.stringify(rows));
  const sum = (rs) => { const o = {}; for (const r of rs) o[r.outcome] = (o[r.outcome] || 0) + 1; return { n: rs.length, ...o }; };
  console.log('all     ', JSON.stringify(sum(rows)));
  console.log('code    ', JSON.stringify(sum(rows.filter(r => r.code))));
  console.log('ast     ', JSON.stringify(sum(rows.filter(r => r.method === 'ast'))));
  console.log('non-code', JSON.stringify(sum(rows.filter(r => !r.code))));
  for (const repo of [...new Set(rows.map(r => r.repo))]) console.log(repo.padEnd(20), JSON.stringify(sum(rows.filter(r => r.repo === repo && r.code))));
  const slow = rows.filter(r => r.ms > 2000); if (slow.length) console.log('slow (>2s):', slow.length, Math.max(...slow.map(r => r.ms)) + 'ms');
  const errs = rows.filter(r => r.error); if (errs.length) console.log('parse errors (fell back to lines):', errs.length);
})();
