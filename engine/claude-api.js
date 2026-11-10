// claude-api.js · one place that talks to Claude (Anthropic API) for the server, the MCP and the GitHub bot.
// The key comes from ANTHROPIC_API_KEY or from .pairplay/anthropic-key.txt (saved from the Projects page).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Installed as an app, the program folder is read-only: the app says where data (TANDEMI_DATA) and the user's
// things (TANDEMI_HOME: final .zip files, projects opened from GitHub, the example) go. Run from a folder, it is all here.
// On Windows, start.bat and the installed app share one place, so the same account, teams and settings show up in
// both: data in %APPDATA%\Tandemi\data (where the app keeps it) and the user's things in Documents\Tandemi.
// Elsewhere (and when TANDEMI_DATA is set) nothing changes. LEGACY: where start.bat kept everything before.
const LEGACY = path.join(ROOT, '.pairplay');
function documentsDir() {
  try {
    const r = require('child_process').spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("MyDocuments")'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const d = String(r.stdout || '').trim(); if (d && fs.existsSync(d)) return d; // also when Documents is moved to OneDrive
  } catch (e) { /* no PowerShell */ }
  return path.join(require('os').homedir(), 'Documents');
}
const SHARED = !process.env.TANDEMI_DATA && process.platform === 'win32';
const DATA = process.env.TANDEMI_DATA ? path.resolve(process.env.TANDEMI_DATA) : SHARED ? path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'Tandemi', 'data') : LEGACY;
const HOME = process.env.TANDEMI_HOME ? path.resolve(process.env.TANDEMI_HOME) : SHARED ? path.join(documentsDir(), 'Tandemi') : ROOT;
const KEY_FILE = path.join(DATA, 'anthropic-key.txt');
const API_BASE = process.env.TANDEMI_API_BASE || process.env.PAIRPLAY_API_BASE || 'https://api.anthropic.com';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tandemi.config.json'), 'utf8')); } catch (e) { /* defaults */ }
const ENV_KEY = process.env.ANTHROPIC_API_KEY || '';
let key = ENV_KEY, keySeen = 0, keyMtime = -1;
// Every team and project runs in its own process, and a key saved in one of them is written to the shared file.
// So each process looks at the file again (at most once a second, and reads it only when it changed), and a key
// pasted anywhere works everywhere at once, without restarting Tandemi.
function liveKey() {
  if (ENV_KEY) return ENV_KEY;
  const now = Date.now();
  if (now - keySeen < 1000) return key;
  keySeen = now;
  try { const m = fs.statSync(KEY_FILE).mtimeMs; if (m !== keyMtime) { keyMtime = m; key = fs.readFileSync(KEY_FILE, 'utf8').trim(); } }
  catch (e) { keyMtime = -1; key = ''; }
  return key;
}
liveKey();
let model = process.env.TANDEMI_MODEL || process.env.PAIRPLAY_MODEL || cfg.model || 'claude-sonnet-5-5';

const hasKey = () => !!liveKey();
function setKey(k) {
  k = String(k || '').trim();
  if (!/^sk-ant-[\w-]{20,}$/.test(k)) throw new Error("That doesn't look like an Anthropic API key. It starts with sk-ant-.");
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(KEY_FILE, k); keyMtime = fs.statSync(KEY_FILE).mtimeMs; } catch (e) { /* kept in memory only */ }
  key = k; keySeen = Date.now();
}
function clearKey() { key = ''; keyMtime = -1; keySeen = Date.now(); try { fs.unlinkSync(KEY_FILE); } catch (e) { /* none */ } }
// ---- Claude Code: the same Claude through the person's own subscription (Pro or Max), no API key needed.
// Tandemi runs it in the background ("claude -p"), with no tools and in an empty folder: it only reads the
// question and answers, like the API does. It has to be installed and signed in once on this computer.
const os = require('os');
const { spawn, execFile } = require('child_process');
const WIN = process.platform === 'win32';
const CC = process.env.TANDEMI_CLAUDE || 'claude';
let cc = { ok: false, version: null, checked: 0, error: null };
let via = 'auto'; // auto: the API key if there is one, otherwise Claude Code · key · claude-code
function checkClaudeCode(force) {
  if (!force && Date.now() - cc.checked < 60000) return Promise.resolve(cc);
  return new Promise((done) => execFile(CC, ['--version'], { shell: WIN, timeout: 20000, windowsHide: true }, (e, out) => {
    cc = { ok: !e && /\d+\.\d+/.test(String(out)), version: String(out || '').trim().split('\n')[0] || null, checked: Date.now(), error: e ? 'not installed' : null };
    done(cc);
  }));
}
// a key the API refused for money or sign-in (no credits, revoked): in Automatic, Claude Code takes over until
// a different key is saved, instead of every fix failing on the same key
let badKey = '';
const keyUsable = () => { const k = liveKey(); return !!k && k !== badKey; };
const usesClaudeCode = () => cc.ok && (via === 'claude-code' || (via === 'auto' && !keyUsable()));
const available = () => { const k = !!liveKey(); return via === 'key' ? k : via === 'claude-code' ? cc.ok : k || cc.ok; };
const ccModel = () => (/opus/i.test(model) ? 'opus' : /haiku/i.test(model) ? 'haiku' : 'sonnet');
function askClaudeCode(text, { timeoutMs = 15 * 60000 } = {}) {
  return new Promise((ok, fail) => {
    const dir = path.join(os.tmpdir(), 'tandemi-claude'); try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* tmp */ }
    const sys = 'You are Claude, working inside Tandemi. Follow the instructions in the message exactly. Answer with JSON only.';
    const args = ['-p', '--output-format', 'json', '--tools', WIN ? '""' : '', '--strict-mcp-config', '--no-session-persistence', '--model', ccModel(), '--system-prompt', WIN ? `"${sys}"` : sys];
    const child = spawn(CC, args, { cwd: dir, shell: WIN, windowsHide: true, env: { ...process.env } });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } fail(new Error('Claude Code took too long to answer.')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', () => { clearTimeout(t); fail(new Error('Claude Code is not installed on this computer.')); });
    child.on('close', () => {
      clearTimeout(t);
      let d = null; try { d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); } catch (e) { /* not JSON */ }
      const msg = d ? String(d.result || '') : (out + err);
      if (/not logged in|please run \/login|invalid api key|authentication|unauthorized/i.test(msg + err)) return fail(new Error('Claude Code is not signed in. Open Command Prompt, type claude, sign in with your Claude account once, then try again.'));
      if (!d || d.is_error) return fail(new Error('Claude Code: ' + (msg || err || 'no answer').trim().split('\n').slice(-2).join(' ').slice(0, 300)));
      ok(msg);
    });
    child.stdin.on('error', () => {}); child.stdin.end(text);
  });
}
async function call(system, messages, { maxTokens = 8000 } = {}) {
  if (via === 'claude-code' && !cc.ok) throw new Error('Claude Code is not installed on this computer.');
  if (usesClaudeCode()) return askClaudeCode(`${system}\n\n${messages.map(m => m.content).join('\n\n')}`);
  const key = liveKey();
  if (!key) throw new Error('No Anthropic API key');
  const r = await fetch(API_BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (d.error && d.error.message) || `Claude answered ${r.status}`;
    const money = /credit balance|billing|purchase credits|insufficient/i.test(msg), auth = r.status === 401 || r.status === 403;
    if (money || auth) {
      badKey = key;
      if (via === 'auto') { await checkClaudeCode(); if (cc.ok) return askClaudeCode(`${system}\n\n${messages.map(m => m.content).join('\n\n')}`); }
      throw new Error(money ? 'Your Anthropic API key has no credits left. Add credits at console.anthropic.com, or install Claude Code to use your Claude plan instead (Settings, "Who does the AI work").' : 'The Anthropic API key was refused. Paste a new one, or use Claude Code with your Claude plan instead (Settings, "Who does the AI work").');
    }
    throw new Error(msg);
  }
  return (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
}
function parseJSON(text) {
  const s = String(text).replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Claude did not answer with JSON');
  return JSON.parse(s.slice(a, b + 1));
}
async function askJSON(system, user, maxTokens = 12000) { return parseJSON(await call(system, [{ role: 'user', content: user }], { maxTokens })); }

module.exports = { LEGACY, SHARED, available, checkClaudeCode, claudeCode: () => ({ ...cc, using: usesClaudeCode() }), setVia: (v) => { via = ['auto', 'key', 'claude-code'].includes(v) ? v : 'auto'; }, via: () => via, hasKey, setKey, clearKey, call, askJSON, parseJSON, model: () => model, setModel: (m) => { model = String(m); }, ROOT, DATA, HOME };
