// auth.js · accounts for Tandemi: register, sign in, sessions and roles (owner, member).
// Passwords are never stored: only a salted scrypt hash. Sessions are random 32-byte tokens; only their SHA-256 is
// kept on disk, so a copied data folder can't be used to sign in. Too many wrong passwords lock that address and
// account for a while.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DIR = null, USERS = [], SESSIONS = {};
const DAY = 24 * 3600 * 1000, SESSION_DAYS = 30;
const usersFile = () => path.join(DIR, 'users.json'), sessionsFile = () => path.join(DIR, 'sessions.json');
function init(dataDir) {
  DIR = dataDir; fs.mkdirSync(DIR, { recursive: true });
  try { USERS = JSON.parse(fs.readFileSync(usersFile(), 'utf8')); } catch (e) { USERS = []; }
  try { SESSIONS = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8')); } catch (e) { SESSIONS = {}; }
  const now = Date.now(); for (const [k, v] of Object.entries(SESSIONS)) if (!v || v.exp < now || !USERS.some(u => u.id === v.uid)) delete SESSIONS[k];
}
const write = (f, d) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(tmp, f); };
const saveUsers = () => write(usersFile(), USERS), saveSessions = () => write(sessionsFile(), SESSIONS);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw).normalize('NFKC'), Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex');
const pub = (u) => (u ? { id: u.id, name: u.name, email: u.email, role: u.role, created: u.created } : null);
const count = () => USERS.length;
const owners = () => USERS.filter(u => u.role === 'owner');
const normEmail = (e) => String(e || '').trim().toLowerCase();

function register({ name, email, password, role }) {
  name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60); email = normEmail(email);
  if (name.length < 2) throw new Error('Write your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new Error("That doesn't look like an email address.");
  if (String(password || '').length < 8) throw new Error('The password needs at least 8 characters.');
  if (String(password).length > 200) throw new Error('That password is too long.');
  if (USERS.some(u => u.email === email)) throw new Error('There is already an account with this email. Sign in instead.');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: crypto.randomBytes(8).toString('hex'), name, email, salt, hash: hashPw(password, salt), role: USERS.length ? (role === 'owner' ? 'owner' : 'member') : 'owner', created: new Date().toISOString() };
  USERS.push(u); saveUsers();
  return pub(u);
}
// wrong passwords: 5 in a row from one address for one account → 10 minutes locked
const FAILS = new Map();
function login({ email, password }, ip) {
  email = normEmail(email);
  const k = `${ip}|${email}`, f = FAILS.get(k);
  if (f && f.until > Date.now()) throw new Error(`Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.`);
  const u = USERS.find(x => x.email === email);
  // the same work and the same answer whether the account exists or not, so nobody can find out which emails have one
  const ok = u ? crypto.timingSafeEqual(Buffer.from(hashPw(password || '', u.salt), 'hex'), Buffer.from(u.hash, 'hex')) : (hashPw(password || '', '00'.repeat(16)), false);
  if (!ok) {
    const n = (f && f.until <= Date.now() && f.n >= 5 ? 0 : (f ? f.n : 0)) + 1;
    FAILS.set(k, { n, until: n >= 5 ? Date.now() + 10 * 60000 : 0 });
    if (FAILS.size > 5000) FAILS.clear();
    throw new Error('Wrong email or password.');
  }
  FAILS.delete(k);
  return startSession(u);
}
function startSession(u) {
  const token = crypto.randomBytes(32).toString('base64url');
  SESSIONS[sha(token)] = { uid: u.id, exp: Date.now() + SESSION_DAYS * DAY };
  saveSessions();
  return { token, user: pub(u), maxAge: SESSION_DAYS * 24 * 3600 };
}
function userFor(token) {
  if (!token) return null;
  const s = SESSIONS[sha(String(token))];
  if (!s || s.exp < Date.now()) return null;
  return pub(USERS.find(u => u.id === s.uid));
}
function logout(token) { if (token && SESSIONS[sha(String(token))]) { delete SESSIONS[sha(String(token))]; saveSessions(); } }
const list = () => USERS.map(pub);
function remove(id, by) {
  const u = USERS.find(x => x.id === id); if (!u) throw new Error('No such person.');
  if (u.role === 'owner' && owners().length === 1) throw new Error('This is the only owner. Make someone else an owner first.');
  if (by && by.id === id) throw new Error("You can't remove yourself here.");
  USERS = USERS.filter(x => x.id !== id); saveUsers();
  for (const [k, v] of Object.entries(SESSIONS)) if (v.uid === id) delete SESSIONS[k];
  saveSessions(); return list();
}
function setRole(id, role) {
  const u = USERS.find(x => x.id === id); if (!u) throw new Error('No such person.');
  if (!['owner', 'member'].includes(role)) throw new Error('A role is owner or member.');
  if (u.role === 'owner' && role !== 'owner' && owners().length === 1) throw new Error('This is the only owner. Make someone else an owner first.');
  u.role = role; saveUsers(); return list();
}
function changePassword(id, oldPw, newPw) {
  const u = USERS.find(x => x.id === id); if (!u) throw new Error('No such person.');
  if (!crypto.timingSafeEqual(Buffer.from(hashPw(oldPw || '', u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) throw new Error('The current password is wrong.');
  if (String(newPw || '').length < 8) throw new Error('The new password needs at least 8 characters.');
  u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(newPw, u.salt); saveUsers();
  // signed out everywhere else
  for (const [k, v] of Object.entries(SESSIONS)) if (v.uid === id) delete SESSIONS[k];
  saveSessions(); return startSession(u);
}
module.exports = { init, count, register, login, logout, userFor, list, remove, setRole, changePassword };
