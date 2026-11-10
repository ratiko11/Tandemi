#!/usr/bin/env node
// Tandemi MCP server · lets an AI coder (Claude Desktop, Claude Code, Cursor) use Tandemi.
// It speaks MCP over stdio. When Tandemi is running it forwards each tool call there (so the page shows it live);
// otherwise it runs the engine itself.
// No dependencies. Logs go to stderr; stdout carries only MCP messages.
'use strict';
const BASE = (process.env.TANDEMI_URL || process.env.PAIRPLAY_URL || 'http://localhost:3000').replace(/\/$/, '');

const TOOLS = [
  // ---- any code: pasted, files or folders (no git needed) ----
  { name: 'ws_new', description: 'Start a new merge of two developers\' code that is not in git (or not in the same repo). Give the project a name and the two developers\' names. Then add each version with ws_add_files or ws_folder, and run ws_merge.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, nameA: { type: 'string', description: "Developer A's name" }, nameB: { type: 'string', description: "Developer B's name" } } } },
  { name: 'ws_add_files', description: 'Add files to one version: side "base" (the original both started from; optional but makes the merge much better), "A" or "B". Each file is { path, text }, e.g. { path: "src/Player.cs", text: "..." }. whole=true means this side is the whole project (a missing file was deleted); otherwise only changed files are given and the rest comes from the original. Any size works.', inputSchema: { type: 'object', properties: { side: { type: 'string', description: '"base" (the original), "A", "B", or C, D… for more developers' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] } }, whole: { type: 'boolean' } }, required: ['side', 'files'] } },
  { name: 'ws_folder', description: 'Use a whole folder on the computer running Tandemi as one version (side "base", "A" or "B"). bin, obj, .git and node_modules are skipped.', inputSchema: { type: 'object', properties: { side: { type: 'string', description: '"base" (the original), "A", "B", or C, D… for more developers' }, path: { type: 'string' } }, required: ['side', 'path'] } },
  { name: 'ws_remove', description: 'Remove one file from a version.', inputSchema: { type: 'object', properties: { side: { type: 'string', description: '"base" (the original), "A", "B", or C, D… for more developers' }, file: { type: 'string' } }, required: ['side', 'file'] } },
  { name: 'ws_clear', description: 'Remove every file from a version.', inputSchema: { type: 'object', properties: { side: { type: 'string', description: '"base" (the original), "A", "B", or C, D… for more developers' } }, required: ['side'] } },
  { name: 'ws_status', description: 'The code added so far: names and files of each version.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ws_add_developer', description: 'Add a third, fourth… developer (up to 12). Returns their side key (C, D…) for ws_add_files. With 3 or more developers, ws_merge merges the whole team at once (team_* tools).', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'ws_remove_developer', description: 'Remove a developer that was added (by side key, e.g. "C").', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'ws_merge', description: 'Merge A and B by the code\'s structure, check each version alone and the merged code (build and tests if there is a project file, otherwise a compile check for C#, JavaScript, TypeScript, Python, Java, C++ and Go), and send every bug to whoever caused it. Then fix with project_write_file, read with project_read_file, and get the final code with project_final.', inputSchema: { type: 'object', properties: {} } },
  // ---- a whole team: 3 or more developers at once ----
  { name: 'team_merge', description: 'Merge three or more branches (one per developer) of the open git project at once, like a merge queue that explains. Each branch is merged by structure in order; one with a real conflict waits. Each is checked alone and all together; if together breaks, Tandemi finds exactly which developers clash, sends the bug to its owner, and builds "works now" from everyone else. Can take minutes.', inputSchema: { type: 'object', properties: { branches: { type: 'array', items: { type: 'string' }, description: 'Branch names in merge order, e.g. ["dev-ana", "dev-beka", "dev-gio"]' }, path: { type: 'string', description: 'Project folder (default: the open project)' } }, required: ['branches'] } },
  { name: 'team_status', description: 'The team merge: each developer (merged, waiting and why), real conflicts, who clashes with whom, bugs with their owner, and what works now.', inputSchema: { type: 'object', properties: {} } },
  { name: 'team_resolve', description: 'Solve a real conflict of a waiting developer: pick "with" (keep the earlier developer\'s version), "self" (keep this developer\'s), "both", or "custom" with code. When all their conflicts are solved, they join and Tandemi checks again.', inputSchema: { type: 'object', properties: { developer: { type: 'string', description: 'The waiting developer\'s key (A, B, C…) from team_status' }, file: { type: 'string' }, part: { type: 'string', description: 'The conflict label from team_status' }, pick: { type: 'string', enum: ['with', 'self', 'both', 'custom'] }, code: { type: 'string' } }, required: ['developer', 'file', 'part', 'pick'] } },
  { name: 'team_read_file', description: 'Read a file of the team\'s merged code, with who wrote each line.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
  { name: 'team_write_file', description: 'Fix the team\'s merged code: save a whole file; Tandemi checks everyone together again and returns the bugs.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' }, by: { type: 'string' } }, required: ['file', 'content'] } },
  { name: 'team_retest', description: 'Check everyone together again.', inputSchema: { type: 'object', properties: {} } },
  { name: 'team_fix_bug', description: "Let Tandemi's own agent (needs an API key in Tandemi) fix one bug of the team merge.", inputSchema: { type: 'object', properties: { bug: { type: 'number' } }, required: ['bug'] } },
  { name: 'team_final', description: 'Save the final code as a .zip: "safe" = everyone who works together now, "full" = everyone merged (with fixes). Default: the best one.', inputSchema: { type: 'object', properties: { which: { type: 'string', enum: ['safe', 'full'] } } } },
  { name: 'team_save_branch', description: 'Save the team merge as a real git merge commit with every merged branch as a parent.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, which: { type: 'string', enum: ['safe', 'full'] } } } },
  // ---- git projects with two developers (and the merged result of ws_merge) ----
  { name: 'project_open', description: 'Open a git project on the computer running Tandemi (a folder with .git). Tandemi reads its branches and finds how to build and test it (tandemi.json, or detects dotnet test / npm test / pytest).', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Folder of the project, e.g. C:\\Users\\me\\source\\MyGame' } }, required: ['path'] } },
  { name: 'project_clone', description: 'Open a project straight from GitHub: paste its link (https://github.com/owner/repo or owner/repo). Tandemi downloads it into its own folder (or updates it if it was downloaded before), then opens it with all its branches.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'project_sample', description: 'Open the sample MonoGame-style C# game (Cat Runner) with two developer branches, dev-a and dev-b.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project_status', description: 'The open project: branches, developers, the last merge (files, real conflicts, what git would say), build and test results of each branch alone and of the merged code, and every bug with the developer it went to.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project_fetch', description: 'git fetch from GitHub/remote, so pushed branches show up.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project_merge', description: 'Merge two branches (one per developer) by the code\'s structure, then build and test each branch alone and the merged code, and send each bug to the developer who wrote the line that broke. Can take minutes for big projects.', inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'Developer A\'s branch, e.g. dev-a or origin/dev-a' }, b: { type: 'string', description: 'Developer B\'s branch' } }, required: ['a', 'b'] } },
  { name: 'project_pick', description: 'Solve a real merge conflict: pick "A", "B" or "both" (or "custom" with code). When every conflict is solved, Tandemi builds and tests.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, conflict: { type: 'number' }, pick: { type: 'string', enum: ['A', 'B', 'both', 'custom'] }, code: { type: 'string' } }, required: ['file', 'conflict', 'pick'] } },
  { name: 'project_read_file', description: 'Read a file of the merged code (with who wrote each changed line).', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
  { name: 'project_write_file', description: 'Fix the merged code: save a whole file, then Tandemi builds and tests again and returns the bugs. Use this to fix the bugs sent to your developer.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' }, by: { type: 'string', description: 'Who is fixing, e.g. "Beka\'s AI coder"' } }, required: ['file', 'content'] } },
  { name: 'project_retest', description: 'Build and test the merged code again.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project_plain_add', description: 'Add a test in plain words to the open project, e.g. "the cat never jumps off the top of the screen". It becomes a real test (written by Tandemi\'s AI, by you through project_plain_set_code, or by hand), is checked on the starting code, and then runs on each developer\'s version and on the merge.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'project_plain_tests', description: 'The tests in plain words of the open project, and for each one still to write: the requirement, the project\'s existing tests and the code it is about, and exactly how to write it. Write them, then send each with project_plain_set_code.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project_plain_set_code', description: 'Give the code of a test in plain words: a NEW file in the project\'s own test framework, and the name of the test method/function. Tandemi checks it on the starting code (it should pass) and then runs it with every check.', inputSchema: { type: 'object', properties: { id: { type: 'number' }, file: { type: 'string', description: 'New file, relative to the project, next to the existing tests' }, code: { type: 'string' }, testName: { type: 'string' } }, required: ['id', 'file', 'code', 'testName'] } },
  { name: 'project_plain_remove', description: 'Remove a test in plain words.', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'project_fix_bug', description: "Let Tandemi's own agent (needs an Anthropic API key in Tandemi) fix one bug; the fix is kept only if the bug is gone.", inputSchema: { type: 'object', properties: { bug: { type: 'number' } }, required: ['bug'] } },
  { name: 'project_mode', description: '"auto": after every check, the developers\' agents fix the bugs automatically (needs an API key in Tandemi). "report": bugs only get reported.', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['auto', 'report'] } }, required: ['mode'] } },
  { name: 'project_final', description: 'Save the final merged code as a .zip in Tandemi\'s final folder and return where it is.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project_save_branch', description: 'Save the merged code as a real git merge commit on a new branch (default tandemi/merge-<a>-<b>), ready to push and open a pull request.', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  // ---- merging without git: one file, or folders on this computer
  { name: 'merge_files', description: 'Merge three versions of ONE file without git: the original, Developer A\'s and Developer B\'s. C#, JavaScript, TypeScript, Python, Java, C++ and Go are merged by structure (classes, methods, fields, statements), so separate changes never conflict; other files line by line. Returns the merged file, or the real conflicts to pick.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'File name, e.g. Player.cs (the extension picks the language).' }, base: { type: 'string', description: 'The original version (empty if there was none).' }, a: { type: 'string' }, b: { type: 'string' } }, required: ['file', 'a', 'b'] } },
  { name: 'merge_folders', description: 'Merge three folders on this computer without git (the original, A\'s copy, B\'s copy) into a new folder, file by file, by structure. Returns what changed and any real conflicts.', inputSchema: { type: 'object', properties: { base: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' }, out: { type: 'string', description: 'A new folder for the result (default: next to A\'s folder, named …-merged).' } }, required: ['base', 'a', 'b'] } },
  { name: 'merge_pick', description: 'Solve a real conflict of merge_files / merge_folders: pick "A", "B", "both" or "custom" (with code). When all are solved, the merged file is returned or the folder is written.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, conflict: { type: 'number' }, pick: { type: 'string', enum: ['A', 'B', 'both', 'custom'] }, code: { type: 'string' } }, required: ['conflict', 'pick'] } },
  { name: 'merge_status', description: 'The merge of files or folders in progress.', inputSchema: { type: 'object', properties: {} } },
];

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), data = JSON.stringify(body);
    const req = require(u.protocol === 'https:' ? 'https' : 'http').request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(process.env.TANDEMI_TOKEN ? { authorization: 'Bearer ' + process.env.TANDEMI_TOKEN } : {}) } }, (res) => {
      let out = ''; res.setEncoding('utf8'); res.on('data', (c) => { out += c; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
// every tool works on its own: when Tandemi isn't running, the MCP runs the engine itself.
let local = null;
function localEngine() {
  if (!local) { local = require('./project-actions.js'); local.init(); local.reopenLast(); }
  return local;
}
async function callTool(name, args) {
  if (!TOOLS.some(t => t.name === name)) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
    let r;
  try {
    r = await post(BASE + '/mcp/call', { tool: name, args: args || {} }); // no time limit: builds of big projects can take long
  } catch (e) {
    // Tandemi isn't open: do it right here
    const E = localEngine();
    await E.reopenLast();
    r = name.startsWith('project_') ? await E.projectAction(name.slice('project_'.length), { by: name === 'project_plain_set_code' ? 'an AI coder (MCP)' : undefined, ...(args || {}) }, true) : name.startsWith('team_') ? await E.teamAction(name.slice('team_'.length), args || {}, true) : name.startsWith('ws_') ? await E.wsAction(name.slice('ws_'.length), args || {}, true) : await E.fileAction(name.slice('merge_'.length), args || {}, true);
  }
  if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(r.result, null, 2) }] };
}
async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code, message } }); };
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tandemi', version: '1.0.0' },
        instructions: 'Tandemi merges two developers\' work by the code\'s structure (so separate changes never conflict), checks it (build and tests, or a compile check), sends every bug to whoever caused it, and hands back the final code. Code not in git (pasted, files, folders): ws_new, ws_add_files or ws_folder for the original, A and B, then ws_merge (ws_add_developer for a 3rd, 4th… developer; then use the team_* tools). A git project: project_open, project_clone (GitHub link) or project_sample, then project_merge with two branches, or team_merge with three or more. Then fix the bugs sent to your developer with project_read_file and project_write_file until none are open, and finish with project_final (a .zip) or project_save_branch (git). Quick merges without checks: merge_files, merge_folders. Works with or without the Tandemi page open.',
      });
    case 'notifications/initialized': case 'notifications/cancelled': return;
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': return reply(await callTool(params && params.name, params && params.arguments));
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return fail(-32601, `Method not found: ${method}`);
  }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(msg).catch(e => { process.stderr.write('tandemi mcp: ' + e.stack + '\n'); if (msg.id != null) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }); });
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`tandemi mcp: ready, talking to ${BASE}\n`);
