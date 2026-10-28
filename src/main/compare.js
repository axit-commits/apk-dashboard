// Compares two processed apps (usually two versions of one app): versions and
// SDK levels, signing key, size breakdown, permissions, components, SDKs,
// native libraries, files, decompiled classes, game assets and audit findings.
// Runs inside compareworker.js so the window stays responsive.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { listEntries } = require('./zipindex');
const { readSigning } = require('./signing');
const { getAudit, apkFiles, SENSITIVE } = require('./audit');
const { hunks } = require('./linediff');

const COMPARE_VERSION = 1;
const MAX_LIST = 5000;

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Every file of the app: from the APK(s) when available (with CRCs), else the inventory.
function entriesOf(ws, meta) {
  const apks = apkFiles(ws, meta);
  const map = new Map();
  if (apks.length) {
    for (const apk of apks) {
      for (const e of listEntries(apk)) {
        if (e.name.endsWith('/')) continue;
        const prev = map.get(e.name);
        if (!prev || e.size > prev.size) map.set(e.name, { path: e.name, size: e.size, packed: e.compressedSize, crc: e.crc });
      }
    }
    return { map, exact: true };
  }
  for (const e of readJson(path.join(ws, 'game', 'inventory.json')) || []) {
    if (!map.has(e.path)) map.set(e.path, { path: e.path, size: e.size, packed: e.packed ?? e.size, crc: null });
  }
  return { map, exact: false };
}

const kindOf = p => (/^classes\d*\.dex$/.test(p) ? 'Code (DEX)'
  : /^lib\//.test(p) ? 'Native libraries'
    : /^res\/|^resources\.arsc$|^AndroidManifest\.xml$/.test(p) ? 'Resources'
      : /^assets\//.test(p) ? 'Assets'
        : 'Other');

function sizeBreakdown(map) {
  const out = {};
  for (const e of map.values()) {
    const k = kindOf(e.path);
    out[k] = out[k] || { size: 0, packed: 0, files: 0 };
    out[k].size += e.size;
    out[k].packed += e.packed;
    out[k].files++;
  }
  return out;
}

// Decompiled classes: relative path -> hash of the source, ignoring jadx's own comments.
function classHashes(ws) {
  const root = path.join(ws, 'jadx', 'sources');
  const out = new Map();
  const walk = (dir, rel) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(dir, d.name), r);
      else if (d.name.endsWith('.java')) {
        const text = fs.readFileSync(path.join(dir, d.name), 'utf8').replace(/^\s*\/\* JADX (INFO|WARNING|DEBUG):[^\n]*\*\/\s*$/gm, '');
        out.set(r, crypto.createHash('sha1').update(text).digest('hex'));
      }
    }
  };
  walk(root, '');
  return out;
}

// Library / SDK name for a class path, or null for app or obfuscated code.
function sdkOf(rel, ownPrefix) {
  if (ownPrefix && rel.startsWith(`${ownPrefix}/`)) return null;
  const parts = rel.split('/');
  if (parts.length < 3) return null; // top-level or single-letter obfuscated packages
  const depth = parts[0] === 'com' && (parts[1] === 'google' || parts[1] === 'facebook') ? (parts[2] === 'android' ? 4 : 3) : 2;
  if (parts.length <= depth) return null;
  const name = parts.slice(0, depth).join('.');
  if (parts.slice(0, depth).some(p => p.length <= 1)) return null;
  return name;
}

function components(o) {
  return new Map((o?.components || []).map(c => [`${c.type}:${c.name}`, c]));
}

function delta(a, b) {
  return (b || 0) - (a || 0);
}

function compareWorkspaces(wsA, wsB, progress = () => {}) {
  const metaA = readJson(path.join(wsA, 'meta.json')) || {};
  const metaB = readJson(path.join(wsB, 'meta.json')) || {};
  const oA = metaA.overview || {};
  const oB = metaB.overview || {};
  const result = { version: COMPARE_VERSION, generated: new Date().toISOString(),
    a: { sha: path.basename(wsA), name: oA.appName, package: oA.package, versionName: oA.versionName, versionCode: oA.versionCode, file: metaA.inputPath ? path.basename(metaA.inputPath) : null },
    b: { sha: path.basename(wsB), name: oB.appName, package: oB.package, versionName: oB.versionName, versionCode: oB.versionCode, file: metaB.inputPath ? path.basename(metaB.inputPath) : null },
    samePackage: !!oA.package && oA.package === oB.package };

  progress('Reading signatures');
  const apksA = apkFiles(wsA, metaA);
  const apksB = apkFiles(wsB, metaB);
  const sigA = apksA.length ? readSigning(apksA[0]) : null;
  const sigB = apksB.length ? readSigning(apksB[0]) : null;
  result.signing = {
    a: sigA?.cert ? { sha256: sigA.cert.sha256, subject: sigA.cert.subject, schemes: sigA.schemes } : null,
    b: sigB?.cert ? { sha256: sigB.cert.sha256, subject: sigB.cert.subject, schemes: sigB.schemes } : null,
  };
  result.signing.same = result.signing.a && result.signing.b ? result.signing.a.sha256 === result.signing.b.sha256 : null;

  progress('Comparing the manifest');
  const permsA = new Map((oA.permissions || []).map(p => [p.name, p]));
  const permsB = new Map((oB.permissions || []).map(p => [p.name, p]));
  const permInfo = (name, p) => ({ name, dangerous: !!p?.dangerous, meaning: p?.meaning || '', play: SENSITIVE[name] || null });
  result.permissions = {
    added: [...permsB.keys()].filter(n => !permsA.has(n)).map(n => permInfo(n, permsB.get(n))),
    removed: [...permsA.keys()].filter(n => !permsB.has(n)).map(n => permInfo(n, permsA.get(n))),
    unchanged: [...permsA.keys()].filter(n => permsB.has(n)).length,
  };
  const compA = components(oA);
  const compB = components(oB);
  result.components = {
    added: [...compB.values()].filter(c => !compA.has(`${c.type}:${c.name}`)),
    removed: [...compA.values()].filter(c => !compB.has(`${c.type}:${c.name}`)),
    exportChanged: [...compB.values()].filter(c => compA.has(`${c.type}:${c.name}`) && compA.get(`${c.type}:${c.name}`).exported !== c.exported)
      .map(c => ({ ...c, wasExported: compA.get(`${c.type}:${c.name}`).exported })),
    unchanged: [...compA.keys()].filter(k => compB.has(k)).length,
  };

  progress('Comparing files and sizes');
  const { map: fA, exact: exA } = entriesOf(wsA, metaA);
  const { map: fB, exact: exB } = entriesOf(wsB, metaB);
  const exact = exA && exB;
  const files = { added: [], removed: [], changed: [], unchanged: 0, exact };
  for (const [p, b] of fB) {
    const a = fA.get(p);
    if (!a) files.added.push({ path: p, sizeB: b.size, packedB: b.packed });
    else if ((exact && a.crc !== b.crc) || a.size !== b.size) files.changed.push({ path: p, sizeA: a.size, sizeB: b.size, delta: delta(a.size, b.size), packedDelta: delta(a.packed, b.packed) });
    else files.unchanged++;
  }
  for (const [p, a] of fA) if (!fB.has(p)) files.removed.push({ path: p, sizeA: a.size, packedA: a.packed });
  files.added.sort((x, y) => y.sizeB - x.sizeB);
  files.removed.sort((x, y) => y.sizeA - x.sizeA);
  files.changed.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  for (const k of ['added', 'removed', 'changed']) { files[`${k}Count`] = files[k].length; files[k] = files[k].slice(0, MAX_LIST); }
  result.files = files;
  const sA = sizeBreakdown(fA);
  const sB = sizeBreakdown(fB);
  result.size = {
    apkA: oA.fileSize || null, apkB: oB.fileSize || null,
    kinds: [...new Set([...Object.keys(sA), ...Object.keys(sB)])].map(k => ({ kind: k, a: sA[k] || { size: 0, packed: 0, files: 0 }, b: sB[k] || { size: 0, packed: 0, files: 0 } })),
  };
  const abis = map => [...new Set([...map.keys()].filter(p => /^lib\/[^/]+\//.test(p)).map(p => p.split('/')[1]))].sort();
  result.abis = { a: abis(fA), b: abis(fB) };

  progress('Comparing decompiled classes');
  const cA = classHashes(wsA);
  const cB = classHashes(wsB);
  const ownPrefix = (oB.package || oA.package || '').split('.').join('/');
  const code = { added: [], removed: [], changed: [], unchanged: 0, available: cA.size > 0 && cB.size > 0, ownPrefix };
  for (const [r, h] of cB) {
    if (!cA.has(r)) code.added.push(r);
    else if (cA.get(r) !== h) code.changed.push(r);
    else code.unchanged++;
  }
  for (const r of cA.keys()) if (!cB.has(r)) code.removed.push(r);
  const own = r => !!ownPrefix && r.startsWith(`${ownPrefix}/`);
  for (const k of ['added', 'removed', 'changed']) {
    code[k].sort((x, y) => own(y) - own(x) || x.localeCompare(y));
    code[`${k}Count`] = code[k].length;
    code[`${k}Own`] = code[k].filter(own).length;
    code[k] = code[k].slice(0, MAX_LIST);
  }
  result.code = code;

  // SDKs by package, from the class lists.
  const sdkCounts = classes => {
    const m = new Map();
    for (const r of classes.keys()) {
      const s = sdkOf(r, ownPrefix);
      if (s) m.set(s, (m.get(s) || 0) + 1);
    }
    return m;
  };
  const kA = sdkCounts(cA);
  const kB = sdkCounts(cB);
  const minClasses = 3;
  result.sdks = {
    added: [...kB].filter(([n, c]) => !kA.has(n) && c >= minClasses).map(([name, classes]) => ({ name, classes })).sort((x, y) => y.classes - x.classes),
    removed: [...kA].filter(([n, c]) => !kB.has(n) && c >= minClasses).map(([name, classes]) => ({ name, classes })).sort((x, y) => y.classes - x.classes),
    changed: [...kB].filter(([n, c]) => kA.has(n) && kA.get(n) !== c).map(([name, classes]) => ({ name, a: kA.get(name), b: classes }))
      .sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a)).slice(0, 200),
  };

  progress('Comparing game assets');
  const gA = readJson(path.join(wsA, 'game', 'assets.json'));
  const gB = readJson(path.join(wsB, 'game', 'assets.json'));
  result.assets = {
    engineA: gA?.engine || null, engineB: gB?.engine || null,
    counts: [...new Set([...Object.keys(gA?.counts || {}), ...Object.keys(gB?.counts || {})])]
      .map(c => ({ category: c, a: gA?.counts?.[c] || 0, b: gB?.counts?.[c] || 0 })).filter(r => r.a || r.b),
  };

  result.facts = [
    ['Version name', oA.versionName, oB.versionName],
    ['Version code', oA.versionCode, oB.versionCode],
    ['Min SDK', oA.minSdk, oB.minSdk],
    ['Target SDK', oA.targetSdk, oB.targetSdk],
    ['Compile SDK', oA.compileSdk, oB.compileSdk],
    ['APK size', oA.fileSize, oB.fileSize, 'bytes'],
    ['Files inside', fA.size, fB.size],
    ['DEX files', oA.dexFiles, oB.dexFiles],
    ['Classes (decompiled)', cA.size || null, cB.size || null],
    ['Permissions', permsA.size, permsB.size],
    ['Components', compA.size, compB.size],
    ['Native ABIs', result.abis.a.join(', ') || 'none', result.abis.b.join(', ') || 'none'],
    ['Frameworks', (oA.frameworks || []).join(', '), (oB.frameworks || []).join(', ')],
    ['Game engine', gA?.engine || 'none', gB?.engine || 'none'],
  ];
  return result;
}

async function compareWithAudit(wsA, wsB, progress) {
  const result = compareWorkspaces(wsA, wsB, progress);
  progress('Running the release audit on both versions');
  try {
    const [aA, aB] = await Promise.all([getAudit(wsA), getAudit(wsB)]);
    const key = f => f.id;
    const byA = new Map(aA.findings.map(f => [key(f), f]));
    const byB = new Map(aB.findings.map(f => [key(f), f]));
    result.audit = {
      countsA: aA.counts, countsB: aB.counts,
      added: aB.findings.filter(f => !byA.has(key(f))).map(({ locations, ...f }) => ({ ...f, places: locations.length })),
      fixed: aA.findings.filter(f => !byB.has(key(f))).map(({ locations, ...f }) => ({ ...f, places: locations.length })),
      changed: aB.findings.filter(f => byA.has(key(f)) && (byA.get(key(f)).severity !== f.severity || byA.get(key(f)).locations.length !== f.locations.length))
        .map(f => ({ id: f.id, title: f.title, severity: f.severity, wasSeverity: byA.get(key(f)).severity, places: f.locations.length, wasPlaces: byA.get(key(f)).locations.length })),
    };
  } catch (err) {
    result.audit = { error: err.message };
  }
  return result;
}

// Line diff of one decompiled class (root 'java') or decoded resource (root 'res').
function diffFile(wsA, wsB, root, rel) {
  const base = r => (root === 'res' ? path.join(r, 'apktool') : path.join(r, 'jadx', 'sources'));
  const read = ws => {
    const p = path.resolve(base(ws), rel);
    if (!p.startsWith(base(ws) + path.sep) || !fs.existsSync(p)) return '';
    const buf = fs.readFileSync(p);
    return buf.length > 3 * 1024 * 1024 ? '' : buf.toString('utf8');
  };
  return hunks(read(wsA), read(wsB));
}

module.exports = { compareWithAudit, diffFile, COMPARE_VERSION };
