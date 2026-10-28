// Code browser back end: the decompiled sources (jadx) and decoded resources
// (apktool) as browsable roots, syntax-highlighted file reading, and search
// in a worker thread.

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const hljs = require('highlight.js/lib/core');

for (const lang of ['java', 'kotlin', 'xml', 'json', 'properties', 'ini', 'yaml', 'javascript', 'css', 'plaintext']) {
  hljs.registerLanguage(lang, require(`highlight.js/lib/languages/${lang}`));
}
const LANG = { java: 'java', kt: 'kotlin', xml: 'xml', html: 'xml', json: 'json', properties: 'properties', pro: 'properties',
  ini: 'ini', cfg: 'ini', yml: 'yaml', yaml: 'yaml', js: 'javascript', css: 'css' };

const MAX_HIGHLIGHT = 400 * 1024;
const MAX_TEXT = 3 * 1024 * 1024;

function roots(ws) {
  return [
    { id: 'java', label: 'Java sources', sub: 'decompiled by jadx', dir: path.join(ws, 'jadx', 'sources') },
    { id: 'res', label: 'Manifest & resources', sub: 'decoded by apktool', dir: path.join(ws, 'apktool'), skip: ['original', 'build', 'unknown'] },
  ].filter(r => fs.existsSync(r.dir));
}

function resolve(ws, rootId, rel = '') {
  const root = roots(ws).find(r => r.id === rootId);
  if (!root) return null;
  const p = path.resolve(root.dir, String(rel || ''));
  return p === root.dir || p.startsWith(root.dir + path.sep) ? { root, p } : null;
}

function listDir(ws, rootId, rel) {
  const r = resolve(ws, rootId, rel);
  if (!r || !fs.existsSync(r.p)) return [];
  return fs.readdirSync(r.p, { withFileTypes: true })
    .filter(d => !(rel === '' && r.root.skip?.includes(d.name)))
    .map(d => ({ name: d.name, dir: d.isDirectory(), size: d.isDirectory() ? 0 : fs.statSync(path.join(r.p, d.name)).size }))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
}

function readFile(ws, rootId, rel) {
  const r = resolve(ws, rootId, rel);
  if (!r || !fs.existsSync(r.p) || !fs.statSync(r.p).isFile()) return { error: 'File not found' };
  const size = fs.statSync(r.p).size;
  const buf = fs.readFileSync(r.p).subarray(0, MAX_TEXT);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size };
  const text = buf.toString('utf8');
  const ext = (rel.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  const lang = LANG[ext] || 'plaintext';
  // hljs escapes the source text; only its own <span> markup is HTML.
  const html = text.length <= MAX_HIGHLIGHT ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : null;
  return { text: html ? null : text, html, lang, size, lines: text.split('\n').length, truncated: size > MAX_TEXT, highlighted: !!html };
}

const searches = new Map();
let nextId = 1;

// Starts a search; onMessage receives { hits } batches and a final { done } or { error }.
function startSearch(ws, { query, mode = 'text', regex = false, caseSensitive = false }, onMessage) {
  const id = nextId++;
  const worker = new Worker(path.join(__dirname, 'codeworker.js'), {
    workerData: { roots: roots(ws).map(({ id: rid, dir, skip }) => ({ id: rid, dir, skip })), query, mode, regex, caseSensitive },
  });
  searches.set(id, worker);
  worker.on('message', m => onMessage(id, m));
  worker.on('error', err => onMessage(id, { error: err.message }));
  worker.on('exit', () => searches.delete(id));
  return id;
}

function cancelSearch(id) {
  const w = searches.get(id);
  if (w) w.terminate();
}

module.exports = { roots, listDir, readFile, startSearch, cancelSearch };
