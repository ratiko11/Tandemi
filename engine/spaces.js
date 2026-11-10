// spaces.js · teams (like Discord servers): who is in which team, with which role, and the invite codes.
// Every person also gets a Personal space of their own. Roles: owner (one or more), admin (manages people and
// settings), member (works). The hub (hub.js) checks these before anything reaches a team's engine.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let FILE = null, SPACES = [];
const ROLES = ['owner', 'admin', 'member'];
function init(dir) { fs.mkdirSync(dir, { recursive: true }); FILE = path.join(dir, 'spaces.json'); try { SPACES = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { SPACES = []; } }
function save() { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(SPACES, null, 1), { mode: 0o600 }); fs.renameSync(tmp, FILE); }
const id = () => crypto.randomBytes(6).toString('hex');
const roleIn = (s, uid) => { const m = s && s.members.find(x => x.uid === uid); return m ? m.role : null; };
// what a member sees of a team (invite codes only for those who may invite)
function view(s, uid) {
  const role = roleIn(s, uid);
  return { id: s.id, name: s.name, personal: !!s.personal, role, created: s.created, members: s.members.length, color: s.color };
}
const COLORS = ['#FF6FAE', '#2EC4E8', '#FFD23F', '#3DDC97', '#B794FF', '#FF9F45', '#5AA9FF', '#A8E05F'];
const cleanName = (n) => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 40);

function create(name, uid, { personal = false } = {}) {
  name = cleanName(name);
  if (!personal && name.length < 2) throw new Error('Give the team a name.');
  if (!personal && SPACES.filter(s => !s.personal && roleIn(s, uid) === 'owner').length >= 50) throw new Error('You own 50 teams already.');
  const s = { id: id(), name: personal ? 'Personal' : name, personal, created: new Date().toISOString(), color: COLORS[SPACES.length % COLORS.length], members: [{ uid, role: 'owner', joined: new Date().toISOString() }], invites: [] };
  SPACES.push(s); save(); return s;
}
const get = (sid) => SPACES.find(s => s.id === sid) || null;
const listFor = (uid) => SPACES.filter(s => roleIn(s, uid)).sort((a, b) => (b.personal - a.personal) || a.created.localeCompare(b.created));
const personalOf = (uid) => SPACES.find(s => s.personal && roleIn(s, uid) === 'owner') || null;
function need(sid, uid, roles) {
  const s = get(sid); const r = roleIn(s, uid);
  if (!s || !r) throw new Error('No such team, or you are not in it.');
  if (roles && !roles.includes(r)) throw new Error(roles.includes('admin') ? "Only the team's owner or admins can do this." : "Only the team's owner can do this.");
  return s;
}
function rename(sid, uid, name) { const s = need(sid, uid, ['owner', 'admin']); if (s.personal) throw new Error('Your Personal space keeps its name.'); name = cleanName(name); if (name.length < 2) throw new Error('Give the team a name.'); s.name = name; save(); return s; }
function remove(sid, uid) { const s = need(sid, uid, ['owner']); if (s.personal) throw new Error('Your Personal space stays.'); SPACES = SPACES.filter(x => x !== s); save(); return s; }

// invites: a code anyone can use to join (like a Discord invite link). Only its SHA-256 is kept.
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
function invite(sid, uid, { days = 7, uses = 0, role = 'member' } = {}) {
  const s = need(sid, uid, ['owner', 'admin']);
  if (s.personal) throw new Error('Your Personal space is only yours. Create a team to invite people.');
  if (!['admin', 'member'].includes(role)) throw new Error('An invite makes members or admins.');
  if (role === 'admin' && roleIn(s, uid) !== 'owner') throw new Error('Only the owner can invite admins.');
  s.invites = (s.invites || []).filter(i => !i.expires || i.expires > Date.now()).slice(-30);
  const code = crypto.randomBytes(9).toString('base64url');
  const inv = { id: id(), hash: sha(code), role, by: uid, created: Date.now(), expires: days ? Date.now() + Number(days) * 86400000 : 0, uses: 0, maxUses: Number(uses) || 0 };
  s.invites.push(inv); save();
  return { code, ...publicInvite(inv) };
}
const publicInvite = (i) => ({ id: i.id, role: i.role, created: i.created, expires: i.expires, uses: i.uses, maxUses: i.maxUses });
function invites(sid, uid) { const s = need(sid, uid, ['owner', 'admin']); return (s.invites || []).filter(i => (!i.expires || i.expires > Date.now()) && (!i.maxUses || i.uses < i.maxUses)).map(publicInvite); }
function revoke(sid, uid, iid) { const s = need(sid, uid, ['owner', 'admin']); s.invites = (s.invites || []).filter(i => i.id !== iid); save(); return invites(sid, uid); }
function findInvite(code) {
  const h = sha(String(code || ''));
  for (const s of SPACES) for (const i of s.invites || []) if (i.hash === h && (!i.expires || i.expires > Date.now()) && (!i.maxUses || i.uses < i.maxUses)) return { s, i };
  return null;
}
const peek = (code) => { const f = findInvite(code); return f ? { team: f.s.name, members: f.s.members.length, role: f.i.role, color: f.s.color } : null; };
function join(code, uid) {
  const f = findInvite(code); if (!f) throw new Error('This invite has expired or was used up. Ask for a new one.');
  if (roleIn(f.s, uid)) return f.s; // already in it
  f.s.members.push({ uid, role: f.i.role, joined: new Date().toISOString() }); f.i.uses++; save(); return f.s;
}
// people
function members(sid, uid) { need(sid, uid); return get(sid).members.map(m => ({ uid: m.uid, role: m.role, joined: m.joined })); }
function setRole(sid, uid, who, role) {
  const s = need(sid, uid, ['owner']);
  if (!ROLES.includes(role)) throw new Error('A role is owner, admin or member.');
  const m = s.members.find(x => x.uid === who); if (!m) throw new Error('They are not in this team.');
  if (m.role === 'owner' && role !== 'owner' && s.members.filter(x => x.role === 'owner').length === 1) throw new Error('A team needs an owner. Make someone else an owner first.');
  m.role = role; save(); return s;
}
function kick(sid, uid, who) {
  const s = need(sid, uid, ['owner', 'admin']);
  const m = s.members.find(x => x.uid === who); if (!m) throw new Error('They are not in this team.');
  if (who === uid) throw new Error('Use Leave team to leave it yourself.');
  if (m.role === 'owner' && roleIn(s, uid) !== 'owner') throw new Error('Only an owner can remove an owner.');
  if (m.role === 'owner' && s.members.filter(x => x.role === 'owner').length === 1) throw new Error('A team needs an owner.');
  s.members = s.members.filter(x => x.uid !== who); save(); return s;
}
function leave(sid, uid) {
  const s = need(sid, uid);
  if (s.personal) throw new Error('Your Personal space stays with you.');
  if (roleIn(s, uid) === 'owner' && s.members.filter(x => x.role === 'owner').length === 1) throw new Error(s.members.length > 1 ? 'You are the only owner. Make someone else an owner first, or delete the team.' : 'You are the only one in this team. Delete it instead.');
  s.members = s.members.filter(x => x.uid !== uid); save(); return s;
}
// an account was deleted: out of every team (its Personal space goes too)
function forgetUser(uid) { SPACES = SPACES.filter(s => !(s.personal && roleIn(s, uid))); for (const s of SPACES) s.members = s.members.filter(m => m.uid !== uid); save(); }
module.exports = { init, create, get, listFor, personalOf, roleIn, view, rename, remove, invite, invites, revoke, peek, join, members, setRole, kick, leave, forgetUser };
