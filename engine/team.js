// team.js · Tandemi for a whole team: three or more developers (branches) merged at once.
// Like a merge queue, but it explains: every branch is merged by the code's structure in order; a branch that really
// conflicts with an earlier one waits. Then each branch is checked alone and everything together. When the
// together-version breaks, Tandemi finds exactly which developers clash (who wrote the broken line, whose change
// caused it, and if that isn't clear, it checks the pairs), sends the bug to its owner, and still gives you a merge
// of everyone who works together ("works now"), while the agents fix the rest.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MERGE = require('./merge.js');
const ZIP = require('./zip.js');
const FAST = require('./fast.js');
const { git, gitOk, shell, detect, buildErrors, parseResults, frames, missingTool, lineSetDiff, rel } = require('./repo.js').helpers;

const KEYS = 'ABCDEFGHIJKL'.split('');
let DATA = null, onChange = () => {}, askClaude = null, hasAI = () => !!askClaude;
let T = { open: false, log: [] };
let bugSeq = 0;

function init(opts) { DATA = opts.dataDir; FAST.cacheInit(DATA); onChange = opts.onChange || onChange; askClaude = opts.claude || null; if (opts.hasAI) hasAI = opts.hasAI; }
function changed() { onChange(publicState()); }
function log(text, cls = '') { T.log.push({ text, cls, at: Date.now() }); if (T.log.length > 200) T.log.shift(); changed(); }
function step(s) { T.step = s; changed(); }
const nm = (k) => (T.devs && T.devs[k] ? T.devs[k].name : k);
const names = (ks) => { const l = ks.map(nm); return l.length < 2 ? l.join('') : l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1]; };
const isGit = () => T.source === 'git';
// a branch Tandemi fetched itself (a pull request) or the remote's main branch is shown by its name only
const shortRef = (b) => String(b || '').replace(/^refs\/(heads|remotes)\//, '');
const sideLabel = (k) => (!isGit() ? `${nm(k)}'s version` : /^refs\/tandemi\//.test(T.devs[k].branch) || shortRef(T.devs[k].branch).replace(/^origin\//, '') === nm(k) ? nm(k) : `${shortRef(T.devs[k].branch)} (${nm(k)})`);

// ---------------------------------------------------------------- git helpers (on T.path / T.work)
async function worktree(name, rev) {
  const dir = path.join(T.work, name);
  await git(['worktree', 'prune'], T.path);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const co = await git(['checkout', '-f', '--detach', rev], dir);
    if (!co.code) { await git(FAST.cleanArgs(), dir); return dir; } // build output stays: incremental builds
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* recreate */ }
    await git(['worktree', 'prune'], T.path);
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await gitOk(['worktree', 'add', '-f', '--detach', dir, rev], T.path);
  return dir;
}
async function show(rev, file) {
  let buf = T.blobs ? T.blobs.get(`${rev}:${file}`) : undefined;
  if (buf === null) return null;
  if (buf === undefined) { const r = await git(['show', `${rev}:${file}`], T.path, { encoding: 'buffer' }); if (r.code) return null; buf = Buffer.isBuffer(r.out) ? r.out : Buffer.from(r.out); }
  if (buf.includes(0)) return { binary: true };
  const text = buf.toString('utf8'); if (text.includes('\r\n')) T.crlf.add(file);
  return text.replace(/\r\n/g, '\n');
}
async function nameStatus(from, to) {
  const out = await gitOk(['diff', '--name-status', '--no-renames', from, to], T.path);
  const m = new Map(); for (const l of out.split('\n').filter(Boolean)) { const [st, f] = l.split('\t'); m.set(f, st[0]); } return m;
}
async function authorOf(range) {
  const out = (await git(['log', '--format=%an|%ae', range], T.path)).out.trim().split('\n').filter(Boolean);
  const count = {}; for (const l of out) count[l] = (count[l] || 0) + 1;
  const top = Object.entries(count).sort((x, y) => y[1] - x[1])[0];
  const [name, email] = top ? top[0].split('|') : ['(no commits)', ''];
  return { name, email, commits: out.length };
}

// ---------------------------------------------------------------- composing: merge a list of developers, in order
// Returns the merged files and the developers that had to wait because of a real conflict with an earlier one.
function compose(keys) {
  const cur = new Map(); // file -> { text, by: [keys], method, language, take }
  const included = [], blocked = [];
  for (const k of keys) {
    const tentative = new Map(), conflicts = [];
    for (const e of T.files) {
      if (!e.changedBy.includes(k) || e.generated) continue;
      const cx = cur.get(e.file) || { text: e.base && !e.base.binary ? e.base : (e.base ? e.base : null), by: [] };
      const vk = e.v[k];
      if (e.binary) {
        const prev = cx.by.length ? cx.by[cx.by.length - 1] : null;
        const res = resOf(k, e.file, `${e.file} (a binary file)`);
        if (prev && e.blob[prev] !== e.blob[k] && !res) conflicts.push({ file: e.file, label: `${e.file} (a binary file)`, with: prev, a: `(${nm(prev)}'s version)`, b: `(${nm(k)}'s version)`, binary: true });
        else tentative.set(e.file, { take: res && res.pick === 'with' ? cx.take || prev : k, by: [...cx.by, k], method: 'one side', binary: true });
        continue;
      }
      if (!cx.by.length) { tentative.set(e.file, { text: vk, by: [k], method: 'one side' }); continue; }
      if (cx.text === vk) { tentative.set(e.file, { text: vk, by: [...cx.by, k], method: cx.method === 'ast' ? 'ast' : 'same' }); continue; }
      if (cx.text == null || vk == null) {
        const res = resOf(k, e.file, e.file);
        if (res) { tentative.set(e.file, { text: res.pick === 'with' ? cx.text : res.pick === 'custom' ? res.custom : vk, by: [...cx.by, k], method: 'whole file' }); continue; }
        conflicts.push({ file: e.file, label: e.file, with: cx.by[cx.by.length - 1], a: cx.text || '(deleted it)', b: vk || '(deleted it)', note: vk == null ? `${nm(k)} deleted this file; it was changed before.` : `${nm(k)} changed this file; it was deleted before.` });
        continue;
      }
      const r = MERGE.merge(e.file, e.base || '', cx.text, vk);
      const open = r.conflicts.filter(c => { const res = resOf(k, e.file, c.label); if (!res) return true; c.pick = res.pick === 'with' ? 'A' : res.pick === 'self' ? 'B' : 'custom'; c.custom = res.pick === 'both' ? [c.a, c.b].filter(Boolean).join('\n') : res.custom; return false; });
      if (open.length) {
        const c = open[0], ca = String(c.a || '').trim();
        // the earlier developer whose own change really conflicts with this one
        const partner = cx.by.length === 1 ? cx.by[0] : cx.by.slice().reverse().find(p => typeof e.v[p] === 'string' && MERGE.merge(e.file, e.base || '', e.v[p], vk).conflicts.length) || cx.by.slice().reverse().find(p => typeof e.v[p] === 'string' && ca && e.v[p].includes(ca)) || cx.by[cx.by.length - 1];
        for (const oc of open) conflicts.push({ file: e.file, label: oc.label, with: partner, a: oc.a, b: oc.b, base: oc.base, note: oc.note ? oc.note.replace('Developer A', nm(partner)).replace('Developer B', nm(k)) : null });
        continue;
      }
      tentative.set(e.file, { text: MERGE.fill(r.template, r.conflicts), by: [...cx.by, k], method: r.method, language: r.language || cx.language, lineConflicts: r.lineConflicts });
    }
    if (conflicts.length) blocked.push({ key: k, conflicts });
    else { included.push(k); for (const [f, v] of tentative) cur.set(f, v); }
  }
  return { keys: included, blocked, files: cur };
}
// how a real conflict was solved: keep the earlier developer's ("with"), this developer's ("self"), both, or custom code
const resOf = (k, file, label) => (T.resolutions || {})[`${k}|${file}|${label}`] || null;
async function recompose() {
  const prevKeys = T.full ? T.full.keys : [], saved = new Map();
  for (const f of T.edited || []) { const t = readIn('full', f); if (t != null) saved.set(f, t); }
  const comp = compose(T.order);
  T.full = { keys: comp.keys, files: comp.files }; T.blocked = comp.blocked; T.safe = null; T.heldKey = null;
  await writeComposed('full', T.full);
  // keep the fixes already made, unless a developer who just joined changed that file too
  const joined = comp.keys.filter(k => !prevKeys.includes(k));
  for (const [f, text] of saved) {
    const e = T.files.find(x => x.file === f);
    if (e && e.changedBy.some(k => joined.includes(k))) { T.edited.delete(f); log(`The fix in ${f} was made before ${names(joined)} joined, who changed it too, so it starts again from the merge.`, 'warn'); continue; }
    fs.writeFileSync(path.join(T.work, 'full', f), T.crlf.has(f) ? text.replace(/\n/g, '\r\n') : text);
  }
  if (!canCheck()) { T.phase = 'done'; T.final = 'full'; T.included = T.full.keys.slice(); return; }
  await checkTeam(true);
}
async function resolve(key, file, label, pick, custom) {
  if (T.busy) throw new Error('Tandemi is busy. Try again in a moment.');
  const b = (T.blocked || []).find(x => x.key === key), c = b && b.conflicts.find(x => x.file === file && x.label === label);
  if (!c) throw new Error('No such conflict.');
  if (!['with', 'self', 'both', 'custom'].includes(pick) || (pick === 'custom' && typeof custom !== 'string') || (pick === 'both' && c.binary)) throw new Error('Choose whose version to keep.');
  (T.resolutions = T.resolutions || {})[`${key}|${file}|${label}`] = { pick, custom };
  c.pick = pick;
  log(`${c.label}: ${pick === 'with' ? `kept ${nm(c.with)}'s version` : pick === 'self' ? `kept ${nm(key)}'s version` : pick === 'both' ? 'kept both' : 'combined'}.`);
  if (b.conflicts.every(x => resOf(key, x.file, x.label))) {
    log(`${nm(key)}'s conflicts are solved, so ${nm(key)} joins the merge.`, 'ok');
    T.busy = true; try { await recompose(); } catch (e) { log(e.message, 'err'); throw e; } finally { T.busy = false; changed(); setTimeout(scheduleAutoFix, 0); }
  } else changed();
  return publicState();
}
const context = (file, a, b) => { const e = T.files.find(x => x.file === file); if (!e) return ''; const cut = (t) => (t && t.length > 12000 ? t.slice(0, 12000) + '\n…' : t || '(deleted)'); return `\n\nFor context, ${nm(a)}'s whole file:\n${cut(e.v[a])}\n\n${nm(b)}'s whole file:\n${cut(e.v[b])}`; };
async function aiResolve(key, file, label) {
  if (!askClaude || !hasAI()) throw new Error('Letting AI combine needs Claude connected (Claude Code with your subscription, or an API key).');
  const b = (T.blocked || []).find(x => x.key === key), c = b && b.conflicts.find(x => x.file === file && x.label === label);
  if (!c || c.binary) throw new Error('No such conflict.');
  c.busy = true; changed();
  let code;
  try {
    const out = await askClaude('You merge code. Two developers changed the same part of a file differently. Write ONE version of that part that keeps what both wanted and compiles. Your code replaces only this part; the rest of the file stays as merged. If one developer removed this part because they moved or renamed it (their whole file shows where), apply the other developer\'s change there in spirit and do not repeat code that already exists elsewhere: the answer can be an empty string. Answer with JSON only: {"code": "<the combined code for this part only>", "why": "<one short sentence>"}',
      `File: ${file}\nPart: ${label}\n\nStarting version:\n${c.base || '(not there)'}\n\n${nm(c.with)}'s version:\n${c.a || '(removed it)'}\n\n${nm(key)}'s version:\n${c.b || '(removed it)'}${context(file, c.with, key)}`);
    if (typeof out.code !== 'string') throw new Error('Claude did not send code');
    code = out.code; c.why = String(out.why || '');
  } finally { c.busy = false; changed(); }
  return resolve(key, file, label, 'custom', code);
}
async function writeComposed(name, comp) {
  const dir = await worktree(name, T.base);
  for (const [file, v] of comp.files) {
    const abs = path.join(dir, file);
    if (v.binary) {
      const r = await git(['show', `${T.devs[v.take].sha}:${file}`], T.path, { encoding: 'buffer' });
      if (r.code) { try { fs.rmSync(abs); } catch (e) { /* gone */ } } else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, r.out); }
      continue;
    }
    if (v.text == null) { try { fs.rmSync(abs); } catch (e) { /* not there */ } continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, T.crlf.has(file) ? v.text.replace(/\n/g, '\r\n') : v.text);
  }
  // fixes made in the everyone-together code: carry each fixed file over when everyone who changed it is in this group
  if (name !== 'full') for (const file of T.edited || []) {
    const e = T.files.find(x => x.file === file);
    const who = e ? e.changedBy.filter(k => T.full.keys.includes(k)) : null;
    if (!who || !who.every(k => comp.keys.includes(k))) continue;
    const src = path.join(T.work, 'full', file);
    if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.copyFileSync(src, path.join(dir, file)); }
  }
  return dir;
}

// who wrote each line (any number of developers): the developers whose own change added that line
const addedCache = new Map();
function addedBy(e, k) {
  const id = e.file + '\u0000' + k;
  if (!addedCache.has(id)) {
    const O = (e.base && !e.base.binary ? e.base : '').split('\n').map(s => s.trim()), X = String(e.v[k] || '').split('\n').map(s => s.trim());
    const m = MERGE.diffMap(X, O); addedCache.set(id, new Set(X.filter((l, i) => m[i] === -1 && l)));
  }
  return addedCache.get(id);
}
function lineAuthors(file, text, keys) {
  const e = T.files.find(x => x.file === file);
  if (!e || e.binary || text == null) return null;
  const ks = keys.filter(k => e.changedBy.includes(k) && typeof e.v[k] === 'string');
  return text.split('\n').map(l => { const t = l.trim(); if (!t || /^[\s{}()[\];,]*$/.test(t)) return []; return ks.filter(k => addedBy(e, k).has(t)); });
}
function readIn(dirName, file) { try { return fs.readFileSync(path.join(T.work, dirName, file), 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return null; } }
function whoWrote(dirName, keys, file, line) { if (!file || !line) return []; const au = lineAuthors(file, readIn(dirName, file), keys); return (au && au[line - 1]) || []; }
// "Ana renamed Health to Hp in Player.cs": a name in the error that one developer removed
function renameHint(message, keys) {
  const quoted = [...String(message).matchAll(/'([A-Za-z_]\w*)'/g)].map(m => m[1]);
  const found = [...new Set([...quoted, ...[...String(message).matchAll(/[A-Za-z_]\w{2,}/g)].map(m => m[0])])].filter(n => !/^(int|float|string|bool|void|object|double|var|variable|symbol|cannot|find|does|not|contain|definition|for|the|type|has|field|method|undefined|name|exist|current|context|property|class|member|named|attribute|object)$/i.test(n));
  for (const name of found) {
    const re = new RegExp(`\\b${name}\\b`);
    for (const k of keys) for (const e of T.files) {
      if (!e.changedBy.includes(k) || typeof e.v[k] !== 'string') continue;
      const { added, removed } = fileDiff(e, k);
      const gone = removed.filter(l => re.test(l)); if (!gone.length || added.some(l => re.test(l))) continue;
      let to = null;
      for (const l of gone) for (const ad of added) { const m = ad.trim().match(new RegExp('^' + l.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(name, '(\\w+)') + '$')); if (m && m[1] !== name) { to = m[1]; break; } }
      return { key: k, name, to, file: e.file, text: `${sideLabel(k)} ${to ? `renamed ${name} to ${to}` : `removed ${name}`} in ${path.basename(e.file)}.` };
    }
  }
  return null;
}

// ---------------------------------------------------------------- checking (build, tests, or a compile check)
function summary(r) {
  const c = T.config && T.config.checksOnly;
  if (!r) return 'not checked';
  if (r.build && !r.build.ok) return `doesn't ${c ? 'compile' : 'build'} (${r.build.errors.length} error${r.build.errors.length === 1 ? '' : 's'})`;
  if (!r.ranTests) return c ? 'compiles' : 'builds';
  const pass = r.tests.filter(t => t.ok).length, n = r.tests.filter(t => !t.skipped).length;
  return `builds, ${pass} of ${n} tests pass`;
}
const canCheck = () => !!(T.config.build || T.config.test);
// what one developer changed in one file (added and removed lines), worked out once per merge and reused
const fileDiff = (e, k) => (e._diff || (e._diff = {}))[k] || (e._diff[k] = lineSetDiff(typeof e.base === 'string' ? e.base : '', e.v[k]));
// ---- tests in plain words: the project's own plain tests run in every version the team merge checks
// (renamed for the developers in that version, like in the two-developer merge)
function plainFor(keys) {
  const changes = [];
  for (const e of T.files || []) if (!e.binary && !e.generated) for (const k of keys) if (e.changedBy.includes(k) && typeof e.v[k] === 'string') changes.push({ side: k, diff: fileDiff(e, k) });
  try { return require('./repo.js').plainForTeam(T.path, changes); } catch (e) { return []; }
}
// the commands plus the plain tests, for cache keys: adding or changing a plain test checks everything again
const cfgFor = (pl) => { const h = pl && pl.length ? require('./repo.js').plainHashOf(pl) : ''; return h ? { ...T.config, test: `${T.config.test || ''}#plain:${h}` } : T.config; };
function overlay(dir, pl) { if (pl && (pl.length || fs.existsSync(path.join(dir, '.tandemi-plain.json')))) require('./repo.js').overlayPlain(dir, pl); }
const plainOfTest = (p, pl) => (pl || []).find(x => x.testName && (p.id === x.testName || String(p.id).endsWith('.' + x.testName) || String(p.name || '').endsWith('.' + x.testName) || p.name === x.testName));
// a check, or the remembered result of exactly the same code with the same tools
async function checkCode(name, dir, what, files, force, keys) {
  const pl = plainFor(keys || T.order || []); overlay(dir, pl);
  const key = await FAST.codeKey(T.base, cfgFor(pl), dir, [...files, ...(T.edited || [])]);
  if (!force) { const hit = FAST.getRun(key); if (hit) return hit; }
  const r = await check(name, dir, what); if (!r.setup) FAST.putRun(key, r); return r;
}
async function check(name, dir, what) {
  const cfg = T.config, results = path.join(T.work, 'results-' + name);
  try { fs.rmSync(results, { recursive: true, force: true }); } catch (e) { /* none */ }
  fs.mkdirSync(results, { recursive: true });
  const fill = (s) => String(s || '').replace(/\{results\}/g, results.replace(/\\/g, '/'));
  const run = { ok: true, build: null, tests: [], output: '', ranTests: false };
  if (cfg.build) {
    step(`${what}: ${cfg.checksOnly ? 'checking that it compiles' : 'building'}…`);
    const r = await shell(fill(cfg.build), dir, cfg.timeoutSec || 900);
    run.output += r.out;
    const errs = buildErrors(r.out, dir);
    run.build = { ok: r.code === 0, errors: errs, secs: r.secs };
    if (r.code) { run.ok = false; const setup = errs.length ? FAST.setupOf(r.out, errs) : missingTool(r.out, cfg.build); if (setup) run.setup = setup; if (!errs.length) run.build.errors = [{ file: null, line: null, code: 'build', message: setup || r.out.trim().split('\n').slice(-6).join('\n') }]; return run; }
  }
  if (cfg.test) {
    step(`${what}: running the tests…`);
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
    if (!run.tests.length) { const setup = r.code ? missingTool(r.out, cfg.test) : null; if (setup) run.setup = setup; run.tests.push({ id: '(test command)', name: 'The test command', ok: r.code === 0, message: r.code ? setup || r.out.trim().split('\n').slice(-6).join('\n') : '', stack: r.out.slice(-4000) }); }
    for (const t of run.tests) t.where = frames(t.stack + '\n' + t.message, dir);
    run.ok = run.tests.every(t => t.ok || t.skipped);
  }
  return run;
}
// a readable title: for a plain test command (no result file), the line that says what failed
function testTitle(t) {
  if (t.id !== '(test command)') return `Test ${t.name} fails`;
  const lines = String((t.stack || '') + '\n' + (t.message || '')).split('\n').map(l => l.trim()).filter(Boolean);
  const ok = (l) => !/^at\s/.test(l) && !/^node:/.test(l) && !/^throw /.test(l) && l !== '^';
  const hit = lines.find(l => ok(l) && /^(AssertionError|\w*Error)\b.*:|FAIL|failed|expected/i.test(l)) || lines.find(l => ok(l) && /error/i.test(l));
  return hit ? `The tests fail: ${hit.replace(/^AssertionError \[ERR_ASSERTION\]:\s*/, '').slice(0, 160)}` : 'The tests fail';
}
// the problems of a run, each with a signature that doesn't depend on line numbers
function problems(run) {
  if (!run || run.ok || run.setup) return []; // a setup problem of this computer is nobody's bug
  if (run.build && !run.build.ok) return run.build.errors.map(e => ({ sig: `build|${e.file}|${e.message}`, kind: 'build', file: e.file, line: e.line, code: e.code, message: e.message, title: e.message.replace(/ and no accessible extension method[\s\S]*$/, '.').replace(/ \(are you missing[\s\S]*$/, '.') }));
  return run.tests.filter(t => !t.ok && !t.skipped).map(t => ({ sig: `test|${t.id}`, kind: 'test', id: t.id, message: t.message, where: t.where || [], title: testTitle(t) }));
}
const aloneHas = (k, p) => problems(T.runs.alone[k]).some(x => x.sig === p.sig);

// who owns each problem of the together-version, and who it clashes with
function attribute(p, keys, dirName) {
  const own = keys.filter(k => aloneHas(k, p));
  if (own.length) return { owner: own[0], partner: null, own: true, file: p.file, line: p.line, why: `This ${p.kind === 'build' ? 'error' : 'test failure'} is already in ${own.length === 1 ? sideLabel(own[0]) : names(own) + "'s versions"} before the merge, so it isn't a clash: it's ${own.length === 1 ? nm(own[0]) + "'s" : 'their'} own bug.` };
  const hint = renameHint(p.message, keys);
  let file = p.file, line = p.line;
  const plainFiles = p.kind === 'test' ? new Set(plainFor(keys).map(x => x.file)) : new Set();
  if (p.kind === 'test') { const loc = p.where.find(w => whoWrote(dirName, keys, w.file, w.line).length) || p.where.find(w => T.files.some(f => f.file === w.file)) || p.where.find(w => plainFiles.has(w.file)); if (loc) { file = loc.file; line = loc.line; } }
  const wrote = whoWrote(dirName, keys, file, line);
  let owner = null, partner = hint ? hint.key : null;
  if (wrote.length === 1) owner = wrote[0];
  else if (wrote.length > 1 && partner) owner = wrote.find(k => k !== partner) || wrote[0];
  if (owner && partner === owner) partner = null;
  if (!owner && partner) { // the line wasn't changed by anyone else: the one who still uses the old name is whoever touched that file
    const users = keys.filter(k => k !== partner && T.files.some(f => f.file === file && f.changedBy.includes(k)));
    if (users.length === 1) owner = users[0];
  }
  // a failing test: which developers' changes does it depend on? (follow the code from the test to what it calls)
  let cause = null;
  if (p.kind === 'test' && file && (!owner || !partner)) {
    const deps = FAST.dependsOn(path.join(T.work, dirName), [...new Set([...T.files.filter(e => !e.binary && !e.generated).map(e => e.file), ...plainFiles])], file, line);
    const rel = {};
    for (const k of keys) {
      const list = [];
      for (const e of T.files) if (e.changedBy.includes(k) && typeof e.v[k] === 'string' && !e.binary) for (const c of MERGE.describe(e.file, e.base && !e.base.binary ? e.base : '', e.v[k]) || []) { const d = FAST.changeDepth(deps, c); if (d !== undefined) list.push([`${c} (${path.basename(e.file)})`, d]); }
      if (list.length) { const best = Math.min(...list.map(x => x[1])); rel[k] = { d: best, list: list.filter(x => x[1] === best).map(x => x[0]) }; }
    }
    const who = Object.keys(rel).sort((x, y) => rel[x].d - rel[y].d || keys.indexOf(x) - keys.indexOf(y));
    if (who.length >= 2) {
      const [a, b] = who.slice(0, 2).sort((x, y) => keys.indexOf(x) - keys.indexOf(y));
      if (!owner) { owner = b; partner = a; } else if (!partner) partner = owner === a ? b : a;
      cause = `Most likely cause: ${nm(a)} ${rel[a].list.slice(0, 3).join(', ')} and ${nm(b)} ${rel[b].list.slice(0, 3).join(', ')}. The test depends on both.`;
    }
  }
  const where = file ? `${path.basename(file)}${line ? ' line ' + line : ''}` : '';
  const why = cause ? `Each version works on its own, but together they don't. ${cause} It goes to ${nm(owner)}, whose change came later; ${nm(partner)} can help.` : owner
    ? `Each version ${T.config.checksOnly ? 'compiles' : 'works'} on its own, but together they don't.${where ? ` ${where} was written by ${nm(owner)}.` : ''}${partner ? ` It clashes with ${nm(partner)}'s change.` : ''}`
    : `Each version ${T.config.checksOnly ? 'compiles' : 'works'} on its own, but together they don't.`;
  return { owner, partner, file, line, why, hint: hint ? hint.text + (hint.to ? ` Use ${hint.to} here.` : '') : null, oldName: hint ? hint.name : null, newName: hint ? hint.to : null };
}

function vanishedNameBugs(keys, dir, found) {
  const out = [], dyn = T.files.filter(e => !e.binary && !e.generated && FAST.dynLang(e.file));
  if (!dyn.length) return out;
  const all = { py: new Set(), js: new Set() }, langsHere = new Set(dyn.map(e => FAST.dynLang(e.file)));
  (function walk(d, depth) { if (depth > 12) return; let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of list) { if (/^(\.git|node_modules|bin|obj|tandemi-check|__pycache__|dist|build|\.venv|venv)$/.test(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else { const l = FAST.dynLang(e.name); if (l && langsHere.has(l)) FAST.defsOfFile(p, l).forEach(n => all[l].add(n)); } } })(dir, 0);
  for (const k of keys) for (const e of dyn) {
    if (!e.changedBy.includes(k) || typeof e.v[k] !== 'string') continue;
    const lang = FAST.dynLang(e.file), before = FAST.defsOf(e.base && !e.base.binary ? e.base : '', lang), after = FAST.defsOf(e.v[k], lang);
    for (const name of before) {
      if (after.has(name) || all[lang].has(name) || name.length < 3) continue;
      for (const g of dyn) {
        if (FAST.dynLang(g.file) !== lang) continue;
        const text = readIn(path.basename(dir), g.file); if (text == null) continue;
        for (const u of FAST.usesOf(text, name, lang)) {
          const wrote = whoWrote(path.basename(dir), keys, g.file, u.line).filter(x => x !== k);
          if (wrote.length !== 1) continue;
          if (found.some(b => b.file === g.file && b.line === u.line) || out.some(b => b.file === g.file && b.line === u.line)) continue;
          const hint = renameHint(`'${name}'`, keys);
          out.push({ key: `static|${g.file}|${name}|${u.text}`, kind: 'static', owner: wrote[0], partner: k, title: `${name} doesn't exist any more`, message: u.text, file: g.file, line: u.line,
            why: `${nm(k)} ${hint && hint.to ? `renamed ${name} to ${hint.to}` : `removed ${name}`}, but ${nm(wrote[0])} still uses it here. ${lang === 'py' ? 'Python' : 'JavaScript'} only notices when this line runs, so Tandemi found it by reading the merged code.`,
            hint: hint ? hint.text + (hint.to ? ` Use ${hint.to} here.` : '') : null, oldName: name, newName: hint ? hint.to : null });
        }
      }
    }
  }
  return out.slice(0, 30);
}

// ---------------------------------------------------------------- the team merge
async function start(opts) {
  if (T.busy) throw new Error('Tandemi is already merging this team. Wait until it finishes.');
  const branches = (opts.branches || []).map(b => (typeof b === 'string' ? { ref: b } : b)).filter(b => b && b.ref);
  if (branches.length < 2) throw new Error('Choose at least two branches.');
  if (branches.length > KEYS.length) throw new Error(`Tandemi merges up to ${KEYS.length} developers at once.`);
  if (new Set(branches.map(b => b.ref)).size !== branches.length) throw new Error('Choose each branch only once.');
  await MERGE.ready;
  const top = await git(['rev-parse', '--show-toplevel'], path.resolve(opts.path));
  if (top.code) throw new Error(`${opts.path} is not a git repository.`);
  const root = path.resolve(top.out.trim());
  T = { open: true, active: true, path: root, source: opts.source || 'git', busy: true, phase: 'merging', step: '', log: [], bugs: [], runs: { alone: {} }, files: [], crlf: new Set(), edited: new Set(), mode: T.mode || 'auto', startedAt: Date.now() };
  addedCache.clear(); bugSeq = 0;
  try {
    T.config = await detect(root);
    if (opts.title) T.config.name = String(opts.title);
    T.work = path.join(DATA, 'team', crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12));
    step('Reading the branches…');
    T.order = branches.map((b, i) => KEYS[i]);
    T.devs = {};
    for (const [i, b] of branches.entries()) {
      const r = await git(['rev-parse', b.ref], root);
      if (r.code) throw new Error(`There is no branch ${b.ref}.`);
      T.devs[KEYS[i]] = { key: KEYS[i], branch: b.ref, sha: r.out.trim() };
    }
    const mb = await git(['merge-base', '--octopus', ...T.order.map(k => T.devs[k].sha)], root);
    if (mb.code) throw new Error('These branches have no common starting point.');
    T.base = mb.out.trim();
    for (const k of T.order) { Object.assign(T.devs[k], await authorOf(`${T.base}..${T.devs[k].sha}`)); if (branches[T.order.indexOf(k)].name) T.devs[k].name = branches[T.order.indexOf(k)].name; }
    log(`Merging ${T.order.length} developers: ${T.order.map(k => isGit() ? `${T.devs[k].branch} (${nm(k)}, ${T.devs[k].commits} commit${T.devs[k].commits === 1 ? '' : 's'})` : nm(k)).join(', ')}.`);
    // what plain git would say, for every pair
    const pairs = [], gitFiles = new Set();
    for (let i = 0; i < T.order.length; i++) for (let j = i + 1; j < T.order.length; j++) {
      const a = T.order[i], b = T.order[j];
      const mt = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', T.devs[a].sha, T.devs[b].sha], root);
      if (mt.code === 1 && mt.out) { const files = mt.out.trim().split('\n').slice(1).filter(Boolean); pairs.push({ a, b, files }); files.forEach(f => gitFiles.add(f)); }
    }
    T.gitView = { pairs, conflictFiles: [...gitFiles] };
    // every changed file, in every version
    const status = {}; for (const k of T.order) status[k] = await nameStatus(T.base, T.devs[k].sha);
    const all = [...new Set(T.order.flatMap(k => [...status[k].keys()]))].sort();
    step(`Reading ${all.length} changed file${all.length === 1 ? '' : 's'}…`);
    const real = all.filter(f => !/(^|\/)(bin|obj)\//i.test(f));
    await MERGE.prepare(real);
    T.blobs = await FAST.readBlobs(root, real.flatMap(f => [`${T.base}:${f}`, ...T.order.filter(k => status[k].has(f)).map(k => `${T.devs[k].sha}:${f}`)])); // one git process for all of them
    for (const f of all) {
      const e = { file: f, changedBy: T.order.filter(k => status[k].has(f)), v: {}, blob: {} };
      if (/(^|\/)(bin|obj)\//i.test(f)) { e.generated = true; T.files.push(e); continue; }
      e.base = await show(T.base, f);
      for (const k of e.changedBy) {
        const v = await show(T.devs[k].sha, f);
        if (v && v.binary) { e.binary = true; e.blob[k] = (await git(['rev-parse', `${T.devs[k].sha}:${f}`], root)).out.trim(); }
        e.v[k] = v && !v.binary ? v : (v ? v : null);
      }
      if (e.base && e.base.binary) e.binary = true;
      T.files.push(e);
    }
    T.blobs = null;
    // merge everyone, in order (like a merge queue)
    const comp = compose(T.order);
    T.full = { keys: comp.keys, files: comp.files };
    T.blocked = comp.blocked;
    for (const b of comp.blocked) log(`${nm(b.key)} has a real conflict with ${nm(b.conflicts[0].with)} in ${b.conflicts[0].file}${b.conflicts.length > 1 ? ` (and ${b.conflicts.length - 1} more)` : ''}: both changed the same part differently. ${nm(b.key)} waits.`, 'warn');
    const ast = [...comp.files.values()].filter(v => v.method === 'ast').length;
    log(`${all.length} changed file${all.length === 1 ? '' : 's'}. git would stop on ${gitFiles.size} file${gitFiles.size === 1 ? '' : 's'} (${pairs.length} pair${pairs.length === 1 ? '' : 's'} of developers). Tandemi merged ${ast} by structure; ${comp.blocked.length ? `${comp.blocked.length} developer${comp.blocked.length === 1 ? '' : 's'} with a real conflict` : 'no real conflicts'}.`, comp.blocked.length ? 'warn' : 'ok');
    await writeComposed('full', T.full);
    if (!canCheck()) { T.phase = 'done'; T.final = 'full'; T.included = T.full.keys.slice(); step('Merged. Nothing to build or test, so Tandemi only merged it.'); log('No build or tests found, so the merge was not checked.', 'warn'); return publicState(); }
    // each developer alone
    for (const k of T.order) {
      const pl = plainFor([k]), key = await FAST.commitKey(T.devs[k].sha, cfgFor(pl));
      let r = FAST.getRun(key);
      if (!r) { const d = await worktree('dev-' + k, T.devs[k].sha); overlay(d, pl); r = await check('dev-' + k, d, sideLabel(k) + ' alone'); if (!r.setup) FAST.putRun(key, r); }
      T.runs.alone[k] = r;
      log(`${sideLabel(k)} alone: ${summary(r)}${r.cached ? ' (same code as before)' : ''}.`, r.ok ? 'ok' : 'warn');
    }
    await checkTeam(true);
    return publicState();
  } catch (e) { T.phase = 'error'; step(e.message); log(e.message, 'err'); throw e; }
  finally { T.busy = false; changed(); setTimeout(scheduleAutoFix, 0); }
}

// check everyone together; if it breaks, find who clashes and build "works now" from everyone else
async function checkTeam(fresh, force) {
  T.phase = 'testing'; changed();
  const keys = T.full.keys;
  const dir = path.join(T.work, 'full');
  T.runs.full = await checkCode('full', dir, keys.length === T.order.length ? 'Everyone together' : `Together (${names(keys)})`, [...T.full.files.keys()], force, keys);
  const plNow = plainFor(keys);
  for (const r of [...new Map(plNow.flatMap(x => x.renames).map(r => [r.from, r])).values()]) if (!(T.toldRename || (T.toldRename = new Set())).has(r.from)) { T.toldRename.add(r.from); log(`${nm(r.side)} renamed ${r.from} to ${r.to}, so Tandemi updated the plain-word tests that use it.`); }
  log(`${keys.length === T.order.length ? 'Everyone together' : 'Together: ' + names(keys)}: ${summary(T.runs.full)}.`, T.runs.full.ok ? 'ok' : 'err');
  const probs = problems(T.runs.full);
  const prev = T.bugs || [];
  const bugs = [];
  const unknown = [];
  for (const p of probs) {
    const a = attribute(p, keys, 'full');
    const old = prev.find(x => x.key === p.sig);
    const alsoAt = a.oldName && p.kind === 'build' ? FAST.stillUses(dir, [...T.full.files.keys(), ...(T.edited || [])].filter(f => { const e = T.files.find(x => x.file === f); return !e || (!e.binary && !e.generated); }), a.oldName, probs.filter(x => x.kind === 'build').map(x => ({ file: x.file, line: x.line }))) : [];
    const plk = p.kind === 'test' ? plainOfTest(p, plNow) : null;
    const bug = { plainId: plk ? plk.id : null, plainText: plk ? plk.text : null, key: p.sig, id: old ? old.id : ++bugSeq, status: 'open', isNew: !old && prev.length > 0, kind: p.kind, title: plk ? `Your test "${plk.text}" fails` : p.title, message: p.message, file: a.file || p.file || null, line: a.line || p.line || null, owner: a.owner, partner: a.partner, why: a.why, hint: a.hint, own: !!a.own, alsoAt, oldName: a.oldName, newName: a.newName };
    bugs.push(bug);
    if (!bug.owner) unknown.push(bug);
  }
  // not clear who clashes: check the developers in pairs (only the pairs that can answer the question)
  const unclear = bugs.filter(u => !u.own && (!u.owner || !u.partner));
  if (unclear.length && keys.length > 2 && fresh) {
    const pairs = [], seen = new Set();
    const addPair = (x, y) => { const [a, b] = keys.indexOf(x) < keys.indexOf(y) ? [x, y] : [y, x]; const id = a + b; if (a !== b && !seen.has(id)) { seen.add(id); pairs.push([a, b]); } };
    for (const u of unclear) { if (u.owner) keys.forEach(k => addPair(u.owner, k)); else for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) addPair(keys[i], keys[j]); }
    // most likely clashes first: pairs whose changes share names with the error and with each other
    const idsOf = (t) => new Set(String(t || '').match(/[A-Za-z_]\w{2,}/g) || []);
    const changedIds = {}; for (const k of keys) { const ids = new Set(); for (const e of T.files) if (e.changedBy.includes(k) && typeof e.v[k] === 'string') { const { added, removed } = fileDiff(e, k); for (const l of [...added, ...removed]) idsOf(l).forEach(x => ids.add(x)); } changedIds[k] = ids; }
    const errIds = new Set(unclear.flatMap(u => [...idsOf(u.title + ' ' + (u.message || ''))]));
    const score = ([a, b]) => { let sc = 0; for (const x of changedIds[a]) { if (changedIds[b].has(x)) sc += 1; if (errIds.has(x)) sc += 3; } for (const x of changedIds[b]) if (errIds.has(x)) sc += 3; return sc; };
    pairs.sort((p, q) => score(q) - score(p));
    if (pairs.length <= 15) {
      log(`To find exactly who clashes, Tandemi checks ${pairs.length} pair${pairs.length === 1 ? '' : 's'} of developers.`);
      for (const [a, b] of pairs) {
        if (!unclear.some(u => !u.owner || !u.partner)) break;
        const c = compose([a, b]); if (c.blocked.length) continue;
        const d = await writeComposed('pair', c);
        const ps = problems(await checkCode('pair', d, `${nm(a)} + ${nm(b)}`, [...c.files.keys()], false, [a, b]));
        for (const u of unclear) {
          if (!ps.some(x => x.sig === u.key)) continue;
          if (!u.owner) { u.owner = b; u.partner = a; u.why = `${nm(a)} and ${nm(b)} each work alone, but not together: Tandemi checked them as a pair. It goes to ${nm(b)}, whose change came later; ${nm(a)} can help.`; }
          else if (!u.partner && (a === u.owner || b === u.owner)) { u.partner = a === u.owner ? b : a; u.why += ` Tandemi checked the pairs: it breaks when ${nm(u.owner)} and ${nm(u.partner)} are merged together.`; }
        }
      }
    }
  }
  // Python and JavaScript: names one developer removed (or renamed) that another still uses (no compiler catches it)
  for (const b of vanishedNameBugs(keys, dir, bugs)) { const old = prev.find(x => x.key === b.key); bugs.push({ ...b, id: old ? old.id : ++bugSeq, status: 'open', isNew: !old && prev.length > 0 }); }
  for (const u of bugs) if (!u.owner) { u.owner = keys[keys.length - 1]; u.why += ` Tandemi couldn't tell who clashes, so it goes to ${nm(u.owner)}, whose change came last.`; }
  for (const old of prev) if (!bugs.some(b => b.key === old.key)) bugs.push(old.status === 'open' ? { ...old, status: 'fixed', fixedNote: old.fixedNote || 'Works now.' } : old);
  T.bugs = bugs.sort((x, y) => (x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1) || x.id - y.id);
  const fixedNow = T.bugs.filter(b => b.status === 'fixed' && prev.some(p => p.key === b.key && p.status === 'open'));
  for (const b of T.bugs.filter(x => x.status === 'open' && !prev.some(p => p.key === x.key))) log(`${b.isNew && fixedNow.length ? `New bug ${b.id}: after the last fix the check got further and found this. ` : `Bug ${b.id} `}→ ${nm(b.owner)}${b.partner ? ` (clashes with ${nm(b.partner)})` : ''}: ${b.title}${b.file ? ` (${path.basename(b.file)}${b.line ? ' line ' + b.line : ''})` : ''}`, 'err');
  for (const b of T.bugs.filter(x => x.status === 'open' && x.alsoAt && x.alsoAt.length && !prev.some(p => p.key === x.key))) log(`${b.oldName} is also still used in ${b.alsoAt.map(a => `${path.basename(a.file)} line ${a.line}`).join(', ')}. The check stops before it gets there, so fix ${b.alsoAt.length === 1 ? 'it' : 'them'} too.`, 'warn');
  const open = T.bugs.filter(b => b.status === 'open');
  if (!open.length) {
    T.included = keys.slice(); T.final = 'full'; T.safe = null; T.phase = 'done';
    step(T.blocked.length ? `${names(keys)} work together. ${names(T.blocked.map(b => b.key))} wait${T.blocked.length === 1 ? 's' : ''} (real conflict).` : 'Everyone works together.');
    log(T.blocked.length ? `Done: ${names(keys)} merged and checked. Get the final code below.` : 'Done: everyone merged and checked. Get the final code below.', 'ok');
    return;
  }
  // "works now": everyone except the developers who have to fix something
  const heldKey = [...new Set(open.map(b => b.owner))].sort().join(',');
  if (fresh || !T.safe || heldKey !== T.heldKey) {
    T.heldKey = heldKey;
    let held = new Set(open.map(b => b.owner));
    let safe = keys.filter(k => !held.has(k)), run = null;
    for (let i = 0; i < keys.length && safe.length; i++) {
      const c = compose(safe); const d = await writeComposed('safe', c);
      run = await checkCode('safe', d, `Without ${names([...held])}`, [...c.files.keys()], false, safe);
      if (run.ok) break;
      const more = problems(run).map(p => attribute(p, safe, 'safe').owner).filter(Boolean);
      const drop = more.length ? more : [safe[safe.length - 1]];
      drop.forEach(k => held.add(k)); safe = safe.filter(k => !held.has(k)); run = null;
    }
    if (safe.length && run && run.ok) {
      T.safe = { keys: safe, run }; T.included = safe; T.final = 'safe';
      log(`Works now: ${names(safe)} together (${summary(run)}). ${names([...held])} wait${held.size === 1 ? 's' : ''} until ${held.size === 1 ? 'their bug is' : 'their bugs are'} fixed.`, 'ok');
    } else { T.safe = null; T.included = []; T.final = 'full'; log('No group of these developers works together yet. Fix the bugs below.', 'warn'); }
  }
  T.phase = 'done';
  step(`${open.length} bug${open.length === 1 ? '' : 's'} sent to ${names([...new Set(open.map(b => b.owner))])}.`);
}

// ---------------------------------------------------------------- fixing (in the everyone-together code)
function mergedFiles() {
  const dir = path.join(T.work || '', 'full');
  if (!T.work || !fs.existsSync(dir)) return [];
  return [...new Set([...T.full.files.keys(), ...(T.edited || [])])].filter(f => !T.files.find(e => e.file === f && e.generated)).sort();
}
function readFile(file) {
  const base = path.join(T.work, 'full'), abs = path.join(base, file);
  if (!rel(base, abs)) throw new Error('That file is outside the project.');
  if (!fs.existsSync(abs)) throw new Error(`There is no ${file} in the merged code.`);
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  const au = lineAuthors(file, text, T.full.keys);
  return { file, content: text, authors: au ? au.map(ks => (ks.length === 1 ? ks[0] : ks.length > 1 ? 'both' : null)) : null, authorKeys: au };
}
function writeFile(file, content, by) {
  const base = path.join(T.work, 'full'), abs = path.join(base, file);
  if (!rel(base, abs)) throw new Error('That file is outside the project.');
  if (T.busy) throw new Error('Tandemi is checking right now. Try again in a moment.');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, T.crlf.has(file) ? String(content).replace(/\r?\n/g, '\r\n') : content);
  (T.edited = T.edited || new Set()).add(file);
  log(`${by || 'Someone'} changed ${file} in the merged code.`);
  changed();
}
async function retest(force = true) {
  if (T.busy) throw new Error('Tandemi is already checking.');
  if (!T.open || !T.full) throw new Error('Merge first.');
  T.busy = true;
  try { if (force) await FAST.tools(true); await checkTeam(false, force); return publicState(); }
  finally { T.busy = false; changed(); setTimeout(scheduleAutoFix, 0); }
}
// the bugs one agent fixes together: same developer, same file (one AI call and one check instead of one per bug)
function fileFor(bug) { return bug.file || (T.files.find(f => f.changedBy.includes(bug.owner) && !f.binary && !f.generated) || {}).file || null; }
// a failing test where two developers' changes clash: the test says what must stay true, so the fix goes into
// the source file the owner changed (the one the test depends on, named in "why" when Tandemi found it), not into the test
const TESTFILE = /(^|\/)(tests?|specs?|__tests__)(\/|$)|tests?\.\w+$|_test\.\w+$|\.spec\.\w+$|(^|\/)test_[^/]*$/i;
function clashTarget(bug) {
  if (bug.kind !== 'test' || !bug.partner || bug.own) return null;
  const src = T.files.filter(f => f.changedBy.includes(bug.owner) && !f.binary && !f.generated && !TESTFILE.test(f.file) && typeof f.v[bug.owner] === 'string');
  if (!src.length) return null;
  const named = src.filter(f => String(bug.why || '').includes(`(${path.basename(f.file)})`));
  return (named[0] || (src.length === 1 ? src[0] : null) || {}).file || null;
}
function clashContext(bug, file) {
  const diffOf = (k) => T.files.filter(f => f.changedBy.includes(k) && !f.binary && !f.generated && typeof f.v[k] === 'string').map(f => { const { added, removed } = lineSetDiff(typeof f.base === 'string' ? f.base : '', f.v[k]); return `${f.file}:\n${removed.slice(0, 12).map(l => '  - ' + l.trim()).join('\n')}\n${added.slice(0, 12).map(l => '  + ' + l.trim()).join('\n')}`; }).join('\n');
  let test = ''; try { test = readFile(bug.file).content; } catch (e) { /* none */ }
  const others = [...new Set(T.files.filter(f => f.changedBy.includes(bug.partner) && !f.binary && !f.generated && f.file !== file && !TESTFILE.test(f.file)).map(f => f.file))].map(f => { try { const c = readFile(f).content; return c.length < 20000 ? `\n\nThe file ${f} (for reference, don't send it back):\n${c}` : ''; } catch (e) { return ''; } }).join('');
  return `The bug: ${bug.title}${bug.message ? '\nDetails: ' + String(bug.message).split('\n').slice(0, 6).join('\n') : ''}\nWhy: ${bug.why}\n\nEach version passes this test alone, but together they don't: ${nm(bug.owner)}'s change clashes with ${nm(bug.partner)}'s.\n${nm(bug.owner)} changed:\n${diffOf(bug.owner)}\n${nm(bug.partner)} changed:\n${diffOf(bug.partner)}\n\nDo NOT change the test, it says what must stay true. Change ${file} so the test passes again while keeping what both developers wanted as much as possible (for example pick a value that works with the other change). Every other test must keep passing too.${others}${test ? `\n\nThe test file ${bug.file}:\n${test}` : ''}`;
}
function groupOf(bug) { const f = fileFor(bug); return T.bugs.filter(b => b.status === 'open' && b.owner === bug.owner && fileFor(b) === f); }
async function fixWithAI(id) {
  if (!askClaude || !hasAI()) throw new Error('AI fixes need Claude connected (Claude Code with your subscription, or an API key), or let your AI coder fix it through the MCP.');
  const bug = T.bugs.find(b => b.id === Number(id) && b.status === 'open'); if (!bug) throw new Error('No such open bug.');
  const clashTo = clashTarget(bug), file = clashTo || fileFor(bug);
  if (!file) throw new Error('Tandemi does not know which file to fix for this bug.');
  const group = clashTo ? [bug] : groupOf(bug), keys = group.map(b => b.key), openBefore = T.bugs.filter(b => b.status === 'open').length;
  const before = readFile(file).content;
  const testsRanBefore = !T.bugs.some(b => b.status === 'open' && b.kind === 'build'); // with build errors the tests never ran
  group.forEach(b => { b.fixing = true; }); changed();
  log(`${nm(bug.owner)}'s agent is fixing ${group.length === 1 ? 'bug ' + bug.id : group.length + ' bugs (' + group.map(b => b.id).join(', ') + ')'} in ${file}…`);
  const changesOf = (k) => T.files.filter(f => f.changedBy.includes(k) && !f.generated).map(f => path.basename(f.file)).join(', ');
  try {
    const list = group.map((b, i) => `${i + 1}. ${b.title}${b.line ? ` (line ${b.line})` : ''}\n   ${b.message && b.message !== b.title ? 'Details: ' + String(b.message).split('\n')[0] + '\n   ' : ''}Why it went to you: ${b.why}${b.hint ? '\n   Hint: ' + b.hint : ''}`).join('\n');
    const out = await askClaude(`You are the AI coding agent of ${nm(bug.owner)}. ${T.order.length} developers' work was merged and the merged code has ${group.length === 1 ? 'a bug' : 'bugs'} in one file that ${group.length === 1 ? 'is' : 'are'} yours to fix. Fix ${group.length === 1 ? 'it' : 'all of them'} with the smallest change that keeps what every developer wanted. Answer with JSON only: {"content": "<the whole new file>", "why": "<one short sentence>"}`,
      `${clashTo ? clashContext(bug, file) : `${group.length === 1 ? 'Bug' : 'Bugs'} in ${file}:\n${list}`}\n\n${T.full.keys.map(k => `${nm(k)} changed: ${changesOf(k)}`).join('\n')}\n\nThe file ${file} in the merged code:\n${before}`);
    if (typeof out.content !== 'string' || !out.content.trim()) throw new Error('Claude did not send a file');
    writeFile(file, out.content, `${nm(bug.owner)}'s agent`);
    T.busy = true; try { await checkTeam(false); } finally { T.busy = false; }
    const still = keys.filter(k => T.bugs.some(b => b.key === k && b.status === 'open'));
    // better = the bugs it worked on are gone and nothing new broke where it changed the code (a new build error elsewhere
    // is fine: the build only got further); a test that passed before and fails now is a new break too
    const openAfter = T.bugs.filter(b => b.status === 'open').length;
    const newHere = T.bugs.some(b => b.status === 'open' && !keys.includes(b.key) && b.isNew && (fileFor(b) === file || (b.kind === 'test' && testsRanBefore)));
    if (still.length === keys.length || (openAfter >= openBefore && newHere)) { // nothing got better: undo it
      fs.writeFileSync(path.join(T.work, 'full', file), T.crlf.has(file) ? before.replace(/\n/g, '\r\n') : before);
      log(`The fix didn't make things better, so it was undone.`, 'warn'); T.busy = true; try { await checkTeam(false); } finally { T.busy = false; }
    } else {
      for (const k of keys) { const b = T.bugs.find(x => x.key === k && x.status === 'fixed'); if (b) b.fixedNote = `Fixed by ${nm(bug.owner)}'s agent: ${out.why || 'see the merged code'}`; }
      log(`${keys.length - still.length} of ${keys.length} fixed: ${out.why || ''}`, 'ok');
    }
  } finally { group.forEach(b => { b.fixing = false; }); changed(); }
  return publicState();
}
function scheduleAutoFix() {
  if (!T.open || T.inAutoFix || T.busy || T.mode === 'report' || T.phase !== 'done') return;
  if (!T.bugs.some(b => b.status === 'open')) return;
  if (!(askClaude && hasAI())) { if (!T.toldNoAI) { T.toldNoAI = true; log('No AI is connected, so the bugs wait for the developers. Connect Claude at the top (Claude Code or an API key), or let an AI coder fix them through the MCP.', 'warn'); } return; }
  autoFix();
}
async function autoFix() {
  if (T.inAutoFix) return;
  T.inAutoFix = true; changed();
  try {
    for (let round = 1; round <= 3; round++) {
      const open = T.bugs.filter(b => b.status === 'open'); if (!open.length) break;
      const before = open.map(b => b.key).sort().join('|');
      const done = new Set();
      for (const b of open) { const cur = T.bugs.find(x => x.key === b.key && x.status === 'open'); if (!cur || done.has(cur.key)) continue; groupOf(cur).forEach(g => done.add(g.key)); try { await fixWithAI(cur.id); } catch (e) { log(`The agent couldn't fix bug ${cur.id}: ${e.message}`, 'warn'); } }
      const after = T.bugs.filter(b => b.status === 'open').map(b => b.key).sort().join('|');
      if (after && after === before) { log('The agents could not fix the remaining bugs, so they wait for the developers.', 'warn'); break; }
    }
  } finally { T.inAutoFix = false; changed(); }
}
async function fixAll() {
  if (!(askClaude && hasAI())) throw new Error('No agent is connected. Connect Claude at the top (Claude Code or an API key) of the page first.');
  if (T.phase !== 'done') throw new Error('Merge first.');
  T.toldNoAI = false; autoFix(); return publicState();
}
function setMode(m) { T.mode = m === 'report' ? 'report' : 'auto'; changed(); if (T.mode === 'auto') scheduleAutoFix(); return publicState(); }
function aiConnected() { T.toldNoAI = false; scheduleAutoFix(); }
function deactivate() { if (T.active) { T.active = false; changed(); } }

// the final code: "safe" = everyone who works together now; "full" = everyone merged (with the fixes)
async function mergedZip(which) {
  if (!T.work) throw new Error('Merge first.');
  const pickDir = which === 'full' || which === 'safe' ? which : T.final || 'full';
  const dir = path.join(T.work, pickDir === 'safe' && T.safe ? 'safe' : 'full');
  if (!fs.existsSync(dir)) throw new Error('Merge first.');
  const tracked = (await gitOk(['ls-files'], dir)).split('\n'), others = (await gitOk(['ls-files', '--others', '--exclude-standard'], dir)).split('\n');
  const list = [...new Set([...tracked, ...others])].filter(f => f && !/^tandemi-check\//.test(f) && fs.existsSync(path.join(dir, f)) && fs.statSync(path.join(dir, f)).isFile());
  const tag = dir.endsWith('safe') ? 'works-now' : 'merged';
  return { name: (T.config.name || 'team').replace(/[^\w.-]+/g, '-') + '-' + tag + '.zip', data: ZIP.zip(list.map(n => ({ name: n, data: fs.readFileSync(path.join(dir, n)) }))), count: list.length };
}
// save as a real git merge commit with every merged developer's branch as a parent (octopus)
async function createBranch(name, which) {
  if (T.busy) throw new Error('Tandemi is checking right now.');
  if (T.phase !== 'done') throw new Error('Merge first.');
  const useSafe = (which || T.final) === 'safe' && T.safe;
  const dirName = useSafe ? 'safe' : 'full', keys = useSafe ? T.safe.keys : T.full.keys, dir = path.join(T.work, dirName);
  const branch = String(name || `tandemi/team-${keys.map(k => T.devs[k].branch.split('/').pop()).join('-')}`).replace(/[^\w./-]+/g, '-').slice(0, 120);
  await gitOk(['add', '-A', '-f', '--', '.'], dir);
  for (const f of ['tandemi-check']) await git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', f], dir);
  const tree = (await gitOk(['write-tree'], dir)).trim();
  const msg = `Merge ${keys.map(k => T.devs[k].branch).join(', ')} (Tandemi)\n\n${useSafe ? T.safe.run && summary(T.safe.run) : summary(T.runs.full)}.`;
  const commit = (await gitOk(['-c', 'user.name=Tandemi', '-c', 'user.email=tandemi@localhost', 'commit-tree', tree, ...keys.flatMap(k => ['-p', T.devs[k].sha]), '-m', msg], T.path)).trim();
  await gitOk(['branch', '-f', branch, commit], T.path);
  T.mergeBranch = { name: branch, commit: commit.slice(0, 8), push: `git push -u origin ${branch}`, keys };
  log(`Saved ${names(keys)} as branch ${branch} (${commit.slice(0, 8)}). Push it: ${T.mergeBranch.push}`, 'ok');
  changed();
  return publicState();
}

function publicState() {
  if (!T.open) return { open: false, active: false, log: T.log };
  const run = (r) => (r ? { ok: r.ok, build: r.build, ranTests: r.ranTests, tests: r.tests.slice(0, 300).map(t => ({ id: t.id, name: t.name, ok: t.ok, skipped: t.skipped, message: t.message })), summary: summary(r) } : null);
  const status = (k) => {
    const b = (T.blocked || []).find(x => x.key === k);
    if (b) return { state: 'conflict', with: b.conflicts[0].with, text: `Real conflict with ${nm(b.conflicts[0].with)} in ${path.basename(b.conflicts[0].file)}` };
    const mine = (T.bugs || []).filter(x => x.status === 'open' && x.owner === k);
    if (T.phase !== 'done') return { state: 'working', text: '' };
    if ((T.included || []).includes(k)) return { state: 'merged', text: 'Merged' + (mine.length ? `, but has ${mine.length} bug${mine.length === 1 ? '' : 's'} to fix` : '') };
    if (mine.length) return { state: 'waiting', with: mine[0].partner, text: `Waits: ${mine.length} bug${mine.length === 1 ? '' : 's'} to fix${mine[0].partner ? ` (clashes with ${nm(mine[0].partner)})` : ''}` };
    return { state: 'waiting', text: 'Waits' };
  };
  return {
    open: true, active: !!T.active, team: true, path: T.path, source: T.source, name: T.config ? T.config.name : '', languages: T.config ? T.config.languages || [] : [], checksOnly: !!(T.config && T.config.checksOnly),
    order: T.order || [], devs: T.order ? T.order.map(k => ({ ...T.devs[k], sha: undefined, run: run(T.runs.alone[k]), status: status(k) })) : [],
    phase: T.phase, step: T.step, busy: !!T.busy, log: T.log.slice(-80), gitView: T.gitView || null, mode: T.mode || 'auto', autoFixing: !!T.inAutoFix, hasAI: !!(askClaude && hasAI()),
    files: (T.files || []).filter(e => !e.generated).slice(0, 2000).map(e => { const v = T.full && T.full.files.get(e.file); return { file: e.file, by: e.changedBy, merged: v ? v.by : [], method: v ? v.method : 'waits', language: v && v.language || null }; }),
    blocked: (T.blocked || []).map(b => ({ key: b.key, conflicts: b.conflicts.map(c => ({ file: c.file, label: c.label, with: c.with, a: c.a, b: c.b, note: c.note || null, binary: !!c.binary, busy: !!c.busy, pick: c.pick || null })) })),
    runs: { full: run(T.runs && T.runs.full), safe: T.safe ? run(T.safe.run) : null },
    setupProblem: (T.runs && ((T.runs.full && T.runs.full.setup) || Object.values(T.runs.alone || {}).map(r => r && r.setup).find(Boolean))) || null,
    together: T.full ? T.full.keys : [], included: T.included || [], safe: T.safe ? T.safe.keys : null, final: T.final || null,
    bugs: T.bugs || [], mergedFiles: T.phase === 'done' ? mergedFiles() : [], mergeBranch: T.mergeBranch || null,
  };
}

module.exports = { testTitle, init, start, resolve, aiResolve, retest, readFile, writeFile, fixWithAI, fixAll, setMode, aiConnected, deactivate, mergedZip, createBranch, publicState };
