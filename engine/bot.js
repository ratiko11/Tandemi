#!/usr/bin/env node
// bot.js · the Tandemi merge bot.
// On GitHub (as an Action, on every pull request): merges the pull request with its base branch by the code's
// structure, builds and tests the base alone, the pull request alone and the merged code, then posts one comment
// on the pull request that says exactly who has to fix what (and keeps it up to date on every push).
// On your computer:  node engine/bot.js --repo <folder> --base <branch> --head <branch>   (prints the report)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const env = process.env;
const onGitHub = flag('github') || !!env.GITHUB_ACTIONS;
const MARK = '<!-- tandemi-bot -->';

function git(argv, cwd) { return new Promise((res) => execFile('git', argv, { cwd, maxBuffer: 64 << 20, windowsHide: true }, (e, out, err) => res({ code: e ? 1 : 0, out: out || '', err: err || '' }))); }
async function api(method, url, body) {
  const base = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'tandemi-bot', 'x-github-api-version': '2022-11-28' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`GitHub ${method} ${url}: ${r.status} ${(data && data.message) || ''}`);
  return data;
}

async function main() {
  // ---- what to merge
  let repoDir = path.resolve(opt('repo', env.GITHUB_WORKSPACE || process.cwd()));
  let event = null;
  if (onGitHub && env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event && event.pull_request;
  let baseRef = opt('base', pr ? pr.base.ref : null), headRef = opt('head', pr ? pr.head.sha : null);
  if (!baseRef || !headRef) {
    console.error('Usage: node engine/bot.js --repo <project folder> --base <branch> --head <branch>\n  (On GitHub it reads the pull request by itself.)');
    process.exit(2);
  }
  // on GitHub the base branch is origin/<name>
  for (const cand of [`origin/${baseRef}`, baseRef]) { if (!(await git(['rev-parse', '--verify', '-q', cand], repoDir)).code) { baseRef = cand; break; } }
  if (pr && (await git(['rev-parse', '--verify', '-q', headRef], repoDir)).code) await git(['fetch', 'origin', pr.head.sha], repoDir);
  if (pr && pr.head.ref) { // a readable name for the pull request's side (instead of a commit id)
    const name = 'pr-' + pr.number + '/' + pr.head.ref.replace(/[^\w./-]+/g, '-');
    if (!(await git(['branch', '-f', name, pr.head.sha], repoDir)).code) headRef = name;
  }

  // ---- run Tandemi
  process.env.TANDEMI_NO_OPEN = '1';
  const REPO = require('./repo.js');
  const AI = require('./claude-api.js');
  const work = path.join(env.RUNNER_TEMP || os.tmpdir(), 'tandemi-bot');
  REPO.init({ dataDir: work, onChange: () => {}, claude: (s, u) => AI.askJSON(s, u), hasAI: AI.hasKey });
  log(`Tandemi: merging ${baseRef} and ${headRef} in ${repoDir}`);
  await REPO.open(repoDir);
  let s = await REPO.startMerge(baseRef, headRef);
  // real conflicts: let AI combine them when a key is set, otherwise report them
  if (s.phase === 'conflicts' && AI.hasKey()) {
    for (const f of s.files) for (const c of f.conflicts) if (!c.pick) { try { s = await REPO.aiPick(f.file, c.id); } catch (e) { log('AI could not combine ' + c.label + ': ' + e.message); } }
  }
  // the AI agents try to fix the bugs (only with a key; the fix is kept only if the bug is gone)
  if (AI.hasKey() && flag('fix') || AI.hasKey() && env.TANDEMI_FIX === 'true') {
    for (const b of (s.bugs || []).filter(x => x.status === 'open')) { try { s = await REPO.fixWithAI(b.id); } catch (e) { log(`AI could not fix bug ${b.id}: ${e.message}`); } }
  }
  s = REPO.publicState();

  // ---- GitHub names for the two sides
  const handles = { A: null, B: null };
  if (onGitHub && env.GITHUB_TOKEN && env.GITHUB_REPOSITORY) {
    try {
      if (pr) handles.B = pr.user && pr.user.login;
      const commits = await api('GET', `/repos/${env.GITHUB_REPOSITORY}/commits?sha=${encodeURIComponent(pr ? pr.base.sha : baseRef)}&per_page=50`);
      const c = commits.find(x => x.commit && x.commit.author && x.commit.author.email === s.devs.A.email && x.author);
      if (c) handles.A = c.author.login;
    } catch (e) { log('Could not look up GitHub names: ' + e.message); }
  }

  // ---- save the merge as a branch when git would have stopped with conflicts but Tandemi merged it
  let pushed = null;
  const gitStops = s.gitView && s.gitView.conflictFiles.length;
  const solved = s.files.every(f => f.conflicts.every(c => c.pick));
  const wantPush = flag('push-merge') || env.TANDEMI_PUSH_MERGE === 'true';
  const clean = !s.bugs.some(b => b.status === 'open');
  if (wantPush && gitStops && solved && clean && s.phase !== 'error') {
    const name = pr ? `tandemi/pr-${pr.number}` : `tandemi/merge-${s.devs.A.branch}-${s.devs.B.branch}`.replace(/[^\w./-]+/g, '-');
    try {
      s = await REPO.createBranch(name);
      const p = await git(['push', '-f', 'origin', `${name}:refs/heads/${name}`], repoDir);
      pushed = p.code ? { name, error: (p.err || p.out).trim().split('\n').pop() } : { name };
    } catch (e) { pushed = { name, error: e.message }; }
  }

  const report = makeReport(s, handles, pr, pushed);
  console.log('\n' + report + '\n');
  if (env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report + '\n'); } catch (e) { /* no summary */ } }

  // ---- one comment on the pull request, updated on every push
  if (onGitHub && pr && env.GITHUB_TOKEN && env.GITHUB_REPOSITORY && env.TANDEMI_COMMENT !== 'false') {
    try {
      const list = await api('GET', `/repos/${env.GITHUB_REPOSITORY}/issues/${pr.number}/comments?per_page=100`);
      const mine = list.find(c => String(c.body || '').includes(MARK));
      if (mine) await api('PATCH', `/repos/${env.GITHUB_REPOSITORY}/issues/comments/${mine.id}`, { body: report });
      else await api('POST', `/repos/${env.GITHUB_REPOSITORY}/issues/${pr.number}/comments`, { body: report });
      log('Posted the Tandemi comment on pull request #' + pr.number);
    } catch (e) { log('Could not comment on the pull request: ' + e.message + ' (does the workflow have "pull-requests: write" permission?)'); }
  }

  const open = s.bugs.filter(b => b.status === 'open').length, unsolved = s.files.reduce((n, f) => n + f.conflicts.filter(c => !c.pick).length, 0);
  const fail = (open || unsolved || s.phase === 'error') && (env.TANDEMI_FAIL_ON_BUGS || 'true') !== 'false' && !flag('no-fail');
  process.exit(fail ? 1 : 0);
}
function log(t) { console.error(t); }

function makeReport(s, handles, pr, pushed) {
  const who = (side) => {
    if (side === 'both') return `${who('A')} and ${who('B')}`;
    const h = handles[side], d = s.devs[side];
    return h ? `@${h}` : `**${d.name}**`;
  };
  const br = (side) => '`' + s.devs[side].branch.replace(/^origin\//, '') + '`';
  const short = (side) => (side === 'B' && pr ? `#${pr.number}` : br(side));
  const L = [MARK, '### 🤝 Tandemi merge check', ''];
  const real = s.files.reduce((n, f) => n + f.conflicts.length, 0), unsolved = s.files.reduce((n, f) => n + f.conflicts.filter(c => !c.pick).length, 0);
  const ast = s.files.filter(f => f.method === 'ast').length, gitN = s.gitView ? s.gitView.conflictFiles.length : null;
  L.push(`Merging ${short('B')} by ${who('B')} into ${br('A')} (${s.devs.A.commits} new commit${s.devs.A.commits === 1 ? '' : 's'} there since this branch started, mostly by ${who('A')}).`, '');
  L.push(`| | |`, `|---|---|`);
  if (gitN != null) L.push(`| git merge | ${gitN ? `❌ stops with conflicts in ${gitN} file${gitN === 1 ? '' : 's'}` : '✅ no conflicts'} |`);
  L.push(`| Tandemi merge (by structure) | ${real ? (unsolved ? `⚠️ ${unsolved} real conflict${unsolved === 1 ? '' : 's'} to decide` : `✅ ${real} real conflict${real === 1 ? '' : 's'}, combined by AI`) : `✅ no real conflicts`}${ast ? ` · ${ast} file${ast === 1 ? '' : 's'} merged by structure` : ''} |`);
  for (const [k, label] of [['A', br('A') + ' alone'], ['B', short('B') + ' alone'], ['merged', 'Merged code']]) if (s.runs[k]) L.push(`| ${label} | ${s.runs[k].ok ? '✅' : '❌'} ${s.runs[k].summary} |`);
  if (!s.commands.build && !s.commands.test) L.push(`| Build and tests | ➖ no build or test command found (add a \`tandemi.json\`) |`);
  L.push('');
  if (unsolved) {
    L.push('#### Real conflicts', 'Both sides changed the same part in different ways. Decide which to keep (or add an `ANTHROPIC_API_KEY` secret and Tandemi combines them):', '');
    for (const f of s.files) for (const c of f.conflicts.filter(x => !x.pick)) L.push(`- \`${f.file}\` → ${c.label}`);
    L.push('');
  }
  const open = s.bugs.filter(b => b.status === 'open'), fixed = s.bugs.filter(b => b.status === 'fixed');
  if (open.length) {
    L.push(`#### ${open.length} bug${open.length === 1 ? '' : 's'}, each sent to whoever caused it`, '');
    for (const b of open) {
      L.push(`**${b.title.replace(/\|/g, '\\|')}** → ${who(b.owner)}${b.file ? ` · \`${b.file}\`${b.line ? ` line ${b.line}` : ''}` : ''}`);
      if (b.kind === 'test' && b.message) L.push(`> ${b.message.split('\n')[0].replace(/^System\.Exception: /, '')}`);
      L.push(`${b.why.replace(/Each branch builds on its own/, 'Each side builds on its own')}`);
      if (b.hint) L.push(`💡 ${b.hint}`);
      if (b.alsoAt && b.alsoAt.length) L.push(`⚠️ \`${b.oldName}\` is also still used in ${b.alsoAt.map(a => `\`${a.file}\` line ${a.line}`).join(', ')}. The build stops before it gets there, so fix ${b.alsoAt.length === 1 ? 'it' : 'them'} too.`);
      L.push('');
    }
  } else if (s.runs.merged) L.push('✅ **The merged code builds and every test passes. Safe to merge.**', '');
  if (fixed.length) L.push(`Fixed by Tandemi's agents: ${fixed.map(b => b.title).join('; ')}`, '');
  if (!pushed && gitN && !unsolved && open.length && (process.env.TANDEMI_PUSH_MERGE === 'true')) L.push(`🔀 git can't merge this, but Tandemi can. Once the bugs above are fixed, Tandemi pushes its merged code to a branch for you.`, '');
  if (pushed) L.push(pushed.error ? `Tandemi tried to push its merge to \`${pushed.name}\` but couldn't: ${pushed.error}` : `🔀 git couldn't merge this, Tandemi could: the merged code is on branch \`${pushed.name}\`.`, '');
  L.push('<sub>Tandemi merges by the code\'s structure, tests each side alone and together, and finds the conflicts git can\'t see. This comment updates on every push.</sub>');
  return L.join('\n').replace(/\borigin\//g, '');
}

main().catch((e) => { console.error('Tandemi bot: ' + e.message); process.exit(1); });
