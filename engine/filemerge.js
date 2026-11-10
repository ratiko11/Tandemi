// filemerge.js · merging without git: three versions of one file, or three folders (the original, A's, B's).
// Same structural merge as for git projects (C#, JavaScript, TypeScript, Python, Java, C++ and Go by structure, other files line by line).
'use strict';
const fs = require('fs');
const path = require('path');
const MERGE = require('./merge.js');

const SKIP = /^(\.git|bin|obj|node_modules|\.vs|\.idea|\.pairplay|\.tandemi)$/i;
let job = null; // the merge in progress: { kind: 'files'|'folders', ... }

function summary() {
  if (!job) return { merge: 'none' };
  const files = job.files.map(f => ({ file: f.file, from: f.from, unchanged: !!f.unchanged, method: f.method, language: f.language || null, lineConflicts: f.lineConflicts ?? null, changes: f.changes || null, error: f.error || null, binary: !!f.binary,
    conflicts: (f.conflicts || []).map(c => ({ id: c.id, label: c.label, base: c.base, a: c.a, b: c.b, note: c.note || null, pick: c.pick || null, binary: !!c.binary })) }));
  const real = files.reduce((n, f) => n + f.conflicts.length, 0), solved = files.reduce((n, f) => n + f.conflicts.filter(c => c.pick).length, 0);
  return {
    kind: job.kind, status: real > solved ? 'conflicts' : 'merged', names: job.names, out: job.out || null, written: job.written || false,
    lineConflicts: files.reduce((n, f) => n + (f.lineConflicts || 0), 0), realConflicts: real, solved, files,
    merged: job.kind === 'files' && real === solved ? finalText(job.files[0]) : undefined,
  };
}
function finalText(f) {
  if (f.method === 'one side' || f.method === 'same') return f.result;
  if (f.method === 'whole file') { const c = f.conflicts[0]; return c.pick === 'A' ? f.A : c.pick === 'B' ? f.B : c.pick === 'custom' ? c.custom : undefined; }
  const t = MERGE.fill(f.template, f.conflicts);
  return t.includes('\u0000') ? undefined : t;
}
function mergeOne(file, base, a, b) {
  const entry = { file, conflicts: [] };
  const norm = (x) => (x == null ? null : String(x).replace(/\r\n/g, '\n'));
  base = norm(base); a = norm(a); b = norm(b);
  const chA = a !== base, chB = b !== base;
  entry.from = chA && chB ? 'both' : chA ? 'A' : chB ? 'B' : 'none';
  entry.base = base; entry.A = a; entry.B = b;
  if (!chA && !chB) { entry.method = 'same'; entry.result = base; return entry; }
  if (!chA || !chB) { entry.method = 'one side'; entry.result = chA ? a : b; if (base != null && entry.result != null) { const d = MERGE.describe(file, base, entry.result); if (d) entry.changes = { A: chA ? d : [], B: chB ? d : [] }; } return entry; }
  if (a === b) { entry.method = 'same'; entry.result = a; return entry; }
  if (a == null || b == null) { entry.method = 'whole file'; entry.conflicts.push({ id: 0, label: `${file}: ${a == null ? 'A deleted it, B changed it' : 'B deleted it, A changed it'}`, base: base || '', a: a || '', b: b || '' }); return entry; }
  const r = MERGE.merge(file, base || '', a, b);
  Object.assign(entry, { method: r.method, language: r.language, lineConflicts: r.lineConflicts, conflicts: r.conflicts, changes: r.changes, template: r.template, error: r.error });
  return entry;
}

// three versions of one file (pasted or uploaded)
async function mergeFiles({ file, base, a, b }) {
  file = String(file || 'file.txt');
  await MERGE.prepare([file]);
  if (typeof a !== 'string' || typeof b !== 'string') throw new Error("Send A's and B's version of the file.");
  job = { kind: 'files', names: { base: 'Original', A: 'A', B: 'B' }, files: [mergeOne(file, base == null ? '' : String(base), a, b)] };
  return summary();
}

// three folders on this computer: the original, A's copy and B's copy; the result goes to `out`
function walk(root) {
  const out = new Map();
  const go = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) go(abs); else if (e.isFile()) out.set(path.relative(root, abs).split(path.sep).join('/'), abs);
    }
  };
  go(root); return out;
}
function readMaybe(abs) { if (!abs) return null; const buf = fs.readFileSync(abs); return buf.includes(0) ? { binary: true, buf } : buf.toString('utf8'); }
async function mergeFolders({ base, a, b, out }) {
  await MERGE.ready;
  const dirs = { base, A: a, B: b };
  for (const [k, d] of Object.entries(dirs)) {
    if (!d) throw new Error(`Choose the ${k === 'base' ? 'original' : k + "'s"} folder.`);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error(`There is no folder ${d} on this computer.`);
  }
  out = out || path.join(path.dirname(path.resolve(a)), path.basename(path.resolve(base)) + '-merged');
  for (const k of ['base', 'A', 'B']) if (path.resolve(out) === path.resolve(dirs[k])) throw new Error('The result folder must be a new folder, not one of the three.');
  const W = { base: walk(base), A: walk(a), B: walk(b) };
  const all = [...new Set([...W.base.keys(), ...W.A.keys(), ...W.B.keys()])].sort();
  await MERGE.prepare(all);
  job = { kind: 'folders', names: { base: path.resolve(base), A: path.resolve(a), B: path.resolve(b) }, out: path.resolve(out), files: [], dirs: W };
  for (const f of all) {
    const vb = readMaybe(W.base.get(f)), va = readMaybe(W.A.get(f)), vB = readMaybe(W.B.get(f));
    if ([vb, va, vB].some(x => x && x.binary)) {
      const same = (x, y) => (x == null && y == null) || (x && y && Buffer.compare(x.buf || Buffer.from(x), y.buf || Buffer.from(y)) === 0);
      const chA = !same(va, vb), chB = !same(vB, vb);
      const e = { file: f, binary: true, from: chA && chB ? 'both' : chA ? 'A' : chB ? 'B' : 'none', conflicts: [] };
      e.take = chA && !chB ? 'A' : 'B';
      if (chA && chB && !same(va, vB)) { e.method = 'whole file'; e.conflicts.push({ id: 0, label: `${f} (a binary file, like an image or a sound)`, base: '', a: "(A's version)", b: "(B's version)", binary: true }); }
      else e.method = chA || chB ? 'one side' : 'same';
      job.files.push(e); continue;
    }
    const e = mergeOne(f, vb, va, vB);
    if (e.from !== 'none') job.files.push(e); else job.files.push({ ...e, unchanged: true });
  }
  const s = summary();
  if (!s.realConflicts) writeOut();
  return summary();
}
function writeOut() {
  if (!job || job.kind !== 'folders') return;
  const out = job.out;
  fs.mkdirSync(out, { recursive: true });
  for (const f of job.files) {
    const abs = path.join(out, f.file);
    if (f.binary) {
      const side = f.conflicts[0] ? f.conflicts[0].pick : f.take;
      const src = (side === 'A' ? job.dirs.A : job.dirs.B).get(f.file) || job.dirs.base.get(f.file);
      if (src) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.copyFileSync(src, abs); }
      continue;
    }
    const text = finalText(f);
    if (text == null) continue; // deleted
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  job.written = true;
}
function pick(file, id, choice, custom) {
  if (!job) throw new Error('Start a merge first.');
  const f = job.files.find(x => x.file === file) || (job.kind === 'files' ? job.files[0] : null);
  if (!f) throw new Error('No such file in this merge.');
  const c = f.conflicts.find(x => x.id === Number(id)); if (!c) throw new Error('No such conflict.');
  if (choice === 'both' && !c.binary) { c.pick = 'custom'; c.custom = [c.a, c.b].filter(Boolean).join('\n'); }
  else if (choice === 'A' || choice === 'B') c.pick = choice;
  else if (choice === 'custom' && typeof custom === 'string') { c.pick = 'custom'; c.custom = custom; }
  else throw new Error('Choose A, B or both.');
  const s = summary();
  if (!s.realConflicts || s.solved === s.realConflicts) writeOut();
  return summary();
}
async function aiPick(file, id, askJSON) {
  if (!job) throw new Error('Start a merge first.');
  const f = job.files.find(x => x.file === file) || job.files[0], c = f && f.conflicts.find(x => x.id === Number(id));
  if (!c || c.binary) throw new Error('No such conflict.');
  const out = await askJSON('You merge code. Two developers changed the same part of a file differently. Write ONE version of that part that keeps what both wanted. Answer with JSON only: {"code": "<the combined code for this part only>", "why": "<one short sentence>"}',
    `File: ${f.file}\nPart: ${c.label}\n\nStarting version:\n${c.base || '(not there)'}\n\nA's version:\n${c.a || '(removed it)'}\n\nB's version:\n${c.b || '(removed it)'}`);
  if (typeof out.code !== 'string') throw new Error('Claude did not send code');
  c.pick = 'custom'; c.custom = out.code; c.why = String(out.why || '');
  const s = summary(); if (s.solved === s.realConflicts) writeOut();
  return summary();
}
function close() { job = null; return summary(); }

module.exports = { mergeFiles, mergeFolders, pick, aiPick, summary, close };
