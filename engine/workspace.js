// workspace.js · code that isn't in git yet (pasted, uploaded files, uploaded or local folders) becomes an internal git
// repository with three branches: main (the original), dev-a (Developer A's version), dev-b (Developer B's version).
// Then the same engine as for real git projects merges, builds, tests and routes the bugs.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SKIP = /^(\.git|bin|obj|node_modules|\.vs|\.idea|\.pairplay|tandemi-check|__pycache__)$/i;
const KEYS = 'ABCDEFGHIJKL'.split('');
const sideList = () => ['base', ...(W && W.devs ? W.devs : ['A', 'B'])];
let ROOT = null, W = null;

function init(dataDir) { ROOT = path.join(dataDir, 'workspaces'); fs.mkdirSync(ROOT, { recursive: true }); W = load(); }
function git(args, cwd, env) {
  return new Promise((resolve) => execFile('git', args, { cwd, windowsHide: true, maxBuffer: 256 << 20, env: { ...process.env, ...(env || {}) } }, (e, out, err) => resolve({ code: e ? 1 : 0, out: out || '', err: err || (e ? e.message : '') })));
}
async function gitOk(args, cwd, env) { const r = await git(args, cwd, env); if (r.code) throw new Error(`git ${args[0]}: ${(r.err || r.out).trim().split('\n').pop()}`); return r.out; }
const stateFile = () => path.join(ROOT, 'current.json');
function save() { try { fs.writeFileSync(stateFile(), JSON.stringify({ id: W.id, names: W.names, replace: W.replace, title: W.title, devs: W.devs })); } catch (e) { /* not saved */ } }
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const dir = path.join(ROOT, s.id);
    if (fs.existsSync(dir)) return { devs: ['A', 'B'], ...s, dir };
  } catch (e) { /* none yet */ }
  return null;
}
function inputDir(side) { return path.join(W.dir, 'inputs', side); }
function safeRel(p) {
  const r = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(x => x && x !== '.' && x !== '..').join('/');
  if (!r) throw new Error('A file needs a name, like Player.cs');
  return r;
}

// a new, empty workspace
function create({ title, nameA, nameB } = {}) {
  const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
  W = { id, dir: path.join(ROOT, id), title: String(title || 'My project').slice(0, 80), devs: ['A', 'B'], names: { A: String(nameA || 'Developer A').slice(0, 40), B: String(nameB || 'Developer B').slice(0, 40) }, replace: { base: true, A: false, B: false } };
  for (const s of sideList()) fs.mkdirSync(inputDir(s), { recursive: true });
  save();
  return summary();
}
function need() { if (!W) create(); }
// "Start over" with pasted code: the workspace (its files, its git, its merges) is thrown away
function discard() {
  if (!W) return null;
  const dir = W.dir; W = null;
  try { fs.rmSync(stateFile(), { force: true }); } catch (e) { /* none */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* in use: left behind, never shown again */ }
  return path.join(dir, 'repo');
}
function setNames({ nameA, nameB, title, names }) {
  need();
  const all = { ...(names || {}), ...(nameA ? { A: nameA } : {}), ...(nameB ? { B: nameB } : {}) };
  for (const [k, v] of Object.entries(all)) if (W.devs.includes(k) && v) W.names[k] = String(v).slice(0, 40);
  if (title) W.title = String(title).slice(0, 80);
  save(); return summary();
}
// a third, fourth… developer
function addDev(name) {
  need();
  const key = KEYS.find(k => !W.devs.includes(k));
  if (!key) throw new Error(`Tandemi merges up to ${KEYS.length} developers at once.`);
  W.devs.push(key); W.names[key] = String(name || `Developer ${key}`).slice(0, 40); W.replace[key] = false;
  fs.rmSync(inputDir(key), { recursive: true, force: true }); fs.mkdirSync(inputDir(key), { recursive: true });
  save(); return { ...summary(), added: key };
}
function removeDev(key) {
  need();
  if (!W.devs.includes(key)) throw new Error('No such developer.');
  if (W.devs.length <= 2) throw new Error('A merge needs at least two developers.');
  W.devs = W.devs.filter(k => k !== key); delete W.names[key]; delete W.replace[key];
  fs.rmSync(inputDir(key), { recursive: true, force: true });
  save(); return summary();
}

// files: [{ path, text } or { path, base64 }]; replace = this side is the whole project (a folder), not just changed files
function setFiles(side, files, { replace, clear } = {}) {
  need();
  if (!sideList().includes(side)) throw new Error(`Side must be one of: ${sideList().join(', ')}.`);
  if (clear) clearSide(side);
  for (const f of files || []) {
    const rel = safeRel(f.path), abs = path.join(inputDir(side), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.base64 != null ? Buffer.from(f.base64, 'base64') : String(f.text ?? '').replace(/\r\n/g, '\n'));
  }
  if (replace != null) W.replace[side] = !!replace;
  save();
  return summary();
}
function copyTree(from, to) {
  let n = 0;
  (function go(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.test(e.name)) continue;
      const s = path.join(d, e.name), t = path.join(to, rel, e.name);
      if (e.isDirectory()) go(s, path.join(rel, e.name));
      else if (e.isFile()) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(s, t); n++; }
    }
  })(from, '');
  return n;
}
// a folder on this computer: this side's whole project
function setFolder(side, folder) {
  need();
  if (!sideList().includes(side)) throw new Error(`Side must be one of: ${sideList().join(', ')}.`);
  const abs = path.resolve(String(folder || '').trim().replace(/^"|"$/g, ''));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`There is no folder ${abs} on this computer.`);
  clearSide(side);
  const n = copyTree(abs, inputDir(side));
  W.replace[side] = true; save();
  return { ...summary(), copied: n };
}
function removeFile(side, file) { need(); const abs = path.join(inputDir(side), safeRel(file)); try { fs.rmSync(abs); } catch (e) { /* not there */ } return summary(); }
function clearSide(side) { need(); fs.rmSync(inputDir(side), { recursive: true, force: true }); fs.mkdirSync(inputDir(side), { recursive: true }); W.replace[side] = side === 'base'; save(); }
function readInput(side, file) { need(); const abs = path.join(inputDir(side), safeRel(file)); if (!fs.existsSync(abs)) throw new Error(`There is no ${file} in this version.`); return fs.readFileSync(abs, 'utf8'); }
function list(dir) {
  const out = [];
  (function go(d, rel) { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) go(p, r); else out.push({ path: r, size: fs.statSync(p).size }); } })(dir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
function summary() {
  if (!W) return { exists: false };
  const sides = {};
  for (const s of sideList()) { const files = list(inputDir(s)); sides[s] = { files: files.slice(0, 2000), count: files.length, bytes: files.reduce((n, f) => n + f.size, 0), whole: !!W.replace[s] }; }
  return { exists: true, id: W.id, title: W.title, names: W.names, devs: W.devs, sides, dir: W.dir };
}

// build the internal repository: main = original, dev-a / dev-b = each developer's version on top of it
async function build() {
  need();
  const repo = path.join(W.dir, 'repo');
  if (!fs.existsSync(path.join(repo, '.git'))) { fs.mkdirSync(repo, { recursive: true }); await gitOk(['init', '-q', '-b', 'main'], repo); }
  // each version's snapshot is built straight from its own folder, with an index that is kept between merges,
  // so git only reads the files that changed since last time (no copies of the project)
  const GIT_DIR = path.join(repo, '.git');
  let baseTree = null;
  const tree = async (side) => {
    const index = path.join(W.dir, 'index-' + side), env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: inputDir(side), GIT_DIR };
    if (side !== 'base' && !W.replace[side]) {
      // only the changed files were given: the original, with this developer's files on top
      try { fs.rmSync(index); } catch (e) { /* new */ }
      await gitOk(['read-tree', baseTree], inputDir(side), env);
      await gitOk(['add', '-f', '--ignore-removal', '--', '.'], inputDir(side), env);
    } else await gitOk(['add', '-A', '-f', '--', '.'], inputDir(side), env);
    const t = (await gitOk(['write-tree'], inputDir(side), env)).trim();
    if (side === 'base') baseTree = t;
    return t;
  };
  const commit = async (treeSha, parent, who, msg) => {
    const env = { GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: who.toLowerCase().replace(/[^\w]+/g, '.') + '@tandemi.local', GIT_COMMITTER_NAME: 'Tandemi', GIT_COMMITTER_EMAIL: 'tandemi@localhost' };
    return (await gitOk(['commit-tree', treeSha, ...(parent ? ['-p', parent] : []), '-m', msg], repo, env)).trim();
  };
  const baseCommit = await commit(await tree('base'), null, 'Original', 'The original version');
  await gitOk(['update-ref', 'refs/heads/main', baseCommit], repo);
  for (const k of W.devs) {
    const c = await commit(await tree(k), baseCommit, W.names[k], `${W.names[k]}'s version`);
    await gitOk(['update-ref', 'refs/heads/dev-' + k.toLowerCase(), c], repo);
  }
  await gitOk(['checkout', '-q', '-f', 'dev-a'], repo);
  await git(['clean', '-fdq'], repo);
  const empty = W.devs.some(k => !list(inputDir(k)).length);
  return { repo, a: 'dev-a', b: 'dev-b', branches: W.devs.map(k => ({ ref: 'dev-' + k.toLowerCase(), name: W.names[k] })), empty };
}

module.exports = { discard, init, create, setNames, addDev, removeDev, setFiles, setFolder, removeFile, clearSide, readInput, summary, build, current: () => W };
