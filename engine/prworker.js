// One pull request check, in its own process: the team merge of the base branch, this pull request and the other open
// ones, with its own folders, so it never touches the project or the merge someone has open in Tandemi.
// The parent sends { path, branches: [{ ref, name }], plain: [...], data } and gets back { state } or { error }.
'use strict';
process.on('message', async (job) => {
  try {
    const REPO = require('./repo.js'), TEAM = require('./team.js');
    REPO.setExternalPlain(job.path, job.plain || []);
    TEAM.init({ dataDir: job.data, onChange: () => {} }); // no AI here: the check only reports
    try { TEAM.setMode('report'); } catch (e) { /* nothing open yet */ }
    await TEAM.start({ path: job.path, branches: job.branches, source: 'git' });
    try { require('./fast.js').flush(); } catch (e) { /* nothing to save */ } // save the build results first: the parent stops this process as soon as it has the answer
    const s = TEAM.publicState();
    process.send({ state: { devs: s.devs.map(d => ({ key: d.key, name: d.name, branch: d.branch, status: d.status, run: d.run ? { ok: d.run.ok, summary: d.run.summary } : null })), blocked: s.blocked.map(b => ({ key: b.key, conflicts: b.conflicts.map(c => ({ file: c.file, label: c.label, with: c.with })) })), full: s.runs.full ? { ok: s.runs.full.ok, summary: s.runs.full.summary } : null, together: s.together, included: s.included, bugs: s.bugs.filter(b => b.status === 'open').map(b => ({ id: b.id, kind: b.kind, title: b.title, file: b.file, line: b.line, owner: b.owner, partner: b.partner, own: !!b.own, why: b.why, hint: b.hint, plainText: b.plainText || null })), setupProblem: s.setupProblem, checksOnly: s.checksOnly, phase: s.phase, step: s.step } });
  } catch (e) { process.send({ error: e.message || String(e) }); }
  setTimeout(() => process.exit(0), 50);
});
