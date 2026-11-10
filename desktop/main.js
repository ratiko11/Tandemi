// Tandemi desktop app: the same hub, teams and page as start.bat, in its own window, with its own Node inside
// (nobody has to install Node.js). The engine runs in this process; its files sit next to the app, not packed,
// so git, the compile checks and the MCP can read them.
'use strict';
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) { app.quit(); return; } // a second start just brings the window forward

const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'tandemi') : path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine');
// where Tandemi keeps things: its data in the app's folder, the user's things (final .zip files, projects from
// GitHub, the example game) in Documents\Tandemi
process.env.TANDEMI_NO_OPEN = '1';
process.env.TANDEMI_DATA = process.env.TANDEMI_DATA || path.join(app.getPath('userData'), 'data');
process.env.TANDEMI_HOME = process.env.TANDEMI_HOME || path.join(app.getPath('documents'), 'Tandemi');
for (const d of [process.env.TANDEMI_DATA, process.env.TANDEMI_HOME]) fs.mkdirSync(d, { recursive: true });

let win = null, url = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 900, minWidth: 760, minHeight: 560, show: false, title: 'Tandemi',
    backgroundColor: '#EDE8FF', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.loadFile(path.join(__dirname, 'loading.html'));
  win.once('ready-to-show', () => win.show());
  // links to other sites open in the normal browser; Tandemi's own pages stay here
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (!u.startsWith(url || 'http://localhost')) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { if (url && !u.startsWith(url)) { e.preventDefault(); shell.openExternal(u); } });
  win.on('closed', () => { win = null; });
}
function menu() {
  const open = (p) => () => { fs.mkdirSync(p, { recursive: true }); shell.openPath(p); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Tandemi', submenu: [
      { label: 'Open final code folder', click: open(path.join(process.env.TANDEMI_HOME, 'final')) },
      { label: 'Open Tandemi folder in Documents', click: open(process.env.TANDEMI_HOME) },
      { type: 'separator' },
      { label: 'Settings (teams, Claude Desktop, theme)', click: () => url && win && win.loadURL(url + '/#settings') },
      { label: 'Open in my browser', click: () => url && shell.openExternal(url) },
      { type: 'separator' },
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [{ label: 'How Tandemi works (README)', click: () => shell.openPath(path.join(ROOT, 'README.md')) }] },
  ]));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit()); // the engine lives in this process: closing the window ends Tandemi
app.whenReady().then(async () => {
  menu(); createWindow();
  try {
    const srv = require(path.join(ENGINE, 'server.js'));
    await srv.ready; url = srv.url();
    if (win) win.loadURL(url);
  } catch (e) {
    dialog.showErrorBox('Tandemi could not start', `${e.message}\n\nIs another program using port 3000? Close it and start Tandemi again.`);
    app.quit();
  }
});
