// merge.js · Tandemi's merge: three-way merge on the code's structure (AST), plus a line-by-line merge to compare.
// Both are three-way: the common starting version (base), Developer A's version and Developer B's version.
// The structural merge matches functions, variables, object fields, statements and class members by name, so two
// developers who change different parts of the same file never conflict, even when their edits touch the same lines.
// Languages: JavaScript (acorn) and C# (tree-sitter). Each language is an adapter; the merge itself is shared.
'use strict';
const path = require('path');
const acorn = require('./vendor/acorn.js');

// ---------------------------------------------------------------- line-by-line three-way merge (what git does)
function lcsPairs(x, y) {
  const n = x.length, m = y.length;
  if (n * m > 4e6) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const map = new Array(n).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) { if (x[i] === y[j]) { map[i] = j; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return map;
}
// Myers' O((N+M)·D) diff for one region (what git uses between patience anchors). Fast when the two sides are
// similar (small D). Gives up (returns false) when the region is too different to be worth it.
function myers(x, y, a0, a1, b0, b1, map, maxD = 2000) {
  const N = a1 - a0, M = b1 - b0, MAX = N + M, off = MAX + 1;
  const V = new Int32Array(2 * MAX + 3); V[off + 1] = 0;
  const trace = [];
  for (let d = 0; d <= Math.min(MAX, maxD); d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)); // the frontier before step d (k from -d-1 to d+1)
    for (let k = -d; k <= d; k += 2) {
      let xx = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
      let yy = xx - k;
      while (xx < N && yy < M && x[a0 + xx] === y[b0 + yy]) { xx++; yy++; }
      V[off + k] = xx;
      if (xx >= N && yy >= M) { // walk back through the frontiers and record the matching lines
        let cx = N, cy = M;
        for (let e = d; e > 0; e--) {
          const W = trace[e], at = (kk) => W[kk + e + 1], kk = cx - cy;
          const pk = (kk === -e || (kk !== e && at(kk - 1) < at(kk + 1))) ? kk + 1 : kk - 1;
          const px = at(pk), py = px - pk;
          while (cx > px && cy > py) { cx--; cy--; map[a0 + cx] = b0 + cy; }
          cx = px; cy = py;
        }
        while (cx > 0 && cy > 0) { cx--; cy--; map[a0 + cx] = b0 + cy; }
        return true;
      }
    }
  }
  return false;
}
// which line of x matches which line of y, for files of any size (patience diff, the way git does it):
// lines that appear exactly once on both sides are anchors; only the small gaps between anchors are compared in full.
function diffMap(x, y) {
  const map = new Array(x.length).fill(-1);
  const stack = [[0, x.length, 0, y.length]];
  while (stack.length) {
    let [a0, a1, b0, b1] = stack.pop();
    while (a0 < a1 && b0 < b1 && x[a0] === y[b0]) { map[a0] = b0; a0++; b0++; }
    while (a0 < a1 && b0 < b1 && x[a1 - 1] === y[b1 - 1]) { map[a1 - 1] = b1 - 1; a1--; b1--; }
    if (a0 >= a1 || b0 >= b1) continue;
    const n = a1 - a0, m = b1 - b0;
    if (n * m <= 250000) { const sub = lcsPairs(x.slice(a0, a1), y.slice(b0, b1)); sub.forEach((j, i) => { if (j >= 0) map[a0 + i] = b0 + j; }); continue; }
    const cx = new Map(), cy = new Map();
    for (let i = a0; i < a1; i++) { const e = cx.get(x[i]); cx.set(x[i], e !== undefined ? -1 : i); } // (index 0 is a real index, not 'not seen')
    for (let j = b0; j < b1; j++) { const e = cy.get(y[j]); cy.set(y[j], e !== undefined ? -1 : j); }
    const pairs = [];
    for (const [k, i] of cx) { if (i < 0) continue; const j = cy.get(k); if (j !== undefined && j >= 0) pairs.push([i, j]); }
    if (!pairs.length) { // nothing unique: Myers (fast when similar), then a full compare if not huge, otherwise treat the block as replaced
      if (myers(x, y, a0, a1, b0, b1, map)) continue;
      if (n * m <= 4e6) { const sub = lcsPairs(x.slice(a0, a1), y.slice(b0, b1)); sub.forEach((j, i) => { if (j >= 0) map[a0 + i] = b0 + j; }); }
      continue;
    }
    pairs.sort((p, q) => p[0] - q[0]);
    // longest increasing run of y positions (patience sorting) = the anchors, in order on both sides
    const tails = [], prev = new Array(pairs.length).fill(-1), tailIdx = [];
    for (let k = 0; k < pairs.length; k++) {
      const j = pairs[k][1]; let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < j) lo = mid + 1; else hi = mid; }
      tails[lo] = j; tailIdx[lo] = k; prev[k] = lo ? tailIdx[lo - 1] : -1;
    }
    const anchors = []; for (let k = tailIdx[tails.length - 1]; k >= 0; k = prev[k]) anchors.push(pairs[k]);
    anchors.reverse();
    let pa = a0, pb = b0;
    for (const [i, j] of anchors) { map[i] = j; if (i > pa && j > pb) stack.push([pa, i, pb, j]); pa = i + 1; pb = j + 1; }
    if (pa < a1 && pb < b1) stack.push([pa, a1, pb, b1]);
  }
  return map;
}
const sameLines = (p, q) => p.length === q.length && p.every((l, i) => l === q[i]);
// three-way merge word by word, for small pieces only; null when the two still change the same words
const TOKENS = /[A-Za-z_$][\w$]*|\d[\w.]*|\s+|[^\w\s]/g;
function tokenMerge(base, a, b) {
  if (base.length > 4000 || a.length > 4000 || b.length > 4000) return null;
  const lines = (t) => t.split('\n').length;
  if (Math.max(lines(base), lines(a), lines(b)) > 25) return null;
  const enc = (t) => (t.match(TOKENS) || []).map(x => x.replace(/\n/g, '\u0001')).join('\n');
  const lm = lineMerge(enc(base), enc(a), enc(b));
  if (lm.tooBig || lm.conflicts.length || typeof lm.template !== 'string') return null;
  const out = lm.template.split('\n').map(x => x.replace(/\u0001/g, '\n')).join('');
  return out === a || out === b || out.trim() ? out : null;
}
function lineMerge(base, a, b) {
  const O = base.split('\n'), A = a.split('\n'), B = b.split('\n');
  const mA = diffMap(O, A), mB = diffMap(O, B);
  const out = [], conflicts = [];
  let i = 0, j = 0, k = 0;
  while (i < O.length || j < A.length || k < B.length) {
    if (i < O.length && mA[i] === j && mB[i] === k) { out.push(O[i]); i++; j++; k++; continue; }
    let i2 = i; while (i2 < O.length && !(mA[i2] >= j && mB[i2] >= k)) i2++;
    const j2 = i2 < O.length ? mA[i2] : A.length, k2 = i2 < O.length ? mB[i2] : B.length;
    const o = O.slice(i, i2), x = A.slice(j, j2), y = B.slice(k, k2);
    if (sameLines(x, o)) out.push(...y);
    else if (sameLines(y, o) || sameLines(x, y)) out.push(...x);
    else {
      const id = conflicts.length;
      conflicts.push({ id, label: `Lines ${j + 1}–${Math.max(j + 1, j2)} of A's version`, base: o.join('\n'), a: x.join('\n'), b: y.join('\n') });
      out.push(`\u0000C${id}\u0000`);
    }
    i = i2; j = j2; k = k2;
  }
  return { conflicts, template: out.join('\n') };
}

const norm = (s) => s.replace(/\s+/g, ' ').replace(/ ?([{}()[\],;:=<>+\-*/!?.&|]) ?/g, '$1').trim();

// ---------------------------------------------------------------- JavaScript adapter (acorn)
function parse(src) {
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true };
  try { return acorn.parse(src, { ...opts, sourceType: 'module' }); }
  catch (e1) { try { return acorn.parse(src, { ...opts, sourceType: 'script' }); } catch (e2) { throw e1; } }
}
const isFn = (n) => n && /Function/.test(n.type);

// the list a node holds (statements, object fields, class members, array items), looking through wrappers
function jsContainer(n) {
  if (!n) return null;
  switch (n.type) {
    case 'Program': case 'BlockStatement': case 'StaticBlock': return { list: n.body, kind: 'stmt', owner: n };
    case 'ClassBody': return { list: n.body, kind: 'class', owner: n };
    case 'ObjectExpression': return { list: n.properties, kind: 'prop', owner: n };
    case 'ArrayExpression': return n.elements.every(Boolean) ? { list: n.elements, kind: 'elem', owner: n } : null;
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': return n.body.type === 'BlockStatement' ? jsContainer(n.body) : null;
    case 'ClassDeclaration': case 'ClassExpression': return jsContainer(n.body);
    case 'VariableDeclaration': return n.declarations.length === 1 ? jsContainer(n.declarations[0].init) : null;
    case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration': return jsContainer(n.declaration);
    case 'ExpressionStatement': {
      const e = n.expression;
      if (e.type === 'AssignmentExpression') return jsContainer(e.right);
      if (e.type === 'CallExpression' || (e.type === 'AwaitExpression' && e.argument.type === 'CallExpression')) {
        const call = e.type === 'CallExpression' ? e : e.argument, last = call.arguments[call.arguments.length - 1];
        return last && (isFn(last) || last.type === 'ObjectExpression') ? jsContainer(last) : null;
      }
      return null;
    }
    case 'IfStatement': return !n.alternate && n.consequent.type === 'BlockStatement' ? jsContainer(n.consequent) : null;
    case 'Property': case 'MethodDefinition': case 'PropertyDefinition': return jsContainer(n.value);
    case 'TryStatement': return !n.handler && !n.finalizer ? jsContainer(n.block) : null;
    case 'ForStatement': case 'ForOfStatement': case 'ForInStatement': case 'WhileStatement': return n.body.type === 'BlockStatement' ? jsContainer(n.body) : null;
    default: return null;
  }
}

// a stable name for a node among its siblings, so the same function or field is matched in all three versions
function jsKeyOf(n, src) {
  const t = (x) => norm(src.slice(x.start, x.end));
  const keyName = (k) => (k.type === 'Identifier' ? k.name : t(k));
  switch (n.type) {
    case 'FunctionDeclaration': case 'ClassDeclaration': return 'decl ' + (n.id ? n.id.name : '?');
    case 'VariableDeclaration': return 'var ' + n.declarations.map(d => t(d.id)).join(',');
    case 'ExportNamedDeclaration': return n.declaration ? 'export ' + jsKeyOf(n.declaration, src) : 'export {' + n.specifiers.map(s => t(s)).join(',') + '}';
    case 'ExportDefaultDeclaration': return 'export default';
    case 'ImportDeclaration': return 'import ' + n.source.value;
    case 'Property': case 'MethodDefinition': case 'PropertyDefinition': return (n.static ? 'static ' : '') + (n.kind && n.kind !== 'init' && n.kind !== 'method' ? n.kind + ' ' : '') + 'field ' + keyName(n.key);
    case 'ExpressionStatement': {
      const e = n.expression;
      if (e.type === 'AssignmentExpression') return 'set ' + t(e.left);
      const call = e.type === 'CallExpression' ? e : e.type === 'AwaitExpression' && e.argument.type === 'CallExpression' ? e.argument : null;
      if (call) { const first = call.arguments[0]; return 'call ' + t(call.callee) + (first && first.type === 'Literal' ? '(' + first.raw : ''); }
      return 'expr ' + t(n);
    }
    case 'IfStatement': return 'if ' + t(n.test);
    case 'ReturnStatement': return 'return';
    case 'ForStatement': case 'WhileStatement': case 'DoWhileStatement': return n.type + ' ' + (n.test ? t(n.test) : '');
    case 'ForOfStatement': case 'ForInStatement': return n.type + ' ' + t(n.left) + ' ' + t(n.right);
    case 'TryStatement': return 'try';
    case 'SwitchStatement': return 'switch ' + t(n.discriminant);
    default: return n.type + ' ' + t(n);
  }
}
const JS = { name: 'JavaScript', parse, container: jsContainer, keyOf: jsKeyOf, start: (n) => n.start, end: (n) => n.end, isRoot: (n) => n.type === 'Program' };

// ---------------------------------------------------------------- C# adapter (tree-sitter, bundled in vendor/)
let TS = null; // { parser } once the C# grammar is loaded (kept for the C# checks below)
const GRAMMARS = { cs: ['tree-sitter-c_sharp.wasm', 'C#'], py: ['tree-sitter-python.wasm', 'Python'], java: ['tree-sitter-java.wasm', 'Java'], ts: ['tree-sitter-typescript.wasm', 'TypeScript'], tsx: ['tree-sitter-tsx.wasm', 'TypeScript (TSX)'], cpp: ['tree-sitter-cpp.wasm', 'C++'], go: ['tree-sitter-go.wasm', 'Go'] };
const PARSERS = {}; // grammar id -> Parser, once loaded
const LIVE = []; // syntax trees (C#, Python, Java…) live in WebAssembly memory: free them when a merge is done
function freeTrees() { KIDS.clear(); while (LIVE.length) { try { LIVE.pop().delete(); } catch (e) { /* already freed */ } } }
// the parsers are loaded only for the languages a merge actually has (lighter on small laptops)
let TSMOD = null, TSDIR = path.join(__dirname, 'vendor', 'tree-sitter');
const ready = (async () => {
  try { TSMOD = require(path.join(TSDIR, 'tree-sitter.cjs')); await TSMOD.Parser.init({ locateFile: (f) => path.join(TSDIR, f) }); }
  catch (e) { TSMOD = null; process.stderr.write('Tandemi: the code parsers did not load (' + e.message + '); C#, Python, Java, TypeScript, C++ and Go files are merged line by line.\n'); }
})();
const LOADING = {};
function loadGrammar(id) {
  if (PARSERS[id] || !GRAMMARS[id]) return Promise.resolve();
  if (!LOADING[id]) LOADING[id] = (async () => {
    await ready; if (!TSMOD) return;
    const [file, name] = GRAMMARS[id];
    try { const lang = await TSMOD.Language.load(path.join(TSDIR, file)); const parser = new TSMOD.Parser(); parser.setLanguage(lang); PARSERS[id] = parser; if (id === 'cs') TS = { parser }; }
    catch (e) { process.stderr.write(`Tandemi: the ${name} parser did not load (${e.message}); ${name} files are merged line by line.\n`); }
  })();
  return LOADING[id];
}
// load the parsers these files need (call before merging them)
async function prepare(files) { await ready; await Promise.all([...new Set([...files].map(langOf).filter(l => l && GRAMMARS[l]))].map(loadGrammar)); }
const prepareAll = () => Promise.all(Object.keys(GRAMMARS).map(loadGrammar));
// parse with one tree-sitter grammar; `from` = { src, tree } of a version already parsed (only the changed lines are parsed again)
function tsParse(id) {
  return function (src, from) {
    const parser = PARSERS[id];
    if (!parser) throw { message: `the ${GRAMMARS[id][1]} parser is not loaded` };
    let old = null;
    if (from && from.tree && from.src.length > 20000 && !process.env.TANDEMI_NO_INCREMENTAL) { try { old = editedCopy(from.tree, from.src, src); } catch (e) { old = null; } }
    const tree = parser.parse(src, old || undefined); LIVE.push(tree); if (old) LIVE.push(old);
    const root = tree.rootNode;
    root.__tree = tree;
    if (root.hasError) {
      const find = (test) => { let hit = null; const walk = (x) => { if (hit) return; if (test(x)) { hit = x; return; } for (const c of x.children) walk(c); }; walk(root); return hit; };
      const bad = find((x) => x.isMissing) || find((x) => x.type === 'ERROR');
      throw { line: bad ? bad.startPosition.row + 1 : null, message: bad && bad.isMissing ? `missing "${bad.type}"` : 'the code has a syntax error here' };
    }
    return root;
  };
}
// a node's children, read from WebAssembly once per merge (reading them again allocates new objects every time)
const KIDS = new Map(); // tree -> (node id -> children); ids repeat across trees that share unchanged parts
const kids = (n) => { let t = KIDS.get(n.tree); if (!t) { t = new Map(); KIDS.set(n.tree, t); } let v = t.get(n.id); if (!v) { v = n.namedChildren; t.set(n.id, v); } return v; };
const named = (n) => kids(n).filter(c => c.type !== 'comment');
const kid = (n, type) => kids(n).find(c => c.type === type) || null;
// the C# parser counts the line breaks after a directive (#nullable, #region, #if…) as part of it: end it at its text,
// otherwise the merge thinks there is nothing between it and the next line and glues them onto one line
const csEnd = (n) => { if (!/^preproc/.test(n.type)) return n.endIndex; const tx = n.text; return n.endIndex - (tx.length - tx.replace(/\s+$/, '').length); };
function csContainer(n) {
  if (!n) return null;
  switch (n.type) {
    case 'compilation_unit': case 'block': case 'switch_body': return { list: named(n), kind: 'stmt', owner: n };
    case 'declaration_list': case 'accessor_list': return { list: named(n), kind: 'class', owner: n };
    case 'enum_member_declaration_list': return { list: named(n), kind: 'prop', owner: n };
    case 'namespace_declaration': case 'class_declaration': case 'struct_declaration': case 'interface_declaration': case 'record_declaration':
      return csContainer(kid(n, 'declaration_list'));
    case 'enum_declaration': return csContainer(kid(n, 'enum_member_declaration_list'));
    case 'method_declaration': case 'constructor_declaration': case 'destructor_declaration': case 'operator_declaration': case 'local_function_statement': case 'accessor_declaration':
      return csContainer(kid(n, 'block'));
    case 'property_declaration': case 'indexer_declaration': return csContainer(kid(n, 'accessor_list'));
    case 'if_statement': { const parts = named(n); return parts.length === 2 && parts[1].type === 'block' ? csContainer(parts[1]) : null; }
    case 'for_statement': case 'foreach_statement': case 'while_statement': case 'using_statement': case 'lock_statement': case 'fixed_statement': case 'checked_statement': case 'unsafe_statement': {
      const body = named(n).filter(c => c.type === 'block').pop(); return body ? csContainer(body) : null;
    }
    case 'switch_statement': return csContainer(kid(n, 'switch_body'));
    default: return null;
  }
}
function csKeyOf(n, src) {
  const t = (x) => (x ? norm(src.slice(x.startIndex, x.endIndex)) : '');
  const name = () => t(n.childForFieldName('name') || kid(n, 'identifier'));
  const vars = (x) => { const v = x.type === 'variable_declaration' ? x : kid(x, 'variable_declaration'); return v ? v.namedChildren.filter(c => c.type === 'variable_declarator').map(d => t(d.childForFieldName('name') || kid(d, 'identifier'))).join(',') : t(x); };
  const params = () => { const pl = kid(n, 'parameter_list'); return pl ? pl.namedChildren.filter(c => c.type === 'parameter').map(p => t(p.childForFieldName('type'))).join(',') : ''; };
  switch (n.type) {
    case 'using_directive': return 'using ' + t(n).replace(/^using\s*/, '').replace(/;$/, '');
    case 'namespace_declaration': case 'file_scoped_namespace_declaration': return 'namespace ' + name();
    case 'class_declaration': case 'struct_declaration': case 'interface_declaration': case 'record_declaration': case 'enum_declaration': case 'delegate_declaration': return 'decl ' + name();
    case 'method_declaration': case 'local_function_statement': case 'constructor_declaration': return 'decl ' + name() + '(' + params() + ')';
    case 'destructor_declaration': return 'decl ~' + name();
    case 'operator_declaration': return 'decl operator ' + t(n.childForFieldName('operator')) + '(' + params() + ')';
    case 'property_declaration': case 'event_declaration': return 'field ' + name();
    case 'indexer_declaration': return 'field this[' + params() + ']';
    case 'field_declaration': case 'event_field_declaration': return 'field ' + vars(n);
    case 'enum_member_declaration': return 'field ' + name();
    case 'accessor_declaration': { const k = n.children.find(c => /^(get|set|init|add|remove)$/.test(c.type)); return 'field ' + (k ? k.type : t(n)); }
    case 'local_declaration_statement': return 'var ' + vars(n);
    case 'expression_statement': {
      const e = n.namedChildren[0];
      if (!e) return 'expr ' + t(n);
      if (e.type === 'assignment_expression') return 'set ' + t(e.childForFieldName('left'));
      if (e.type === 'invocation_expression') { const args = kid(e, 'argument_list'), first = args && args.namedChildren[0], lit = first && first.namedChildren[0]; return 'call ' + t(e.childForFieldName('function')) + (lit && /literal/.test(lit.type) ? '(' + t(lit) : ''); }
      if (/(postfix|prefix)_unary_expression/.test(e.type)) return 'set ' + t(e).replace(/\+\+|--/g, '');
      return 'expr ' + t(n);
    }
    case 'if_statement': return 'if ' + t(n.childForFieldName('condition') || named(n)[0]);
    case 'return_statement': return 'return';
    case 'switch_statement': return 'switch ' + t(n.childForFieldName('value') || named(n)[0]);
    case 'switch_section': return 'case ' + named(n).filter(c => /label|pattern/.test(c.type)).map(t).join(',');
    case 'for_statement': case 'foreach_statement': case 'while_statement': { const body = named(n).filter(c => c.type === 'block').pop(); return n.type + ' ' + norm(src.slice(n.startIndex, body ? body.startIndex : n.endIndex)); }
    default: return n.type + ' ' + t(n);
  }
}
const CS = {
  name: 'C#', available: () => !!PARSERS.cs, container: csContainer, keyOf: csKeyOf, start: (n) => n.startIndex, end: csEnd, isRoot: (n) => n.type === 'compilation_unit',
  parse: tsParse('cs'),
};
// tell tree-sitter which lines changed between two versions, so it can reuse everything else of the old tree
function editedCopy(tree, oldSrc, newSrc) {
  const O = oldSrc.split('\n'), N = newSrc.split('\n'), m = diffMap(O, N);
  const startO = [0], startN = [0];
  for (let i = 0; i < O.length; i++) startO.push(startO[i] + O[i].length + 1);
  for (let j = 0; j < N.length; j++) startN.push(startN[j] + N[j].length + 1);
  const hunks = []; // [o0, o1, n0, n1) in lines
  let i = 0, j = 0;
  while (i < O.length || j < N.length) {
    if (i < O.length && m[i] === j) { i++; j++; continue; }
    let i2 = i; while (i2 < O.length && m[i2] < 0) i2++;
    const j2 = i2 < O.length ? m[i2] : N.length;
    hunks.push([i, i2, j, j2]); i = i2; j = j2;
  }
  if (!hunks.length) return tree.copy();
  if (hunks.length > 2000) return null;
  const copy = tree.copy();
  const point = (lines, starts, li, extra) => ({ row: li, column: 0 }); // edits always start and end at line starts
  for (let k = hunks.length - 1; k >= 0; k--) { // from the end, so earlier positions stay valid
    const [o0, o1, n0, n1] = hunks[k];
    const s0 = Math.min(startO[o0], oldSrc.length), oe = Math.min(startO[o1], oldSrc.length), newLen = Math.min(startN[n1], newSrc.length) - Math.min(startN[n0], newSrc.length);
    const endRowNew = o0 + (n1 - n0);
    copy.edit({ startIndex: s0, oldEndIndex: oe, newEndIndex: s0 + newLen, startPosition: point(O, startO, o0), oldEndPosition: point(O, startO, o1), newEndPosition: { row: endRowNew, column: 0 } });
  }
  return copy;
}
// ---------------------------------------------------------------- Python, Java, TypeScript, C++, Go (tree-sitter)
// Every adapter answers two questions: which nodes hold a list of members (container) and what each member is
// called (keyOf). The merge itself is the same for every language.
const F = (n, name) => (n ? n.childForFieldName(name) : null);
const T = (src, x) => (x ? norm(src.slice(x.startIndex, x.endIndex)) : '');
const firstLiteral = (args, src) => { const a = args && named(args)[0]; return a && /string|literal|number|integer/.test(a.type) ? '(' + T(src, a) : ''; };
const tsLang = (id, extra) => ({ name: GRAMMARS[id][1], parse: tsParse(id), start: (n) => n.startIndex, end: (n) => n.endIndex, available: () => !!PARSERS[id], ...extra });
const stmts = (n) => (n ? { list: named(n), kind: 'stmt', owner: n } : null);
const members = (n, kind = 'class') => (n ? { list: named(n), kind, owner: n } : null);

// Python: indentation blocks; comments start with #
function pyContainer(n) {
  if (!n) return null;
  switch (n.type) {
    case 'module': case 'block': return stmts(n);
    case 'class_definition': return members(F(n, 'body'));
    case 'function_definition': return stmts(F(n, 'body'));
    case 'decorated_definition': return pyContainer(F(n, 'definition'));
    case 'if_statement': return F(n, 'alternative') || named(n).some(c => /elif_clause|else_clause/.test(c.type)) ? null : stmts(F(n, 'consequence'));
    case 'for_statement': case 'while_statement': case 'with_statement': return F(n, 'alternative') ? null : stmts(F(n, 'body'));
    default: return null;
  }
}
function pyKeyOf(n, src) {
  const t = (x) => T(src, x);
  switch (n.type) {
    case 'import_statement': case 'import_from_statement': case 'future_import_statement': return 'import ' + t(n).replace(/^(from|import)\s*/, '');
    case 'class_definition': return 'decl ' + t(F(n, 'name'));
    case 'function_definition': return 'decl ' + t(F(n, 'name')) + '()';
    case 'decorated_definition': return pyKeyOf(F(n, 'definition'), src);
    case 'expression_statement': {
      const e = named(n)[0];
      if (!e) return 'expr ' + t(n);
      if (e.type === 'assignment' || e.type === 'augmented_assignment') return 'set ' + t(F(e, 'left'));
      if (e.type === 'call') return 'call ' + t(F(e, 'function')) + firstLiteral(F(e, 'arguments'), src);
      if (e.type === 'string') return 'doc';
      return 'expr ' + t(n);
    }
    case 'if_statement': return 'if ' + t(F(n, 'condition'));
    case 'for_statement': return 'for ' + t(F(n, 'left')) + ' in ' + t(F(n, 'right'));
    case 'while_statement': return 'while ' + t(F(n, 'condition'));
    case 'with_statement': return 'with ' + t(named(n)[0]);
    case 'return_statement': return 'return';
    default: return n.type + ' ' + t(n);
  }
}

// Java
function javaContainer(n) {
  if (!n) return null;
  switch (n.type) {
    case 'program': case 'block': case 'constructor_body': case 'switch_block_statement_group': return stmts(n);
    case 'class_body': case 'interface_body': case 'annotation_type_body': return members(n);
    case 'enum_body': return named(n).some(c => c.type === 'enum_body_declarations') ? null : members(n, 'prop');
    case 'class_declaration': case 'interface_declaration': case 'enum_declaration': case 'record_declaration': case 'annotation_type_declaration': return javaContainer(F(n, 'body'));
    case 'method_declaration': case 'constructor_declaration': case 'compact_constructor_declaration': return javaContainer(F(n, 'body'));
    case 'if_statement': { const c = F(n, 'consequence'); return !F(n, 'alternative') && c && c.type === 'block' ? stmts(c) : null; }
    case 'for_statement': case 'enhanced_for_statement': case 'while_statement': { const b = F(n, 'body'); return b && b.type === 'block' ? stmts(b) : null; }
    default: return null;
  }
}
function javaKeyOf(n, src) {
  const t = (x) => T(src, x);
  const params = () => { const p = F(n, 'parameters'); return p ? named(p).filter(c => /parameter/.test(c.type)).map(c => t(F(c, 'type'))).join(',') : ''; };
  const decls = () => n.namedChildren.filter(c => c.type === 'variable_declarator').map(d => t(F(d, 'name'))).join(',');
  switch (n.type) {
    case 'package_declaration': return 'package';
    case 'import_declaration': return 'import ' + t(n).replace(/^import\s*/, '').replace(/;$/, '');
    case 'class_declaration': case 'interface_declaration': case 'enum_declaration': case 'record_declaration': case 'annotation_type_declaration': return 'decl ' + t(F(n, 'name'));
    case 'method_declaration': case 'constructor_declaration': return 'decl ' + t(F(n, 'name')) + '(' + params() + ')';
    case 'compact_constructor_declaration': return 'decl ' + t(F(n, 'name'));
    case 'field_declaration': case 'constant_declaration': return 'field ' + decls();
    case 'enum_constant': return 'field ' + t(F(n, 'name'));
    case 'local_variable_declaration': return 'var ' + decls();
    case 'expression_statement': {
      const e = named(n)[0];
      if (!e) return 'expr ' + t(n);
      if (e.type === 'assignment_expression') return 'set ' + t(F(e, 'left'));
      if (e.type === 'update_expression') return 'set ' + t(e).replace(/\+\+|--/g, '');
      if (e.type === 'method_invocation') return 'call ' + (F(e, 'object') ? t(F(e, 'object')) + '.' : '') + t(F(e, 'name')) + firstLiteral(F(e, 'arguments'), src);
      return 'expr ' + t(n);
    }
    case 'explicit_constructor_invocation': return 'call ' + t(n).replace(/\(.*/, '');
    case 'if_statement': return 'if ' + t(F(n, 'condition'));
    case 'for_statement': case 'enhanced_for_statement': case 'while_statement': { const b = F(n, 'body'); return n.type + ' ' + norm(src.slice(n.startIndex, b ? b.startIndex : n.endIndex)); }
    case 'return_statement': return 'return';
    default: return n.type + ' ' + t(n);
  }
}

// TypeScript (and TSX)
function tsContainer(n) {
  if (!n) return null;
  switch (n.type) {
    case 'program': case 'statement_block': return stmts(n);
    case 'class_body': case 'interface_body': case 'object_type': return members(n);
    case 'enum_body': case 'object': return members(n, 'prop');
    case 'array': return named(n).length ? members(n, 'elem') : null;
    case 'function_declaration': case 'generator_function_declaration': case 'function_expression': case 'function': case 'method_definition': return tsContainer(F(n, 'body'));
    case 'public_field_definition': case 'pair': return tsContainer(F(n, 'value')); // handler = () => { … }, key: { … }
    case 'arrow_function': { const b = F(n, 'body'); return b && b.type === 'statement_block' ? stmts(b) : null; }
    case 'class_declaration': case 'abstract_class_declaration': case 'class': case 'interface_declaration': case 'enum_declaration': return tsContainer(F(n, 'body'));
    case 'internal_module': case 'module': return tsContainer(F(n, 'body'));
    case 'export_statement': return tsContainer(F(n, 'declaration'));
    case 'lexical_declaration': case 'variable_declaration': { const d = n.namedChildren.filter(c => c.type === 'variable_declarator'); return d.length === 1 ? tsContainer(F(d[0], 'value')) : null; }
    case 'expression_statement': { const e = named(n)[0]; if (e && e.type === 'assignment_expression') return tsContainer(F(e, 'right')); if (e && e.type === 'call_expression') { const a = named(F(e, 'arguments') || e); const last = a[a.length - 1]; return last && /function|arrow_function|object/.test(last.type) ? tsContainer(last) : null; } return null; }
    case 'if_statement': { const c = F(n, 'consequence'); return !F(n, 'alternative') && c && c.type === 'statement_block' ? stmts(c) : null; }
    case 'for_statement': case 'for_in_statement': case 'while_statement': { const b = F(n, 'body'); return b && b.type === 'statement_block' ? stmts(b) : null; }
    default: return null;
  }
}
function tsKeyOf(n, src) {
  const t = (x) => T(src, x);
  const decls = () => n.namedChildren.filter(c => c.type === 'variable_declarator').map(d => t(F(d, 'name'))).join(',');
  switch (n.type) {
    case 'import_statement': return 'import ' + t(F(n, 'source'));
    case 'export_statement': return F(n, 'declaration') ? 'export ' + tsKeyOf(F(n, 'declaration'), src) : 'export ' + t(n);
    case 'function_declaration': case 'generator_function_declaration': case 'class_declaration': case 'abstract_class_declaration': case 'interface_declaration': case 'type_alias_declaration': case 'enum_declaration': case 'internal_module': case 'module': return 'decl ' + t(F(n, 'name'));
    case 'method_definition': case 'abstract_method_signature': case 'method_signature': case 'public_field_definition': case 'property_signature': return 'field ' + t(F(n, 'name'));
    case 'pair': return 'field ' + t(F(n, 'key'));
    case 'enum_assignment': return 'field ' + t(F(n, 'name'));
    case 'property_identifier': case 'shorthand_property_identifier': return 'field ' + t(n);
    case 'lexical_declaration': case 'variable_declaration': return 'var ' + decls();
    case 'expression_statement': {
      const e = named(n)[0];
      if (!e) return 'expr ' + t(n);
      if (e.type === 'assignment_expression' || e.type === 'augmented_assignment_expression') return 'set ' + t(F(e, 'left'));
      if (e.type === 'update_expression') return 'set ' + t(e).replace(/\+\+|--/g, '');
      if (e.type === 'call_expression' || (e.type === 'await_expression' && named(e)[0] && named(e)[0].type === 'call_expression')) { const c = e.type === 'call_expression' ? e : named(e)[0]; return 'call ' + t(F(c, 'function')) + firstLiteral(F(c, 'arguments'), src); }
      return 'expr ' + t(n);
    }
    case 'if_statement': return 'if ' + t(F(n, 'condition'));
    case 'for_statement': case 'for_in_statement': case 'while_statement': { const b = F(n, 'body'); return n.type + ' ' + norm(src.slice(n.startIndex, b ? b.startIndex : n.endIndex)); }
    case 'return_statement': return 'return';
    default: return n.type + ' ' + t(n);
  }
}

// C++
function cppDeclName(d, src) { // the name inside a declarator: f(int), *p, &r, Cat::run
  while (d && /(function|pointer|reference|array|init|parenthesized)_declarator/.test(d.type)) d = F(d, 'declarator') || named(d)[0];
  return T(src, d);
}
function cppFn(d) { while (d && d.type !== 'function_declarator' && /(pointer|reference|parenthesized)_declarator/.test(d.type)) d = F(d, 'declarator') || named(d)[0]; return d && d.type === 'function_declarator' ? d : null; }
function cppContainer(n) {
  if (!n) return null;
  switch (n.type) {
    case 'translation_unit': case 'compound_statement': return stmts(n);
    case 'declaration_list': case 'field_declaration_list': return members(n);
    case 'enumerator_list': return members(n, 'prop');
    case 'namespace_definition': case 'linkage_specification': return cppContainer(F(n, 'body'));
    case 'preproc_ifdef': case 'preproc_if': { // an include guard (#ifndef X … #endif) holds the whole header
      if (F(n, 'alternative')) return null;
      const skip = new Set([F(n, 'name'), F(n, 'condition')].filter(Boolean).map(x => x.id));
      return { list: named(n).filter(c => !skip.has(c.id)), kind: 'stmt', owner: n };
    }
    case 'class_specifier': case 'struct_specifier': case 'union_specifier': case 'enum_specifier': return cppContainer(F(n, 'body'));
    case 'function_definition': return cppContainer(F(n, 'body'));
    case 'template_declaration': return cppContainer(named(n).filter(c => c.type !== 'template_parameter_list')[0]);
    case 'if_statement': { const c = F(n, 'consequence'); return !F(n, 'alternative') && c && c.type === 'compound_statement' ? stmts(c) : null; }
    case 'for_statement': case 'for_range_loop': case 'while_statement': { const b = F(n, 'body'); return b && b.type === 'compound_statement' ? stmts(b) : null; }
    default: return null;
  }
}
function cppKeyOf(n, src) {
  const t = (x) => T(src, x);
  const params = (fd) => { const p = fd && F(fd, 'parameters'); return p ? named(p).map(c => t(F(c, 'type')) || t(c)).join(',') : ''; };
  const decls = () => n.namedChildren.filter((c, i) => n.fieldNameForChild(n.children.indexOf(c)) === 'declarator').map(d => cppDeclName(d, src)).join(',');
  switch (n.type) {
    case 'preproc_include': return 'import ' + t(F(n, 'path'));
    case 'preproc_def': case 'preproc_function_def': return 'define ' + t(F(n, 'name'));
    case 'preproc_ifdef': case 'preproc_if': return 'ifdef ' + t(F(n, 'name') || F(n, 'condition'));
    case 'using_declaration': case 'alias_declaration': case 'type_definition': return 'using ' + t(n);
    case 'namespace_definition': return 'namespace ' + t(F(n, 'name'));
    case 'class_specifier': case 'struct_specifier': case 'union_specifier': case 'enum_specifier': return 'decl ' + t(F(n, 'name'));
    case 'function_definition': { const fd = cppFn(F(n, 'declarator')); return 'decl ' + cppDeclName(F(n, 'declarator'), src) + '(' + params(fd) + ')'; }
    case 'template_declaration': { const inner = named(n).filter(c => c.type !== 'template_parameter_list')[0]; return inner ? 'template ' + cppKeyOf(inner, src) : 'template ' + t(n); }
    case 'declaration': case 'field_declaration': {
      const d = F(n, 'declarator'), fd = cppFn(d);
      if (fd) return 'proto ' + cppDeclName(d, src) + '(' + params(fd) + ')';
      if (!d) { const ty = F(n, 'type'); return ty && /specifier/.test(ty.type) ? cppKeyOf(ty, src) : n.type + ' ' + t(n); }
      return (n.type === 'field_declaration' ? 'field ' : 'var ') + (decls() || cppDeclName(d, src));
    }
    case 'enumerator': return 'field ' + t(F(n, 'name'));
    case 'access_specifier': return 'access ' + t(n);
    case 'expression_statement': {
      const e = named(n)[0];
      if (!e) return 'expr ' + t(n);
      if (e.type === 'assignment_expression') return 'set ' + t(F(e, 'left'));
      if (e.type === 'update_expression') return 'set ' + t(e).replace(/\+\+|--/g, '');
      if (e.type === 'call_expression') return 'call ' + t(F(e, 'function')) + firstLiteral(F(e, 'arguments'), src);
      return 'expr ' + t(n);
    }
    case 'if_statement': return 'if ' + t(F(n, 'condition'));
    case 'for_statement': case 'for_range_loop': case 'while_statement': { const b = F(n, 'body'); return n.type + ' ' + norm(src.slice(n.startIndex, b ? b.startIndex : n.endIndex)); }
    case 'return_statement': return 'return';
    default: return n.type + ' ' + t(n);
  }
}

// Go
function goContainer(n) {
  if (!n) return null;
  switch (n.type) {
    case 'source_file': case 'statement_list': return stmts(n);
    case 'block': { const l = named(n).find(c => c.type === 'statement_list'); return l ? stmts(l) : null; }
    case 'function_declaration': case 'method_declaration': case 'func_literal': return goContainer(F(n, 'body'));
    case 'type_declaration': { const specs = named(n).filter(c => c.type === 'type_spec'); return specs.length === 1 ? goContainer(F(specs[0], 'type')) : members(n); }
    case 'type_spec': case 'type_alias': return goContainer(F(n, 'type'));
    case 'struct_type': return members(named(n).find(c => c.type === 'field_declaration_list'));
    case 'interface_type': return members(n);
    case 'import_declaration': { const l = named(n).find(c => c.type === 'import_spec_list'); return l ? members(l) : null; }
    case 'const_declaration': case 'var_declaration': { const specs = named(n).filter(c => /_spec$/.test(c.type)); return specs.length > 1 ? members(n) : null; }
    case 'composite_literal': return members(F(n, 'body'), 'prop');
    case 'literal_value': return members(n, 'prop');
    case 'if_statement': return F(n, 'alternative') ? null : goContainer(F(n, 'consequence'));
    case 'for_statement': return goContainer(F(n, 'body'));
    default: return null;
  }
}
function goKeyOf(n, src) {
  const t = (x) => T(src, x);
  const specNames = (x) => named(x).filter(c => /_spec$/.test(c.type)).map(sp => t(F(sp, 'name'))).join(',');
  switch (n.type) {
    case 'package_clause': return 'package';
    case 'import_declaration': { const l = named(n).find(c => c.type === 'import_spec_list'); return l ? 'import group' : 'import ' + t(F(named(n)[0], 'path')); }
    case 'import_spec': return 'import ' + t(F(n, 'path'));
    case 'function_declaration': return 'decl ' + t(F(n, 'name'));
    case 'method_declaration': { const r = F(n, 'receiver'), p = r && named(r)[0]; return 'decl (' + t(p && F(p, 'type')).replace(/^\*/, '') + ') ' + t(F(n, 'name')); }
    case 'type_declaration': return 'decl ' + named(n).filter(c => /type_spec|type_alias/.test(c.type)).map(sp => t(F(sp, 'name'))).join(',');
    case 'type_spec': case 'type_alias': return 'decl ' + t(F(n, 'name'));
    case 'field_declaration': return 'field ' + (n.namedChildren.filter((c, i) => n.fieldNameForChild(n.children.indexOf(c)) === 'name').map(t).join(',') || t(F(n, 'type')));
    case 'method_spec': case 'method_elem': return 'field ' + t(F(n, 'name'));
    case 'const_declaration': case 'var_declaration': return 'var ' + specNames(n);
    case 'const_spec': case 'var_spec': return 'var ' + n.namedChildren.filter((c, i) => n.fieldNameForChild(n.children.indexOf(c)) === 'name').map(t).join(',');
    case 'short_var_declaration': return 'var ' + t(F(n, 'left'));
    case 'assignment_statement': return 'set ' + t(F(n, 'left'));
    case 'inc_statement': case 'dec_statement': return 'set ' + t(n).replace(/\+\+|--/g, '');
    case 'keyed_element': return 'field ' + t(named(n)[0]);
    case 'expression_statement': { const e = named(n)[0]; return e && e.type === 'call_expression' ? 'call ' + t(F(e, 'function')) + firstLiteral(F(e, 'arguments'), src) : 'expr ' + t(n); }
    case 'if_statement': return 'if ' + t(F(n, 'condition'));
    case 'for_statement': { const b = F(n, 'body'); return 'for ' + norm(src.slice(n.startIndex, b ? b.startIndex : n.endIndex)); }
    case 'return_statement': return 'return';
    default: return n.type + ' ' + t(n);
  }
}
const PY = tsLang('py', { container: pyContainer, keyOf: pyKeyOf, isRoot: (n) => n.type === 'module', comment: '#' });
const JAVA = tsLang('java', { container: javaContainer, keyOf: javaKeyOf, isRoot: (n) => n.type === 'program' });
const TSL = tsLang('ts', { container: tsContainer, keyOf: tsKeyOf, isRoot: (n) => n.type === 'program' });
const TSX = tsLang('tsx', { container: tsContainer, keyOf: tsKeyOf, isRoot: (n) => n.type === 'program' });
// C++ quirks: preprocessor lines include their newline, and the ";" after "class X { … }" is a separate token
const cppEnd = (n) => { let e = n.endIndex; const nx = n.nextSibling; if (nx && !nx.isNamed && nx.type === ';' && /specifier$/.test(n.type)) e = nx.endIndex; else if (/^preproc/.test(n.type)) { const tx = n.text; e -= tx.length - tx.replace(/\s+$/, '').length; } return e; };
const CPP = tsLang('cpp', { container: cppContainer, keyOf: cppKeyOf, isRoot: (n) => n.type === 'translation_unit', end: cppEnd });
const GO = tsLang('go', { container: goContainer, keyOf: goKeyOf, isRoot: (n) => n.type === 'source_file' });
const LANGS = { js: JS, cs: CS, py: PY, java: JAVA, ts: TSL, tsx: TSX, cpp: CPP, go: GO };
const EXT = { js: 'js', mjs: 'js', cjs: 'js', cs: 'cs', py: 'py', pyw: 'py', java: 'java', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', jsx: 'tsx', c: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', h: 'cpp', go: 'go' };
function langOf(file) { return EXT[(String(file).split('.').pop() || '').toLowerCase()] || null; }
const canParse = (lang) => !!lang && (lang === 'js' || (LANGS[lang].available ? LANGS[lang].available() : !!TS));

// ---------------------------------------------------------------- the shared structural merge
// labels of statements that are not functions (a change inside them belongs to the function around them)
const CONTROL = /^(if \(|if\b|for|foreach|while|switch|using|lock|catch|return|try|namespace |For|While|DoWhile|Switch|Try|expr )/;
function labelOf(key) {
  const k = key.replace(/#\d+$/, '');
  const m = k.match(/^(decl|var|field|set|call|if|return|export|import|using|namespace|case) ?(.*)$/);
  const label = !m ? k.replace(/^\w+ /, '') : m[1] === 'decl' ? m[2] : m[1] === 'var' ? m[2] : m[1] === 'field' ? 'field ' + m[2] : m[1] === 'set' ? m[2] + ' =' : m[1] === 'call' ? m[2].replace(/\($/, '') + (m[2].includes('(') ? ')' : '()') : m[1] === 'if' ? 'if (' + m[2] + ')' : m[1] === 'using' || m[1] === 'namespace' || m[1] === 'case' ? m[1] + ' ' + m[2] : k;
  const pretty = label.replace(/(===|!==|==|!=|&&|\|\||=>|>=|<=)/g, ' $1 ').replace(/,(?=\S)/g, ', ').replace(/ {2,}/g, ' ');
  return pretty.length > 70 ? pretty.slice(0, 67) + '…' : pretty;
}

// attach comments that sit right before a node, so a comment moves together with its function
const stripComments = (s, L) => (L.comment === '#' ? s.replace(/#[^\n]*/g, '') : s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
// one member of a list; its whitespace-free form is only computed when the raw text differs somewhere
class Item {
  constructor(key, node, start, end, gap, raw, trail) { this.key = key; this.node = node; this.start = start; this.end = end; this.gap = gap; this.raw = raw; this.trail = trail || ''; this._n = null; }
  get norm() { if (this._n === null) this._n = norm(this.raw); return this._n; }
}
const same = (x, y) => x.raw === y.raw || (x.raw.length < 65536 && y.raw.length < 65536 && x.norm === y.norm);
function items(c, src, L) {
  const seen = {}, itemEnds = [], trails = [];
  return c.list.map((n, idx) => {
    const ns = L.start(n);
    let start = ns, ne = L.end(n);
    // a comment at the end of the item's last line belongs to the item ("#endif // DIRECTX", "x = 1; // why")
    const tail = src.slice(ne, ne + 400).match(L.comment === '#' ? /^[ \t]*#[^\n]*/ : /^[ \t]*(?:\/\/[^\n]*|\/\*[^\n]*?\*\/[ \t]*(?=\n|$))/);
    // (not for the last item: what follows it is kept with the text after the list)
    if (tail && idx + 1 < c.list.length && L.start(c.list[idx + 1]) >= ne + tail[0].length) ne += tail[0].length;
    // in a list with commas ({ a: 1, // why }), the comment after the comma belongs to the item before it
    let trail = '';
    if ((c.kind === 'prop' || c.kind === 'elem') && idx + 1 < c.list.length) {
      const t = src.slice(ne, L.start(c.list[idx + 1])).match(L.comment === '#' ? /^[ \t]*,[ \t]*(#[^\n]*)/ : /^[ \t]*,[ \t]*(\/\/[^\n]*|\/\*[^\n]*?\*\/(?=[ \t]*\n))/);
      if (t) { trail = ' ' + t[1]; trails[idx] = t[0].length; }
    }
    const prevEnd = idx ? itemEnds[idx - 1] : null;
    itemEnds[idx] = ne;
    {
      // take whole comment lines just above the node
      const before = src.slice(prevEnd == null ? Math.max(0, src.lastIndexOf('\n', ns - 1) + 1) : prevEnd, ns);
      const m = before.match(L.comment === '#' ? /((?:[ \t]*#[^\n]*\n)+)[ \t]*$/ : /((?:[ \t]*\/\/[^\n]*\n|[ \t]*\/\*[\s\S]*?\*\/[ \t]*\n)+)[ \t]*$/);
      // only comments on their own lines belong to the next item (a comment at the end of the previous line stays there)
      let own = m ? m[0] : '';
      if (m && prevEnd != null && !before.slice(0, m.index).includes('\n')) { const nl = own.indexOf('\n'); own = nl >= 0 ? own.slice(nl + 1) : ''; if (!/\S/.test(own)) own = ''; }
      if (own && (prevEnd != null || !L.isRoot(c.owner))) start = ns - own.length + (own.length - own.trimStart().length);
    }
    let k = L.keyOf(n, src); seen[k] = (seen[k] || 0) + 1; if (seen[k] > 1) k += '#' + seen[k];
    const gap = prevEnd == null ? '' : (trails[idx - 1] ? src.slice(prevEnd, prevEnd + trails[idx - 1]).replace(/[ \t]*(\/\/|\/\*|#)[\s\S]*$/, '') + src.slice(prevEnd + trails[idx - 1], start) : src.slice(prevEnd, start)).replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n'); // up to two blank lines, as written (Python likes two)
    return new Item(k, n, start, ne, gap, src.slice(start, ne), trail);
  });
}

function lineStartCol(src, pos) { const ls = src.lastIndexOf('\n', pos - 1) + 1; return src.slice(ls, pos); }

// merge one node that both sides have; returns { raw, who }
function mergeNode(path, O, A, B, ctx) {
  if (same(A, B)) return { raw: A.raw, who: O && same(O, A) ? null : 'both' };
  if (O && same(A, O)) return { raw: B.raw, who: 'B' };
  if (O && same(B, O)) return { raw: A.raw, who: 'A' };
  // both changed it differently: look inside if all three hold a list (a function body, an object, a class)
  const L = ctx.L;
  const cA = L.container(A.node), cB = L.container(B.node), cO = O ? L.container(O.node) : null;
  if (cA && cB && (!O || cO) && cA.kind === cB.kind && (!cO || cO.kind === cA.kind) && cA.list.length && cB.list.length && (!cO || cO.list.length)) {
    const region = (c) => ({ s: L.start(c.list[0]), e: L.end(c.list[c.list.length - 1]) });
    const rA = region(cA), rB = region(cB), rO = cO ? region(cO) : null;
    const head = (it, r, src) => norm(src.slice(it.start, r.s) + '\u0001' + src.slice(r.e, it.end));
    const hA = head(A, rA, ctx.a), hB = head(B, rB, ctx.b), hO = O ? head(O, rO, ctx.o) : undefined;
    let headSide = null;
    if (hA === hB || hB === hO) headSide = 'A'; else if (hA === hO) headSide = 'B';
    if (headSide) {
      const merged = mergeLists(path, cO ? items(cO, ctx.o, L) : [], items(cA, ctx.a, L), items(cB, ctx.b, L), ctx, cA.kind);
      const H = headSide === 'A' ? A : B, r = headSide === 'A' ? rA : rB, src = headSide === 'A' ? ctx.a : ctx.b;
      const firstItem = (headSide === 'A' ? cA : cB).list;
      const indent = lineStartCol(src, L.start(firstItem[0])).match(/^\s*/)[0];
      const comma = cA.kind === 'prop' || cA.kind === 'elem' ? ',' : '';
      let sep = null;
      for (const [c, s2] of [[headSide === 'A' ? cA : cB, src], [cA, ctx.a], [cB, ctx.b], [cO, ctx.o]]) {
        if (sep || !c || c.list.length < 2) continue;
        sep = stripComments(s2.slice(L.end(c.list[0]), L.start(c.list[1])), L).replace(/\n(?:[ \t]*\n){2,}\s*/g, '\n\n\n').replace(/\n[ \t]*\n(?![ \t]*\n)\s*/g, '\n\n').replace(/[ \t]+$/, '');
        sep = /\n/.test(sep) ? sep.replace(/\n[ \t]*$/, '\n') + indent : comma + ' ';
      }
      if (!sep) sep = /\n/.test(src.slice(H.start, H.end).slice(r.s - H.start, r.e - H.start) + src.slice(r.e, H.end).split('\n')[0]) || /\n/.test(src.slice(r.s, r.e)) ? comma + '\n' + indent : comma + ' ';
      if (!sep.trim() && comma) sep = comma + sep;
      const multi = /\n/.test(sep);
      const body = merged.map((m, i) => {
        if (!i) return m.raw + (m.after || '');
        let g = multi && m.gap && /\n/.test(m.gap) ? m.gap.replace(/\n[ \t]*$/, '\n') + indent : sep;
        if (comma && !g.includes(',')) g = ',' + g;
        const tr = merged[i - 1].trail;
        if (tr && multi) g = g.startsWith(',') ? ',' + tr + g.slice(1) : tr + g;
        if (L.comment !== '#' && m.raw.startsWith('#') && /\n[ \t]+$/.test(g)) g = g.replace(/[ \t]+$/, ''); // #if, #region… start at the line's beginning
        return g + m.raw + (m.after || '');
      }).join('');
      return { raw: src.slice(H.start, r.s) + body + src.slice(r.e, H.end), who: 'mixed' };
    }
  }
  // both changed this piece and its parts can't be merged one by one (a statement, an #if block…): when the two
  // edits touch different lines of it, merge it line by line, like git would inside this piece
  if (O && O.raw && A.raw.length + B.raw.length < 200000) {
    const lm = lineMerge(O.raw, A.raw, B.raw);
    if (!lm.tooBig && !lm.conflicts.length && typeof lm.template === 'string') return { raw: lm.template, who: 'mixed' };
    // still clashing on the same lines: for a small piece, try word by word (one renamed a name, the other changed an
    // argument on the same line: different words, so both edits fit)
    const tm = tokenMerge(O.raw, A.raw, B.raw);
    if (tm != null) return { raw: tm, who: 'mixed' };
  }
  const id = ctx.conflicts.length;
  ctx.conflicts.push({ id, label: path.join(' → ') || 'the whole file', base: O ? O.raw : '', a: A.raw, b: B.raw });
  return { raw: `\u0000C${id}\u0000`, who: 'conflict' };
}

// An item one side changed so much that its key changed (a renamed function, a statement keyed by its text) looks like
// "deleted the old one, added a new one". If both sides do that, both new items would be kept: a silent duplicate.
// So first pair every original item a side no longer has with that side's new item in the same place, when they are
// the same kind of thing and mostly the same text: that is an edit, merged (or reported as a conflict) like any other.
function similarity(x, y) { // Dice coefficient on the lines (fast, order-free)
  const a = x.split('\n').map(l => l.trim()).filter(Boolean), b = y.split('\n').map(l => l.trim()).filter(Boolean);
  if (!a.length || !b.length) return x.trim() === y.trim() ? 1 : 0;
  if (a.length === 1 && b.length === 1) { const p = norm(a[0]), q = norm(b[0]); const big = (t) => { const m = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }; const ma = big(p), mb = big(q); let common = 0; for (const [g, c] of ma) common += Math.min(c, mb.get(g) || 0); return (2 * common) / Math.max(1, p.length - 1 + q.length - 1); }
  const m = new Map(); for (const l of a) m.set(l, (m.get(l) || 0) + 1);
  let common = 0; for (const l of b) { const c = m.get(l); if (c) { common++; m.set(l, c - 1); } }
  return (2 * common) / (a.length + b.length);
}
const kindOf = (key) => key.replace(/#\d+$/, '').split(' ')[0];
function rekey(Ol, Xl) {
  const inO = new Set(Ol.map(x => x.key)), inX = new Set(Xl.map(x => x.key));
  if (Ol.every(o => inX.has(o.key))) return Xl; // nothing lost: nothing to pair (the usual case)
  const posX = new Map(Xl.map((x, k) => [x.key, k])); // keys are unique within a list (repeats get #2, #3…)
  const out = Xl.slice();
  // walk both lists between the items they share; inside each gap, pair lost originals with new items
  let i = 0, j = 0;
  while (i <= Ol.length && j <= Xl.length) {
    let i2 = i; while (i2 < Ol.length && !inX.has(Ol[i2].key)) i2++;
    let j2 = j; while (j2 < Xl.length && !inO.has(Xl[j2].key)) j2++;
    const lost = Ol.slice(i, i2), fresh = []; for (let k = j; k < j2; k++) fresh.push(k);
    for (const o of lost) {
      const sameKind = fresh.filter(k => !out[k].paired && kindOf(out[k].key) === kindOf(o.key));
      const lostOfKind = lost.filter(x => kindOf(x.key) === kindOf(o.key)).length;
      let best = -1, bestSim = 0.5;
      if (sameKind.length === 1 && lostOfKind === 1) best = sameKind[0]; // one went, one of the same kind came, in the same spot: an edit
      else for (const k of sameKind) { const sim = similarity(o.raw, out[k].raw); if (sim > bestSim) { bestSim = sim; best = k; } }
      if (best >= 0) { const x = out[best]; const y = new Item(o.key, x.node, x.start, x.end, x.gap, x.raw); y.paired = true; out[best] = y; }
    }
    if (i2 >= Ol.length || j2 >= Xl.length) break;
    // move past the shared item (find where it is on the other side)
    const at = posX.get(Ol[i2].key);
    i = i2 + 1; j = at !== undefined && at >= j2 ? at + 1 : j2 + 1;
  }
  return out;
}
function mergeLists(path, Ol, Al0, Bl0, ctx, kind) {
  const Al = rekey(Ol, Al0), Bl = rekey(Ol, Bl0);
  const byO = new Map(Ol.map(x => [x.key, x])), byA = new Map(Al.map(x => [x.key, x])), byB = new Map(Bl.map(x => [x.key, x]));
  const out = [];
  const fn = kind === 'stmt' ? [...path].reverse().find(x => !CONTROL.test(x)) : null; // the function this list of statements is in
  const note = (who, key, what) => { if (who !== 'A' && who !== 'B') return; const lab = labelOf(key); const t = `${what} ${lab}${kind === 'stmt' && fn && fn !== lab ? ' in ' + fn : ''}`.trim(); if (!ctx.changes[who].includes(t)) ctx.changes[who].push(t); };
  // a comment block standing on its own above a removed item (with a blank line between) isn't part of it:
  // keep it, in front of the next item
  let carry = '';
  const keep = (gap) => { if (!carry) return gap; const g = carry.replace(/\s+$/, '') + gap; carry = ''; return g; };
  const dropped = (x) => { if (x.gap && stripComments(x.gap, ctx.L) !== x.gap) carry = carry ? carry.replace(/\s+$/, '') + x.gap : x.gap; };
  // walk A's order; then place B-only items after their neighbour in B
  for (const a of Al) {
    const o = byO.get(a.key), b = byB.get(a.key);
    if (b) {
      const r = mergeNode([...path, labelOf(a.key)], o, a, b, ctx);
      if (r.who === 'A' || r.who === 'B') note(r.who, a.key, o ? 'changed' : 'added');
      out.push({ key: a.key, raw: r.raw, gap: keep(a.gap), trail: a.trail || (byB.get(a.key) || {}).trail || '' });
    } else if (o) { // B deleted it
      if (same(a, o)) { note('B', a.key, 'removed'); dropped(a); continue; }
      const id = ctx.conflicts.length;
      ctx.conflicts.push({ id, label: [...path, labelOf(a.key)].join(' → '), base: o.raw, a: a.raw, b: '', note: 'Developer B removed this, Developer A changed it.' });
      out.push({ key: a.key, raw: `\u0000C${id}\u0000`, gap: keep(a.gap), trail: a.trail });
    } else { note('A', a.key, 'added'); out.push({ key: a.key, raw: a.raw, gap: keep(a.gap), trail: a.trail }); }
  }
  if (carry && out.length) out[out.length - 1].after = carry.replace(/\s+$/, ''); // the removed item was the last one
  for (let i = 0; i < Bl.length; i++) {
    const b = Bl[i];
    if (byA.has(b.key)) continue;
    const o = byO.get(b.key);
    let raw;
    if (o) { // A deleted it
      if (same(b, o)) { note('A', b.key, 'removed'); continue; }
      const id = ctx.conflicts.length;
      ctx.conflicts.push({ id, label: [...path, labelOf(b.key)].join(' → '), base: o.raw, a: '', b: b.raw, note: 'Developer A removed this, Developer B changed it.' });
      raw = `\u0000C${id}\u0000`;
    } else { note('B', b.key, 'added'); raw = b.raw; }
    // after the nearest earlier B item that is already placed
    let at = -1;
    for (let p = i - 1; p >= 0 && at < 0; p--) at = out.findIndex(x => x.key === Bl[p].key);
    if (at < 0 && i + 1 < Bl.length) { // or before the next one
      let nxt = -1; for (let p = i + 1; p < Bl.length && nxt < 0; p++) nxt = out.findIndex(x => x.key === Bl[p].key);
      out.splice(nxt < 0 ? out.length : nxt, 0, { key: b.key, raw, gap: b.gap, trail: b.trail });
    } else {
      while (at + 1 < out.length && out[at + 1].fromB) at++;
      out.splice(at + 1, 0, { key: b.key, raw, gap: b.gap, trail: b.trail, fromB: true });
    }
  }
  return out;
}

function astMerge(base, a, b, lang = 'js') {
  const L = LANGS[lang];
  const ctx = { o: base, a, b, conflicts: [], changes: { A: [], B: [] }, L };
  const trees = {};
  for (const [side, src] of [['base', base], ['A', a], ['B', b]]) {
    try { trees[side] = L.parse(src, side === 'base' || !trees.base || !trees.base.__tree ? null : { src: base, tree: trees.base.__tree }); }
    catch (e) { return { error: { side, line: e.loc ? e.loc.line : e.line || null, message: String(e.message || e).replace(/\s*\(\d+:\d+\)$/, '') } }; }
  }
  const whole = (t, src) => new Item('', t, 0, src.length, '', src);
  const r = mergeNode([], whole(trees.base, base), whole(trees.A, a), whole(trees.B, b), ctx);
  return { template: r.raw, conflicts: ctx.conflicts, changes: ctx.changes };
}
function astMergeFree(base, a, b, lang) { try { return astMerge(base, a, b, lang); } finally { freeTrees(); } }

// what one side changed, by name (for files only one developer touched): "added Dash()", "changed field Speed"
function describe(file, base, side) {
  const lang = langOf(file); if (!canParse(lang)) return null;
  const L = LANGS[lang], out = [];
  let tb, ts; try { tb = L.parse(base); ts = L.parse(side); } catch (e) { freeTrees(); return null; }
  try { return describeTrees(L, tb, ts, base, side, out); } finally { freeTrees(); }
}
function describeTrees(L, tb, ts, base, side, out) {
  const walk = (nb, ns, srcB, srcS, depth, fn) => {
    const cb = L.container(nb), cs = L.container(ns);
    if (!cb || !cs || cb.kind !== cs.kind || depth > 6) return false;
    const ib = items(cb, srcB, L), is = items(cs, srcS, L), byB = new Map(ib.map(x => [x.key, x])), byS = new Map(is.map(x => [x.key, x]));
    const inFn = (lab) => (cb.kind === 'stmt' && fn && fn !== lab ? ' in ' + fn : ''); // name the function a statement-level change is in
    for (const x of is) {
      const o = byB.get(x.key), lab = labelOf(x.key);
      const isFn = !CONTROL.test(lab) && (/\(/.test(lab) || (L.container(x.node) || {}).kind === 'stmt');
      if (!o) out.push('added ' + lab + inFn(lab));
      else if (!same(o, x) && !walk(o.node, x.node, srcB, srcS, depth + 1, isFn ? lab : fn)) out.push('changed ' + lab + inFn(lab));
    }
    for (const o of ib) if (!byS.has(o.key)) out.push('removed ' + labelOf(o.key) + inFn(labelOf(o.key)));
    return true;
  };
  walk(tb, ts, base, side, 0, null);
  return [...new Set(out)];
}

// put the chosen text into each conflict's place
function fill(template, conflicts) {
  return template.replace(/\u0000C(\d+)\u0000/g, (_, i) => { const c = conflicts[+i]; return c.pick === 'A' ? c.a : c.pick === 'B' ? c.b : c.pick === 'custom' ? c.custom : `\u0000C${i}\u0000`; });
}

// who wrote each line of the merged file: compare with each side's own changes against the base
function authorLines(base, a, b, merged) {
  const O = base.split('\n').map(s => s.trim());
  const added = (x) => { const X = x.split('\n').map(s => s.trim()), m = diffMap(X, O); return new Set(X.filter((l, i) => m[i] === -1 && l)); };
  const fromA = added(a), fromB = added(b), baseSet = new Set(O);
  return merged.split('\n').map((l) => { const t = l.trim(); if (!t || /^[\s{}()[\];,]*$/.test(t) || baseSet.has(t) && !fromA.has(t) && !fromB.has(t)) return null; const inA = fromA.has(t), inB = fromB.has(t); return inA && !inB ? 'A' : inB && !inA ? 'B' : inA && inB ? 'both' : null; });
}

// the full merge: try the structure first (JavaScript, C#), fall back to lines for other files
const crypto = require('crypto');
const MEMO = new Map(), MEMO_MAX = 300;
const h = (s) => crypto.createHash('sha1').update(s).digest('hex');
function merge(file, base, a, b) {
  const key = h(file + '\u0000' + h(base) + h(a) + h(b));
  const hit = MEMO.get(key);
  if (hit) { MEMO.delete(key); MEMO.set(key, hit); return structuredClone(hit); }
  const res = mergeOnce(file, base, a, b);
  MEMO.set(key, res); if (MEMO.size > MEMO_MAX) MEMO.delete(MEMO.keys().next().value);
  return structuredClone(res);
}
// a file that starts with a byte-order mark (Visual Studio saves C# files like that): merge without it and put one
// back at the start, otherwise the mark sticks to whatever comes first and gets copied onto moved lines
function mergeOnce(file, base, a, b) {
  const BOM = '\uFEFF', has = [base, a, b].some(x => x.startsWith(BOM));
  if (!has) return mergeBare(file, base, a, b);
  const strip = (x) => (x.startsWith(BOM) ? x.slice(1) : x);
  const res = mergeBare(file, strip(base), strip(a), strip(b));
  if ((a.startsWith(BOM) || b.startsWith(BOM)) && typeof res.template === 'string') res.template = BOM + res.template;
  return res;
}
function mergeBare(file, base, a, b) {
  const line = lineMerge(base, a, b);
  const res = { file, lineConflicts: line.tooBig ? null : line.conflicts.length, method: 'lines', template: line.template, conflicts: line.conflicts, changes: null, error: null };
  const lang = langOf(file);
  if (canParse(lang)) {
    const ast = astMergeFree(base, a, b, lang);
    res.language = LANGS[lang].name;
    if (ast.error) res.error = ast.error;
    else Object.assign(res, { method: 'ast', template: ast.template, conflicts: ast.conflicts, changes: ast.changes });
  }
  return res;
}

module.exports = { merge, fill, authorLines, lineMerge, astMerge: astMergeFree, myers, parse, ready, prepare, prepareAll, langOf, describe, diffMap };
