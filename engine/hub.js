// Tandemi · hub
// The front door: accounts (register, sign in), teams (like Discord servers) with invites and roles, and each team's
// own Tandemi engine. Every team runs in its own process (engine-server.js), started the first time someone opens it
// and stopped after a while with nobody there, so teams never see or slow down each other. The hub checks who is
// asking and their role in the team, then passes the request to that team's engine with a secret only it knows.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork, spawn } = require('child_process');
const AI = require('./claude-api.js');
const AUTH = require('./auth.js');
const SP = require('./spaces.js');

const ROOT = AI.ROOT, DATA = AI.DATA, HOME = AI.HOME;
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'tandemi.config.json'), 'utf8')); } catch (e) { /* defaults */ }
const PORT = Number(process.env.TANDEMI_PORT || process.env.PAIRPLAY_PORT) || CFG.port || 3000;
const HUB = path.join(DATA, 'hub');
// once: start.bat used to keep everything in the tandemi folder (.pairplay). Now it shares the app's folder, so its
// accounts, teams, projects and settings are copied there the first time (the old folder stays as it was, as a
// backup). If the app already made its own data there, that is kept next to it as "data-before-start-bat-…".
function bringStartBatData() {
  if (!AI.SHARED || path.resolve(AI.LEGACY) === path.resolve(DATA)) return;
  const mark = path.join(DATA, 'came-from-start-bat.txt');
  if (fs.existsSync(mark) || !fs.existsSync(AI.LEGACY)) return;
  if (!['hub', 'accounts', 'projects', 'spaces'].some(d => fs.existsSync(path.join(AI.LEGACY, d)))) return; // nothing made there yet
  const SKIP = /[\\/](projects[\\/](work|team)|prcheck[\\/]team)([\\/]|$)/; // git worktrees: rebuilt when needed, never copied
  try {
    if (fs.existsSync(DATA) && fs.readdirSync(DATA).length) {
      const bak = `${DATA}-before-start-bat-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      fs.renameSync(DATA, bak);
      console.log(`  The app's own Tandemi data is kept in ${bak}`);
    }
    fs.mkdirSync(DATA, { recursive: true });
    fs.cpSync(AI.LEGACY, DATA, { recursive: true, filter: (src) => !SKIP.test(path.relative(AI.LEGACY, src) ? path.sep + path.relative(AI.LEGACY, src) : '') });
    fs.writeFileSync(mark, `Copied from ${AI.LEGACY} on ${new Date().toISOString()}\n`);
    try { fs.writeFileSync(path.join(AI.LEGACY, 'MOVED.txt'), `Tandemi now keeps its data in ${DATA}, shared by start.bat and the app.\nThis folder is the old copy: you can delete it once everything looks right.\n`); } catch (e) { /* read-only: fine */ }
    console.log(`  Tandemi now keeps its data in ${DATA} (shared with the app). Your accounts, teams and projects came along.`);
  } catch (e) { console.log(`  Tandemi couldn't move its data to the shared folder (${e.message}). It keeps working; close the Tandemi app and start again to try once more.`); }
}
bringStartBatData();
fs.mkdirSync(HUB, { recursive: true });
// accounts made with the version before teams keep working: they move into the hub (passwords stay as they were)
if (!fs.existsSync(path.join(HUB, 'accounts', 'users.json')) && fs.existsSync(path.join(DATA, 'accounts', 'users.json'))) { try { fs.rmSync(path.join(HUB, 'accounts'), { recursive: true, force: true }); fs.renameSync(path.join(DATA, 'accounts'), path.join(HUB, 'accounts')); } catch (e) { /* stays: new accounts then */ } }
AUTH.init(path.join(HUB, 'accounts')); SP.init(HUB);
const SECRET = crypto.randomBytes(32).toString('hex'); // new every start: only this hub's engines know it

// ---- the server's own settings (the first account owns the server)
const SERVER_FILE = path.join(HUB, 'server.json');
let SERVER = { allowRegister: true, shareOnNetwork: CFG.shareOnNetwork !== false };
try { Object.assign(SERVER, JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'))); } catch (e) { /* defaults */ }
const saveServer = () => fs.writeFileSync(SERVER_FILE, JSON.stringify(SERVER, null, 2));
let LAST = {}; const LAST_FILE = path.join(HUB, 'last-space.json');
try { LAST = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch (e) { /* none */ }
const remember = (uid, sid) => { if (LAST[uid] === sid) return; LAST[uid] = sid; try { fs.writeFileSync(LAST_FILE, JSON.stringify(LAST)); } catch (e) { /* not remembered */ } };

// ---- Tandemi from before teams: its projects, tests and key become the first person's Personal space
const LEGACY = ['projects', 'workspaces', 'plain', 'settings.json', 'anthropic-key.txt', 'last-project.txt'];
function adoptLegacy(space) {
  const to = spaceData(space); fs.mkdirSync(to, { recursive: true });
  for (const n of LEGACY) { const from = path.join(DATA, n); if (fs.existsSync(from) && !fs.existsSync(path.join(to, n))) try { fs.renameSync(from, path.join(to, n)); } catch (e) { /* in use: stays where it was */ } }
}
// everyone has a Personal space; the server's owner's first one also gets what Tandemi had from before teams
function personalFor(u) {
  let p = SP.personalOf(u.id);
  if (!p) { p = SP.create('Personal', u.id, { personal: true }); if (u.role === 'owner') adoptLegacy(p); }
  return p;
}
const slug = (s) => String(s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 32) || 'team';
const spaceData = (s) => path.join(DATA, 'spaces', s.id);
const spaceHome = (s) => path.join(HOME, s.personal ? 'Personal' : `${slug(s.name)}-${s.id.slice(0, 4)}`);

// ---- each team's engine
const ENG = new Map();
function engineFor(s) {
  const have = ENG.get(s.id); if (have) return have.ready;
  const env = { ...process.env, TANDEMI_HUB_SECRET: SECRET, TANDEMI_DATA: spaceData(s), TANDEMI_HOME: spaceHome(s), TANDEMI_NO_OPEN: '1', ELECTRON_RUN_AS_NODE: '1' };
  delete env.TANDEMI_PORT; delete env.PAIRPLAY_PORT;
  fs.mkdirSync(env.TANDEMI_DATA, { recursive: true });
  const child = fork(path.join(__dirname, 'engine-server.js'), [], { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const e = { child, port: null, last: Date.now(), clients: 0 };
  e.ready = new Promise((ok, fail) => {
    const t = setTimeout(() => { fail(new Error("The team's engine didn't start in time.")); try { child.kill(); } catch (x) { /* gone */ } }, 90000);
    child.on('message', (m) => { if (m && m.ready) { clearTimeout(t); e.port = m.port; ok(e); } });
    child.on('exit', () => { clearTimeout(t); ENG.delete(s.id); fail(new Error("The team's engine stopped.")); });
  });
  e.ready.catch(() => {});
  ENG.set(s.id, e); return e.ready;
}
const stopEngine = (sid) => { const e = ENG.get(sid); if (e) { ENG.delete(sid); try { e.child.kill(); } catch (x) { /* gone */ } } };
// nobody there for 30 minutes and nothing running: the team's engine stops (it starts again in a second when needed)
setInterval(() => {
  for (const [sid, e] of ENG) {
    if (!e.port || e.clients > 0 || Date.now() - e.last < 30 * 60000) continue;
    const r = http.request({ host: '127.0.0.1', port: e.port, path: '/api/health', headers: { 'x-tandemi-hub': SECRET } }, (res) => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { if (!JSON.parse(b).busy) stopEngine(sid); } catch (x) { /* keep it */ } }); });
    r.on('error', () => stopEngine(sid)); r.end();
  }
}, 5 * 60000).unref();
process.on('exit', () => { for (const e of ENG.values()) try { e.child.kill(); } catch (x) { /* gone */ } });

// ---- helpers
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function lanAddresses() { const out = []; for (const list of Object.values(require('os').networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address); return out; }
function json(res, code, obj, headers = {}) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); }
function readBody(req, limit = 1e5) { return new Promise((resolve) => { const chunks = []; let n = 0; req.on('data', c => { n += c.length; if (n > limit) req.destroy(); else chunks.push(c); }); req.on('end', () => { try { const b = Buffer.concat(chunks).toString('utf8'); resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } }); }); }
const redirect = (res, to) => { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); };
const page = (res, file) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(__dirname, file))); };
const cookie = (req, name) => { const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return m ? decodeURIComponent(m[1]) : null; };
const sessionCookie = (token, maxAge) => ({ 'set-cookie': `tandemi_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` });
// Only Tandemi's own pages may send commands: posts from other websites (or with a strange Host name) are refused
function foreign(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const okHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[a-z0-9-]+$/.test(host) || /\.(local|lan|home\.arpa|internal)$/.test(host) || (process.env.TANDEMI_HOSTNAME && host === process.env.TANDEMI_HOSTNAME.toLowerCase());
  if (!okHost) return 'Unknown host name.';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') { try { if (new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) return 'Requests from other websites are not allowed.'; } catch (e) { return 'Bad origin.'; } }
  if (req.method === 'POST' && req.url !== '/api/quit' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return 'Tandemi only takes JSON.';
  return null;
}
const names = () => { const m = new Map(); for (const u of AUTH.list()) m.set(u.id, u); return m; };
function hubView(req, me) {
  const spaces = me ? SP.listFor(me.id).map(s => SP.view(s, me.id)) : [];
  return { me, spaces, last: me ? LAST[me.id] || null : null, serverOwner: !!me && me.role === 'owner', server: me && me.role === 'owner' ? { ...SERVER, lan: SERVER.shareOnNetwork ? lanAddresses().map(a => `http://${a}:${port}`) : [] } : null, local: isLocal(req), restartNeeded };
}
let restartNeeded = false;
// ---- AI coders (MCP): a private key per person and team, so Claude Desktop works in that team as that person
const TOK_FILE = path.join(HUB, 'mcp-tokens.json');
let TOKENS = {}; try { TOKENS = JSON.parse(fs.readFileSync(TOK_FILE, 'utf8')); } catch (e) { /* none */ }
const saveTokens = () => fs.writeFileSync(TOK_FILE, JSON.stringify(TOKENS), { mode: 0o600 });
const tokHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function tokenUser(req, sid) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/); if (!m) return null;
  const t = TOKENS[tokHash(m[1])]; if (!t || t.sid !== sid) return null;
  return AUTH.list().find(u => u.id === t.uid) || null;
}
function membersOf(s, me) { const n = names(); return { members: s.members.map(m => ({ uid: m.uid, role: m.role, name: (n.get(m.uid) || {}).name || 'Someone', email: (n.get(m.uid) || {}).email || '', me: m.uid === me.id })), myRole: SP.roleIn(s, me.id) }; }

// ---- the routes of the hub
async function hubRoute(req, res, what, me) {
  if (what === 'invite' && req.method === 'GET') { const code = new URL(req.url, 'http://x').searchParams.get('code'); return json(res, 200, { invite: SP.peek(code) }); }
  if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
  if (!me) return json(res, 401, { error: 'Sign in first.', signIn: true });
  const b = await readBody(req);
  try {
    const team = (roles) => { const s = SP.get(String(b.id || '')); if (!s || !SP.roleIn(s, me.id)) throw new Error('No such team, or you are not in it.'); if (roles && !roles.includes(SP.roleIn(s, me.id))) throw new Error("Only the team's owner or admins can do this."); return s; };
    switch (what) {
      case 'me': return json(res, 200, hubView(req, me));
      case 'create': { const s = SP.create(b.name, me.id); remember(me.id, s.id); return json(res, 200, { space: SP.view(s, me.id) }); }
      case 'rename': return json(res, 200, { space: SP.view(SP.rename(String(b.id), me.id, b.name), me.id) });
      case 'delete': { const s = SP.remove(String(b.id), me.id); stopEngine(s.id); try { fs.rmSync(spaceData(s), { recursive: true, force: true }); } catch (e) { /* in use */ } return json(res, 200, hubView(req, me)); }
      case 'leave': SP.leave(String(b.id), me.id); return json(res, 200, hubView(req, me));
      case 'invite': { const inv = SP.invite(String(b.id), me.id, { days: b.days ?? 7, uses: b.uses || 0, role: b.role || 'member' }); return json(res, 200, { ...inv, link: `${req.headers.host ? 'http://' + req.headers.host : ''}/join/${inv.code}` }); }
      case 'invites': return json(res, 200, { invites: SP.invites(String(b.id), me.id) });
      case 'revoke': return json(res, 200, { invites: SP.revoke(String(b.id), me.id, String(b.invite || '')) });
      case 'join': { const s = SP.join(String(b.code || '').trim().replace(/^.*\/join\//, ''), me.id); remember(me.id, s.id); return json(res, 200, { space: SP.view(s, me.id) }); }
      case 'members': return json(res, 200, membersOf(team(), me));
      case 'role': SP.setRole(String(b.id), me.id, String(b.uid), String(b.role)); return json(res, 200, membersOf(team(), me));
      case 'kick': SP.kick(String(b.id), me.id, String(b.uid)); return json(res, 200, membersOf(team(), me));
      case 'mcp': {
        const s = team();
        for (const [h, t] of Object.entries(TOKENS)) if (t.uid === me.id && t.sid === s.id) delete TOKENS[h]; // one key per person and team: a new one replaces the old
        if (b.disconnect) { saveTokens(); return json(res, 200, { ok: true }); }
        const token = crypto.randomBytes(24).toString('base64url');
        TOKENS[tokHash(token)] = { uid: me.id, sid: s.id, created: Date.now() }; saveTokens();
        const url = `http://localhost:${port}/s/${s.id}`, name = s.personal ? 'tandemi' : `tandemi-${slug(s.name).toLowerCase()}`;
        const out = { name, claudeCode: `claude mcp add ${name} -e PAIRPLAY_URL=${url} -e TANDEMI_TOKEN=${token} -- node "${path.join(__dirname, 'mcp.js')}"` };
        if (isLocal(req) && !b.noconfig) { try { out.file = require('./setup-mcp.js').connect(url, { name, token, data: spaceData(s), home: spaceHome(s) }); } catch (e) { out.error = e.message; } }
        return json(res, 200, out);
      }
      case 'last': if (SP.get(String(b.id)) && SP.roleIn(SP.get(String(b.id)), me.id)) remember(me.id, String(b.id)); return json(res, 200, { ok: true });
      case 'server': {
        if (me.role !== 'owner') throw new Error('Only the owner of this Tandemi server can change this.');
        const ch = b.changes || {};
        for (const [k, v] of Object.entries(ch)) { if (!['allowRegister', 'shareOnNetwork'].includes(k) || typeof v !== 'boolean') throw new Error(`Not a valid setting: ${k}.`); }
        if (ch.shareOnNetwork !== undefined && ch.shareOnNetwork !== SERVER.shareOnNetwork) restartNeeded = true;
        Object.assign(SERVER, ch); saveServer(); return json(res, 200, hubView(req, me));
      }
      default: return json(res, 404, { error: 'Not found' });
    }
  } catch (e) { return json(res, 400, { error: e.message }); }
}
async function authRoute(req, res, what, me) {
  const ip = req.socket.remoteAddress;
  if (what === 'me') return json(res, 200, { me, people: AUTH.count(), allowRegister: SERVER.allowRegister || AUTH.count() === 0, firstAccount: AUTH.count() === 0, local: isLocal(req), signInOn: true });
  if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
  const b = await readBody(req);
  try {
    switch (what) {
      case 'login': { const s = AUTH.login(b, ip); return json(res, 200, { me: s.user }, sessionCookie(s.token, s.maxAge)); }
      case 'logout': AUTH.logout(cookie(req, 'tandemi_session')); return json(res, 200, { ok: true }, sessionCookie('', 0));
      case 'register': {
        const first = AUTH.count() === 0;
        // the first account owns this Tandemi server and is made on the computer running it
        if (first && !isLocal(req)) throw new Error('The first account (the owner of this Tandemi) is made on the computer running it.');
        if (!first && !SERVER.allowRegister && !(b.invite && SP.peek(b.invite))) throw new Error('New accounts are closed here. Ask for an invite link.');
        const u = AUTH.register({ name: b.name, email: b.email, password: b.password });
        const personal = personalFor(u);
        let to = `/s/${personal.id}/`;
        if (b.invite) { try { const s = SP.join(b.invite, u.id); to = `/s/${s.id}/`; } catch (e) { /* expired: they still have their account */ } }
        const s = AUTH.login(b, ip); return json(res, 200, { me: s.user, to }, sessionCookie(s.token, s.maxAge));
      }
      case 'password': { if (!me) throw new Error('Sign in first.'); const s = AUTH.changePassword(me.id, b.old, b.new); return json(res, 200, { me: s.user }, sessionCookie(s.token, s.maxAge)); }
      default: return json(res, 404, { error: 'Not found' });
    }
  } catch (e) { return json(res, 400, { error: e.message }); }
}
// a team's request goes to its engine, with who is asking and their role in that team
async function toEngine(req, res, s, sub, me) {
  let e; try { e = await engineFor(s); } catch (err) { return json(res, 503, { error: err.message }); }
  const headers = { ...req.headers };
  for (const h of ['host', 'origin', 'referer', 'cookie', 'authorization', 'x-tandemi-hub', 'x-tandemi-user']) delete headers[h];
  headers['x-tandemi-hub'] = SECRET;
  headers['x-tandemi-user'] = Buffer.from(JSON.stringify({ id: me.id, name: me.name, email: me.email, role: SP.roleIn(s, me.id), local: isLocal(req), team: s.name, personal: !!s.personal })).toString('base64');
  e.last = Date.now();
  const p = http.request({ host: '127.0.0.1', port: e.port, path: sub, method: req.method, headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
  p.on('error', () => { if (!res.headersSent) json(res, 502, { error: "The team's engine isn't answering. Try again in a moment." }); else res.end(); });
  if (sub.startsWith('/events')) { e.clients++; res.on('close', () => { e.clients--; e.last = Date.now(); p.destroy(); }); }
  req.pipe(p);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const bad = foreign(req);
  if (bad) return json(res, 403, { error: bad });
  let me = AUTH.userFor(cookie(req, 'tandemi_session'));
  if (url === '/api/version') return json(res, 200, { running: RUNNING, onDisk: engineHash() });
  if (url === '/api/quit' && req.method === 'POST' && isLocal(req)) { res.writeHead(200); res.end('bye'); console.log('\n  A newer Tandemi started, so this one closes.\n'); setTimeout(() => process.exit(0), 200); return; }
  if (req.method === 'GET' && /^\/fonts\/[\w.-]+\.woff2$/.test(url)) { const f = path.join(__dirname, 'vendor', 'fonts', path.basename(url)); if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000, immutable' }); return res.end(fs.readFileSync(f)); } res.writeHead(404); return res.end(); }
  if (req.method === 'GET' && (url === '/login' || url === '/register')) return page(res, 'login.html');
  if (url.startsWith('/api/auth/')) return authRoute(req, res, url.slice(10), me);
  if (url.startsWith('/api/hub/')) return hubRoute(req, res, url.slice(9), me);
  let m;
  if (req.method === 'GET' && (m = url.match(/^\/join\/([\w-]{6,40})$/))) {
    if (!me) return redirect(res, `/login?invite=${m[1]}`);
    try { const s = SP.join(m[1], me.id); remember(me.id, s.id); return redirect(res, `/s/${s.id}/`); } catch (e) { return redirect(res, `/login?bad=1`); }
  }
  if (req.method === 'GET' && url === '/') {
    if (!me) return redirect(res, AUTH.count() ? '/login' : '/register');
    personalFor(me); const mine = SP.listFor(me.id), last = mine.find(s => s.id === LAST[me.id]) || mine[0];
    return redirect(res, `/s/${last.id}/`);
  }
  if ((m = url.match(/^\/s\/([0-9a-f]{12})(\/.*)?$/))) {
    if (!me && m[2] === '/mcp/call') me = tokenUser(req, m[1]); // an AI coder with its key for this team
    if (!me) return req.method === 'GET' && !m[2]?.startsWith('/api') && m[2] !== '/events' ? redirect(res, '/login') : json(res, 401, { error: 'Sign in first.', signIn: true });
    const s = SP.get(m[1]);
    if (!s || !SP.roleIn(s, me.id)) return req.method === 'GET' && !m[2]?.startsWith('/api') ? redirect(res, '/') : json(res, 403, { error: "You're not in this team." });
    if (!m[2]) return redirect(res, `/s/${s.id}/`);
    if (req.method === 'GET' && m[2] === '/') remember(me.id, s.id);
    return toEngine(req, res, s, m[2] + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), me);
  }
  res.writeHead(404); res.end();
});

// which Tandemi code is running, and which is on disk: they differ when Tandemi was updated but not restarted
const engineHash = () => { try { return crypto.createHash('sha1').update(fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).sort().map(f => f + fs.readFileSync(path.join(__dirname, f))).join('\0')).digest('hex').slice(0, 12); } catch (e) { return '?'; } };
const RUNNING = engineHash();

// is the program on our port an older Tandemi? Then ask it to close; one too old to know how is stopped by its process id (Windows)
function replaceOld() {
  const ask = (method, p) => new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 2000, headers: method === 'POST' ? { 'content-type': 'application/json' } : {} }, (res) => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => ok({ code: res.statusCode, body: b })); }); r.on('error', () => ok(null)); r.on('timeout', () => { r.destroy(); ok(null); }); r.end(); });
  return (async () => {
    const v = await ask('GET', '/api/version'), st = v && v.code === 200 ? v : await ask('POST', '/api/project/state');
    if (!st || st.code !== 200 || !/"(open|running)"\s*:/.test(st.body)) return false; // not Tandemi: leave it alone
    console.log('  An older Tandemi is still running. Closing it so this one can start…');
    const q = await ask('POST', '/api/quit');
    if (q && q.code === 200) return true;
    if (process.platform !== 'win32') return false;
    const out = require('child_process').spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    const pids = [...new Set(out.split('\n').filter(l => new RegExp(`[:.]${PORT}\\s+\\S+\\s+LISTENING`, 'i').test(l)).map(l => l.trim().split(/\s+/).pop()).filter(x => /^\d+$/.test(x) && Number(x) !== process.pid))];
    for (const pid of pids) require('child_process').spawnSync('taskkill', ['/pid', pid, '/f'], { windowsHide: true });
    return pids.length > 0;
  })();
}
// the app (desktop) waits for this before it shows the window
let readyOk, readyFail; const ready = new Promise((ok, fail) => { readyOk = ok; readyFail = fail; });
let port = PORT;
function main() {
  server.requestTimeout = 0; server.headersTimeout = 0; // builds and tests of big projects can take long
  let tries = 0;
  const listen = () => server.listen(port, SERVER.shareOnNetwork ? '0.0.0.0' : '127.0.0.1');
  server.on('error', async (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    if (port === PORT && tries++ < 3 && await replaceOld()) { setTimeout(listen, 800); return; }
    if (process.versions.electron && port < PORT + 20) { port++; setTimeout(listen, 50); return; }
    if (process.versions.electron) { readyFail(new Error(`Ports ${PORT} to ${port} are all busy.`)); return; }
    console.error(`\n  Port ${PORT} is busy. Is Tandemi already running? Close the other window, or set TANDEMI_PORT to another number.\n`); process.exit(1);
  });
  listen();
  server.once('listening', () => {
    readyOk(port);
    console.log(`\n  Tandemi is running.  Open  http://localhost:${port}  in your browser.`);
    const lan = SERVER.shareOnNetwork ? lanAddresses() : [];
    if (lan.length) console.log(`  Your team on the same Wi-Fi: open  http://${lan[0]}:${port}`);
    console.log('');
    if (!process.env.TANDEMI_NO_OPEN && !process.env.PAIRPLAY_NO_OPEN) {
      const u = `http://localhost:${port}`;
      try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', u], { detached: true, stdio: 'ignore' });
        else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [u], { detached: true, stdio: 'ignore' }).on('error', () => {});
      } catch (e) { /* open it by hand */ }
    }
  });
}
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main();
module.exports = { ready, lanAddresses, url: () => `http://localhost:${port}` };
