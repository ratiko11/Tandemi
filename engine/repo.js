// repo.js · Tandemi on a real git project (C# / MonoGame / WinForms / WPF, and others).
// Takes two branches (one per developer), merges every changed file by the code's structure, builds and tests
// each branch alone and the merged code in separate git worktrees, and sends each bug to the developer whose
// line broke it. Nothing in the developer's own checkout is touched; the merge can be saved as a merge branch.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const MERGE = require('./merge.js');
const ZIP = require('./zip.js');
const FAST = require('./fast.js');

let DATA = null, onChange = () => {}, askClaude = null, hasAI = () => !!askClaude;
const P = { path: null, open: false, phase: 'idle', step: '', log: [], busy: false };
const MAX_LOG = 200;

function init(opts) { DATA = opts.dataDir; FAST.cacheInit(DATA); onChange = opts.onChange || onChange; askClaude = opts.claude || null; if (opts.hasAI) hasAI = opts.hasAI; }
function changed() { onChange(publicState()); }
function log(text, cls = '') { P.log.push({ text, cls, at: Date.now() }); if (P.log.length > MAX_LOG) P.log.shift(); changed(); }
function step(s) { P.step = s; changed(); }

// ---------------------------------------------------------------- shell helpers
function git(args, cwd, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true, ...opts }, (err, out, errOut) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: out || '', err: errOut || (err && !errOut ? err.message : '') });
    });
  });
}
async function gitOk(args, cwd) { const r = await git(args, cwd); if (r.code) throw new Error(`git ${args[0]}: ${(r.err || r.out).trim().split('\n').slice(-1)[0]}`); return r.out; }
function shell(cmd, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', CI: '1', DOTNET_ROLL_FORWARD: process.env.DOTNET_ROLL_FORWARD || 'Major' };
    if (process.versions.electron && cmd.includes('checks.js')) env.ELECTRON_RUN_AS_NODE = '1'; // inside the app, its own Node runs the compile checks // a project made for an older .NET runs on the newer one this computer has
    const child = spawn(cmd, { cwd, shell: true, env, windowsHide: true });
    let out = '';
    const add = (b) => { out += b.toString(); if (out.length > 4e6) out = out.slice(-2e6); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { out += `\n[Tandemi] Stopped after ${timeoutSec} s.`; try { process.platform === 'win32' ? spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']) : child.kill('SIGKILL'); } catch (e) { /* gone */ } }, timeoutSec * 1000);
    child.on('error', (e) => { out += '\n' + e.message; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? 1 : code, out, secs: Math.round((Date.now() - t0) / 100) / 10 }); });
  });
}
const rel = (root, p) => {
  if (!p) return null;
  const n = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = n(path.resolve(root)), b = n(path.isAbsolute(p) ? p : path.resolve(root, p));
  const same = process.platform === 'win32' ? b.toLowerCase().startsWith(a.toLowerCase() + '/') : b.startsWith(a + '/');
  return same ? b.slice(a.length + 1) : null;
};

// ---------------------------------------------------------------- open a repo, read its config or detect one
async function listBranches() {
  const out = await gitOk(['for-each-ref', '--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)|%(authorname)', 'refs/heads', 'refs/remotes'], P.path);
  const all = out.trim().split('\n').filter(Boolean).map(l => { const [name, sha, when, author] = l.split('|'); return { name, sha, when, author }; }).filter(b => !/\/HEAD$/.test(b.name) && b.name !== 'origin');
  // a local branch that is just a copy of origin/<same name> is shown once (as origin/<name>)
  return all.filter(b => b.name.includes('/') && b.name.startsWith('origin/') || !all.some(r => r.name === 'origin/' + b.name && r.sha === b.sha));
}
async function detect(root) {
  const cfgFile = path.join(root, 'tandemi.json');
  let cfg = {};
  if (fs.existsSync(cfgFile)) { try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); cfg.source = 'tandemi.json'; } catch (e) { throw new Error('tandemi.json in this project is not valid JSON: ' + e.message); } }
  const files = (await gitOk(['ls-files'], root)).split('\n').filter(Boolean);
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch (e) { return ''; } };
  const csproj = files.filter(f => /\.csproj$/i.test(f) && !/(^|\/)(bin|obj)\//i.test(f)), sln = files.find(f => /\.slnx?$/i.test(f));
  const pkg = files.includes('package.json') ? (() => { try { return JSON.parse(read('package.json')); } catch (e) { return {}; } })() : null;
  const auto = {};
  if (csproj.length) {
    const texts = csproj.map(read).join('\n');
    auto.kind = /MonoGame/i.test(texts) ? 'game' : /<UseWPF>|<UseWindowsForms>|WindowsDesktop/i.test(texts) ? 'desktop' : 'app';
    auto.languages = ['C#'];
    const hasTests = /Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest/i.test(texts);
    const target = csproj.length === 1 ? `"${csproj[0]}"` : sln ? `"${sln}"` : ''; // one project: build it directly (older SDKs can't read .slnx)
    if (hasTests) { auto.test = `dotnet test ${target} --logger trx --results-directory "{results}"`; auto.results = '{results}/*.trx'; }
    else auto.build = `dotnet build ${target}`.trim();
  } else if (pkg) {
    auto.kind = pkg.dependencies && pkg.dependencies.electron || pkg.devDependencies && pkg.devDependencies.electron ? 'desktop' : 'web';
    auto.languages = ['JavaScript'];
    if (pkg.scripts && pkg.scripts.test) auto.test = 'npm test';
    auto.build = 'npm install --no-audit --no-fund';
  } else if (files.includes('pom.xml')) { // Java with Maven (JUnit reports in target/surefire-reports)
    auto.kind = 'app'; auto.languages = ['Java'];
    auto.test = 'mvn -q -B test'; auto.results = 'target/surefire-reports/*.xml';
  } else if (files.some(f => /^(build\.gradle|build\.gradle\.kts)$/.test(f))) { // Java/Kotlin with Gradle
    auto.kind = 'app'; auto.languages = ['Java'];
    const wrapper = files.includes(process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    auto.test = (wrapper ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew') : 'gradle') + ' test --console=plain'; auto.results = 'build/test-results/test/*.xml';
  } else if (files.includes('go.mod')) { // Go: go test, read from its -v output
    auto.kind = 'app'; auto.languages = ['Go'];
    auto.test = 'go test -v ./...';
  } else if (files.some(f => /(^|\/)(pyproject\.toml|pytest\.ini|setup\.py)$/.test(f) || /(^|\/)test_.*\.py$/.test(f))) {
    auto.kind = 'app'; auto.languages = ['Python'];
    auto.test = 'python -m pytest --junitxml "{results}/junit.xml"'; auto.results = '{results}/*.xml';
  } else {
    // no project file: still check that the code compiles (C#, JavaScript, TypeScript, Python, Java, C++, Go), with each language's real tool
    const exts = { cs: 'C#', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', cpp: 'C++', cc: 'C++', cxx: 'C++', h: 'C++', hpp: 'C++', java: 'Java', ts: 'TypeScript', tsx: 'TypeScript', go: 'Go' };
    const langs = [...new Set(files.map(f => exts[(f.split('.').pop() || '').toLowerCase()]).filter(Boolean))];
    if (langs.length) { auto.kind = 'code'; auto.languages = langs; auto.build = `"${process.execPath}" "${path.join(__dirname, 'checks.js')}"`; auto.checksOnly = true; }
  }
  const merged = { name: path.basename(root), kind: 'app', timeoutSec: 900, ...auto, ...cfg };
  merged.source = cfg.source || (auto.checksOnly ? 'checks' : auto.test || auto.build ? 'detected' : 'none');
  return merged;
}
async function open(dir, opts = {}) {
  if (P.busy) throw new Error('Tandemi is busy with this project. Wait until it finishes.');
  const abs = path.resolve(String(dir || '').trim().replace(/^"|"$/g, ''));
  if (!fs.existsSync(abs)) throw new Error(`There is no folder ${abs} on this computer.`);
  const ver = await git(['--version'], abs);
  if (ver.code) throw new Error('Git is not installed on this computer (or not on PATH). Install it from https://git-scm.com, then start Tandemi again.');
  const top = await git(['rev-parse', '--show-toplevel'], abs);
  if (top.code) throw new Error(`${abs} is not a git repository. Open the project folder that has the .git folder (run "git init" first if it has none).`);
  Object.assign(P, { path: path.resolve(top.out.trim()), open: true, phase: 'idle', step: '', log: [], a: null, b: null, base: null, devs: null, files: [], runs: {}, bugs: [], gitView: null, mergeBranch: null, edited: new Set() });
  P.config = await detect(P.path);
  if (opts.name) P.config.name = String(opts.name);
  P.source = opts.source || 'git';
  P.work = path.join(DATA, 'work', crypto.createHash('sha1').update(P.path.toLowerCase()).digest('hex').slice(0, 12));
  plainLoad();
  P.branches = await listBranches();
  P.current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], P.path)).out.trim();
  log(`Opened ${P.config.name}${P.source === 'git' ? ` (${P.path}). ${P.branches.length} branches` : ''}. ${P.config.source === 'tandemi.json' ? 'Using tandemi.json.' : P.config.source === 'detected' ? `Detected a ${P.config.languages.join('/')} ${P.config.kind} project.` : P.config.source === 'checks' ? `No project file, so Tandemi checks that the ${P.config.languages.join(', ')} code compiles.` : 'No build or tests found; Tandemi will only merge.'}`);
  changed();
  return publicState();
}
async function fetchAll() {
  const r = await git(['fetch', '--all', '--prune'], P.path);
  P.branches = await listBranches(); changed();
  return r.code ? (r.err || r.out).trim().split('\n').pop() : 'ok';
}

// ---------------------------------------------------------------- worktrees: one for each branch and one for the merge
async function worktree(name, rev) {
  const dir = path.join(P.work, name);
  await git(['worktree', 'prune'], P.path);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const co = await git(['checkout', '-f', '--detach', rev], dir);
    if (!co.code) { await git(FAST.cleanArgs(), dir); return dir; } // build output (bin/obj…) stays: the next build is incremental
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* recreate below */ }
    await git(['worktree', 'prune'], P.path);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await gitOk(['worktree', 'add', '-f', '--detach', dir, rev], P.path);
  return dir;
}

// ---------------------------------------------------------------- reading build errors and test results
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? decode(m[1]) : ''; };
function parseResults(xml) {
  const tests = [];
  if (/<TestRun\b/.test(xml)) { // TRX (dotnet test --logger trx)
    for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
      const outcome = attr(m[1], 'outcome'), body = m[3] || '';
      const msg = (body.match(/<Message>([\s\S]*?)<\/Message>/) || [])[1], st = (body.match(/<StackTrace>([\s\S]*?)<\/StackTrace>/) || [])[1];
      tests.push({ id: attr(m[1], 'testName'), name: attr(m[1], 'testName'), ok: outcome === 'Passed', skipped: outcome === 'NotExecuted', message: decode(msg).trim(), stack: decode(st).trim() });
    }
  } else if (/<test-run\b|<test-case\b/.test(xml)) { // NUnit 3
    for (const m of xml.matchAll(/<test-case\b([^>]*?)(\/>|>([\s\S]*?)<\/test-case>)/g)) {
      const result = attr(m[1], 'result'), body = m[3] || '';
      tests.push({ id: attr(m[1], 'fullname') || attr(m[1], 'name'), name: attr(m[1], 'name'), ok: result === 'Passed', skipped: result === 'Skipped' || result === 'Inconclusive', message: decode((body.match(/<message>([\s\S]*?)<\/message>/) || [])[1]).trim(), stack: decode((body.match(/<stack-trace>([\s\S]*?)<\/stack-trace>/) || [])[1]).trim() });
    }
  } else { // JUnit (pytest, jest-junit, many others)
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const body = m[3] || '', fail = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
      const cls = attr(m[1], 'classname'), name = attr(m[1], 'name');
      tests.push({ id: (cls ? cls + '.' : '') + name, name: (cls ? cls.split('.').pop() + '.' : '') + name, ok: !fail && !/<skipped/.test(body), skipped: /<skipped/.test(body), message: fail ? (attr(fail[2], 'message') || decode(fail[3]).split('\n')[0]).trim() : '', stack: fail ? decode(fail[3]).trim() : '' });
    }
  }
  return tests;
}
function buildErrors(out, root) {
  const seen = new Set(), errs = [];
  const add = (file, line, code, message) => { const r = rel(root, file) || file.replace(/\\/g, '/'); const k = `${r}:${line}:${code}`; if (seen.has(k)) return; seen.add(k); errs.push({ file: r, line: +line, code, message: message.trim() }); };
  for (const m of out.matchAll(/^\s*(.+?)\((\d+),\d+\): error ([A-Z]+\d*): (.+?)(?: \[[^\]\n]+\])?\s*$/gm)) add(m[1], m[2], m[3], m[4]); // MSBuild / dotnet, and Tandemi's own checks (JAVA, GO, CPP, PY, JS)
  for (const m of out.matchAll(/^(.+?\.(?:c|cc|cpp|h|hpp|ts|tsx|js|py|go|rs)):(\d+):\d+:\s*(?:fatal )?error:?\s*(.+)$/gm)) add(m[1], m[2], 'error', m[3]); // gcc/clang/tsc style
  for (const m of out.matchAll(/^(?:\[ERROR\] )?(.+?\.java):\[?(\d+)(?:,\d+\])?:? (?:error: )?(.+)\n(?:.*\n){0,3}?\s*symbol:\s*(.+)$/gm)) add(m[1], m[2], 'JAVA', `${m[3].trim()}: ${m[4].trim()}`); // javac / Maven, with the missing symbol
  for (const m of out.matchAll(/^(?:\[ERROR\] )?(.+?\.java):\[?(\d+)(?:,\d+\])?:? error: (.+)$/gm)) if (!/cannot find symbol/.test(m[3])) add(m[1], m[2], 'JAVA', m[3]);
  for (const m of out.matchAll(/^(?:vet: |# )?(\.?[^\s:()]*?\.go):(\d+):\d+: (.+)$/gm)) add(m[1], m[2], 'GO', m[3]); // go build / go vet
  return errs.slice(0, 40);
}
function frames(stack, root) {
  const out = [];
  for (const m of String(stack || '').matchAll(/ in (.+?):line (\d+)|File "(.+?)", line (\d+)|\(?((?:[A-Za-z]:)?[^\s():]+\.(?:js|ts|tsx|mjs|cjs)):(\d+):\d+\)?|((?:[A-Za-z]:)?[^\s():]+\.go):(\d+)/g)) {
    const file = m[1] || m[3] || m[5] || m[7], line = +(m[2] || m[4] || m[6] || m[8]);
    const r = rel(root, file); if (r) out.push({ file: r, line });
  }
  return out;
}
function missingTool(out, cmd) {
  if (!/is not recognized as an internal or external command|command not found|: not found|No such file or directory/i.test(out)) return FAST.setupOf(out);
  const tool = String(cmd).trim().split(/\s+/)[0];
  const how = { dotnet: 'Install the .NET SDK from https://dotnet.microsoft.com/download (the same one you use for MonoGame).', npm: 'Install Node.js from https://nodejs.org.', python: 'Install Python from https://python.org.' }[tool] || '';
  return `"${tool}" isn't installed on this computer, so Tandemi can't build or test the project. ${how}`;
}
// a build/test run, or the remembered result of exactly the same code with the same tools
async function runCached(name, dir, key, force) {
  if (!force) { const hit = FAST.getRun(key); if (hit) { if (name !== 'merged') step(`${label(name)}: same code as before, result remembered.`); return hit; } }
  const r = await runSide(name, dir); if (!r.setup) FAST.putRun(key, r); return r; // a setup problem is not remembered: it goes away once the tool is installed
}
async function runSide(name, dir) {
  const cfg = P.config, results = path.join(P.work, 'results-' + name);
  try { fs.rmSync(results, { recursive: true, force: true }); } catch (e) { /* none */ }
  fs.mkdirSync(results, { recursive: true });
  const fill = (s) => String(s || '').replace(/\{results\}/g, results.replace(/\\/g, '/'));
  const run = { ok: true, build: null, tests: [], output: '', ranTests: false };
  if (cfg.build) {
    step(`${label(name)}: building…`);
    const r = await shell(fill(cfg.build), dir, cfg.timeoutSec || 900);
    run.output += r.out;
    const errs = buildErrors(r.out, dir);
    run.build = { ok: r.code === 0, errors: errs, secs: r.secs };
    if (r.code) { run.ok = false; const setup = errs.length ? FAST.setupOf(r.out, errs) : missingTool(r.out, cfg.build); if (setup) run.setup = setup; if (!errs.length) run.build.errors = [{ file: null, line: null, code: 'build', message: setup || r.out.trim().split('\n').slice(-6).join('\n') }]; return run; }
  }
  if (cfg.test) {
    step(`${label(name)}: running the tests…`);
    const r = await shell(fill(cfg.test), dir, cfg.timeoutSec || 900);
    run.output += r.out; run.ranTests = true;
    const errs = buildErrors(r.out, dir);
    if (errs.length && !cfg.build) { run.build = { ok: false, errors: errs }; run.ok = false; return run; }
    if (!cfg.build) run.build = { ok: true, errors: [] };
    const pattern = fill(cfg.results || '');
    if (pattern) {
      const dirOf = path.dirname(pattern), ext = path.extname(pattern) || '.xml';
      const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(ext) ? [path.join(d, e.name)] : [])) : []);
      for (const f of walk(path.isAbsolute(dirOf) ? dirOf : path.join(dir, dirOf))) run.tests.push(...parseResults(fs.readFileSync(f, 'utf8')));
    }
    if (!run.tests.length) for (const m of r.out.matchAll(/^\s*--- (PASS|FAIL|SKIP): (\S+) \([\d.]+s\)\n?((?:\s{4,}.*\n)*)/gm)) run.tests.push({ id: m[2], name: m[2], ok: m[1] === 'PASS', skipped: m[1] === 'SKIP', message: (m[3] || '').trim().split('\n')[0].replace(/^\S+?\.go:\d+: /, ''), stack: (m[3] || '').trim() }); // go test -v
    if (!run.tests.length) { const setup = r.code ? missingTool(r.out, cfg.test) : null; if (setup) run.setup = setup; run.tests.push({ id: '(test command)', name: 'The test command', ok: r.code === 0, message: r.code ? setup || r.out.trim().split('\n').slice(-6).join('\n') : '', stack: r.out.slice(-4000) }); }
    for (const t of run.tests) t.where = frames(t.stack + '\n' + t.message, dir);
    try { // what the last test runs printed, for when something goes wrong on a computer nobody can look at
      const logDir = path.join(DATA, 'runlog'); fs.mkdirSync(logDir, { recursive: true });
      const keep = fs.readdirSync(logDir).sort(); keep.slice(0, Math.max(0, keep.length - 20)).forEach(f => fs.rmSync(path.join(logDir, f), { force: true }));
      fs.writeFileSync(path.join(logDir, `${Date.now()}-${name}.txt`), `cmd: ${fill(cfg.test)}\ncode: ${r.code}\nroll: ${process.env.DOTNET_ROLL_FORWARD || '(set per command)'}\nsetup: ${run.setup || ''}\ntests: ${run.tests.length}\n\n${r.out.slice(-6000)}`);
    } catch (e) { /* only a log */ }
    run.ok = run.tests.every(t => t.ok || t.skipped);
  }
  return run;
}

// ---------------------------------------------------------------- the merge
const isGit = () => (P.source || 'git') === 'git';
const label = (x) => (x === 'merged' ? 'Merged code' : x === 'probe' ? 'Trying a fix' : x === 'start' ? 'Starting code (checking a plain-word test)' : P.devs && P.devs[x] ? (isGit() ? `${P.devs[x].branch} (${P.devs[x].name})` : `${P.devs[x].name}'s version`) : x);
const brn = (x) => (isGit() && P.devs && P.devs[x] ? ` (${P.devs[x].branch})` : ''); // the branch, only when the user chose it
const sideName = (x) => (isGit() ? P.devs[x].branch : `${P.devs[x].name}'s version`);
async function show(rev, file) {
  let buf;
  if (P.blobs && P.blobs.has(`${rev}:${file}`)) { buf = P.blobs.get(`${rev}:${file}`); if (buf === null) return null; }
  if (!buf) { const r = await git(['show', `${rev}:${file}`], P.path, { encoding: 'buffer' }); if (r.code) return null; buf = Buffer.isBuffer(r.out) ? r.out : Buffer.from(r.out); } if (buf.includes(0)) return { binary: true }; const text = buf.toString('utf8'); if (text.includes('\r\n')) P.crlf.add(file); return text.replace(/\r\n/g, '\n'); }
async function nameStatus(from, to) {
  const out = await gitOk(['diff', '--name-status', '--no-renames', from, to], P.path);
  const m = new Map(); for (const l of out.split('\n').filter(Boolean)) { const [st, f] = l.split('\t'); m.set(f, st[0]); } return m;
}
async function authorOf(range) {
  const out = (await git(['log', '--format=%an|%ae', range], P.path)).out.trim().split('\n').filter(Boolean);
  const count = {}; for (const l of out) count[l] = (count[l] || 0) + 1;
  const top = Object.entries(count).sort((x, y) => y[1] - x[1])[0];
  const [name, email] = top ? top[0].split('|') : ['(no commits)', ''];
  return { name, email, commits: out.length };
}
function lineSetDiff(base, side) {
  const O = (base || '').split('\n'), X = (side || '').split('\n');
  const os = new Set(O.map(s => s.trim())), xs = new Set(X.map(s => s.trim()));
  return { added: X.filter(l => l.trim() && !os.has(l.trim())), removed: O.filter(l => l.trim() && !xs.has(l.trim())) };
}

async function startMerge(a, b) {
  P.toldRename = new Set();
  if (!P.open) throw new Error('Open a project first.');
  if (P.busy) throw new Error('Tandemi is already working on this project.');
  P.busy = true;
  try {
    await MERGE.ready;
    bugSeq = 0; // every merge numbers its bugs from 1
    Object.assign(P, { a, b, phase: 'merging', files: [], runs: {}, bugs: [], mergeBranch: null, edited: new Set(), gitView: null, crlf: new Set(), toldNoAI: false });
    step('Reading the two branches…');
    const ra = (await gitOk(['rev-parse', a], P.path)).trim(), rb = (await gitOk(['rev-parse', b], P.path)).trim();
    const mb = await git(['merge-base', ra, rb], P.path);
    if (mb.code) throw new Error(`${a} and ${b} have no common starting point.`);
    P.base = mb.out.trim(); P.sha = { A: ra, B: rb };
    P.devs = { A: { branch: a, ...(await authorOf(`${P.base}..${ra}`)) }, B: { branch: b, ...(await authorOf(`${P.base}..${rb}`)) } };
    if (P.devs.A.email && P.devs.A.email === P.devs.B.email) P.devs.B.name += ' (same person)';
    if (!isGit()) log(`Merging ${P.devs.A.name}'s version and ${P.devs.B.name}'s version.`);
    else log(`Merging ${a} (${P.devs.A.name}, ${P.devs.A.commits} commit${P.devs.A.commits === 1 ? '' : 's'}) and ${b} (${P.devs.B.name}, ${P.devs.B.commits} commit${P.devs.B.commits === 1 ? '' : 's'}).`);
    // what plain git would say
    const mt = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', ra, rb], P.path);
    if (mt.code <= 1 && mt.out) { const lines = mt.out.trim().split('\n'); P.gitView = { conflictFiles: mt.code === 1 ? lines.slice(1).filter(Boolean) : [], ok: mt.code === 0 }; }
    const sa = await nameStatus(P.base, ra), sb = await nameStatus(P.base, rb);
    // every version of every changed file, read with one git process
    const changedFiles = [...new Set([...sa.keys(), ...sb.keys()])].filter(f => !/(^|\/)(bin|obj)\//i.test(f));
    step(`Reading ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}…`);
    await MERGE.prepare(changedFiles); // the parsers for the languages in this merge
    P.blobs = await FAST.readBlobs(P.path, changedFiles.flatMap(f => [`${P.base}:${f}`, ...(sa.has(f) ? [`${ra}:${f}`] : []), ...(sb.has(f) ? [`${rb}:${f}`] : [])]));
    for (const f of [...new Set([...sa.keys(), ...sb.keys()])].sort()) {
      const inA = sa.has(f), inB = sb.has(f);
      const entry = { file: f, from: inA && inB ? 'both' : inA ? 'A' : 'B', conflicts: [], changes: null, method: null };
      if (/(^|\/)(bin|obj)\//i.test(f)) { // build output that was committed by mistake: never a conflict, rebuilt anyway
        Object.assign(entry, { method: 'build output', binary: true, generated: true, take: inB ? 'B' : 'A' });
        P.files.push(entry); continue;
      }
      const base = await show(P.base, f), va = inA ? await show(ra, f) : base, vb = inB ? await show(rb, f) : base;
      entry.base = base && !base.binary ? base : null; entry.A = va && !va.binary ? va : null; entry.B = vb && !vb.binary ? vb : null;
      if ((va && va.binary) || (vb && vb.binary) || (base && base.binary)) {
        entry.binary = true;
        if (entry.from === 'both' && (await git(['diff', '--quiet', ra, rb, '--', f], P.path)).code) { entry.method = 'whole file'; entry.conflicts.push({ id: 0, label: `${f} (a binary file, like an image or a sound)`, base: '', a: '(Developer A\'s version)', b: '(Developer B\'s version)', binary: true }); }
        else entry.method = 'one side';
        entry.take = inA ? 'A' : 'B';
      } else if (entry.from !== 'both') {
        entry.method = 'one side'; entry.result = entry.from === 'A' ? va : vb;
        if (base != null && entry.result != null) { // what they changed, by name
          const list = MERGE.describe(f, base, entry.result);
          if (list) entry.changes = { A: entry.from === 'A' ? list : [], B: entry.from === 'B' ? list : [] };
        }
      }
      else if (va === vb) { entry.method = 'same'; entry.result = va; }
      else if (va == null || vb == null) {
        entry.method = 'whole file';
        entry.conflicts.push({ id: 0, label: `${f}: ${va == null ? P.devs.A.name + ' deleted it, ' + P.devs.B.name + ' changed it' : P.devs.B.name + ' deleted it, ' + P.devs.A.name + ' changed it'}`, base: base || '', a: va || '', b: vb || '', deleted: true });
      } else {
        const r = MERGE.merge(f, base || '', va, vb);
        Object.assign(entry, { method: r.method, language: r.language || null, lineConflicts: r.lineConflicts, conflicts: r.conflicts, changes: r.changes, template: r.template, parseError: r.error });
        if (r.error) log(`${f}: ${r.error.side === 'base' ? 'the starting version' : sideName(r.error.side)} has a syntax error${r.error.line ? ' on line ' + r.error.line : ''}, so this file is merged line by line.`, 'warn');
      }
      P.files.push(entry);
    }
    P.blobs = null;
    const astFiles = P.files.filter(f => f.method === 'ast').length, real = P.files.reduce((n, f) => n + f.conflicts.length, 0);
    const gen = P.files.filter(f => f.generated).length;
    if (gen) log(`${gen} changed file${gen === 1 ? ' is' : 's are'} build output (bin/ or obj/) that is saved in git. Tandemi doesn't merge those; it rebuilds them. Tip: add a .gitignore for Visual Studio so bin/ and obj/ stay out of git.`, 'warn');
    log(`${P.files.length} changed file${P.files.length === 1 ? '' : 's'}: ${P.files.filter(f => f.from === 'both').length} changed by both. ${P.gitView ? `git would stop with conflicts in ${P.gitView.conflictFiles.length} file${P.gitView.conflictFiles.length === 1 ? '' : 's'}; ` : ''}Tandemi merged ${astFiles} by structure and has ${real} real conflict${real === 1 ? '' : 's'}.`, real ? 'warn' : 'ok');
    if (real) { P.phase = 'conflicts'; step('Waiting for you to choose what to keep in each real conflict.'); return publicState(); }
    P.busy = false;
    return await buildAndTest(true);
  } catch (e) { P.phase = 'error'; step(e.message); log(e.message, 'err'); throw e; }
  finally { P.busy = false; changed(); }
}

function finalText(entry) {
  if (entry.method === 'one side' || entry.method === 'same') return entry.result;
  if (entry.method === 'whole file') { const c = entry.conflicts[0]; return c.pick === 'A' ? entry.A : c.pick === 'B' ? entry.B : c.pick === 'custom' ? c.custom : undefined; }
  const t = MERGE.fill(entry.template, entry.conflicts);
  return t.includes('\u0000') ? undefined : t;
}
async function pick(file, id, choice, custom) {
  const f = P.files.find(x => x.file === file); if (!f) throw new Error('No such file in this merge.');
  const c = f.conflicts.find(x => x.id === Number(id)); if (!c) throw new Error('No such conflict.');
  if (choice === 'both' && !c.binary && !c.deleted) { c.pick = 'custom'; c.custom = [c.a, c.b].filter(Boolean).join('\n'); }
  else if (choice === 'A' || choice === 'B') c.pick = choice;
  else if (choice === 'custom' && typeof custom === 'string') { c.pick = 'custom'; c.custom = custom; }
  else throw new Error('Choose A, B or both.');
  changed();
  if (P.files.every(x => x.conflicts.every(y => y.pick))) return buildAndTest(true);
  return publicState();
}
async function aiPick(file, id) {
  if (!askClaude || !hasAI()) throw new Error('Letting AI combine needs Claude connected at the top of the page (Claude Code or an API key).');
  const f = P.files.find(x => x.file === file), c = f && f.conflicts.find(x => x.id === Number(id));
  if (!c || c.binary) throw new Error('No such conflict.');
  c.busy = true; changed();
  try {
    const out = await askClaude('You merge code. Two developers changed the same part of a file differently. Write ONE version of that part that keeps what both wanted and compiles. Your code replaces only this part; the rest of the file stays as merged. If one developer removed this part because they moved or renamed it (their whole file shows where), apply the other developer\'s change there in spirit and do not repeat code that already exists elsewhere: the answer can be an empty string. Answer with JSON only: {"code": "<the combined code for this part only>", "why": "<one short sentence>"}',
      `File: ${file}\nPart: ${c.label}\n\nStarting version:\n${c.base || '(not there)'}\n\n${P.devs.A.name}'s version:\n${c.a || '(removed it)'}\n\n${P.devs.B.name}'s version:\n${c.b || '(removed it)'}\n\nFor context, ${P.devs.A.name}'s whole file:\n${String(f.A || '(deleted)').slice(0, 12000)}\n\n${P.devs.B.name}'s whole file:\n${String(f.B || '(deleted)').slice(0, 12000)}`);
    if (typeof out.code !== 'string') throw new Error('Claude did not send code');
    c.pick = 'custom'; c.custom = out.code; c.why = String(out.why || '');
  } finally { c.busy = false; changed(); }
  if (P.files.every(x => x.conflicts.every(y => y.pick))) return buildAndTest(true);
  return publicState();
}

// write the merged files into the merge worktree (on top of the starting version)
async function writeMerged() {
  const dir = await worktree('merged', P.base);
  for (const f of P.files) {
    const abs = path.join(dir, f.file);
    if (f.binary) { const side = f.conflicts[0] ? f.conflicts[0].pick : f.take; const r = await git(['show', `${P.sha[side === 'B' ? 'B' : 'A']}:${f.file}`], P.path, { encoding: 'buffer' }); if (r.code) { try { fs.rmSync(abs); } catch (e) { /* gone */ } } else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, r.out); } continue; }
    const text = finalText(f);
    if (text == null) { try { fs.rmSync(abs); } catch (e) { /* not there */ } continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, P.crlf.has(f.file) ? text.replace(/\n/g, '\r\n') : text); // keep Windows line endings where the project uses them
  }
  return dir;
}
// who wrote each line of a file in the merged code (A, B, both, or null = it was already there)
function authorsOf(file, text) {
  const f = P.files.find(x => x.file === file);
  if (!f || f.binary || text == null) return null;
  const base = f.base || '';
  return MERGE.authorLines(base, f.from === 'B' ? base : (f.A || ''), f.from === 'A' ? base : (f.B || ''), text);
}
function readMerged(file) { try { return fs.readFileSync(path.join(P.work, 'merged', file), 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return null; } }
function whoWroteLine(file, line, side) {
  if (!file || !line) return null;
  if (side === 'A' || side === 'B') { const f = P.files.find(x => x.file === file); if (!f || f.from === (side === 'A' ? 'B' : 'A')) return null; const txt = f[side]; const au = txt != null ? MERGE.authorLines(f.base || '', txt, f.base || '', txt) : null; return au && au[line - 1] === 'A' ? side : null; }
  const au = authorsOf(file, readMerged(file)); const w = au && au[line - 1];
  return w === 'A' || w === 'B' ? w : w === 'both' ? 'both' : null;
}
// "A renamed RunSpeed to Speed in Cat.cs": a name in the error that one side removed
function renameHint(message) {
  const quoted = [...String(message).matchAll(/'([A-Za-z_]\w*)'/g)].map(m => m[1]);
  const names = [...new Set([...quoted, ...[...String(message).matchAll(/[A-Za-z_]\w{2,}/g)].map(m => m[0])])].filter(n => !/^(int|float|string|bool|void|object|double|var|variable|symbol|cannot|find|does|not|contain|definition|for|the|type|has|field|method|undefined|name|exist|current|context|property|class|member|named|attribute|object)$/i.test(n));
  for (const nm of names) {
    for (const side of ['A', 'B']) {
      for (const f of P.files) {
        if (f.from !== side && f.from !== 'both') continue;
        const { added, removed } = lineSetDiff(f.base, f[side]);
        const re = new RegExp(`\\b${nm}\\b`);
        const gone = removed.filter(l => re.test(l)); if (!gone.length) continue;
        if (added.some(l => re.test(l))) continue;
        let to = null;
        for (const l of gone) for (const ad of added) { const m = ad.trim().match(new RegExp('^' + l.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(nm, '(\\w+)') + '$')); if (m && m[1] !== nm) { to = m[1]; break; } }
        return { side, name: nm, to, file: f.file, text: `${P.devs[side].name}${brn(side)} ${to ? `renamed ${nm} to ${to}` : `removed ${nm}`} in ${path.basename(f.file)}.` };
      }
    }
  }
  return null;
}
function changesOf(side) {
  const out = [];
  for (const f of P.files) {
    if (f.from !== side && f.from !== 'both') continue;
    if (/(^|\/)(tests?|specs?)(\/|$)|tests?\.\w+$|_test\.|\.spec\./i.test(f.file)) continue; // what they changed in the product, not in tests
    if (f.changes && f.changes[side] && f.changes[side].length) out.push(...f.changes[side].map(c => `${c} (${path.basename(f.file)})`));
    else if (f.from === side) out.push(`changed ${path.basename(f.file)}`);
  }
  return out;
}

async function buildAndTest(fresh, force) {
  if (P.busy && !fresh) throw new Error('Tandemi is already working on this project.');
  P.busy = true; P.phase = 'testing'; changed();
  try {
    restoreProbe();
    const cfg = P.config;
    const dir = fresh ? await writeMerged() : path.join(P.work, 'merged');
    if (!cfg.build && !cfg.test) { P.phase = 'done'; step('Merged. This project has no build or test command, so Tandemi only merged it.'); log('No build or tests to run. Add a tandemi.json with "build" and "test" to test the merged code.', 'warn'); return publicState(); }
    // each branch alone (cached by commit), then the merged code
    if (force) await FAST.tools(true); // "Test again": look at the installed tools again too
    for (const side of ['A', 'B']) {
      const pl = plainFor([side]), cacheKey = await FAST.commitKey(P.sha[side], keyCfg(pl));
      const recheck = force && P.runs[side] && !P.runs[side].ok; // "Test again" also re-checks a branch that failed alone
      if (P.runs[side] && P.runs[side].key === cacheKey && !recheck) continue; // a branch alone only changes with its commit or the tools
      const r = (!recheck && FAST.getRun(cacheKey)) || await runCached(side, await (async () => { const d = await worktree(side, P.sha[side]); overlayPlain(d, pl); return d; })(), cacheKey, true); r.key = cacheKey; P.runs[side] = r;
      log(`${label(side)} alone: ${summary(r)}${r.cached ? ' (same code as before)' : ''}.`, r.ok ? 'ok' : 'warn');
    }
    const pl = plainFor(['A', 'B']); overlayPlain(dir, pl); // the tests in plain words run on the merge too
    for (const r of [...new Map(pl.flatMap(x => x.renames).map(r => [r.from, r])).values()]) if (!(P.toldRename || (P.toldRename = new Set())).has(r.from)) { P.toldRename.add(r.from); log(`${P.devs[r.side].name} renamed ${r.from} to ${r.to}, so Tandemi updated the plain-word tests that use it.`); }
    const r = await runCached('merged', dir, await FAST.codeKey(P.base, keyCfg(pl), dir, mergedFiles()), force); P.runs.merged = r;
    log(`Merged code: ${summary(r)}.`, r.ok ? 'ok' : 'err');
    makeBugs();
    if (r.setup) log(r.setup, 'err');
    await tryUndo();
    P.phase = 'done';
    const openN = P.bugs.filter(b => b.status === 'open').length;
    step(r.setup ? 'The tests could not start on this computer (setup problem).' : openN ? `${openN} bug${openN === 1 ? '' : 's'} sent to the developers.` : cfg.checksOnly ? 'The merged code compiles.' : 'The merged code builds and every test passes.');
    if (!openN && !P.inAutoFix && !r.setup) log(cfg.checksOnly ? 'Done: the merged code compiles. Get the final code below.' : 'Done: the merged code builds and every test passes. Get the final code below.', 'ok');
    return publicState();
  } catch (e) { P.phase = 'error'; step(e.message); log(e.message, 'err'); throw e; }
  finally { P.busy = false; changed(); setTimeout(scheduleAutoFix, 0); }
}
// "Agents fix it": after every test run, each developer's AI agent fixes the bugs sent to them, until the tests pass
function scheduleAutoFix() {
  if (P.inAutoFix || P.mode === 'report' || P.phase !== 'done') return;
  const open = (P.bugs || []).filter(b => b.status === 'open');
  if (!open.length) return;
  if (!(askClaude && hasAI())) {
    if (!P.toldNoAI) { P.toldNoAI = true; log('No AI is connected, so the bugs wait for the developers. Connect Claude at the top (Claude Code or an API key), or let an AI coder fix them through the MCP.', 'warn'); changed(); }
    return;
  }
  autoFix();
}
async function autoFix() {
  if (P.inAutoFix) return;
  P.inAutoFix = true; changed();
  try {
    for (let round = 1; round <= 3; round++) {
      const open = P.bugs.filter(b => b.status === 'open'); if (!open.length) break;
      const before = open.map(b => b.key).sort().join('|');
      const done = new Set();
      for (const b of open) {
        const cur = P.bugs.find(x => x.key === b.key && x.status === 'open'); if (!cur || done.has(cur.key)) continue;
        groupOf(cur).forEach(g => done.add(g.key)); // its whole group is handled by this one call
        try { await fixWithAI(cur.id); } catch (e) { log(`The agent couldn't fix bug ${cur.id}: ${e.message}`, 'warn'); }
      }
      const after = P.bugs.filter(b => b.status === 'open').map(b => b.key).sort().join('|');
      if (after && after === before) { log('The agents could not fix the remaining bugs, so they wait for the developers.', 'warn'); break; }
    }
    if (!P.bugs.some(b => b.status === 'open')) log(P.config.checksOnly ? 'Done: the agents fixed every bug and the merged code compiles. Get the final code below.' : 'Done: the agents fixed every bug; the merged code builds and every test passes. Get the final code below.', 'ok');
  } finally { P.inAutoFix = false; changed(); }
}
// the agents fix every open bug now (the button, or right after an API key is added)
async function fixAll() {
  if (!(askClaude && hasAI())) throw new Error('No agent is connected. Connect Claude at the top (Claude Code or an API key) of the page first.');
  if (P.phase !== 'done') throw new Error('Merge first.');
  if (!P.bugs.some(b => b.status === 'open')) return publicState();
  P.toldNoAI = false; autoFix(); return publicState();
}
function aiConnected() { P.toldNoAI = false; scheduleAutoFix(); }
function setMode(m) { P.mode = m === 'report' ? 'report' : 'auto'; changed(); if (P.mode === 'auto') scheduleAutoFix(); return publicState(); }
// the final code: every file of the merged result, as one .zip
async function mergedZip() {
  restoreProbe();
  const dir = path.join(P.work || '', 'merged');
  if (!P.work || !fs.existsSync(dir)) throw new Error('Merge first.');
  const tracked = (await gitOk(['ls-files'], dir)).split('\n'), others = (await gitOk(['ls-files', '--others', '--exclude-standard'], dir)).split('\n');
  const names = [...new Set([...tracked, ...others])].filter(f => f && !/^tandemi-check\//.test(f) && f !== '.tandemi-plain.json' && f !== 'probe-backup.json' && fs.existsSync(path.join(dir, f)) && fs.statSync(path.join(dir, f)).isFile());
  return { name: (P.config.name || 'merged').replace(/[^\w.-]+/g, '-') + '-merged.zip', data: ZIP.zip(names.map(n => ({ name: n, data: fs.readFileSync(path.join(dir, n)) }))), count: names.length };
}
function summary(r) {
  const c = P.config && P.config.checksOnly;
  if (r.build && !r.build.ok) return `doesn't ${c ? 'compile' : 'build'} (${r.build.errors.length} error${r.build.errors.length === 1 ? '' : 's'})`;
  if (!r.ranTests) return c ? 'compiles' : 'builds';
  const pass = r.tests.filter(t => t.ok).length, n = r.tests.filter(t => !t.skipped).length;
  return `builds, ${pass} of ${n} tests pass`;
}

function vanishedNameBugs(found) {
  const out = [], dir = path.join(P.work, 'merged');
  const dyn = P.files.filter(f => !f.binary && !f.generated && FAST.dynLang(f.file));
  if (!dyn.length) return out;
  // everything the merged project defines, per language (all its files, not only the changed ones)
  const all = { py: new Set(), js: new Set() }, langsHere = new Set(dyn.map(f => FAST.dynLang(f.file)));
  (function walk(d, depth) { if (depth > 12) return; let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of list) { if (/^(\.git|node_modules|bin|obj|tandemi-check|__pycache__|dist|build|\.venv|venv)$/.test(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else { const l = FAST.dynLang(e.name); if (l && langsHere.has(l)) FAST.defsOfFile(p, l).forEach(n => all[l].add(n)); } } })(dir, 0);
  for (const side of ['A', 'B']) {
    const other = side === 'A' ? 'B' : 'A';
    for (const f of dyn) {
      if (f.from !== side && f.from !== 'both') continue;
      const lang = FAST.dynLang(f.file), before = FAST.defsOf(f.base || '', lang), after = FAST.defsOf(f[side] || '', lang);
      for (const name of before) {
        if (after.has(name) || all[lang].has(name) || name.length < 3) continue; // still defined somewhere: moved, not gone
        for (const g of dyn) {
          if (FAST.dynLang(g.file) !== lang) continue;
          const text = readMerged(g.file); if (text == null) continue;
          for (const u of FAST.usesOf(text, name, lang)) {
            const w = whoWroteLine(g.file, u.line);
            if (w !== other) continue; // only lines the other developer wrote
            if (found.some(b => b.file === g.file && b.line === u.line) || out.some(b => b.file === g.file && b.line === u.line)) continue;
            const hint = renameHint(`'${name}'`);
            out.push({ key: `static|${g.file}|${name}|${u.text}`, kind: 'static', owner: other, title: `${name} doesn't exist any more`, message: u.text, file: g.file, line: u.line,
              why: `${P.devs[side].name}${brn(side)} ${hint && hint.to ? `renamed ${name} to ${hint.to}` : `removed ${name}`}, but ${P.devs[other].name}${brn(other)} still uses it here. ${lang === 'py' ? 'Python' : 'JavaScript'} only notices when this line runs, so Tandemi found it by reading the merged code.`,
              hint: hint ? hint.text + (hint.to ? ` Use ${hint.to} here.` : '') : null, oldName: name, newName: hint ? hint.to : null });
          }
        }
      }
    }
  }
  return out.slice(0, 30);
}
// the exact line a change touched: before (common ancestor) and after (this developer), so a clash can be shown in code, not only by name
function changeDetail(side, label) {
  const name = FAST.changeName(label), m = String(label).match(/\(([^()]+)\)$/);
  if (!name || !m) return null;
  const f = P.files.find(x => path.basename(x.file) === m[1] && (x.from === side || x.from === 'both') && !x.binary && !x.generated);
  if (!f) return null;
  const re = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  const O = String(f.base || '').split('\n').filter(l => re.test(l)), X = String(f[side] || '').split('\n').filter(l => re.test(l));
  const os = new Set(O.map(l => l.trim())), xs = new Set(X.map(l => l.trim()));
  const before = O.find(l => !xs.has(l.trim())), after = X.find(l => !os.has(l.trim()));
  if (!after) return null;
  return { side, name, file: f.file, label, before: before ? before.trim() : null, after: after.trim() };
}
// a try (tryUndo) that was cut off by closing Tandemi: put the merged file back as it was
function restoreProbe() {
  if (!P.work) return;
  const backup = path.join(P.work, 'probe-backup.json');
  try { if (!fs.existsSync(backup)) return; const b = JSON.parse(fs.readFileSync(backup, 'utf8')); const abs = path.join(P.work, 'merged', b.file); if (rel(path.join(P.work, 'merged'), abs)) fs.writeFileSync(abs, b.content); fs.rmSync(backup, { force: true }); } catch (e) { /* nothing to put back */ }
}
// A clash between two changes: Tandemi undoes one change at a time in the merged code and runs the tests again,
// so the developers see which change breaks the test instead of guessing. The merged file is always put back.
async function tryUndo() {
  if (P.inAutoFix || P.config.checksOnly || !P.config.test) return;
  const dir = path.join(P.work, 'merged');
  const clashes = (P.bugs || []).filter(b => b.status === 'open' && b.kind === 'test' && b.clash);
  if (!clashes.length) return;
  // each change once (the same two changes often explain several failing tests), at most 4 trial runs
  const changes = [];
  for (const b of clashes) { b.tries = []; for (const c of [...b.clash.A, ...b.clash.B]) if (c.before && c.after && !changes.some(x => x.file === c.file && x.after === c.after)) changes.push(c); }
  for (const c of changes.slice(0, 4)) {
    const abs = path.join(dir, c.file); let orig;
    try { orig = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
    const lines = orig.split('\n'), i = lines.findIndex(l => l.trim() === c.after);
    if (i < 0 || lines.findIndex((l, j) => j > i && l.trim() === c.after) >= 0) continue; // not there any more, or not one clear line
    lines[i] = lines[i].match(/^\s*/)[0] + c.before + (lines[i].endsWith('\r') ? '\r' : '');
    step(`Trying the merged code without ${P.devs[c.side].name}'s ${c.name} change…`);
    const backup = path.join(P.work, 'probe-backup.json');
    try {
      fs.writeFileSync(backup, JSON.stringify({ file: c.file, content: orig })); // if Tandemi is closed mid-try, the file is put back next time
      fs.writeFileSync(abs, lines.join('\n'));
      const r = await runCached('probe', dir, await FAST.codeKey(P.base, keyCfg(plainFor(['A', 'B'])), dir, mergedFiles()), false);
      for (const b of clashes) {
        if (![...b.clash.A, ...b.clash.B].some(x => x.file === c.file && x.after === c.after)) continue;
        const t = r.ranTests ? r.tests.find(x => x.id === b.testId) : null;
        b.tries.push({ side: c.side, name: c.name, file: c.file, line: i + 1, before: c.before, after: c.after, passes: !!(t && t.ok), allPass: !!r.ok, summary: summary(r) });
      }
    } catch (e) { /* a try that can't run tells nothing */ } finally { fs.writeFileSync(abs, orig); try { fs.rmSync(backup, { force: true }); } catch (e) { /* gone */ } }
  }
  for (const b of clashes) { const good = b.tries.filter(x => x.passes); if (b.tries.length) log(good.length ? `Bug ${b.id}: the test passes without ${good.map(x => `${P.devs[x.side].name}'s ${x.name} change`).join(' or without ')}.` : `Bug ${b.id}: undoing one change alone doesn't fix it.`, good.length ? 'ok' : 'warn'); }
}
let bugSeq = 0;
function makeBugs() {
  const prev = P.bugs || [];
  // the test command fails with the same words in both versions and in the merged code, and Tandemi couldn't read a
  // single test from it: nothing about the changes, most likely this computer's setup
  const tc = (r) => (r && r.ranTests && r.tests.length === 1 && r.tests[0].id === '(test command)' && !r.tests[0].ok ? String(r.tests[0].message || '').trim().split('\n')[0] : null);
  if (!P.runs.merged.setup && tc(P.runs.merged) && tc(P.runs.merged) === tc(P.runs.A) && tc(P.runs.merged) === tc(P.runs.B)) P.runs.merged.setup = `The tests fail the same way in both versions and in the merged code, before any test runs, so this is most likely the setup of this computer, not anyone's change. What the test command printed: ${String(P.runs.merged.tests[0].message || '').trim().split('\n').slice(-3).join(' ')}`;
  if (P.runs.merged.setup) { P.bugs = prev; return; } // the tests didn't run: nothing is known about the bugs, keep them as they were
  const bugs = [];
  const M = P.runs.merged, RA = P.runs.A, RB = P.runs.B;
  const name = (s) => (s === 'both' ? `${P.devs.A.name} and ${P.devs.B.name}` : P.devs[s].name);
  const add = (b) => { const old = prev.find(x => x.key === b.key); bugs.push({ ...b, id: old ? old.id : ++bugSeq, status: 'open', isNew: !old && prev.length > 0 }); };
  if (M.build && !M.build.ok) {
    for (const e of M.build.errors) {
      const sideBroken = ['A', 'B'].filter(s => P.runs[s].build && !P.runs[s].build.ok && P.runs[s].build.errors.some(x => x.file === e.file && x.message === e.message));
      let owner, why;
      const hint = renameHint(e.message);
      if (sideBroken.length) { owner = sideBroken.length === 2 ? 'both' : sideBroken[0]; why = `This error is already in ${owner === 'both' ? 'both versions' : sideName(owner)} before the merge, so it goes to ${name(owner)}.`; }
      else {
        const w = whoWroteLine(e.file, e.line);
        owner = w || (hint ? (hint.side === 'A' ? 'B' : 'A') : 'both');
        why = `Each side ${P.config.checksOnly ? 'compiles' : 'builds'} on its own, but the merged code doesn't, so the two changes clash.${e.file ? ` ${path.basename(e.file)} line ${e.line} ${w === 'A' || w === 'B' ? `was written by ${name(w)}${brn(w)}` : w === 'both' ? 'was written by both' : 'was already there before'}.` : ''}`;
      }
      const alsoAt = hint ? FAST.stillUses(path.join(P.work, 'merged'), P.files.filter(f => !f.binary && !f.generated).map(f => f.file), hint.name, M.build.errors.map(x => ({ file: x.file, line: x.line }))) : [];
      add({ key: `build|${e.file}|${e.line}|${e.code}`, kind: 'build', owner, title: e.message.replace(/ and no accessible extension method[\s\S]*$/, '.').replace(/ \(are you missing[\s\S]*$/, '.'), message: e.message, file: e.file, line: e.line, code: e.code, why, hint: hint ? hint.text + (hint.to ? ` Use ${hint.to} here.` : '') : null, alsoAt, oldName: hint ? hint.name : null, newName: hint ? hint.to : null });
    }
  } else if (M.setup) {
    // the tests could not even start on this computer: a setup problem, nobody's bug
  } else if (M.ranTests) {
    const byId = (run, id) => (run && run.tests ? run.tests.find(t => t.id === id) : null);
    for (const t of M.tests.filter(x => !x.ok && !x.skipped)) {
      const ta = byId(RA, t.id), tb = byId(RB, t.id);
      const failedOn = ['A', 'B'].filter(s => { const x = s === 'A' ? ta : tb; return x && !x.ok && !x.skipped; });
      let owner, why, file = null, line = null, related = null, clash = null;
      const loc = (t.where || []).find(w => whoWroteLine(w.file, w.line)) || null;
      const plk = plainOf(t);
      if (plk && plk.keep && plk.status === 'fails-start' && failedOn.length === 2) { owner = 'both'; why = 'This test in plain words already failed on the starting code (it was kept anyway), so the merge did not cause it. Fix the code so the sentence becomes true, or change the test.'; }
      else if (failedOn.length) { owner = failedOn.length === 2 ? 'both' : failedOn[0]; why = `This test already fails in ${owner === 'both' ? 'both versions' : sideName(owner)} before the merge, so it goes to ${name(owner)}.`; }
      else if (loc) { owner = whoWroteLine(loc.file, loc.line); file = loc.file; line = loc.line; why = `This test passes in ${ta ? sideName('A') : ''}${ta && tb ? ' and ' : ''}${tb ? sideName('B') : ''} alone but fails after the merge. The error comes from ${path.basename(loc.file)} line ${loc.line}, which ${owner === 'both' ? 'both wrote' : name(owner) + ' wrote'}.`; }
      else {
        owner = 'both';
        const plainFiles = new Set(plainActive().map(x => x.file)); const where = (t.where || []).find(w => P.files.some(f => f.file === w.file) || plainFiles.has(w.file)); if (where) { file = where.file; line = where.line; }
        // which changes does this test depend on? follow the code from the test to what it calls
        const deps = file ? FAST.dependsOn(path.join(P.work, 'merged'), [...P.files.filter(f => !f.binary && !f.generated).map(f => f.file), ...plainFiles], file, line) : new Map();
        // each side's changes the test depends on, closest to the test first (only the closest ones are kept)
        const near = (list) => { const scored = list.map(c => [c, FAST.changeDepth(deps, c)]).filter(([, d]) => d !== undefined); const best = Math.min(...scored.map(([, d]) => d)); return scored.filter(([, d]) => d === best).map(([c]) => c); };
        const relA = near(changesOf('A')), relB = near(changesOf('B'));
        if (relA.length && relB.length) {
          related = { A: relA.slice(0, 4), B: relB.slice(0, 4) };
          clash = { A: relA.slice(0, 3).map(c => changeDetail('A', c)).filter(Boolean), B: relB.slice(0, 3).map(c => changeDetail('B', c)).filter(Boolean) };
          why = `This test passes on each branch alone but fails after the merge, so the two changes clash. Most likely cause: ${P.devs.A.name} ${relA.slice(0, 3).join(', ')} and ${P.devs.B.name} ${relB.slice(0, 3).join(', ')}. The test depends on both. It goes to both.`;
        } else why = `This test passes on each branch alone but fails after the merge, so the two changes clash. It goes to both. ${P.devs.A.name} changed: ${changesOf('A').slice(0, 5).join(', ') || 'nothing in code'}. ${P.devs.B.name} changed: ${changesOf('B').slice(0, 5).join(', ') || 'nothing in code'}.`;
      }
      const pl = plainOf(t);
      add({ related, clash, testId: t.id, plainId: pl ? pl.id : null, plainText: pl ? pl.text : null, key: `test|${t.id}`, kind: 'test', owner, title: pl ? `Your test "${pl.text}" fails` : t.id === '(test command)' ? require('./team.js').testTitle(t) : `Test ${t.name} fails`, message: t.message, file, line, why, hint: renameHint(t.message) ? renameHint(t.message).text : null });
    }
  }
  // Python and JavaScript: names one developer removed (or renamed) that the other still uses. No compiler catches this;
  // the code only breaks when that line runs. Tandemi finds it by reading the merged code.
  for (const b of vanishedNameBugs(bugs)) add(b);
  for (const old of prev) if (!bugs.some(b => b.key === old.key)) bugs.push(old.status === 'open' ? { ...old, status: 'fixed', fixedNote: old.fixedNote || 'Passes now.' } : old);
  P.bugs = bugs.sort((x, y) => (x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1) || x.id - y.id);
  const fixedNow = P.bugs.filter(b => b.status === 'fixed' && prev.some(p => p.key === b.key && p.status === 'open'));
  for (const b of P.bugs.filter(x => x.status === 'open' && !prev.some(p => p.key === x.key))) log(`${b.isNew && fixedNow.length ? `New bug ${b.id}: after the last fix the ${P.config.checksOnly ? 'check' : 'build'} got further and found this. ` : `Bug ${b.id} `}→ ${name(b.owner)}: ${b.title}${b.file ? ` (${path.basename(b.file)}${b.line ? ' line ' + b.line : ''})` : ''}`, 'err');
  for (const b of P.bugs.filter(x => x.status === 'open' && x.alsoAt && x.alsoAt.length && !prev.some(p => p.key === x.key))) log(`${b.oldName} is also still used in ${b.alsoAt.map(a => `${path.basename(a.file)} line ${a.line}`).join(', ')}. The ${P.config.checksOnly ? 'check' : 'build'} stops before it gets there, so fix ${b.alsoAt.length === 1 ? 'it' : 'them'} too.`, 'warn');
}

// ---------------------------------------------------------------- fixing in the merged code
function mergedFiles() {
  const dir = path.join(P.work, 'merged');
  if (!fs.existsSync(dir)) return [];
  const changedSet = new Set([...P.files.map(f => f.file), ...P.edited, ...plainActive().map(t => t.file)]);
  return [...changedSet].sort();
}
function readFile(file) {
  restoreProbe();
  const abs = path.join(P.work, 'merged', file);
  if (!rel(path.join(P.work, 'merged'), abs)) throw new Error('That file is outside the project.');
  if (!fs.existsSync(abs)) throw new Error(`There is no ${file} in the merged code.`);
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  return { file, content: text, authors: authorsOf(file, text.replace(/\r\n/g, '\n')) };
}
function writeFile(file, content, by) {
  const abs = path.join(P.work, 'merged', file);
  if (!rel(path.join(P.work, 'merged'), abs)) throw new Error('That file is outside the project.');
  if (P.busy) throw new Error('Tandemi is testing right now. Try again in a moment.');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, P.crlf && P.crlf.has(file) ? String(content).replace(/\r?\n/g, '\r\n') : content);
  P.edited.add(file); P.mergeBranch = null;
  log(`${by || 'Someone'} changed ${file} in the merged code.`);
  changed();
}
async function retest(force = true) { return buildAndTest(false, force); }
// the bugs one agent fixes together: same developer, same file (one AI call and one check instead of one per bug)
function fileFor(bug) { return bug.file || (P.files.find(f => (f.from === bug.owner || bug.owner === 'both') && !f.binary && !f.generated) || {}).file || null; }
function clashTarget(bug) {
  if (!bug.clash) return null;
  const all = [...(bug.clash.A || []), ...(bug.clash.B || [])].filter(c => c.file && !TEST_PATH.test(c.file));
  const mine = all.filter(c => bug.owner === 'both' || c.side === bug.owner);
  return ((mine[0] || all[0]) || {}).file || null;
}
function clashContext(bug, file) {
  const ch = [...(bug.clash.A || []), ...(bug.clash.B || [])].map(c => `- ${P.devs[c.side].name} changed in ${c.file}: "${c.before}" → "${c.after}"`).join('\n');
  const tries = (bug.tries || []).map(t => `- Without ${P.devs[t.side].name}'s change to ${t.name}: ${t.passes ? 'the test passes' : 'still fails'} (${t.summary || ''})`).join('\n');
  let test = ''; try { test = readFile(bug.file).content; } catch (e) { /* no test file */ }
  // the other changed files too, so the AI sees both sides of the clash (small ones only)
  const others = [...new Set([...(bug.clash.A || []), ...(bug.clash.B || [])].map(c => c.file))].filter(f => f && f !== file).map(f => { try { const c = readFile(f).content; return c.length < 20000 ? `\n\nThe file ${f} (for reference, don't send it back):\n${c}` : ''; } catch (e) { return ''; } }).join('');
  return `The bug: ${bug.title}${bug.message ? '\nDetails: ' + String(bug.message).split('\n').slice(0, 6).join('\n') : ''}\n\nThe test passes on each branch alone but fails after the merge, so these two changes clash:\n${ch}\n${tries ? 'Tandemi tried undoing each one:\n' + tries + '\n' : ''}\nDo NOT change the test, it says what must stay true. Change ${file} so the test passes again while keeping what both developers wanted as much as possible (for example pick a value that works with the other change). Every other test must keep passing too.${others}${test ? `\n\nThe test file ${bug.file}:\n${test}` : ''}`;
}
function groupOf(bug) { const f = fileFor(bug); return P.bugs.filter(b => b.status === 'open' && b.owner === bug.owner && fileFor(b) === f); }
async function fixWithAI(id) {
  if (!askClaude || !hasAI()) throw new Error('AI fixes need Claude connected (Claude Code with your subscription, or an API key), or let your AI coder fix it through the MCP.');
  const bug = P.bugs.find(b => b.id === Number(id) && b.status === 'open'); if (!bug) throw new Error('No such open bug.');
  // two changes that clash: the test is right, so the fix goes in one of the changed source files, not in the test
  const clashTo = clashTarget(bug), file = clashTo || fileFor(bug);
  if (!file) throw new Error('Tandemi does not know which file to fix for this bug.');
  const group = clashTo ? [bug] : groupOf(bug), keys = group.map(b => b.key), openBefore = P.bugs.filter(b => b.status === 'open').length;
  const before = readFile(file).content;
  const testsRanBefore = !P.bugs.some(b => b.status === 'open' && b.kind === 'build'); // with build errors the tests never ran, so a failing test showing up after the fix is not new
  const who = bug.owner === 'both' ? 'both developers' : P.devs[bug.owner].name;
  group.forEach(b => { b.fixing = true; }); changed();
  log(`${bug.owner === 'both' ? 'The agents are' : who + "'s agent is"} fixing ${group.length === 1 ? 'bug ' + bug.id : group.length + ' bugs (' + group.map(b => b.id).join(', ') + ')'} in ${file}…`);
  try {
    const list = group.map((b, i) => `${i + 1}. ${b.title}${b.line ? ` (line ${b.line})` : ''}\n   ${b.message && b.message !== b.title ? 'Details: ' + String(b.message).split('\n')[0] + '\n   ' : ''}Why it went to you: ${b.why}${b.hint ? '\n   Hint: ' + b.hint : ''}`).join('\n');
    const out = await askClaude(`You are the AI coding agent of ${who}. Two branches were merged and the merged code has ${group.length === 1 ? 'a bug' : 'bugs'} in one file. Fix ${group.length === 1 ? 'it' : 'all of them'} with the smallest change that keeps what both developers wanted. Answer with JSON only: {"content": "<the whole new file>", "why": "<one short sentence>"}`,
      `${clashTo ? clashContext(bug, file) : `${group.length === 1 ? 'Bug' : 'Bugs'} in ${file}:\n${list}`}\n\n${P.devs.A.name} changed: ${changesOf('A').join(', ')}\n${P.devs.B.name} changed: ${changesOf('B').join(', ')}\n\nThe file ${file} in the merged code:\n${before}`);
    if (typeof out.content !== 'string' || !out.content.trim()) throw new Error('Claude did not send a file');
    writeFile(file, out.content, bug.owner === 'both' ? 'The agents' : `${who}'s agent`);
    await buildAndTest(false);
    const still = keys.filter(k => P.bugs.some(b => b.key === k && b.status === 'open'));
    const openAfter = P.bugs.filter(b => b.status === 'open').length;
    // better = the bugs it worked on are gone and it didn't break the file it changed; a new bug somewhere else is fine
    // when the build only got further (a compiler stops at the first broken file, so the next one shows up only now)
    const newHere = P.bugs.some(b => b.status === 'open' && !keys.includes(b.key) && b.isNew && (fileFor(b) === file || (b.kind === 'test' && testsRanBefore)));
    if (still.length === keys.length || (openAfter >= openBefore && newHere)) { // nothing got better: undo it
      fs.writeFileSync(path.join(P.work, 'merged', file), P.crlf && P.crlf.has(file) ? before.replace(/\n/g, '\r\n') : before);
      log(`The fix didn't make things better, so it was undone.`, 'warn'); await buildAndTest(false);
    } else {
      for (const k of keys) { const b = P.bugs.find(x => x.key === k && x.status === 'fixed'); if (b) b.fixedNote = `Fixed by AI: ${out.why || 'see the merged code'}`; }
      log(`${keys.length - still.length} of ${keys.length} fixed: ${out.why || ''}`, 'ok');
    }
  } finally { group.forEach(b => { b.fixing = false; }); changed(); }
  return publicState();
}

// ---------------------------------------------------------------- tests in plain words
// Someone writes what must stay true ("the cat never jumps off the top of the screen"). An AI (Tandemi's own, or an
// AI coder through the MCP) or a person turns it into a real test in the project's own test framework. Tandemi checks
// it on the starting code first (it should pass there), then runs it on each developer's version and on the merge, so
// a merge that breaks the rule shows up as a bug like any other. The tests are saved per project and survive restarts.
const SRC_EXT = /\.(cs|js|mjs|cjs|ts|tsx|jsx|py|java|go|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;
const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)(\/|$)|tests?\.\w+$|_test\.\w+$|\.spec\.\w+$|(^|\/)test_[^/]*$/i;
const STOP = new Set('the a an and or of to in on at is are be it its this that should must never always can cannot when after before with without than then not no every each any all from for by as into out up down'.split(' '));
const plainPath = () => path.join(DATA, 'plain', crypto.createHash('sha1').update(String(P.path).toLowerCase()).digest('hex').slice(0, 12) + '.json');
// "Start over": close the project (nothing open, nothing remembered for this session)
function close() {
  if (P.busy) throw new Error('Tandemi is working on this project. Wait until it finishes, then start over.');
  for (const k of Object.keys(P)) delete P[k];
  Object.assign(P, { open: false, log: [], phase: 'idle', bugs: [], files: [], runs: {}, plain: [] }); changed();
}
// the plain-word tests saved for one project (the example and thrown-away pasted code start clean)
function forgetPlain(projectPath) { try { const f = path.join(DATA, 'plain', crypto.createHash('sha1').update(String(path.resolve(projectPath)).toLowerCase()).digest('hex').slice(0, 12) + '.json'); fs.rmSync(f, { force: true }); } catch (e) { /* nothing saved */ } }
function plainLoad() { try { P.plain = JSON.parse(fs.readFileSync(plainPath(), 'utf8')); } catch (e) { P.plain = []; } P.plain.forEach(t => { if (['writing', 'checking'].includes(t.status)) t.status = t.code ? 'unchecked' : 'new'; }); }
function plainSave() { try { fs.mkdirSync(path.dirname(plainPath()), { recursive: true }); fs.writeFileSync(plainPath(), JSON.stringify(P.plain.map(t => ({ ...t, busy: undefined })), null, 1)); } catch (e) { /* kept in memory */ } }
// the plain tests that run with every check: checked and passing on the starting code, or kept on purpose
const plainActive = () => (P.plain || []).filter(t => t.code && t.file && (t.status === 'ready' || t.keep));
const plainHash = (list = plainActive()) => (list.length ? FAST.sha1(list.map(t => t.file + '\0' + t.code).join('\0')).slice(0, 12) : '');
// the commands plus the plain tests: part of every cache key, so adding or changing one runs everything again
function keyCfg(list) { const h = plainHash(list); return h ? { ...P.config, test: `${P.config.test || ''}#plain:${h}` } : P.config; }
// put the plain tests into a folder that is about to be built (each branch, the merge, the starting code)
function overlayPlain(dir, list = plainActive()) {
  const want = new Set();
  for (const t of list) { const abs = path.join(dir, t.file); if (!rel(dir, abs)) continue; want.add(t.file); let same = false; try { same = fs.readFileSync(abs, 'utf8') === t.code; } catch (e) { /* not there yet */ } if (same) continue; fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, t.code); } // same text: not written, so the next build doesn't recompile the tests
  // a plain test that was removed or moved must not stay behind in the merged code (worktrees are cleaned by git)
  const mark = path.join(dir, '.tandemi-plain.json');
  let before = []; try { before = JSON.parse(fs.readFileSync(mark, 'utf8')); } catch (e) { /* first time */ }
  for (const f of before) if (!want.has(f)) { const abs = path.join(dir, f); if (rel(dir, abs)) try { fs.rmSync(abs, { force: true }); } catch (e) { /* gone */ } }
  try { if (want.size) fs.writeFileSync(mark, JSON.stringify([...want])); else fs.rmSync(mark, { force: true }); } catch (e) { /* only a note */ }
}
// A developer renamed something the plain test uses (RunSpeed → Speed): the test is Tandemi's, not theirs, so Tandemi
// follows the rename in the copy it puts into that version, instead of blaming the developer for a test that no longer compiles.
// each developer's changed lines, indexed by the names in them (built once per merge): for every name of a test,
// "was it removed by this developer, and what replaced it" is a lookup, not a search through every changed file
function sideIndex(side) {
  P._sideIdx = P._sideIdx || {};
  const c = P._sideIdx[side]; if (c && c.files === P.files) return c;
  const removedBy = new Map(), addedNames = new Set(), pairs = [];
  for (const f of (P.files || []).filter(f => (f.from === side || f.from === 'both') && !f.binary && !f.generated && f.base != null)) {
    const { added, removed } = lineSetDiff(f.base, f[side]);
    for (const l of added) for (const n of l.match(/[A-Za-z_]\w*/g) || []) addedNames.add(n);
    for (const l of removed) for (const n of new Set(l.match(/[A-Za-z_]\w{2,}/g) || [])) { if (!removedBy.has(n)) removedBy.set(n, []); removedBy.get(n).push({ l, added }); }
  }
  const idx = { files: P.files, removedBy, addedNames }; P._sideIdx[side] = idx; return idx;
}
function renamesFor(code, sides) {
  const out = []; if (!P.files || !P.files.length || !sides.length) return out;
  const toks = [...new Set(String(code).match(/[A-Za-z_]\w{2,}/g) || [])];
  for (const side of sides) {
    const idx = sideIndex(side);
    for (const nm of toks) {
      if (out.some(r => r.from === nm) || idx.addedNames.has(nm)) continue; // still there in this version: not renamed
      for (const { l, added } of idx.removedBy.get(nm) || []) {
        const pat = new RegExp('^' + l.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(new RegExp(`\\b${nm}\\b`), '(\\w+)') + '$');
        const hit = added.map(ad => ad.trim().match(pat)).find(m => m && m[1] !== nm);
        if (hit) { out.push({ side, from: nm, to: hit[1] }); break; }
      }
    }
  }
  return out;
}
// the same for the team merge (3+ developers): the plain tests of this project, renamed for the files the given
// developers changed ({ base, text } for each), so team.js can put them into each version it checks
// (a pull request check runs in its own process, where the project isn't open: it gets the list handed over)
let EXT_PLAIN = null;
const samePath = (x, y) => !!x && !!y && path.resolve(x).toLowerCase() === path.resolve(y).toLowerCase();
function plainForTeam(projectPath, changes) {
  const list = P.open && samePath(P.path, projectPath) ? plainActive() : EXT_PLAIN && samePath(EXT_PLAIN.path, projectPath) ? EXT_PLAIN.list : [];
  if (!list.length) return [];
  // one index per developer: a name counts as renamed when that developer replaced it (and didn't also add it somewhere)
  const idx = new Map();
  for (const c of changes || []) {
    if (!idx.has(c.side)) idx.set(c.side, { removedBy: new Map(), addedNames: new Set() });
    const x = idx.get(c.side), { added, removed } = c.diff || lineSetDiff(c.base || '', c.text);
    for (const l of added) for (const n of l.match(/[A-Za-z_]\w*/g) || []) x.addedNames.add(n);
    for (const l of removed) for (const n of new Set(l.match(/[A-Za-z_]\w{2,}/g) || [])) { if (!x.removedBy.has(n)) x.removedBy.set(n, []); x.removedBy.get(n).push({ l, added }); }
  }
  return list.map(t => {
    let code = t.code; const renames = [];
    for (const [side, x] of idx) for (const nm of [...new Set(String(t.code).match(/[A-Za-z_]\w{2,}/g) || [])]) {
      if (renames.some(r => r.from === nm) || x.addedNames.has(nm)) continue;
      for (const { l, added } of x.removedBy.get(nm) || []) {
        const pat = new RegExp('^' + l.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(new RegExp(`\\b${nm}\\b`), '(\\w+)') + '$');
        const hit = added.map(ad => ad.trim().match(pat)).find(m => m && m[1] !== nm);
        if (hit) { renames.push({ side, from: nm, to: hit[1] }); code = code.replace(new RegExp(`\\b${nm}\\b`, 'g'), hit[1]); break; }
      }
    }
    return { id: t.id, text: t.text, file: t.file, code, testName: t.testName, renames };
  });
}
// the plain tests as they go into one version: renamed for the developers whose code it is
function plainFor(sides, list = plainActive()) {
  return list.map(t => { let code = t.code; const ren = renamesFor(code, sides); for (const r of ren) code = code.replace(new RegExp(`\\b${r.from}\\b`, 'g'), r.to); return { id: t.id, file: t.file, code, renames: ren }; });
}
const plainOf = (t) => (P.plain || []).find(x => x.testName && (t.name === x.testName || t.id === x.testName || String(t.id).endsWith('.' + x.testName) || String(t.name).endsWith('.' + x.testName)));
// the code a plain test is about: files whose names or text use the words of the sentence, and the existing tests as an example
async function plainContext(text) {
  const rev = P.base || 'HEAD';
  const all = (await gitOk(['ls-tree', '-r', '--name-only', rev], P.path)).split('\n').filter(f => f && SRC_EXT.test(f) && !/(^|\/)(bin|obj|node_modules|dist|build|vendor)\//.test(f));
  const words = [...new Set((String(text).match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []).map(w => w.toLowerCase()).filter(w => !STOP.has(w)))];
  if (!P._ctxFiles || P._ctxFiles.rev !== rev || P._ctxFiles.path !== P.path) {
    const blobs = await FAST.readBlobs(P.path, all.slice(0, 3000).map(f => `${rev}:${f}`));
    P._ctxFiles = { rev, path: P.path, list: all.slice(0, 3000).map(f => { const b = blobs.get(`${rev}:${f}`); const t = b ? b.toString('utf8') : ''; return { f, t, low: t.toLowerCase() }; }) };
  }
  const scored = P._ctxFiles.list.map(({ f, t: s, low }) => {
    const name = f.toLowerCase();
    // a word the code uses (also inside longer names: "jump" finds JumpPower), more if it is in the file name
    const score = words.reduce((n, w) => n + (low.includes(w) ? 1 : 0) + (name.includes(w) ? 2 : 0), 0);
    return { file: f, text: s, score, test: TEST_PATH.test(f) };
  }).filter(x => x.text.length < 150000);
  const pick = (list, n, cap) => { const out = []; let size = 0; for (const x of list) { if (out.length >= n || size + x.text.length > cap) continue; out.push(x); size += x.text.length; } return out; };
  const by = (a, b) => b.score - a.score || a.file.length - b.file.length;
  return { rev, source: pick(scored.filter(x => !x.test && x.score > 0).sort(by), 5, 40000), tests: pick(scored.filter(x => x.test).sort(by), 2, 12000), testFiles: scored.filter(x => x.test).map(x => x.file).slice(0, 200), allFiles: all };
}
function plainPrompt(t, ctx, errors) {
  const system = `You turn one requirement written in plain words into ONE automated test for an existing project. Use the project's own test framework and the same style as its existing tests (same namespace, attributes, assert helpers, imports). The test must pass on the current code if the requirement holds, and fail if a later change breaks it. Test the behaviour the sentence describes, through the project's public code; do not copy numbers from the code into the test unless the sentence is about them. Put the test in a NEW file next to the existing tests, so it is built and run by the same test command (never change an existing file). Answer with JSON only: {"file": "<path of the new file, relative to the project root>", "code": "<the whole new file>", "testName": "<the test's method or function name, exactly as written in the code>", "why": "<one short sentence: what the test checks>"}`;
  const user = [`Requirement: ${t.text}`, `Project: ${P.config.name} (${(P.config.languages || []).join(', ') || 'unknown language'}). Test command: ${P.config.test || '(none)'}${P.config.build ? `. Build command: ${P.config.build}` : ''}.`,
    ctx.tests.length ? `Existing tests (follow their style):\n${ctx.tests.map(x => `--- ${x.file}\n${x.text}`).join('\n')}` : `There are no tests yet. Test files in the project: ${ctx.testFiles.join(', ') || 'none'}.`,
    `Other test files: ${ctx.testFiles.join(', ') || 'none'}`,
    ctx.source.length ? `The code the requirement is about:\n${ctx.source.map(x => `--- ${x.file}\n${x.text}`).join('\n')}` : `Files in the project: ${ctx.allFiles.slice(0, 300).join(', ')}`,
    errors ? `Your last attempt (${t.file}) did not work:\n${errors}\nFix it and send the whole file again.` : ''].filter(Boolean).join('\n\n');
  return { system, user };
}
// a new test file must be new, inside the project, and in the project's language
async function plainValidate(file, code, testName, id) {
  const f = String(file || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!f || /(^|\/)\.\.(\/|$)/.test(f) || path.isAbsolute(f)) throw new Error('The test needs a file path inside the project, like tests/MyGame.Tests/PlainTests.cs');
  if (!SRC_EXT.test(f)) throw new Error(`${f} is not a code file.`);
  if (!String(code || '').trim()) throw new Error('The test has no code.');
  if (!String(testName || '').trim()) throw new Error('Say the name of the test (its method or function name), so Tandemi can find its result.');
  if (!new RegExp(`\\b${String(testName).replace(/[^\w$]/g, '')}\\b`).test(code)) throw new Error(`There is no ${testName} in the code of the test.`);
  const rev = P.base || 'HEAD';
  const exists = await git(['cat-file', '-e', `${rev}:${f}`], P.path);
  if (!exists.code) throw new Error(`${f} already exists in the project. A plain-word test goes in a new file.`);
  const other = (P.plain || []).find(t => t.id !== Number(id) && (t.file === f || (t.testName && t.testName === String(testName).trim())));
  if (other) throw new Error(other.file === f ? `${f} is already used by the test "${other.text}". Use another file name.` : `The test "${other.text}" already has a test named ${testName}. Use another name.`);
  return f;
}
// run one plain test (and the other active ones) on the starting code
async function plainCheck(t) {
  const rev = P.base || (await gitOk(['rev-parse', 'HEAD'], P.path)).trim();
  const list = [...plainActive().filter(x => x.id !== t.id && x.file !== t.file), t];
  const dir = await worktree('start', rev); overlayPlain(dir, list);
  const r = await runCached('start', dir, await FAST.commitKey(rev, keyCfg(list)), false);
  if (r.setup) return { status: 'unchecked', note: r.setup };
  if (r.build && !r.build.ok) {
    const mine = r.build.errors.filter(e => e.file && e.file.replace(/\\/g, '/') === t.file);
    if (mine.length || r.build.errors.some(e => !e.file)) return { status: 'error', note: `It doesn't ${P.config.checksOnly ? 'compile' : 'build'}: ${(mine.length ? mine : r.build.errors).slice(0, 5).map(e => `${e.file ? path.basename(e.file) + ' line ' + e.line + ': ' : ''}${e.message}`).join(' | ')}`, errors: (mine.length ? mine : r.build.errors).slice(0, 8).map(e => `line ${e.line}: ${e.message}`).join('\n') };
    return { status: 'unchecked', note: `The starting code doesn't ${P.config.checksOnly ? 'compile' : 'build'} by itself, so the test couldn't be checked: ${r.build.errors[0].message}` };
  }
  if (!r.ranTests) return { status: 'unchecked', note: 'This project has no test command, so a plain-word test can\'t run. Add "test" to tandemi.json.' };
  const res = r.tests.find(x => plainOf(x) === t || x.name === t.testName || String(x.id).endsWith('.' + t.testName) || String(x.name).endsWith('.' + t.testName));
  if (!res) return { status: 'error', note: `The test ran, but Tandemi found no result named ${t.testName}. Is it in the folder the test command runs?`, errors: `No test named ${t.testName} ran. The test command was: ${P.config.test}` };
  if (res.ok) return { status: 'ready', note: 'Passes on the starting code. It now runs with every check.' };
  return { status: 'fails-start', note: `Fails already on the starting code: ${String(res.message || '').split('\n')[0]}. Either the sentence isn't true yet, or the test is wrong. Look at the code, or keep it anyway.`, errors: String(res.message || '').slice(0, 800) };
}
async function waitFree() { for (let i = 0; P.busy && i < 3600; i++) await new Promise(r => setTimeout(r, 500)); if (P.busy) throw new Error('Tandemi is still busy.'); }
async function plainRun(t, fn) {
  await waitFree(); P.busy = true; t.busy = true; changed();
  try { return await fn(); } finally { P.busy = false; t.busy = false; plainSave(); changed(); }
}
// after a plain test changed: check the merge again, so it runs on both versions and on the merged code
async function plainAfter() { if (P.runs && P.runs.merged && P.phase === 'done') { await buildAndTest(false); } }

function plainAdd(text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  if (s.length < 5) throw new Error('Write what the test should check, in a sentence.');
  if (!P.open) throw new Error('Open a project first.');
  P.plain = P.plain || [];
  const t = { id: Math.max(0, ...P.plain.map(x => x.id)) + 1, text: s.slice(0, 500), status: 'new', note: '', file: null, code: null, testName: null, by: null };
  P.plain.push(t); plainSave(); log(`New test in plain words: "${t.text}"`);
  if (askClaude && hasAI()) setTimeout(() => plainWrite(t.id).catch(e => log(`Couldn't write the test "${t.text}": ${e.message}`, 'warn')), 0);
  else { t.note = 'Waiting for someone to write it: connect Claude at the top, ask your AI coder (MCP tool project_plain_tests), or write it yourself.'; plainSave(); }
  changed(); return publicState();
}
// Tandemi's own AI writes the test, checks it on the starting code, and tries again (twice) when it doesn't build
async function plainWrite(id) {
  if (!askClaude || !hasAI()) throw new Error('Writing tests with AI needs Claude connected (Claude Code with your subscription, or an API key), or let your AI coder do it through the MCP (project_plain_tests), or write it yourself.');
  const t = (P.plain || []).find(x => x.id === Number(id)); if (!t) throw new Error('No such plain-word test.');
  const ctx = await plainContext(t.text);
  let errors = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    t.status = 'writing'; t.note = attempt > 1 ? `Fixing the test (try ${attempt} of 3)…` : 'AI is writing the test…'; changed();
    const { system, user } = plainPrompt(t, ctx, errors);
    const out = await askClaude(system, user);
    let file;
    try { file = await plainValidate(out.file, out.code, out.testName, t.id); } catch (e) { errors = e.message; t.status = 'error'; t.note = e.message; continue; }
    Object.assign(t, { file, code: String(out.code), testName: String(out.testName).trim(), why: out.why || '', by: 'AI' });
    t.status = 'checking'; t.note = 'Checking it on the starting code…'; changed();
    const res = await plainRun(t, () => plainCheck(t));
    Object.assign(t, { status: res.status, note: res.note }); plainSave(); changed();
    if (res.status !== 'error') break;
    errors = res.errors || res.note;
  }
  log(`Test "${t.text}": ${t.note}`, t.status === 'ready' ? 'ok' : 'warn');
  if (t.status === 'ready') await plainAfter();
  return publicState();
}
// a person or an AI coder (MCP) gives the code of the test
async function plainSet(id, file, code, testName, by) {
  const t = (P.plain || []).find(x => x.id === Number(id)); if (!t) throw new Error('No such plain-word test.');
  const f = await plainValidate(file, code, testName, id);
  Object.assign(t, { file: f, code: String(code), testName: String(testName).trim(), by: by || 'by hand', keep: false, status: 'checking', note: 'Checking it on the starting code…' }); changed();
  const res = await plainRun(t, () => plainCheck(t));
  Object.assign(t, { status: res.status, note: res.note }); plainSave();
  log(`Test "${t.text}": ${t.note}`, t.status === 'ready' ? 'ok' : 'warn');
  if (t.status === 'ready') await plainAfter();
  return publicState();
}
async function plainKeep(id, keep) { const t = (P.plain || []).find(x => x.id === Number(id)); if (!t || !t.code) throw new Error('No such plain-word test with code.'); t.keep = keep !== false; plainSave(); changed(); await plainAfter(); return publicState(); }
async function plainRemove(id) { const n = (P.plain || []).length; P.plain = (P.plain || []).filter(x => x.id !== Number(id)); if (P.plain.length === n) throw new Error('No such plain-word test.'); plainSave(); changed(); await plainAfter(); return publicState(); }
// for an AI coder: everything it needs to write the waiting tests itself
async function plainTasks() {
  const out = [];
  for (const t of (P.plain || []).filter(x => x.status !== 'ready' && !x.keep)) { const ctx = await plainContext(t.text); out.push({ id: t.id, requirement: t.text, status: t.status, note: t.note, ...plainPrompt(t, ctx, t.status === 'error' || t.status === 'fails-start' ? t.note : null) }); }
  return { tests: (P.plain || []).map(t => ({ id: t.id, text: t.text, status: t.status, file: t.file, testName: t.testName, note: t.note })), toWrite: out, how: 'Write each test in toWrite as described in its "system" and "user" text, then send it with project_plain_set_code (id, file, code, testName). Tandemi checks it on the starting code and then runs it on every version.' };
}

// ---------------------------------------------------------------- saving the merge as a real merge commit
async function createBranch(name) {
  if (P.busy) throw new Error('Tandemi is testing right now.');
  if (!P.runs.merged && P.phase !== 'done') throw new Error('Merge first (and solve any real conflicts).');
  const branch = String(name || `tandemi/merge-${P.devs.A.branch}-${P.devs.B.branch}`).replace(/[^\w./-]+/g, '-').replace(/\.\.+/g, '.');
  const dir = path.join(P.work, 'merged');
  const files = mergedFiles();
  for (const f of files) {
    if (fs.existsSync(path.join(dir, f))) await gitOk(['add', '-f', '--', f], dir);
    else await git(['rm', '--cached', '-q', '--ignore-unmatch', '--', f], dir);
  }
  const tree = (await gitOk(['write-tree'], dir)).trim();
  const open = P.bugs.filter(b => b.status === 'open').length;
  const msg = `Merge ${P.devs.A.branch} and ${P.devs.B.branch} (Tandemi)\n\nMerged by structure: ${P.files.filter(f => f.method === 'ast').length} file(s); real conflicts solved: ${P.files.reduce((n, f) => n + f.conflicts.length, 0)}.\nResult: ${P.runs.merged ? summary(P.runs.merged) : 'not built or tested (no build or test command)'}.${open ? ` ${open} open bug(s).` : ''}`;
  const commit = (await gitOk(['-c', 'user.name=Tandemi', '-c', 'user.email=tandemi@localhost', 'commit-tree', tree, '-p', P.sha.A, '-p', P.sha.B, '-m', msg], P.path)).trim();
  await gitOk(['branch', '-f', branch, commit], P.path);
  P.mergeBranch = { name: branch, commit: commit.slice(0, 8), push: `git push -u origin ${branch}` };
  P.branches = await listBranches();
  log(`Saved the merge as branch ${branch} (${commit.slice(0, 8)}). Push it and open a pull request: ${P.mergeBranch.push}`, 'ok');
  changed();
  return publicState();
}

// ---------------------------------------------------------------- what the page and the MCP see
function publicState() {
  if (!P.open || !P.config) return { open: false, log: P.log || [] }; // also while a project is still opening
  const run = (r) => (r ? { ok: r.ok, build: r.build, ranTests: r.ranTests, tests: r.tests.map(t => ({ id: t.id, name: t.name, ok: t.ok, skipped: t.skipped, message: t.message })), summary: summary(r), output: r.ok ? '' : r.output.slice(-6000) } : null);
  return {
    open: true, path: P.path, source: P.source || 'git', name: P.config.name, kind: P.config.kind, languages: P.config.languages || [], configSource: P.config.source,
    commands: { build: P.config.build || null, test: P.config.test || null },
    branches: P.branches, current: P.current, a: P.a, b: P.b, base: P.base ? P.base.slice(0, 8) : null, devs: P.devs,
    phase: P.phase, step: P.step, busy: P.busy, log: P.log.slice(-80), gitView: P.gitView,
    files: (P.files || []).map(f => ({ file: f.file, from: f.from, method: f.method, language: f.language, lineConflicts: f.lineConflicts, binary: !!f.binary, generated: !!f.generated, changes: f.changes, parseError: f.parseError || null, conflicts: f.conflicts.map(c => ({ id: c.id, label: c.label, base: c.base, a: c.a, b: c.b, note: c.note, pick: c.pick || null, why: c.why, busy: !!c.busy, binary: !!c.binary, deleted: !!c.deleted })) })),
    runs: { A: run(P.runs && P.runs.A), B: run(P.runs && P.runs.B), merged: run(P.runs && P.runs.merged) },
    plain: (P.plain || []).map(t => ({ id: t.id, text: t.text, status: t.status, note: t.note, file: t.file, code: t.code, testName: t.testName, why: t.why || '', by: t.by, keep: !!t.keep, busy: !!t.busy })), bugs: P.bugs || [], setupProblem: (P.runs && P.runs.merged && P.runs.merged.setup) || null, mergedFiles: (P.runs && P.runs.merged) || P.phase === 'done' ? mergedFiles() : [], mergeBranch: P.mergeBranch, hasAI: !!(askClaude && hasAI()), mode: P.mode || 'auto', autoFixing: !!P.inAutoFix, checksOnly: !!P.config.checksOnly,
  };
}

module.exports = { plainForTeam, setExternalPlain: (p, list) => { EXT_PLAIN = { path: p, list: (list || []).filter(t => t && t.file && typeof t.code === 'string') }; }, plainActiveFor: (p) => (P.open && samePath(P.path, p) ? plainActive().map(t => ({ id: t.id, text: t.text, file: t.file, code: t.code, testName: t.testName })) : []), plainHashOf: (list) => plainHash(list), overlayPlain, close, forgetPlain, plainAdd, plainWrite, plainSet, plainKeep, plainRemove, plainTasks, helpers: { git, gitOk, shell, detect, buildErrors, parseResults, frames, missingTool, lineSetDiff, rel }, init, setMode, fixAll, aiConnected, mergedZip, open, fetchAll, startMerge, pick, aiPick, retest, readFile, writeFile, fixWithAI, createBranch, publicState, setClaude: (fn) => { askClaude = fn; }, parseResults, buildErrors };
