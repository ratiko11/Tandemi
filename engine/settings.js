// settings.js · Tandemi's settings, saved in its data folder, so the app and every browser see the same ones.
'use strict';
const fs = require('fs');
const path = require('path');

const MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'Balanced: good fixes, quick. The default.' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'The strongest. Slower, and costs more per fix.' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'The fastest and cheapest, for simple fixes.' },
];
const DEFAULTS = { prAuto: false, prComment: true, prRepo: '', aiVia: 'auto', theme: 'system', style: 'arcade', celebrate: true, mode: 'auto', model: 'claude-sonnet-5-5', shareOnNetwork: true, requireSignIn: false, allowRegister: false };
// what each setting may be: anything else is refused, so a bad request can't break Tandemi
const CHECK = {
  prAuto: v => typeof v === 'boolean',
  prComment: v => typeof v === 'boolean',
  prRepo: v => typeof v === 'string' && (v === '' || /^[\w.-]+\/[\w.-]+$/.test(v)),
  aiVia: v => ['auto', 'key', 'claude-code'].includes(v),
  theme: v => ['system', 'light', 'dark'].includes(v),
  style: v => ['arcade', 'calm'].includes(v),
  celebrate: v => typeof v === 'boolean',
  mode: v => ['auto', 'report'].includes(v),
  model: v => MODELS.some(m => m.id === v),
  shareOnNetwork: v => typeof v === 'boolean',
  requireSignIn: v => typeof v === 'boolean',
  allowRegister: v => typeof v === 'boolean',
};
let FILE = null, S = null;
function init(dataDir, legacy = {}) {
  FILE = path.join(dataDir, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first start */ }
  // tandemi.config.json from before the settings page still counts until someone changes it here
  const fromConfig = {}; if (legacy.shareOnNetwork === false) fromConfig.shareOnNetwork = false; if (legacy.model && MODELS.some(m => m.id === legacy.model)) fromConfig.model = legacy.model;
  S = { ...DEFAULTS, ...fromConfig };
  for (const [k, v] of Object.entries(saved)) if (CHECK[k] && CHECK[k](v)) S[k] = v;
  return S;
}
const get = () => ({ ...S });
function set(changes) {
  const bad = Object.keys(changes || {}).filter(k => !CHECK[k] || !CHECK[k](changes[k]));
  if (bad.length) throw new Error(`Not a valid setting: ${bad.join(', ')}.`);
  Object.assign(S, changes);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(S, null, 2));
  return get();
}
module.exports = { init, get, set, MODELS, DEFAULTS };
