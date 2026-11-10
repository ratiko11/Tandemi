#!/usr/bin/env node
// Adds Tandemi to Claude Desktop as an MCP server, so Claude can use Tandemi's tools.
// Usage: node engine/setup-mcp.js            (asks where Tandemi runs)
//        node engine/setup-mcp.js http://192.168.1.20:3000   (second laptop: the address shown on the first one)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline');

function configPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude', 'claude_desktop_config.json');
}
// Claude Desktop from the Microsoft Store keeps its settings in its own folder
// (AppData\Local\Packages\Claude_…\LocalCache\Roaming\Claude), not in AppData\Roaming: write to every one there is
function configPaths() {
  const out = [configPath()];
  if (process.platform === 'win32') {
    const pk = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Packages');
    try { for (const d of fs.readdirSync(pk)) if (/claude/i.test(d) && fs.existsSync(path.join(pk, d, 'LocalCache'))) out.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')); } catch (e) { /* no Store apps */ }
    // newer Store versions: AppData\Local\Claude-Data\claude_<package id>\claude_desktop_config.json
    const cd = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-Data');
    try { for (const d of fs.readdirSync(cd)) if (/^claude/i.test(d) && fs.statSync(path.join(cd, d)).isDirectory()) out.push(path.join(cd, d, 'claude_desktop_config.json')); } catch (e) { /* not this kind of install */ }
  }
  return out;
}
function ask(q) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); })); }

// writes Tandemi into Claude Desktop's settings; used by this script and by the app's "Connect Claude Desktop" menu
function connect(url, opts = {}) {
  const key = opts.name || 'tandemi';
  // a team's MCP: its address, the person's key for that team, and the team's folders (so it also works while Tandemi is closed);
  // inside the app there is no separate Node: the app's own program runs the MCP as plain Node
  const entry = { command: process.execPath, args: [path.join(__dirname, 'mcp.js')], env: { PAIRPLAY_URL: url, ...(opts.token ? { TANDEMI_TOKEN: opts.token } : {}), ...(opts.data ? { TANDEMI_DATA: opts.data, TANDEMI_HOME: opts.home } : process.env.TANDEMI_DATA ? { TANDEMI_DATA: process.env.TANDEMI_DATA, TANDEMI_HOME: process.env.TANDEMI_HOME } : {}), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } };
  const written = [];
  for (const file of configPaths()) {
    let cfg = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      try { cfg = raw.trim() ? JSON.parse(raw) : {}; }
      catch (e) { throw new Error(`${file} isn't valid JSON, so Tandemi didn't change it. Fix or delete it, then try again.`); }
      fs.writeFileSync(file + '.backup', raw);
    } else fs.mkdirSync(path.dirname(file), { recursive: true });
    cfg.mcpServers = cfg.mcpServers || {};
    delete cfg.mcpServers.pairplay; // the old name
    cfg.mcpServers[key] = entry;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    written.push(file);
  }
  return written.join('  and  ');
}
module.exports = { connect, configPath, configPaths };
if (require.main === module) (async () => {
  let url = process.argv[2] || '';
  if (!url) {
    console.log('\n  Tandemi → Claude Desktop\n');
    console.log('  Is Tandemi (start.bat) running on THIS computer?');
    console.log('   - Yes: just press Enter.');
    console.log('   - No, it runs on the other laptop: type the address that laptop shows,');
    console.log('     for example http://192.168.1.20:3000\n');
    url = await ask('  Address (Enter = this computer): ');
  }
  if (!url) url = 'http://localhost:' + (process.env.PAIRPLAY_PORT || 3000);
  if (!/^https?:\/\//.test(url)) url = 'http://' + url;
  url = url.replace(/\/+$/, '').replace(/\/(live|pairplay|tandemi)$/, '');

  let file;
  try { file = connect(url); } catch (e) { console.error('\n  ' + e.message + '\n'); process.exit(1); }
  console.log(`\n  Done. Claude Desktop will use Tandemi at ${url}`);
  console.log(`  Settings file: ${file}${fs.existsSync(file + '.backup') ? '  (old version saved as .backup)' : ''}`);
  console.log('\n  Now fully quit Claude Desktop (also from the tray / menu bar) and open it again.');
  console.log('  Keep Tandemi open in this computer\'s browser, then ask Claude, for example:');
  console.log('    "Use Tandemi: run the demo and tell me which bugs went to which developer."\n');
  console.log('  Claude Code instead of Desktop? Run:');
  console.log(`    claude mcp add tandemi -e PAIRPLAY_URL=${url} -- node "${path.join(__dirname, 'mcp.js')}"\n`);
})();
