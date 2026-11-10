#!/usr/bin/env node
// checks.js · when code has no project file (no .csproj, package.json …), Tandemi still checks that it compiles.
// Run in a folder: finds C#, JavaScript, TypeScript, Python, Java, C++ and Go files and checks each with its real tool.
// Prints errors as  file(line,col): error CODE: message  (the format Tandemi reads) and exits 1 if any.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const os = require('os');
const root = process.cwd();
const SKIP = /^(\.git|bin|obj|node_modules|\.vs|\.idea|tandemi-check|__pycache__|dist|build)$/i;
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.test(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(root);
const by = (re) => files.filter(f => re.test(f));
const out = [];
const err = (file, line, col, code, msg) => out.push(`${file}(${line || 1},${col || 1}): error ${code}: ${String(msg).replace(/\s+/g, ' ').trim()}`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, maxBuffer: 64 << 20, ...opts });
const HAVE = {};
const have = (cmd) => { if (!(cmd in HAVE)) { const r = run(cmd, [cmd === 'go' ? 'version' : '--version']); HAVE[cmd] = !r.error && r.status === 0 ? String(r.stdout || '').trim() : null; } return HAVE[cmd] !== null; };
// run commands a few at a time (light on a weak laptop: at most half the cores)
const runAll = (jobs, limit = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)))) => new Promise((resolve) => {
  const results = new Array(jobs.length); let next = 0, active = 0, finished = 0;
  if (!jobs.length) return resolve(results);
  const start = () => {
    while (active < limit && next < jobs.length) {
      const i = next++, [cmd, args] = jobs[i]; active++;
      let out = ''; const c = spawn(cmd, args, { windowsHide: true });
      c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
      c.on('error', () => {}); c.on('close', () => { results[i] = out; active--; finished++; if (finished === jobs.length) resolve(results); else start(); });
    }
  };
  start();
});
let checked = 0, missing = [], cppJobs = [], cppCxx = null, cppIncs = [];
const libs = new Set(); // outside libraries that aren't on this computer (their errors aren't anyone's fault)

// JavaScript: parse every file (syntax errors with exact line and column)
const js = by(/\.(m?js|cjs)$/i);
if (js.length) {
  const acorn = require('./vendor/acorn.js');
  for (const f of js) {
    const src = fs.readFileSync(f, 'utf8'); checked++;
    try { acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); }
    catch (e1) { try { acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true }); } catch (e) { err(f, e.loc && e.loc.line, e.loc && e.loc.column + 1, 'JS', e.message.replace(/\s*\(\d+:\d+\)$/, '')); } }
  }
}
// Python: compile every file
const py = by(/\.py$/i);
if (py.length) {
  const pyCmd = have('python3') ? 'python3' : have('python') ? 'python' : have('py') ? 'py' : null;
  if (!pyCmd) missing.push('Python (python.org)');
  else {
    const script = 'import sys,py_compile\nfor f in sys.argv[1:]:\n    try:\n        py_compile.compile(f, doraise=True)\n    except py_compile.PyCompileError as e:\n        x = e.exc_value\n        print("%s(%s,%s): error PY: %s" % (f, getattr(x, "lineno", 1) or 1, getattr(x, "offset", 1) or 1, getattr(x, "msg", str(x))))\n';
    const r = run(pyCmd, ['-c', script, ...py], { shell: false }); checked += py.length;
    for (const l of (r.stdout || '').split('\n')) if (l.trim()) out.push(l.trim());
  }
}
// C++: syntax and type check every .cpp/.cc (headers come in through #include)
const cpp = by(/\.(cpp|cc|cxx)$/i);
if (cpp.length || by(/\.(h|hpp)$/i).length) {
  const cxx = have('g++') ? 'g++' : have('clang++') ? 'clang++' : null;
  if (!cxx) missing.push('a C++ compiler (g++ or clang++)');
  else {
    const units = cpp.length ? cpp : by(/\.(h|hpp)$/i);
    const incs = [...new Set(files.filter(f => /\.(h|hpp)$/i.test(f)).map(f => '-I' + path.dirname(f)))];
    checked += units.length;
    cppJobs = units.map(f => [cxx, ['-fsyntax-only', '-std=c++17', ...incs, f]]);
    cppCxx = cxx; cppIncs = incs;
  }
}
// Java: compile every .java file (javac), errors with the symbol it couldn't find
const java = by(/\.java$/i);
if (java.length) {
  if (!have('javac')) missing.push('a Java JDK (javac)');
  else {
    const outDir = path.join(root, 'tandemi-check', 'java'); fs.mkdirSync(outDir, { recursive: true });
    checked += java.length;
    const r = run('javac', ['-d', outDir, '-Xmaxerrs', '200', '-encoding', 'UTF-8', ...java], { shell: false });
    const text = (r.stderr || '') + (r.stdout || '');
    // packages that aren't here (a library without its jar): skip those errors and the classes imported from them
    const gone = new Set([...text.matchAll(/error: package ([\w.]+) does not exist/g)].map(m => m[1]));
    gone.forEach(p => libs.add(p));
    const fromGone = new Map(); // file -> class names imported from missing packages ('*' = everything)
    for (const f of java) { const names = new Set(); for (const m of fs.readFileSync(f, 'utf8').matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\.(\w+|\*)\s*;/gm)) if ([...gone].some(g => m[1] === g || m[1].startsWith(g + '.'))) names.add(m[2]); fromGone.set(path.resolve(f), names); }
    const noise = (file, sym) => { const n = fromGone.get(path.resolve(file)); if (!n || !n.size) return false; const cls = (sym.match(/^class (\w+)/) || [])[1]; return n.has('*') ? !!cls : !!cls && n.has(cls); };
    for (const m of text.matchAll(/^(.+?\.java):(\d+): error: (.+)\n(?:.*\n){0,3}?\s*symbol:\s*(.+)$/gm)) if (!noise(m[1], m[4].trim())) err(m[1], m[2], 1, 'JAVA', `${m[3]}: ${m[4].trim()}`);
    for (const m of text.matchAll(/^(.+?\.java):(\d+): error: (.+)$/gm)) if (!/cannot find symbol/.test(m[3]) && !/^package [\w.]+ does not exist/.test(m[3])) err(m[1], m[2], 1, 'JAVA', m[3]);
  }
}
// TypeScript: type-check with tsc (the project's tsconfig.json when there is one)
const tsFiles = by(/\.(ts|tsx|mts|cts)$/i).filter(f => !/\.d\.ts$/i.test(f));
if (tsFiles.length) {
  if (!have('tsc')) missing.push('TypeScript (npm install -g typescript)');
  else {
    checked += tsFiles.length;
    const hasConfig = fs.existsSync(path.join(root, 'tsconfig.json'));
    const r = run('tsc', hasConfig ? ['--noEmit', '-p', root] : ['--noEmit', '--skipLibCheck', '--target', 'es2020', '--jsx', 'react', ...tsFiles]);
    for (const m of ((r.stdout || '') + (r.stderr || '')).matchAll(/^(.+?\.(?:ts|tsx|mts|cts))\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)) if (hasConfig || !/^TS(2307|2792|2875)$/.test(m[4])) err(m[1], m[2], m[3], m[4], m[5]); // without a tsconfig, missing packages aren't the code's fault
  }
}
// Go: build every package (go vet, which also compiles)
const goFiles = by(/\.go$/i);
if (goFiles.length) {
  if (!have('go')) missing.push('Go (go.dev/dl)');
  else {
    checked += goFiles.length;
    const hasMod = fs.existsSync(path.join(root, 'go.mod'));
    const dirs = [...new Set(goFiles.map(f => path.dirname(f)))];
    const gopath = path.join(root, 'tandemi-check', 'gopath'), stubbed = new Set();
    const bin = path.join(root, 'tandemi-check', 'gobin') + path.sep; fs.mkdirSync(bin, { recursive: true });
    // go build with -gcflags=-e reports every error (go vet stops at the first one)
    const vet = () => (hasMod ? [run('go', ['build', '-gcflags=-e', '-o', bin, './...'], { cwd: root, shell: false })] : dirs.map(d => run('go', ['build', '-gcflags=-e', '-o', bin, '.'], { cwd: d, shell: false, env: { ...process.env, GO111MODULE: 'off', GOPATH: gopath, GOFLAGS: '' } })));
    const missingPkgs = (text) => [...text.matchAll(/cannot find package "([^"]+)"|package ([\w./-]+) is not in (?:std|GOROOT)|no required module provides package ([\w./-]+)/g)].map(m => m[1] || m[2] || m[3]);
    // stand-ins made by an earlier check are still stand-ins
    (function walk(d, rel) { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), rel ? rel + '/' + e.name : e.name); else if (e.name === 'stub.go' && rel) { stubbed.add(rel); libs.add(rel); } } })(path.join(gopath, 'src'), '');
    let runs = vet();
    // without go.mod: a package that isn't on this computer gets an empty stand-in, so the rest of the code is still type-checked
    for (let round = 0; !hasMod && round < 4; round++) {
      const need = [...new Set(runs.flatMap(r => missingPkgs((r.stderr || '') + (r.stdout || ''))))].filter(p => !stubbed.has(p));
      if (!need.length) break;
      for (const pkg of need) { stubbed.add(pkg); libs.add(pkg); const dir = path.join(gopath, 'src', ...pkg.split('/')); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'stub.go'), `// empty stand-in made by Tandemi: this package is not on this computer\npackage ${pkg.split('/').pop().replace(/^go-/, '').replace(/[^A-Za-z0-9_]/g, '_')}\n`); }
      runs = vet();
    }
    const stubNames = [...stubbed].map(p => p.split('/').pop().replace(/^go-/, '').replace(/[^A-Za-z0-9_]/g, '_'));
    runs.forEach((r, i) => {
      const base = hasMod ? root : dirs[i];
      const text = (r.stderr || '') + (r.stdout || '');
      missingPkgs(text).forEach(p => libs.add(p));
      for (const m of text.matchAll(/^(?:vet: )?(\.?[^\s:]*?\.go):(\d+):(\d+): (.+)$/gm)) {
        if (/cannot find package|is not in (std|GOROOT)|no required module provides|could not import/.test(m[4])) continue;
        if (stubNames.some(n => new RegExp(`\\b${n}\\.\\w+`).test(m[4]) || new RegExp(`"[^"]*${n}"`).test(m[4]))) continue; // something from the stand-in package
        err(path.resolve(base, m[1]), m[2], m[3], 'GO', m[4]);
      }
    });
  }
}
// C#: build all .cs files with a small generated project (only when the code has no .csproj of its own)
const cs = by(/\.cs$/i);
if (cs.length && !files.some(f => /\.csproj$/i.test(f))) {
  if (!have('dotnet')) missing.push('the .NET SDK (dotnet.microsoft.com/download)');
  else {
    const major = (HAVE.dotnet || '8').split('.')[0];
    const text = cs.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const winForms = /System\.Windows\.Forms/.test(text), wpf = /System\.Windows\.(Controls|Markup)|PresentationFramework/.test(text);
    const monogame = /Microsoft\.Xna\.Framework/.test(text);
    const dir = path.join(root, 'tandemi-check'); fs.mkdirSync(dir, { recursive: true });
    const tfm = `net${major}.0${winForms || wpf ? '-windows' : ''}`;
    const projFile = path.join(dir, 'TandemiCheck.csproj');
    const proj = (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${tfm}</TargetFramework>
    <OutputType>Library</OutputType>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>${winForms || wpf ? '\n    <EnableWindowsTargeting>true</EnableWindowsTargeting>' : ''}${winForms ? '\n    <UseWindowsForms>true</UseWindowsForms>' : ''}${wpf ? '\n    <UseWPF>true</UseWPF>' : ''}
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="../**/*.cs" Exclude="../**/bin/**;../**/obj/**;../tandemi-check/**" />
  </ItemGroup>${monogame ? `
  <ItemGroup>
    <PackageReference Include="MonoGame.Framework.DesktopGL" Version="3.8.*" />
  </ItemGroup>` : ''}
</Project>
`);
    // the project file is only rewritten when it changes, and packages are only restored when needed: the check is incremental
    let same = false; try { same = fs.readFileSync(projFile, 'utf8') === proj; } catch (e) { /* first time */ }
    if (!same) fs.writeFileSync(projFile, proj);
    const restored = same && fs.existsSync(path.join(dir, 'obj', 'project.assets.json'));
    checked += cs.length;
    const r = run('dotnet', ['build', projFile, '-nologo', '-v', 'q', '-clp:NoSummary', ...(restored ? ['--no-restore'] : [])]);
    const lines = ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => / error [A-Z]+\d+:/.test(l));
    for (const l of [...new Set(lines.map(l => l.trim().replace(/ \[[^\]]+\]$/, '')))]) out.push(l);
    if (r.status && !lines.length) out.push(`${path.join(dir, 'TandemiCheck.csproj')}(1,1): error BUILD: ${((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' ')}`);
  }
}
// <outside/header.h> that isn't on this computer: give the compiler an empty one, so the rest of the file is still checked
const missingHeader = (text) => [...String(text || '').matchAll(/fatal error: ([\w./+-]+): No such file or directory/g)].map(m => m[1]).filter(h => !files.some(f => f.replace(/\\/g, '/').endsWith('/' + h)));
async function checkCpp() {
  const stubs = path.join(root, 'tandemi-check', 'stubs');
  let results = await runAll(cppJobs);
  for (let round = 0; round < 6; round++) {
    const need = [...new Set(results.flatMap(missingHeader))];
    if (!need.length) break;
    for (const h of need) { libs.add(h); const p = path.join(stubs, h); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '// empty stand-in made by Tandemi: this library is not on this computer\n'); }
    results = await runAll(cppJobs.map(([c, args]) => [c, ['-I' + stubs, ...args]]));
  }
  return results;
}
// errors that come only from a stand-in header (unknown types from the missing library) aren't the code's fault either
const libNoise = (msg) => {
  if (!/does not name a type|was not declared in this scope|has not been declared|incomplete type|is not a member of|is not a namespace/.test(msg)) return false;
  const quoted = [...msg.matchAll(/'([\w:]+)'/g)].map(m => m[1]);
  const prefixes = [...libs].filter(h => /\.(h|hpp|hh)$/i.test(h)).flatMap(h => [path.basename(h).replace(/\.\w+$/, '').replace(/\d+$/, ''), h.split('/')[0].replace(/\d+$/, '')]).filter(p => p.length >= 2);
  return quoted.some(q => prefixes.some(p => q.toLowerCase().startsWith(p.toLowerCase())) || /^(SDL|GL|gl[A-Z]|glfw|sf|cv|boost|Q[A-Z]|vk|Vk|al[A-Z]|AL_)/.test(q));
};
// "'w' was not declared" on a line like "SDL_Window* w = …": only because the library type is unknown here
const declaredWithLibType = (file, line, msg) => {
  const id = (msg.match(/'(\w+)' was not declared/) || [])[1]; if (!id) return false;
  let src; try { src = fs.readFileSync(file, 'utf8').split(/\r?\n/)[line - 1] || ''; } catch (e) { return false; }
  const m = src.match(new RegExp(`\\b([A-Za-z_][\\w:]*)\\s*[*&]*\\s*\\b${id}\\b\\s*[=;(,)\\[{]`));
  return !!m && libNoise(`'${m[1]}' does not name a type`);
};
(cppJobs.length ? checkCpp() : Promise.resolve([])).then((results) => {
  for (const text of results) for (const m of String(text || '').matchAll(/^(.+?):(\d+):(\d+):\s*(?:fatal )?error:\s*(.+)$/gm)) if (!/No such file or directory/.test(m[4]) || !missingHeader(m[0]).length) if (!(libs.size && (libNoise(m[4]) || declaredWithLibType(m[1], +m[2], m[4])))) err(m[1], m[2], m[3], 'CPP', m[4]);
  const uniq = [...new Set(out)]; out.length = 0; out.push(...uniq);
  for (const l of out) console.log(l);
  if (missing.length) console.log(`Tandemi: to check all the code, install ${missing.join(' and ')}.`);
  if (libs.size) console.log(`Tandemi: these outside libraries aren't on this computer, so errors about them were skipped (the rest was checked): ${[...libs].slice(0, 8).join(', ')}${libs.size > 8 ? '…' : ''}.`);
  console.log(`Tandemi checked ${checked} file${checked === 1 ? '' : 's'}: ${out.length ? out.length + ' error' + (out.length === 1 ? '' : 's') : 'no errors'}.`);
  process.exit(out.length ? 1 : 0);
});
