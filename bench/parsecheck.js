// Safe check without running any project code: does each file Tandemi merged on its own still parse,
// compared with the humans' version of the same file? (Tandemi's own parsers; nothing is executed.)
// usage: node parsecheck.js <engine dir> <scored.json>
'use strict';
const fs = require('fs'), path = require('path');
const [engine, scored] = process.argv.slice(2);
const MERGE = require(path.join(engine, 'merge.js'));
const rows = JSON.parse(fs.readFileSync(scored)).filter(r => r.code && r.outcome !== 'conflict' && r.method === 'ast');
const cases = new Map();
for (const f of fs.readdirSync(path.join(__dirname, 'cases'))) for (const l of fs.readFileSync(path.join(__dirname, 'cases', f), 'utf8').split('\n')) if (l) { const c = JSON.parse(l); cases.set(c.repo + c.merge.slice(0, 10) + c.file, c); }
const parses = (file, text) => { const r = MERGE.astMerge(text, text, text, MERGE.langOf(file)); return !r.error; };
(async () => {
  await MERGE.prepare(rows.map(r => r.file));
  const tally = { checked: 0, bothParse: 0, tandemiBroken: 0, humanBroken: 0, bothBroken: 0 }; const broken = [];
  for (const r of rows) {
    const c = cases.get(r.repo + r.merge + r.file), n = (x) => x.replace(/\r\n/g, '\n');
    const m = MERGE.merge(c.file, n(c.base_), n(c.a), n(c.b)); const t = MERGE.fill(m.template, m.conflicts);
    const pt = parses(c.file, t), ph = parses(c.file, n(c.human));
    tally.checked++;
    if (pt && ph) tally.bothParse++; else if (!pt && ph) { tally.tandemiBroken++; broken.push(`${r.repo} ${r.merge} ${r.file} (${r.outcome})`); } else if (pt && !ph) tally.humanBroken++; else tally.bothBroken++;
  }
  console.log(JSON.stringify(tally)); if (broken.length) console.log('Tandemi broke the code in:\n  ' + broken.join('\n  '));
})();
