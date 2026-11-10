// Tandemi · engine
// One team's Tandemi: bring each developer's code (paste, upload files or a folder, a folder on this computer, a git
// project or a GitHub link), merge it by structure, build and test it, send every bug to whoever caused it, let their
// AI agent fix it, and hand back the final code. Also answers the MCP for AI coders.
// It runs as its own process for each team, started by the hub (hub.js), which signs people in and says who is asking.
// It only listens on this computer and only answers requests that carry the hub's secret.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AI = require('./claude-api.js');
const ACT = require('./project-actions.js');
const REPO = ACT.REPO;

const ROOT = AI.ROOT, DATA = AI.DATA;
const SECRET = process.env.TANDEMI_HUB_SECRET || '';
if (!SECRET) { console.error('The engine is started by Tandemi (engine/server.js), not on its own.'); process.exit(1); }
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'tandemi.config.json'), 'utf8')); } catch (e) { /* defaults */ }
fs.mkdirSync(DATA, { recursive: true });
const SETTINGS = require('./settings.js');
SETTINGS.init(DATA, CFG);
AI.setModel(SETTINGS.get().model);
AI.setVia(SETTINGS.get().aiVia);
// what the page shows about the AI: an API key, or Claude Code with the person's own Claude subscription
const aiInfo = () => { const c = AI.claudeCode(); return { hasKey: AI.hasKey(), ready: AI.available(), via: AI.via(), claudeCode: { ok: c.ok, version: c.version, using: c.using }, model: AI.model() }; };
// looks for Claude Code now and then (someone may install or sign in while Tandemi runs) and tells the pages when it changed
async function recheckAI(force) { const was = AI.available(); await AI.checkClaudeCode(force); broadcast('ai', aiInfo()); if (!was && AI.available()) { try { pushProject(); REPO.aiConnected(); ACT.TEAM.aiConnected(); } catch (e) { /* nothing open */ } } }
setTimeout(() => recheckAI(true), 0);
// pull request check: watches the open project's GitHub pull requests while Tandemi runs (when it's turned on)
const PR = require('./prcheck.js');
let prTimer = null;
const pushPR = () => { if (prTimer) return; prTimer = setTimeout(() => { prTimer = null; broadcast('pr', PR.view()); }, 80); };
PR.init({ dataDir: DATA, onChange: pushPR, settings: () => SETTINGS.get(),
  projectPath: () => { const s = REPO.publicState(); return s.open && s.source === 'git' && s.path ? s.path : null; },
  plainFor: (dir) => REPO.plainActiveFor(dir) });
// pages listening for updates
const clients = new Set();
function send(res, event, data) { res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`); }
// one JSON for every page, and nothing at all when nothing changed since the last update
const last = {};
function broadcast(event, data) { const json = JSON.stringify(data); if (last[event] === json) return; last[event] = json; for (const c of clients) send(c, event, json); }
let timer = null;
const pushProject = () => { if (timer) return; timer = setTimeout(() => { timer = null; broadcast('project', REPO.publicState()); }, 80); };
let tTimer = null;
const pushTeam = () => { if (tTimer) return; tTimer = setTimeout(() => { tTimer = null; broadcast('team', ACT.TEAM.publicState()); }, 80); };
ACT.init(pushProject, pushTeam);
REPO.setMode(SETTINGS.get().mode); ACT.TEAM.setMode(SETTINGS.get().mode);
let wTimer = null;
const pushWorkspace = () => { if (wTimer) return; wTimer = setTimeout(() => { wTimer = null; broadcast('workspace', require('./workspace.js').summary()); }, 60); };

function json(res, code, obj, headers = {}) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); }
function readBody(req, limit = 300e6) { return new Promise((resolve) => { const chunks = []; let n = 0; req.on('data', c => { n += c.length; if (n > limit) req.destroy(); else chunks.push(c); }); req.on('end', () => { try { const b = Buffer.concat(chunks).toString('utf8'); resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } }); }); }
// who is asking, as the hub says: { id, name, email, role: owner | admin | member, local }
const sameSecret = (h) => { const a = Buffer.from(String(h || '')), b = Buffer.from(SECRET); return a.length === b.length && crypto.timingSafeEqual(a, b); };
function whoFrom(req) { try { return JSON.parse(Buffer.from(String(req.headers['x-tandemi-user'] || ''), 'base64').toString('utf8')); } catch (e) { return null; } }
const isAdmin = (me) => !!me && (me.role === 'owner' || me.role === 'admin');
function settingsView(me) {
  return { settings: SETTINGS.get(), models: SETTINGS.MODELS, me, owner: isAdmin(me), hasKey: AI.hasKey(), ai: aiInfo(),
    data: me && me.local ? DATA : null, home: me && me.local ? AI.HOME : null, version: (() => { try { return require('../package.json').version; } catch (e) { return ''; } })() };
}

// a folder on the computer running Tandemi can only be opened from that computer (not by a teammate elsewhere)
const LOCAL_ONLY = { project: ['open'], ws: ['folder'], merge: ['folders'] };
// starting over throws the team's open work away: in a team only its owner and admins may (your Personal space is yours)
const resetGuard = (what, me) => (/^(reset|start_over)$/.test(what) && !(me && (me.personal || isAdmin(me))) ? { error: "Only the team's owner or admins can start over: it clears the team's work for everyone." } : null);
const localOnly = (kind, what, me) => (LOCAL_ONLY[kind].includes(what) && !(me && me.local) ? { error: 'Opening a folder works only on the computer running Tandemi. Use a GitHub link, or upload the code.' } : null);
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (!sameSecret(req.headers['x-tandemi-hub'])) return json(res, 403, { error: 'Open Tandemi through its page.' });
  if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return json(res, 403, { error: 'Tandemi only takes JSON.' });
  const me = whoFrom(req), ok = !!me;
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, 'workspace.html'))); }
  if (url === '/api/settings' && req.method === 'GET') return json(res, 200, settingsView(me));
  if (url === '/api/pr' && req.method === 'GET') return json(res, 200, PR.view());
  if (url.startsWith('/api/pr/') && req.method === 'POST') {
    const what = url.slice(8), body = await readBody(req, 1e4);
    if (what !== 'check' && !isAdmin(me)) return json(res, 403, { error: "Only the team's owner or admins can change the pull request check." });
    try {
      if (what === 'token') { PR.setToken(body.token); return json(res, 200, PR.view()); }
      if (what === 'token/clear') { PR.clearToken(); return json(res, 200, PR.view()); }
      if (what === 'check') return json(res, 200, PR.checkNow());
    } catch (e) { return json(res, 400, { error: e.message }); }
    return json(res, 404, { error: 'No such action.' });
  }
  if (url === '/api/ai/check' && req.method === 'POST') { await recheckAI(true); return json(res, 200, aiInfo()); }
  if (url === '/api/health') return json(res, 200, { busy: !!(REPO.publicState().busy || ACT.TEAM.publicState().busy || REPO.publicState().autoFixing || ACT.TEAM.publicState().autoFixing), clients: clients.size });
  if (url === '/api/settings' && req.method === 'POST') {
    if (!isAdmin(me)) return json(res, 403, { error: "Only the team's owner or admins can change its settings." });
    const body = await readBody(req, 1e5);
    try {
      const ch = body.changes || {};
      for (const k of Object.keys(ch)) if (!['mode', 'model', 'aiVia', 'prAuto', 'prComment', 'prRepo'].includes(k)) throw new Error(`${k} is not a team setting.`);
      const now = SETTINGS.set(ch);
      if (ch.model) AI.setModel(now.model);
      if ('prAuto' in ch || 'prRepo' in ch) PR.settingsChanged();
      if (ch.aiVia) { AI.setVia(now.aiVia); await recheckAI(false); pushProject(); pushTeam(); }
      if (ch.mode) { REPO.setMode(now.mode); ACT.TEAM.setMode(now.mode); pushProject(); pushTeam(); }
      broadcast('settings', { settings: now });
      return json(res, 200, settingsView(me));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    clients.add(res);
    send(res, 'project', REPO.publicState()); send(res, 'team', ACT.TEAM.publicState()); send(res, 'workspace', require('./workspace.js').summary()); send(res, 'ai', aiInfo()); send(res, 'pr', PR.view()); send(res, 'settings', { settings: SETTINGS.get() });
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* gone */ } }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); }); return;
  }
  if (req.method === 'GET' && url === '/final.zip') { // the final code
    const which = (req.url.split('?')[1] || '').match(/which=(\w+)/);
    try { const z = ACT.TEAM.publicState().active ? await ACT.TEAM.mergedZip(which && which[1]) : await REPO.mergedZip(); res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${z.name}"` }); res.end(z.data); }
    catch (e) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end(e.message); }
    return;
  }
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  if (url === '/mcp/call') { // the MCP server (engine/mcp.js) forwards AI coders' tool calls here when Tandemi is running
    const b = await readBody(req), tool = String(b.tool || '');
    let r;
    if (tool.startsWith('project_')) r = localOnly('project', tool.slice(8), me) || await ACT.projectAction(tool.slice(8), { by: tool === 'project_plain_set_code' ? 'an AI coder (MCP)' : undefined, ...(b.args || {}) }, ok);
    else if (tool.startsWith('merge_')) r = localOnly('merge', tool.slice(6), me) || await ACT.fileAction(tool.slice(6), b.args || {}, ok);
    else if (tool.startsWith('team_')) r = await ACT.teamAction(tool.slice(5), b.args || {}, ok);
    else if (tool.startsWith('ws_')) { r = localOnly('ws', tool.slice(3), me) || await ACT.wsAction(tool.slice(3), b.args || {}, ok); pushWorkspace(); }
    else r = { error: 'Unknown tool ' + tool };
    return json(res, 200, r);
  }
  if (url.startsWith('/api/ws/')) {
    const r = localOnly('ws', url.slice(8), me) || await ACT.wsAction(url.slice(8), await readBody(req), ok); pushWorkspace();
    return json(res, r.error ? 400 : 200, r.error ? { error: r.error } : r.result);
  }
  if (url.startsWith('/api/team/')) {
    const r = await ACT.teamAction(url.slice(10), await readBody(req), ok);
    return json(res, r.error ? 400 : 200, r.error ? { error: r.error } : r.result);
  }
  if (url.startsWith('/api/project/')) {
    const r = localOnly('project', url.slice(13), me) || resetGuard(url.slice(13), me) || await ACT.projectAction(url.slice(13), await readBody(req), ok);
    if (/^(reset|start_over|sample)$/.test(url.slice(13))) { pushWorkspace(); pushTeam(); pushProject(); }
    return json(res, r.error ? 400 : 200, r.error ? { error: r.error } : r.result);
  }
  if (url.startsWith('/api/merge/')) { // three versions of one file, or three folders, without the build (quick merge)
    const r = localOnly('merge', url.slice(11), me) || await ACT.fileAction(url.slice(11), await readBody(req), ok);
    return json(res, r.error ? 400 : 200, r.error ? { error: r.error } : r.result);
  }
  if (!isAdmin(me)) return json(res, 403, { error: 'Only the team\'s owner or admins can do this.' });
  const body = await readBody(req, 1e6);
  if (url === '/api/key') { try { AI.setKey(body.key); } catch (e) { return json(res, 400, { error: e.message }); } broadcast('ai', aiInfo()); pushProject(); REPO.aiConnected(); ACT.TEAM.aiConnected(); return json(res, 200, { ok: true }); }
  if (url === '/api/settings/forget-results') { require('./fast.js').clearCache(); return json(res, 200, { ok: true }); }
  if (url === '/api/key/clear') { AI.clearKey(); broadcast('ai', aiInfo()); pushProject(); return json(res, 200, { ok: true }); }
  res.writeHead(404); res.end();
});
// the hub waits for the port, then sends this team's requests here
function main() {
  server.requestTimeout = 0; server.headersTimeout = 0; // builds and tests of big projects can take long
  ACT.reopenLast();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    if (process.send) process.send({ ready: true, port }); else console.log(`engine on ${port}`);
  });
  process.on('disconnect', () => process.exit(0)); // the hub is gone: so is this team's engine
}
process.on('SIGINT', () => process.exit(0));
main();
