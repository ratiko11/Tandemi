// fast.js · shared speed-ups for the git engines (two developers and a whole team):
//  - readBlobs: read many files from git with ONE process (git cat-file --batch) instead of one process per file
//  - check cache: the result of a build/test of exactly the same code with the same tools is remembered on disk,
//    so merging the same branches again, checking pairs, or "works now" never rebuilds identical code
//  - KEEP: build output that survives between checks (incremental builds instead of full rebuilds)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
// the code of Tandemi itself that decides what a build or test result means: when it changes, results remembered
// by an older Tandemi are not used any more (they may have been read the wrong way)
const ENGINE = (() => { try { return sha1(['repo.js', 'team.js', 'fast.js', 'checks.js'].map(f => { try { return fs.readFileSync(path.join(__dirname, f)); } catch (e) { return ''; } }).join('\0')).slice(0, 12); } catch (e) { return 'x'; } })();

// ---------------------------------------------------------------- many blobs, one git process
// specs: ["<rev>:<path>", …] → Map(spec → Buffer | null when it doesn't exist)
function readBlobs(cwd, specs) {
  return new Promise((resolve) => {
    const out = new Map(); const list = [...new Set(specs)];
    if (!list.length) return resolve(out);
    const child = spawn('git', ['cat-file', '--batch'], { cwd, windowsHide: true });
    const chunks = []; let failed = false;
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', () => { failed = true; });
    child.on('close', () => {
      if (failed) { list.forEach(s => out.set(s, undefined)); return resolve(out); }
      const buf = Buffer.concat(chunks); let pos = 0;
      for (const spec of list) {
        const nl = buf.indexOf(10, pos); if (nl < 0) { out.set(spec, undefined); continue; }
        const head = buf.toString('utf8', pos, nl); pos = nl + 1;
        const m = head.match(/^[0-9a-f]+ (\w+) (\d+)$/);
        if (!m) { out.set(spec, null); continue; } // "missing" (deleted in that version) or "ambiguous"
        const size = +m[2]; out.set(spec, m[1] === 'blob' ? buf.subarray(pos, pos + size) : null); pos += size + 1;
      }
      resolve(out);
    });
    child.stdin.on('error', () => { /* git ended early */ });
    child.stdin.end(list.join('\n') + '\n');
  });
}

// ---------------------------------------------------------------- what a build keeps between checks
const KEEP = ['bin/', 'obj/', 'tandemi-check/', 'node_modules/', 'packages/', '.vs/', '__pycache__/'];
const cleanArgs = () => ['clean', '-fdq', ...KEEP.flatMap(p => ['-e', p])];

// ---------------------------------------------------------------- the tools on this computer (part of the cache key)
let toolsPrint = /^[0-9a-f]{12}$/.test(process.env.TANDEMI_TOOLS_PRINT || '') ? process.env.TANDEMI_TOOLS_PRINT : null; // a helper process gets it from its parent
// on Windows tools like tsc and mvn are .cmd files, which need the shell: give it one command line (no separate args)
function run(cmd, args, all) { return new Promise((r) => { const done = (e, o, er) => r(e ? '-' : all ? String(o || er).trim() : String(o || er).split('\n')[0].trim()); if (process.platform === 'win32') require('child_process').exec([cmd, ...args].join(' '), { windowsHide: true, timeout: 15000 }, done); else execFile(cmd, args, { windowsHide: true, timeout: 15000 }, done); }); }
async function tools(force) {
  if (toolsPrint && !force) return toolsPrint;
  // every tool whose version can change a result, and the .NET runtimes installed (a project for .NET 8 needs one that can run it)
  const v = await Promise.all([run('dotnet', ['--version']), run('dotnet', ['--list-runtimes'], true), run('g++', ['--version']), run('python', ['--version']), run('python3', ['--version']), run('javac', ['-version']), run('go', ['version']), run('tsc', ['--version']), run('mvn', ['-v'])]);
  toolsPrint = sha1(process.version + '|' + v.join('|')).slice(0, 12);
  return toolsPrint;
}

// ---------------------------------------------------------------- the check cache (on disk, small, newest kept)
let FILE = null, DB = null, saveTimer = null;
const MAX = 400;
function cacheInit(dataDir) { if (FILE) return; FILE = path.join(dataDir, 'check-cache.json'); }
function load() { if (DB) return DB; try { DB = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { DB = {}; } return DB; }
function save() { if (saveTimer) return; saveTimer = setTimeout(flush, 300); }
// write now (a short-lived process calls this before it exits, or its results would be lost)
function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } if (!DB || !FILE) return; try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(DB)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { /* not saved */ } } // whole or not at all: never a half-written file
// a run is worth remembering only if it says something about the code (not "dotnet is missing" or "stopped after 900 s")
// A result that is about this computer, not about the code: a missing or too old tool or runtime, no network for
// packages, no disk space, a file locked by another program. It is shown as a setup problem (nobody's bug) and
// never remembered, so it goes away by itself once the computer is fixed.
const SETUP_CODES = { NETSDK1045: 'The installed .NET SDK is too old for this project.', NETSDK1004: 'The project\'s packages were never restored.', MSB4236: 'The .NET SDK this project asks for is not installed.', MSB4019: 'A build file this project imports is missing from this computer.', NU1301: 'NuGet packages could not be downloaded (no internet, or the package source is unreachable).', MSB3027: 'A file is locked by another program (is the game or an IDE still running?).', MSB3021: 'A file is locked by another program (is the game or an IDE still running?).', NETSDK1005: 'The project\'s packages were restored for another target. Restore them again.' };
function setupOf(out, errors) {
  const o = String(out || '');
  let m = o.match(/framework '([^']+)', version '([^']+)'|Framework: ([\w.]+), version (\d[\w.-]*)|app-launch-failed|You must install or update \.NET/i);
  if (m) { const v = (m[2] || m[4] || (o.match(/version '?(\d+\.\d+)/i) || [])[1] || '').replace(/^(\d+\.\d+).*/, '$1'); return `This computer doesn't have the .NET ${v ? v + ' ' : ''}runtime this project needs, so it could not start. Install it from https://dotnet.microsoft.com/download${v ? '/dotnet/' + v : ''} and click Test again.`; }
  const codes = (errors || []).map(e => e.code).filter(Boolean);
  if (codes.length && codes.every(c => SETUP_CODES[c])) return `${SETUP_CODES[codes[0]]} That is the setup of this computer, not a bug in the code. Fix it and click Test again.`;
  if (/No space left on device|ENOSPC|There is not enough space on the disk/i.test(o)) return 'The disk is full, so the build could not finish. Free some space and click Test again.';
  if (/npm ERR! code (ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN)|getaddrinfo ENOTFOUND|dial tcp: lookup|Could not resolve host|Temporary failure in name resolution/i.test(o)) return 'Packages could not be downloaded (no internet, or the package server is unreachable). That is not a bug in the code. Check the connection and click Test again.';
  if (/No module named pytest/i.test(o)) return 'pytest is not installed on this computer, so the Python tests could not run. Install it with: python -m pip install pytest';
  if (/error: (invalid source release|release version \d+ not supported)|invalid target release/i.test(o)) return 'The installed Java is older than this project needs. Install a newer JDK and click Test again.';
  if (/go: go\.mod requires go >= |requires go >= /i.test(o)) return 'The installed Go is older than this project needs. Install a newer Go and click Test again.';
  if (/is being used by another process|EBUSY: resource busy/i.test(o)) return 'A file is locked by another program (is the app or an IDE still running?). Close it and click Test again.';
  return null;
}
function cacheable(run) {
  if (!run) return false;
  if (run.setup) return false;
  if (/\[Tandemi\] Stopped after/.test(run.output || '')) return false;
  if (run.build && run.build.errors && run.build.errors.some(e => e.code === 'build')) return false;
  if ((run.tests || []).some(t => /isn't installed on this computer/.test(t.message || ''))) return false;
  if (/Tandemi: to check all the code, install/.test(run.output || '')) return false;
  if (run.setup || /app-launch-failed|You must install or update \.NET|framework '[^']+', version '[^']+' \([^)]*\) was not found/i.test(run.output || '')) return false; // the computer's setup, not the code
  return true;
}
function slim(run) {
  return { ...run, output: String(run.output || '').slice(-6000), tests: (run.tests || []).map(t => ({ ...t, stack: String(t.stack || '').slice(-2000) })), cached: undefined };
}
// Settings → Storage: forget every remembered build and test result (the next check runs everything again)
function clearCache() { DB = {}; try { if (FILE) fs.rmSync(FILE, { force: true }); } catch (e) { /* none */ } }
function getRun(key) { if (!FILE || !key) return null; const db = load(), hit = db[key]; if (!hit) return null; hit.at = Date.now(); save(); return { ...JSON.parse(JSON.stringify(hit.run)), cached: true }; }
function putRun(key, run) {
  if (!FILE || !key || !cacheable(run)) return;
  const db = load(); db[key] = { at: Date.now(), run: slim(run) };
  const keys = Object.keys(db); if (keys.length > MAX) keys.sort((a, b) => db[a].at - db[b].at).slice(0, keys.length - MAX).forEach(k => delete db[k]);
  save();
}
// the key of "this code": the starting commit, the commands, the tools, and every file that differs from the starting commit
async function codeKey(base, cfg, dir, files) {
  const parts = [];
  for (const f of [...new Set(files)].sort()) {
    let c; try { c = sha1(fs.readFileSync(path.join(dir, f))); } catch (e) { c = '-'; }
    parts.push(f + '=' + c);
  }
  return sha1(['code', ENGINE, base, cfg.build || '', cfg.test || '', await tools(), ...parts].join('\n'));
}
async function commitKey(sha, cfg) { return sha1(['commit', ENGINE, sha, cfg.build || '', cfg.test || '', await tools()].join('\n')); }

// other places in the merged code that still use a name somebody renamed or removed. The build often stops at the
// first project that fails, so these show up only after the first fix; Tandemi lists them right away.
function stillUses(dir, files, name, skip = []) {
  const out = [], re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < 8; i++) {
      const l = lines[i].trim();
      if (!re.test(l) || /^(\/\/|\*|\/\*|#)/.test(l)) continue;
      if (skip.some(x => x.file === f && x.line === i + 1)) continue;
      out.push({ file: f, line: i + 1, text: l.slice(0, 160) });
    }
  }
  return out;
}
// what a failing test depends on: the names in the test, then in the methods it calls (a few levels deep).
// Used to find which of the developers' changes most likely broke it.
const KEYWORDS = new Set('var let const new return if else for foreach while true false null this base public private protected internal static void int float double bool string class namespace using Assert True Equal False function async await of in out ref is as typeof sizeof default case switch break continue try catch finally throw'.split(' '));
function bodyAt(text, from) { // the block that starts at the first "{" after `from` (or one expression for "=>")
  const brace = text.indexOf('{', from), arrow = text.indexOf('=>', from), semi = text.indexOf(';', from);
  if (arrow >= 0 && (brace < 0 || arrow < brace) && semi > arrow) return text.slice(from, semi + 1);
  if (brace < 0) return text.slice(from, from + 400);
  let depth = 0;
  for (let i = brace; i < text.length && i < brace + 20000; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) return text.slice(from, i + 1); }
  return text.slice(from, brace + 2000);
}
function dependsOn(dir, files, startFile, startLine, depth = 3) { // → Map(name → how many calls away from the test)
  const texts = new Map();
  for (const f of files) { if (!/\.(cs|js|mjs|cjs|ts|py|java|cpp|cc|h|hpp)$/i.test(f)) continue; try { const t = fs.readFileSync(path.join(dir, f), 'utf8'); if (t.length < 2e6) texts.set(f, t); } catch (e) { /* gone */ } }
  let start = texts.get(startFile); if (start == null) { try { start = fs.readFileSync(path.join(dir, startFile), 'utf8'); } catch (e) { return new Map(); } }
  const lines = start.split(/\r?\n/), at = Math.max(0, (startLine || 1) - 1);
  const offset = lines.slice(0, at).join('\n').length;
  const ids = new Map(), seen = new Set();
  const all = [...texts.values()].join('\n');
  const isClass = (n) => new RegExp(`\\b(class|struct|record)\\s+${n}\\b`).test(all);
  const add = (code, d) => { for (const m of code.matchAll(/[A-Za-z_]\w*/g)) if (!KEYWORDS.has(m[0]) && m[0].length > 1 && !ids.has(m[0])) ids.set(m[0], d); };
  add(bodyAt(start, offset), 0);
  for (let d = 0; d < depth; d++) {
    for (const [name, nd] of [...ids]) {
      if (nd !== d || seen.has(name) || isClass(name)) continue; // constructors and type names say little about the cause
      seen.add(name);
      const re = new RegExp(`\\b${name}\\s*\\([^;{}()]*\\)\\s*(\\{|=>)`, 'g');
      for (const [, t] of texts) for (const m of t.matchAll(re)) { const before = t.slice(Math.max(0, m.index - 80), m.index); if (/(new|\.|=|return|\()\s*$/.test(before)) continue; add(bodyAt(t, m.index), d + 1); }
      if (seen.size > 200) break;
    }
  }
  return ids;
}
// the name a change is about: "changed field JumpPower (Cat.cs)" → JumpPower, "added SpeedUp(Cat) (World.cs)" → SpeedUp
function changeName(label) { const m = String(label).match(/^(?:added|changed|removed)\s+(?:(?:field|method|property|class|struct|enum|interface|const|var|let|function)\s+)?([A-Za-z_][\w.]*)/); return m ? m[1].split('.').pop() : null; }
// every name a change is about: its own name and the function it is in ("added if (n >= 3) in total(n)" → if… total)
function changeNames(label) { const out = []; const own = changeName(label); if (own && !KEYWORDS.has(own)) out.push(own); const m = String(label).match(/ in ([A-Za-z_][\w.]*)/); if (m) out.push(m[1].split('.').pop()); return out; }
const changeDepth = (deps, label) => { const ds = changeNames(label).map(n => deps.get(n)).filter(d => d !== undefined); return ds.length ? Math.min(...ds) : undefined; };
// ---------------------------------------------------------------- names that vanished (Python and JavaScript have no compiler)
// What a file defines: functions, classes, variables, fields (self.x / this.x), methods.
const DEFS = {
  py: /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)|^[ \t]*class[ \t]+([A-Za-z_]\w*)|^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)|self\.([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)|^[ \t]*(?:from[ \t]+\S+[ \t]+)?import[ \t]+(?:\S+[ \t]+as[ \t]+)?([A-Za-z_]\w*)/gm,
  js: /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)|\bclass\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|this\.([A-Za-z_$][\w$]*)\s*=(?!=)|^[ \t]*(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)\n]*\)\s*\{|^[ \t]*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:function|\(|async)|^[ \t]*([A-Za-z_$][\w$]*)\s*=(?!=)|\b(?:import|export)\s*\{([^}]*)\}/gm,
};
const dynLang = (file) => (/\.(py|pyw)$/i.test(file) ? 'py' : /\.(js|mjs|cjs|jsx)$/i.test(file) ? 'js' : null);
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'self', 'this', 'super', 'constructor', 'require', 'module', 'exports']);
// the names a file defines, remembered by file size and time: checking again after a small edit re-reads one file, not the project
const DEFS_CACHE = new Map();
function defsOfFile(file, lang) {
  let st; try { st = fs.statSync(file); } catch (e) { return new Set(); }
  if (st.size >= 2e6) return new Set();
  const k = file + '|' + lang, hit = DEFS_CACHE.get(k);
  if (hit && hit.m === st.mtimeMs && hit.s === st.size) return hit.d;
  let d; try { d = defsOf(fs.readFileSync(file, 'utf8'), lang); } catch (e) { d = new Set(); }
  if (DEFS_CACHE.size > 20000) DEFS_CACHE.clear();
  DEFS_CACHE.set(k, { m: st.mtimeMs, s: st.size, d }); return d;
}
function defsOf(text, lang) {
  const out = new Set();
  for (const m of String(text || '').matchAll(DEFS[lang])) for (const g of m.slice(1)) if (g) for (const n of g.split(',').map(x => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)) if (/^[A-Za-z_$][\w$]*$/.test(n) && !NOT_NAMES.has(n)) out.add(n);
  return out;
}
// lines that still use a name, ignoring comments and text inside quotes
function usesOf(text, name, lang) {
  const re = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`), out = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    const code = l.replace(lang === 'py' ? /#.*$/ : /\/\/.*$/, '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    if (re.test(code)) out.push({ line: i + 1, text: l.trim().slice(0, 160) });
  });
  return out;
}
module.exports = { flush, clearCache, defsOfFile, setupOf, ENGINE, dynLang, defsOf, usesOf, changeName, changeNames, changeDepth, dependsOn, stillUses, readBlobs, cleanArgs, KEEP, tools, cacheInit, getRun, putRun, codeKey, commitKey, sha1 };
