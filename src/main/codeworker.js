// Worker thread: searches the decompiled code and decoded resources so the
// window stays responsive. Posts { hits } batches, then { done }.

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const TEXT_EXT = /\.(java|kt|smali|xml|json|txt|properties|yml|yaml|js|html|css|csv|pro|cfg|ini|gradle)$/i;
const MAX_FILE = 4 * 1024 * 1024;

const { roots, query, mode, regex, caseSensitive, limit = 2000, patterns } = workerData;

function* walk(dir, rel = '') {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  names.sort((a, b) => a.name.localeCompare(b.name));
  for (const d of names) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) yield* walk(path.join(dir, d.name), r);
    else yield [path.join(dir, d.name), r];
  }
}

// Pattern scan (release audit): every pattern over every text file, capped per pattern.
if (patterns) {
  const res = patterns.map(p => ({ ...p, re: new RegExp(p.re, p.flags || ''), found: [] }));
  let scanned = 0;
  for (const root of roots) {
    for (const [full, rel] of walk(root.dir)) {
      if (root.skip && root.skip.some(s => rel === s || rel.startsWith(`${s}/`))) continue;
      if (!TEXT_EXT.test(rel)) continue;
      let text;
      try {
        if (fs.statSync(full).size > MAX_FILE) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      scanned++;
      for (const p of res) {
        if (p.found.length >= (p.max || 200) || !p.re.test(text)) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && p.found.length < (p.max || 200); i++) {
          const m = p.re.exec(lines[i]);
          if (!m || (p.exclude && new RegExp(p.exclude, 'i').test(m[0]))) continue;
          p.found.push({ root: root.id, file: rel, line: i + 1, match: m[0].slice(0, 160), text: lines[i].trim().slice(0, 220) });
        }
      }
    }
  }
  parentPort.postMessage({ done: true, scanned, results: Object.fromEntries(res.map(p => [p.id, p.found])) });
  return; // CommonJS module: ends the worker after the message is sent
}

let matcher;
try {
  if (mode === 'file' || !regex) {
    const q = caseSensitive ? query : query.toLowerCase();
    matcher = s => (caseSensitive ? s : s.toLowerCase()).indexOf(q);
  } else {
    const re = new RegExp(query, caseSensitive ? '' : 'i');
    matcher = s => { const m = re.exec(s); return m ? m.index : -1; };
  }
} catch (err) {
  parentPort.postMessage({ error: `Invalid search: ${err.message}` });
  return; // CommonJS module: ends the worker after the message is sent
}

let hits = 0;
let files = 0;
let batch = [];
const flush = () => { if (batch.length) { parentPort.postMessage({ hits: batch }); batch = []; } };

outer:
for (const root of roots) {
  for (const [full, rel] of walk(root.dir)) {
    if (root.skip && root.skip.some(s => rel === s || rel.startsWith(`${s}/`))) continue;
    files++;
    if (mode === 'file') {
      if (matcher(rel) >= 0) {
        batch.push({ root: root.id, file: rel });
        if (++hits >= limit) break outer;
      }
      continue;
    }
    if (!TEXT_EXT.test(rel)) continue;
    let text;
    try {
      if (fs.statSync(full).size > MAX_FILE) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch { continue; }
    if (matcher(text) < 0) continue; // quick reject before splitting lines
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const col = matcher(lines[i]);
      if (col < 0) continue;
      const line = lines[i];
      const start = Math.max(0, col - 60);
      batch.push({ root: root.id, file: rel, line: i + 1, col, text: (start ? '…' : '') + line.slice(start, start + 200).trimEnd() });
      if (++hits >= limit) break outer;
    }
    if (batch.length >= 100) flush();
  }
}
flush();
parentPort.postMessage({ done: true, files, hits, truncated: hits >= limit });
