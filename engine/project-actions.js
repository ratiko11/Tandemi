// project-actions.js · every action on a real git project, shared by the server (Projects page),
// the standalone MCP (when Tandemi isn't running) and the GitHub merge bot.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const REPO = require('./repo.js');
const MERGE = require('./merge.js');
const AI = require('./claude-api.js');
const FM = require('./filemerge.js');
const WS = require('./workspace.js');
const TEAM = require('./team.js');

const LAST_PROJECT = path.join(AI.DATA, 'last-project.txt');
let inited = false;
function init(onChange, onTeam) {
  if (inited) return; inited = true;
  fs.mkdirSync(AI.DATA, { recursive: true });
  WS.init(AI.DATA);
  REPO.init({ dataDir: path.join(AI.DATA, 'projects'), onChange: onChange || (() => {}), claude: (system, user) => AI.askJSON(system, user), hasAI: AI.available });
  TEAM.init({ dataDir: path.join(AI.DATA, 'projects'), onChange: onTeam || (() => {}), claude: (system, user) => AI.askJSON(system, user), hasAI: AI.available });
}
function runGit(args, cwd) { return new Promise((resolve) => execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out, errOut) => resolve({ code: err ? 1 : 0, out: out || '', err: errOut || (err ? err.message : '') }))); }
// "https://github.com/owner/repo", "github.com/owner/repo.git", "owner/repo" or any git URL → { url, name }
function parseRepoUrl(input) {
  let u = String(input || '').trim().replace(/^"|"$/g, '');
  if (!u) throw new Error('Paste the GitHub link of the project, like https://github.com/owner/repo');
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = 'https://github.com/' + u;
  if (/^(github\.com|gitlab\.com|bitbucket\.org)\//i.test(u)) u = 'https://' + u;
  const gh = u.match(/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob|pull|issues)\b.*)?\/?$/i);
  if (gh) return { url: `https://${gh[1].toLowerCase()}/${gh[2]}/${gh[3]}.git`, name: `${gh[2]}-${gh[3]}` };
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(u)) { const m = u.replace(/\.git$/, '').match(/([\w.-]+)\/([\w.-]+)$/); return { url: u, name: m ? `${m[1]}-${m[2]}` : 'project' }; }
  throw new Error("That doesn't look like a GitHub link. Use something like https://github.com/owner/repo");
}
// download a project from GitHub into Tandemi's own folder (or update it if it's already there), then open it
async function cloneProject(input) {
  const { url, name } = parseRepoUrl(input);
  const ver = await runGit(['--version'], AI.ROOT);
  if (ver.code) throw new Error('Git is not installed on this computer. Install it from https://git-scm.com, then start Tandemi again.');
  const dir = path.join(AI.HOME, 'projects', name.replace(/[^\w.-]+/g, '-'));
  if (fs.existsSync(path.join(dir, '.git'))) {
    const f = await runGit(['fetch', '--all', '--prune'], dir);
    if (f.code) throw new Error('Could not update it from GitHub: ' + (f.err || f.out).trim().split('\n').pop());
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const c = (fs.mkdirSync(path.dirname(dir), { recursive: true }), await runGit(['clone', '--no-checkout', url, dir], AI.HOME));
    if (c.code) {
      const why = (c.err || c.out).trim().split('\n').filter(Boolean).pop() || '';
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* nothing to clean */ }
      if (/not found|does not exist|could not read Username|Authentication failed|terminal prompts disabled/i.test(why)) throw new Error(`GitHub didn't let Tandemi download it: either the link is wrong, or the repository is private. Check the link. For a private one, sign in to GitHub once: run "git clone ${url}" in Command Prompt and log in, then try again.`);
      throw new Error('Could not download it: ' + why);
    }
    await runGit(['checkout', '-q'], dir); // the default branch, so the folder isn't empty
  }
  return dir;
}
// a teammate who works in their own copy (a fork): add it to the open project as a second remote named after them,
// so their branches show up next to the others (ana/main, ana/feature-x) and can be merged like any branch
async function addFork(input) {
  const st = REPO.publicState();
  if (!st.open || st.source === 'workspace' || !st.path) throw new Error('Open the project first (a folder or a GitHub link), then add the teammate\'s copy.');
  const { url } = parseRepoUrl(input);
  const owner = (url.match(/[/:]([\w.-]+)\/[\w.-]+?(?:\.git)?$/) || [])[1] || 'fork';
  const list = (await runGit(['remote', '-v'], st.path)).out.split('\n').map(l => l.split(/\s+/)).filter(x => x[1]);
  const norm = (u) => String(u).toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  let name = (list.find(x => norm(x[1]) === norm(url)) || [])[0];
  if (!name) {
    const base = owner.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^origin$/, 'fork'); name = base;
    for (let i = 2; list.some(x => x[0] === name); i++) name = `${base}-${i}`;
    const r = await runGit(['remote', 'add', name, url], st.path);
    if (r.code) throw new Error('Could not add it: ' + (r.err || r.out).trim().split('\n').pop());
  }
  const f = await runGit(['fetch', '--prune', name], st.path);
  if (f.code) {
    const why = (f.err || f.out).trim().split('\n').filter(Boolean).pop() || '';
    if (!list.some(x => x[0] === name)) await runGit(['remote', 'remove', name], st.path);
    if (/not found|does not exist|could not read Username|Authentication failed|terminal prompts disabled/i.test(why)) throw new Error("GitHub didn't let Tandemi download it: either the link is wrong, or that copy is private.");
    throw new Error('Could not download it: ' + why);
  }
  await REPO.fetchAll();
  const state = REPO.publicState();
  return { state, remote: name, added: state.branches.filter(b => b.name.startsWith(name + '/')).map(b => b.name) };
}
async function openSample() {
  const dir = path.join(AI.HOME, 'samples', 'cat-runner'), bundle = path.join(AI.ROOT, 'samples', 'cat-runner.bundle');
  // the example always starts fresh: a new copy, and none of the plain-word tests or edits of last time
  REPO.forgetPlain(dir);
  if (fs.existsSync(bundle)) { if (REPO.publicState().open && REPO.publicState().path && path.resolve(REPO.publicState().path) === path.resolve(dir)) REPO.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* in use: reused below */ } }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (!fs.existsSync(bundle)) throw new Error('The sample game is missing (samples/cat-runner.bundle).');
    const c = (fs.mkdirSync(path.dirname(dir), { recursive: true }), await runGit(['clone', '-q', bundle, dir], AI.HOME));
    if (c.code) throw new Error('Could not unpack the sample game: ' + c.err.trim() + ' Is git installed? Get it from https://git-scm.com');
    for (const br of ['dev-a', 'dev-b']) await runGit(['branch', br, 'origin/' + br], dir);
    await runGit(['remote', 'remove', 'origin'], dir);
  }
  return dir;
}
const remember = (p) => { try { fs.writeFileSync(LAST_PROJECT, p); } catch (e) { /* not remembered */ } };
async function reopenLast() {
  await MERGE.ready;
  try { const last = fs.readFileSync(LAST_PROJECT, 'utf8').trim(); if (last && fs.existsSync(last) && !REPO.publicState().open) await REPO.open(last); } catch (e) { /* no project yet */ }
}
// one place for every project action; `local` is false for calls from another laptop (read-only there)
async function projectAction(what, a = {}, local = true) {
  const readOnly = ['state', 'status', 'read_file', 'read', 'plain_tests', 'plain_list'];
  if (!local && !readOnly.includes(what)) return { error: 'Project actions work only on the computer running Tandemi (they change the git repository there).' };
  try {
    switch (what) {
      case 'state': case 'status': return { result: REPO.publicState() };
      // a clean page: close the project; pasted code is thrown away with its plain-word tests (a git project keeps its own)
      case 'reset': case 'start_over': {
        TEAM.deactivate();
        const st = REPO.publicState();
        if (st.open && st.source === 'workspace') REPO.forgetPlain(st.path);
        REPO.close();
        const gone = WS.discard(); if (gone) REPO.forgetPlain(gone);
        try { fs.rmSync(LAST_PROJECT, { force: true }); } catch (e) { /* none */ }
        return { result: REPO.publicState() };
      }
      case 'open': { const r = await REPO.open(a.path); remember(r.path); return { result: r }; }
      case 'clone': case 'github': { const r = await REPO.open(await cloneProject(a.url || a.repo || a.path)); remember(r.path); return { result: r }; }
      case 'sample': { const r = await REPO.open(await openSample()); remember(r.path); return { result: r }; }
      case 'add_fork': case 'fork': return { result: await addFork(a.url || a.repo) };
      case 'fetch': { const r = await REPO.fetchAll(); return r === 'ok' ? { result: REPO.publicState() } : { error: 'git fetch: ' + r }; }
      case 'merge': TEAM.deactivate(); return { result: await REPO.startMerge(String(a.a || a.branchA || ''), String(a.b || a.branchB || '')) };
      case 'pick': return { result: await REPO.pick(String(a.file || ''), a.id ?? a.conflict, String(a.pick || ''), a.code) };
      case 'ai': return { result: await REPO.aiPick(String(a.file || ''), a.id ?? a.conflict) };
      case 'read': case 'read_file': return { result: REPO.readFile(String(a.file || '')) };
      case 'write': case 'write_file': REPO.writeFile(String(a.file || ''), String(a.content ?? ''), a.by || 'An AI coder'); return { result: a.retest === false ? REPO.publicState() : await REPO.retest(false) };
      case 'retest': return { result: await REPO.retest() };
      // tests in plain words
      case 'plain_add': return { result: REPO.plainAdd(a.text) };
      case 'plain_write': return { result: await REPO.plainWrite(a.id) };
      case 'plain_set': case 'plain_set_code': return { result: await REPO.plainSet(a.id, a.file, a.code, a.testName || a.test_name, a.by || (local ? 'by hand' : 'an AI coder')) };
      case 'plain_keep': return { result: await REPO.plainKeep(a.id, a.keep) };
      case 'plain_remove': return { result: await REPO.plainRemove(a.id) };
      case 'plain_tests': case 'plain_list': return { result: await REPO.plainTasks() };
      case 'fix': case 'fix_bug': return { result: await REPO.fixWithAI(a.bug ?? a.id) };
      case 'branch': case 'save_branch': return { result: await REPO.createBranch(a.name) };
      case 'fix_all': return { result: await REPO.fixAll() };
      case 'mode': TEAM.setMode(a.mode); return { result: REPO.setMode(a.mode) };
      case 'final': { const z = await REPO.mergedZip(); const out = path.join(AI.HOME, 'final', z.name); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, z.data); return { result: { saved: out, files: z.count } }; }
      default: return { error: 'Unknown project action ' + what };
    }
  } catch (e) { return { error: e.message }; }
}
// merging without git: three versions of a file, or three folders on this computer
async function fileAction(what, a = {}, local = true) {
  if (!local && what === 'folders') return { error: 'Merging folders works only on the computer that has them.' };
  try {
    switch (what) {
      case 'status': return { result: FM.summary() };
      case 'files': return { result: await FM.mergeFiles(a) };
      case 'folders': return { result: await FM.mergeFolders(a) };
      case 'pick': return { result: FM.pick(String(a.file || ''), a.id ?? a.conflict, String(a.pick || ''), a.code) };
      case 'ai': if (!AI.available()) return { error: 'Letting AI combine needs Claude Code (your Claude subscription) or an Anthropic API key.' }; return { result: await FM.aiPick(String(a.file || ''), a.id ?? a.conflict, AI.askJSON) };
      case 'close': return { result: FM.close() };
      default: return { error: 'Unknown merge action ' + what };
    }
  } catch (e) { return { error: e.message }; }
}
// the workspace: code that isn't in git yet (pasted, uploaded, folders) for the original, Developer A and Developer B
async function wsAction(what, a = {}, local = true) {
  if (!local && ['folder'].includes(what)) return { error: 'A folder path only works on the computer that has the folder. Upload the folder instead.' };
  try {
    switch (what) {
      case 'state': case 'status': return { result: WS.summary() };
      case 'new': return { result: WS.create(a) };
      case 'names': return { result: WS.setNames(a) };
      case 'files': case 'add_files': return { result: WS.setFiles(String(a.side || ''), a.files || [], { replace: a.replace ?? a.whole, clear: a.clear }) };
      case 'folder': return { result: WS.setFolder(String(a.side || ''), a.path || a.folder) };
      case 'remove': return { result: WS.removeFile(String(a.side || ''), String(a.file || a.path || '')) };
      case 'clear': WS.clearSide(String(a.side || '')); return { result: WS.summary() };
      case 'read': return { result: { file: a.file, content: WS.readInput(String(a.side || ''), String(a.file || '')) } };
      case 'add_developer': case 'add': return { result: WS.addDev(a.name) };
      case 'remove_developer': case 'drop': return { result: WS.removeDev(String(a.key || a.side || '')) };
      case 'merge': {
        const sum = WS.summary();
        const empty = sum.devs.filter(k => !sum.sides[k].count);
        if (empty.length) return { error: `Add ${empty.map(k => sum.names[k]).join(' and ')}'s code first${sum.devs.length > 2 ? ', or remove ' + (empty.length === 1 ? 'that developer' : 'those developers') : ''}.` };
        const b = await WS.build();
        if (b.branches.length > 2) return { result: await TEAM.start({ path: b.repo, branches: b.branches, source: 'workspace', title: sum.title }) };
        TEAM.deactivate();
        await REPO.open(b.repo, { name: sum.title, source: 'workspace' });
        return { result: await REPO.startMerge(b.a, b.b) };
      }
      default: return { error: 'Unknown workspace action ' + what };
    }
  } catch (e) { return { error: e.message }; }
}
// a whole team: three or more branches at once
async function teamAction(what, a = {}, local = true) {
  const readOnly = ['state', 'status', 'read', 'read_file'];
  if (!local && !readOnly.includes(what)) return { error: 'Team actions work only on the computer running Tandemi.' };
  try {
    switch (what) {
      case 'state': case 'status': return { result: TEAM.publicState() };
      case 'start': case 'merge': {
        const where = a.path || REPO.publicState().path;
        if (!where) return { error: 'Open a project first (a folder or a GitHub link).' };
        if (!Array.isArray(a.branches) || a.branches.length < 2) return { error: 'Choose at least two branches.' };
        if (a.branches.length === 2 && !a.team) { TEAM.deactivate(); if (a.path) await REPO.open(a.path); return { result: await REPO.startMerge(String(a.branches[0].ref || a.branches[0]), String(a.branches[1].ref || a.branches[1])) }; }
        return { result: await TEAM.start({ path: where, branches: a.branches, source: 'git' }) };
      }
      case 'resolve': case 'pick': return { result: await TEAM.resolve(String(a.developer || a.key || ''), String(a.file || ''), String(a.label || a.part || ''), String(a.pick || ''), a.code) };
      case 'ai': case 'ai_resolve': return { result: await TEAM.aiResolve(String(a.developer || a.key || ''), String(a.file || ''), String(a.label || a.part || '')) };
      case 'read': case 'read_file': return { result: TEAM.readFile(String(a.file || '')) };
      case 'write': case 'write_file': TEAM.writeFile(String(a.file || ''), String(a.content ?? ''), a.by || 'An AI coder'); return { result: a.retest === false ? TEAM.publicState() : await TEAM.retest(false) };
      case 'retest': return { result: await TEAM.retest() };
      case 'fix': case 'fix_bug': return { result: await TEAM.fixWithAI(a.bug ?? a.id) };
      case 'fix_all': return { result: await TEAM.fixAll() };
      case 'mode': REPO.setMode(a.mode); return { result: TEAM.setMode(a.mode) };
      case 'branch': case 'save_branch': return { result: await TEAM.createBranch(a.name, a.which) };
      case 'final': { const z = await TEAM.mergedZip(a.which); const out = path.join(AI.HOME, 'final', z.name); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, z.data); return { result: { saved: out, files: z.count } }; }
      default: return { error: 'Unknown team action ' + what };
    }
  } catch (e) { return { error: e.message }; }
}
module.exports = { TEAM, teamAction, init, wsAction, projectAction, fileAction, reopenLast, openSample, cloneProject, parseRepoUrl, REPO };
