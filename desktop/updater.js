// Updates: Tandemi looks at its GitHub releases a few seconds after it starts (and every 6 hours while it runs).
// When a newer version is there it asks once; "Update now" downloads the installer, checks it is the exact file
// GitHub lists, closes Tandemi, installs over the old version without questions and opens Tandemi again.
// Accounts, teams and projects live in the data folder, which an update never touches.
'use strict';
const { app, dialog, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'ratiko11/Tandemi';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const PAGE = `https://github.com/${REPO}/releases/latest`;
const EVERY = 6 * 3600 * 1000;
const STATE = () => path.join(app.getPath('userData'), 'update.json');

let getWin = () => null, busy = false, asked = '';

// "2.4.10" > "2.4.9": compare number by number, never as text
function newer(a, b) {
  const p = (v) => String(v).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch (e) { return {}; } };
const writeState = (s) => { try { fs.writeFileSync(STATE(), JSON.stringify(s)); } catch (e) { /* not important */ } };

async function latest() {
  const r = await net.fetch(API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Tandemi/' + app.getVersion() } });
  if (!r.ok) throw new Error('GitHub answered ' + r.status);
  const d = await r.json();
  const exe = (d.assets || []).find(a => a.name === 'Tandemi-Setup.exe') || (d.assets || []).find(a => /\.exe$/i.test(a.name));
  const sha = (exe && /^sha256:([0-9a-f]{64})$/i.exec(exe.digest || '')) || /sha256:\s*([0-9a-f]{64})/i.exec(d.body || '');
  return { version: String(d.tag_name || '').replace(/^v/i, ''), notes: String(d.body || ''), exe, sha256: sha ? sha[1].toLowerCase() : null };
}

// the installer, to a temporary file, with the taskbar showing how far it is; refused unless its size (and its
// sha256, when GitHub gives one) match, so a broken or swapped download is never run
async function download(rel) {
  const win = getWin();
  const file = path.join(app.getPath('temp'), `Tandemi-Setup-${rel.version}.exe`);
  const r = await net.fetch(rel.exe.browser_download_url, { headers: { 'user-agent': 'Tandemi/' + app.getVersion() } });
  if (!r.ok || !r.body) throw new Error('The download failed (' + r.status + ').');
  const total = rel.exe.size || +r.headers.get('content-length') || 0;
  const out = fs.createWriteStream(file), hash = crypto.createHash('sha256');
  const reader = r.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const b = Buffer.from(value);
      hash.update(b); got += b.length;
      if (!out.write(b)) await new Promise(ok => out.once('drain', ok));
      if (win && total) win.setProgressBar(got / total);
    }
  } finally {
    await new Promise(ok => out.end(ok));
    if (win) win.setProgressBar(-1);
  }
  if (total && got !== total) throw new Error('The download was cut off. Try again later.');
  if (rel.sha256 && hash.digest('hex') !== rel.sha256) { try { fs.unlinkSync(file); } catch (e) { /* gone */ } throw new Error("The downloaded file isn't the one on GitHub, so it was not installed."); }
  return file;
}

function install(file) {
  // /S: no questions, into the same folder as now · --updated: an update, not a new install · --force-run: open
  // Tandemi again when it's done. The installer waits for this Tandemi to close.
  spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  setTimeout(() => app.quit(), 300);
}

async function check({ manual = false } = {}) {
  if (busy) return;
  if (!app.isPackaged || process.platform !== 'win32') {
    if (manual) dialog.showMessageBox({ type: 'info', message: 'Updates work in the installed Tandemi app.', detail: 'With start.bat, download the new version from GitHub instead.', buttons: ['Open GitHub', 'OK'] }).then(r => { if (r.response === 0) shell.openExternal(PAGE); });
    return;
  }
  busy = true;
  let updating = false;
  try {
    const rel = await latest();
    const st = readState();
    const have = app.getVersion();
    if (!rel.version || !newer(rel.version, have) || !rel.exe) {
      if (manual) await dialog.showMessageBox(getWin(), { type: 'info', message: `You have the newest Tandemi (${have}).`, buttons: ['OK'] });
      return;
    }
    if (!manual && (st.skip === rel.version || asked === rel.version)) return; // asked already: never nag
    asked = rel.version;
    const notes = rel.notes.split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^sha256/i.test(s)).slice(0, 8).join('\n');
    const { response } = await dialog.showMessageBox(getWin(), {
      type: 'info', title: 'Tandemi update',
      message: `Tandemi ${rel.version} is ready (you have ${have}).`,
      detail: `${notes ? notes + '\n\n' : ''}Update now downloads it (${Math.round((rel.exe.size || 0) / 1048576)} MB), closes Tandemi, installs it and opens Tandemi again. Your accounts, teams and projects stay as they are.`,
      buttons: ['Update now', 'Later', 'Skip this version'], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (response === 2) { writeState({ ...st, skip: rel.version }); return; }
    if (response !== 0) return;
    updating = true;
    const file = await download(rel);
    install(file);
  } catch (e) {
    if (manual) dialog.showMessageBox(getWin(), { type: 'warning', message: "Tandemi couldn't check for updates.", detail: `${e.message}\n\nYou can always download the newest version from GitHub.`, buttons: ['Open GitHub', 'OK'] }).then(r => { if (r.response === 0) shell.openExternal(PAGE); });
    else if (updating) dialog.showMessageBox(getWin(), { type: 'warning', message: "The update didn't finish.", detail: e.message, buttons: ['OK'] });
  } finally { busy = false; }
}

function start(winGetter) {
  getWin = winGetter;
  if (!app.isPackaged || process.platform !== 'win32') return;
  setTimeout(() => check(), 8000);
  setInterval(() => check(), EVERY).unref();
}

module.exports = { start, check, newer };
