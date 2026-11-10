// Pull request check: while Tandemi is open, it looks at the open pull requests of the project's GitHub repository.
// Each new or updated one is merged in its own folder with the base branch and the other open pull requests, built and
// tested (with the tests in plain words), and the result goes on the pull request as one comment that Tandemi keeps
// up to date: safe to merge, or what breaks and whose change it is.
'use strict';
const fs = require('fs');
const path = require('path');
const { fork, execFile } = require('child_process');

const API = (process.env.TANDEMI_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const MARK = '<!-- tandemi-pr-check -->';
const EVERY = Number(process.env.TANDEMI_PR_EVERY || 120) * 1000; // look for new pull requests every 2 minutes
const OTHERS = 3; // other open pull requests merged together with each one

let DATA = null, onChange = () => {}, projectPath = () => null, plainFor = () => [], settings = () => ({}), token = '';
let S = { prs: {}, busy: false, last: null, error: null, repo: null, step: '' };
let timer = null, wake = null;

const tokenFile = () => path.join(DATA, 'github-token.txt');
const stateFile = () => path.join(DATA, 'prcheck', 'state.json');
function init(opts) {
  DATA = opts.dataDir; onChange = opts.onChange || onChange; projectPath = opts.projectPath || projectPath; plainFor = opts.plainFor || plainFor; settings = opts.settings || settings;
  try { token = fs.readFileSync(tokenFile(), 'utf8').trim(); } catch (e) { token = ''; }
  try { S.prs = JSON.parse(fs.readFileSync(stateFile(), 'utf8')).prs || {}; } catch (e) { S.prs = {}; }
  schedule(5000);
}
const save = () => { try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify({ prs: S.prs })); } catch (e) { /* only a cache */ } };
const changed = () => onChange(view());
function setToken(t) {
  t = String(t || '').trim();
  if (!/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(t)) throw new Error('That doesn\'t look like a GitHub token. It starts with github_pat_ or ghp_.');
  token = t; fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(tokenFile(), t); S.error = null; changed(); schedule(500);
}
function clearToken() { token = ''; try { fs.rmSync(tokenFile(), { force: true }); } catch (e) { /* none */ } changed(); }

function git(args, cwd, env) { return new Promise((ok) => execFile('git', args, { cwd, windowsHide: true, maxBuffer: 1 << 24, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env || {}) } }, (e, out, err) => ok({ code: e ? 1 : 0, out: String(out || ''), err: String(err || '') }))); }
// git with the token for github.com, given through the environment (not the command line, not the repository's settings)
const authEnv = () => (token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64') } : {});

// GETs remember GitHub's ETag: asking again with it gets a tiny "304 nothing changed" answer that GitHub doesn't
// count against the hourly limit, and Tandemi then skips the rest of its look
const etags = new Map();
async function gh(method, url, body) {
  const memo = method === 'GET' ? etags.get(url) : null;
  const r = await fetch(API + url, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Tandemi', ...(memo ? { 'if-none-match': memo.etag } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 304 && memo) { gh.same = (gh.same || 0) + 1; return memo.data; }
  const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (method === 'GET' && r.ok && r.headers.get('etag')) { etags.set(url, { etag: r.headers.get('etag'), data }); if (etags.size > 200) etags.delete(etags.keys().next().value); }
  if (!r.ok) {
    const why = data && data.message ? data.message : `HTTP ${r.status}`;
    const e = new Error(r.status === 401 ? 'GitHub doesn\'t accept the token (wrong or expired). Make a new one and save it again.' : r.status === 403 && /rate limit/i.test(why) ? 'GitHub says Tandemi asked too often. It tries again in a few minutes.' : r.status === 404 ? 'GitHub can\'t find the repository with this token. Check the repository, and that the token may read it.' : r.status === 403 ? `GitHub didn't allow it: ${why}. The token needs "Pull requests: read and write" (and "Commit statuses: read and write").` : `GitHub: ${why}`);
    e.status = r.status; throw e;
  }
  return data;
}

// owner/repo: from the settings, otherwise from the project's "origin" remote on github.com
async function repoOf(dir) {
  const set = String(settings().prRepo || '').trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(set)) return set;
  const r = await git(['remote', 'get-url', 'origin'], dir);
  const m = r.out.trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function schedule(ms) { clearTimeout(timer); timer = setTimeout(() => tick().catch(() => {}), ms == null ? EVERY : ms); }
async function tick(force) {
  try {
    const set = settings(), dir = projectPath();
    if (S.busy) return;
    if (!force && !set.prAuto) return;
    if (!token) { S.error = force ? 'Save a GitHub token first.' : null; return; }
    if (!dir) { S.error = 'Open the project (a folder or a GitHub link) so Tandemi knows which repository to watch.'; return; }
    S.repo = await repoOf(dir);
    if (!S.repo) { S.error = 'This project has no GitHub "origin". Type the repository (owner/name) in the settings.'; return; }
    S.busy = true; S.error = null; S.step = 'Looking at the open pull requests…'; changed();
    const pulls = (await gh('GET', `/repos/${S.repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`)) || [];
    S.open = pulls.map(p => p.number);
    for (const n of Object.keys(S.prs)) if (!S.open.includes(Number(n))) delete S.prs[n]; // closed or merged
    // where each base branch is now (from GitHub, also answered with "nothing changed" when it didn't move)
    const bases = {};
    for (const b of new Set(pulls.map(p => p.base.ref))) { const br = await gh('GET', `/repos/${S.repo}/branches/${encodeURIComponent(b)}`); bases[b] = br && br.commit ? br.commit.sha : ''; }
    // the pull requests of the same base go together; each one with up to OTHERS of the most recently updated others;
    // only the ones whose code changed since their last check are fetched and checked again
    const todo = pulls.slice(0, 10).map(p => {
      const others = pulls.filter(o => o.number !== p.number && o.base.ref === p.base.ref).slice(0, OTHERS);
      return { p, others, key: [bases[p.base.ref], p.head.sha, ...others.map(o => `${o.number}:${o.head.sha}`)].join('|') };
    }).filter(x => force || !S.prs[x.p.number] || S.prs[x.p.number].key !== x.key || S.prs[x.p.number].status === 'checking');
    if (todo.length) {
      const need = new Set(); for (const x of todo) for (const q of [x.p, ...x.others]) need.add(q);
      const f = await git(['fetch', '--quiet', 'origin', ...[...new Set(todo.map(x => x.p.base.ref))].map(b => `+refs/heads/${b}:refs/remotes/origin/${b}`), ...[...need].map(q => `+refs/pull/${q.number}/head:refs/tandemi/pr/${q.number}`)], dir, authEnv());
      if (f.code) throw new Error('git could not get the pull requests: ' + (f.err || f.out).trim().split('\n').pop());
    }
    for (const { p, others, key } of todo) {
      const old = S.prs[p.number];
      S.prs[p.number] = { ...(old || {}), number: p.number, title: p.title, by: p.user && p.user.login, url: p.html_url, key, status: 'checking', at: Date.now() };
      S.step = `Checking pull request #${p.number} (${p.title})…`; changed();
      const res = await checkOne(dir, p, others);
      Object.assign(S.prs[p.number], res, { at: Date.now() });
      if (set.prComment !== false && res.comment) {
        try { S.prs[p.number].commentId = await postComment(p.number, res.comment, S.prs[p.number].commentId); } catch (e) { S.prs[p.number].commentError = e.message; }
        try { await gh('POST', `/repos/${S.repo}/statuses/${p.head.sha}`, { state: res.status === 'safe' ? 'success' : res.status === 'breaks' ? 'failure' : 'error', context: 'Tandemi', description: res.headline.slice(0, 140) }); } catch (e) { /* the token may not have "commit statuses": the comment is enough */ }
      }
      save(); changed();
    }
    S.last = Date.now();
  } catch (e) {
    S.error = e.message;
    for (const p of Object.values(S.prs)) if (p.status === 'checking') Object.assign(p, { status: 'error', headline: `Tandemi couldn't finish the check: ${e.message}`, problems: [] }); // never stuck on "checking"
  }
  finally { S.busy = false; S.step = ''; save(); changed(); schedule(); }
}

// one pull request: base + this one + the others, merged and checked in a separate process
function runWorker(job) {
  return new Promise((ok) => {
    const w = fork(path.join(__dirname, 'prworker.js'), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TANDEMI_TOOLS_PRINT: job.tools || '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let done = false; const end = (r) => { if (!done) { done = true; clearTimeout(t); try { w.kill(); } catch (e) { /* gone */ } ok(r); } };
    const t = setTimeout(() => end({ error: 'The check took longer than 30 minutes, so Tandemi stopped it.' }), 30 * 60000);
    w.on('message', end); w.on('exit', () => end({ error: 'The check stopped unexpectedly.' })); w.send(job);
  });
}
async function checkOne(dir, p, others) {
  const who = (o) => `@${o.user ? o.user.login : 'someone'} (#${o.number})`;
  const branches = [{ ref: `refs/remotes/origin/${p.base.ref}`, name: p.base.ref }, { ref: `refs/tandemi/pr/${p.number}`, name: who(p) }, ...others.map(o => ({ ref: `refs/tandemi/pr/${o.number}`, name: who(o) }))];
  const r = await runWorker({ path: dir, branches, plain: plainFor(dir), data: path.join(DATA, 'prcheck'), tools: await require('./fast.js').tools() });
  if (r.error) return { status: 'error', headline: `Tandemi couldn't check it: ${r.error}`, comment: null, error: r.error };
  return describe(r.state, p, others, branches);
}

// what the comment says, for this pull request (problems that are only between other pull requests are just counted)
function describe(s, p, others, branches) {
  const me = s.devs[1] ? s.devs[1].key : 'B', nameOf = (k) => (s.devs.find(d => d.key === k) || {}).name || k;
  const baseKey = s.devs[0] ? s.devs[0].key : 'A';
  const mine = s.bugs.filter(b => b.owner === me || b.partner === me), inBase = s.bugs.filter(b => !mine.includes(b) && b.owner === baseKey && !b.partner);
  const elsewhere = s.bugs.length - mine.length - inBase.length;
  const blocked = s.blocked.filter(b => b.key === me || b.conflicts.some(c => c.with === me));
  const withText = others.length ? ` and the other open pull request${others.length === 1 ? '' : 's'} (${others.map(o => '#' + o.number).join(', ')})` : '';
  const checks = s.full ? s.full.summary : '';
  let status, headline;
  if (s.setupProblem) { status = 'error'; headline = `Tandemi couldn't build it on this computer: ${s.setupProblem}`; }
  else if (!mine.length && !blocked.length) { status = 'safe'; const rest = s.bugs.length + s.blocked.length; headline = rest ? `Safe to merge: nothing in it breaks anything. Together with ${p.base.ref}${withText} ${rest === 1 ? 'one problem remains, and it comes' : `${rest} problems remain, and they come`} from elsewhere.` : `Safe to merge: together with ${p.base.ref}${withText} it ${checks || 'merges cleanly'}.`; }
  else { status = 'breaks'; headline = `${mine.length + blocked.length} problem${mine.length + blocked.length === 1 ? '' : 's'} when merged with ${p.base.ref}${withText}.`; }
  const lines = [MARK, `### ${status === 'safe' ? '✅' : status === 'breaks' ? '❌' : '⚠️'} Tandemi: ${status === 'safe' ? 'safe to merge' : status === 'breaks' ? 'this breaks something' : "couldn't check"}`, '', headline, ''];
  for (const b of blocked) for (const c of b.conflicts.filter(c => b.key === me || c.with === me)) lines.push(`- **Real conflict** in \`${c.file}\` (${c.label}): ${nameOf(b.key)} and ${nameOf(c.with)} changed the same part differently. One of them has to choose what to keep.`);
  for (const b of mine) {
    const where = b.file ? ` (\`${b.file}${b.line ? ':' + b.line : ''}\`)` : '';
    lines.push(`- **${b.title.replace(/\s+/g, ' ')}**${where} → goes to **${nameOf(b.owner)}**${b.partner ? `, clashes with ${nameOf(b.partner)}` : ''}.`);
    if (b.why) lines.push(`  ${b.why.replace(/\s+/g, ' ')}`);
    if (b.hint) lines.push(`  Hint: ${b.hint.replace(/\s+/g, ' ')}`);
  }
  if (inBase.length) lines.push('', `Note: ${p.base.ref} itself already has ${inBase.length} problem${inBase.length === 1 ? '' : 's'} before any merge (${inBase.slice(0, 3).map(b => b.title.replace(/\s+/g, ' ')).join('; ')}). That isn't this pull request's fault.`);
  if (elsewhere > 0) lines.push('', `Tandemi also found ${elsewhere} problem${elsewhere === 1 ? '' : 's'} between other pull requests; ${elsewhere === 1 ? 'it is' : 'they are'} reported there.`);
  lines.push('', `<sub>Checked: ${branches.map(b => b.name).join(' + ')} · ${s.checksOnly ? 'compile check' : 'build and tests'}${s.full ? ' · ' + s.full.summary : ''} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</sub>`);
  return { status, headline, comment: lines.join('\n'), problems: mine.map(b => ({ title: b.title, owner: nameOf(b.owner), partner: b.partner ? nameOf(b.partner) : null })).concat(blocked.map(b => ({ title: 'Real conflict', owner: nameOf(b.key), partner: nameOf(b.conflicts[0].with) }))), error: null };
}

// one Tandemi comment per pull request, updated each time (found again by its mark if the id was lost)
async function postComment(number, body, id) {
  if (id) { try { await gh('PATCH', `/repos/${S.repo}/issues/comments/${id}`, { body }); return id; } catch (e) { if (e.status !== 404) throw e; } }
  const list = (await gh('GET', `/repos/${S.repo}/issues/${number}/comments?per_page=100`)) || [];
  const mine = list.find(c => typeof c.body === 'string' && c.body.startsWith(MARK));
  if (mine) { await gh('PATCH', `/repos/${S.repo}/issues/comments/${mine.id}`, { body }); return mine.id; }
  return (await gh('POST', `/repos/${S.repo}/issues/${number}/comments`, { body })).id;
}

function view() {
  return { hasToken: !!token, repo: S.repo, busy: S.busy, step: S.step, error: S.error, last: S.last, every: EVERY / 1000,
    prs: Object.values(S.prs).sort((a, b) => b.number - a.number).map(p => ({ number: p.number, title: p.title, by: p.by, url: p.url, status: p.status, headline: p.headline || '', problems: p.problems || [], at: p.at, commentError: p.commentError || null })) };
}
const checkNow = () => { if (S.busy) throw new Error('Tandemi is checking the pull requests right now.'); if (!token) throw new Error('Save a GitHub token first.'); setTimeout(() => tick(true).catch(() => {}), 0); return view(); };
module.exports = { init, view, setToken, clearToken, checkNow, settingsChanged: () => schedule(1000), describe };
