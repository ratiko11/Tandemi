// Finds real merges where git's own merge conflicts, and saves base / ours / theirs / what the humans committed, per file.
// usage: node extract.js <bare repo> <out.jsonl> [max merges to look at]
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const [repo, out, maxArg] = process.argv.slice(2);
const MAX = Number(maxArg || 4000);
const git = (args, opts = {}) => execFileSync('git', ['--git-dir', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'], ...opts });
const gitCode = (args) => { try { return { code: 0, out: git(args) }; } catch (e) { return { code: e.status, out: String(e.stdout || '') }; } };
const EXT = /\.(cs|js|mjs|cjs|ts|mts|cts|tsx|jsx|py|java|go|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;

// one cat-file process for all blob reads
const cat = spawn('git', ['--git-dir', repo, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = Buffer.alloc(0), waiting = [];
cat.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
function pump() {
  while (waiting.length) {
    const nl = buf.indexOf(10); if (nl < 0) return;
    const head = buf.slice(0, nl).toString();
    if (/ missing$/.test(head)) { buf = buf.slice(nl + 1); waiting.shift()(null); continue; }
    const size = Number(head.split(' ')[2]);
    if (buf.length < nl + 1 + size + 1) return;
    const body = buf.slice(nl + 1, nl + 1 + size); buf = buf.slice(nl + 2 + size);
    waiting.shift()(body);
  }
}
const blob = (rev, file) => new Promise((ok) => { waiting.push(ok); cat.stdin.write(`${rev}:${file}\n`); });

(async () => {
  const merges = git(['rev-list', '--merges', '--parents', '--all', '-n', String(MAX)]).trim().split('\n').filter(Boolean).map(l => l.split(' ')).filter(x => x.length === 3);
  const o = fs.createWriteStream(out);
  let looked = 0, conflicted = 0, cases = 0;
  for (const [m, p1, p2] of merges) {
    looked++;
    const r = gitCode(['merge-tree', '--write-tree', '--name-only', '--no-messages', p1, p2]);
    if (r.code !== 1) continue; // 0 = git merges it cleanly
    const files = r.out.trim().split('\n').slice(1).filter(Boolean);
    if (!files.length) continue;
    conflicted++;
    const base = (gitCode(['merge-base', p1, p2]).out.trim().split('\n')[0]) || null;
    if (!base) continue;
    for (const file of files) {
      const [B, A, Bv, H] = await Promise.all([blob(base, file), blob(p1, file), blob(p2, file), blob(m, file)]);
      if (!B || !A || !Bv || !H) continue; // added/deleted/renamed: not a three-way content merge
      if ([B, A, Bv, H].some(x => x.length > 400000 || x.includes(0))) continue; // big or binary
      o.write(JSON.stringify({ repo: repo.split('/').pop().replace(/\.git$/, ''), merge: m, p1, p2, base, file, code: EXT.test(file), base_: B.toString('utf8'), a: A.toString('utf8'), b: Bv.toString('utf8'), human: H.toString('utf8') }) + '\n');
      cases++;
    }
  }
  o.end(); cat.stdin.end();
  console.log(JSON.stringify({ repo, looked, conflicted, cases }));
})();
