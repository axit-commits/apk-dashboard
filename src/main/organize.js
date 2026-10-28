// Builds <ws>/Extracted/: the ten category folders filled with every extracted
// and decoded file (hard links, so no extra disk space), plus the extraction
// report in HTML, JSON and CSV. Also fills in the status of entries decoded by
// apktool and jadx.

const fs = require('fs');
const path = require('path');

const TOP = ['3D_Models', 'Animations', 'Textures', 'Materials_Shaders', 'Audio_Music', 'Videos_Cutscenes',
  'Scenes_Maps', 'UI_Assets', 'Scripts_Data', 'Other_Assets'];

const STATUSES = ['decoded', 'extracted', 'partial', 'unsupported', 'encrypted', 'corrupted', 'missing'];

const safe = s => String(s || 'unnamed').replace(/[^A-Za-z0-9._ ()-]+/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) || 'unnamed';
const stripAssets = p => p.replace(/^Assets\//i, '').replace(/^assets\//, '');

// Category folder (and sub-folder) for an asset.
function folderFor(item) {
  const t = item.type;
  switch (item.category) {
    case 'characters': return '3D_Models/Characters';
    case 'models': return item.meta?.path ? '3D_Models' : '3D_Models/Objects';
    case 'animations':
      if (t === 'Spine' || t === 'Spine (binary)') return 'Animations/Spine_Skeletons';
      if (t === 'Lottie') return 'Animations/Lottie';
      if (item.meta?.androidAnim) return 'Animations/Android_UI';
      if (t === 'AnimationClip') return 'Animations/Clips';
      if (/Animator/.test(t)) return 'Animations/Animator_Controllers';
      return 'Animations';
    case 'textures': return 'Textures';
    case 'materials': return 'Materials_Shaders/Materials';
    case 'shaders': return 'Materials_Shaders/Shaders';
    case 'audio': return 'Audio_Music';
    case 'video': return 'Videos_Cutscenes';
    case 'scenes': return 'Scenes_Maps';
    case 'ui':
      if (t === 'Font' || /^(TTF|OTF)$/.test(t)) return 'UI_Assets/Fonts';
      if (t === 'SpriteAtlas') return 'UI_Assets/Sprite_Atlases';
      return item.meta?.path ? 'UI_Assets' : 'UI_Assets/Sprites';
    case 'text':
      if (t === 'IL2CPP metadata' || t === 'Unity script data') return 'Scripts_Data/Unity_Scripts';
      return item.meta?.path ? 'Scripts_Data' : 'Scripts_Data/TextAssets';
    case 'packages': return 'Other_Assets/Engine_Packages';
    default: return t && t.startsWith('Native library') ? 'Other_Assets/Native_Libraries' : 'Other_Assets';
  }
}

function linkFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.linkSync(src, dest); } catch { fs.copyFileSync(src, dest); }
}

function linkTree(srcDir, destDir, filter = () => true) {
  let n = 0;
  if (!fs.existsSync(srcDir)) return 0;
  for (const name of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, name);
    const d = path.join(destDir, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) n += linkTree(s, d, filter);
    else if (filter(s)) { linkFile(s, d); n++; }
  }
  return n;
}

function organize({ ws, stages = {}, overview = null, log = [] }) {
  const gameDir = path.join(ws, 'game');
  const out = path.join(ws, 'Extracted');
  fs.rmSync(out, { recursive: true, force: true });
  for (const f of TOP) fs.mkdirSync(path.join(out, f), { recursive: true });

  const assetsPath = path.join(gameDir, 'assets.json');
  const invPath = path.join(gameDir, 'inventory.json');
  const assets = fs.existsSync(assetsPath) ? JSON.parse(fs.readFileSync(assetsPath, 'utf8')) : { items: [] };
  const inventory = fs.existsSync(invPath) ? JSON.parse(fs.readFileSync(invPath, 'utf8')) : [];
  const used = new Set();
  const unique = rel => {
    let r = rel;
    for (let i = 2; used.has(r.toLowerCase()); i++) r = rel.replace(/(\.[^./]+)?$/, m => ` (${i})${m}`);
    used.add(r.toLowerCase());
    return r;
  };

  // 1. Assets: real files are linked; metadata-only assets (materials, clips, scenes, ...) are written as JSON.
  const byId = new Map();
  // Spine skeletons first: their skeleton, atlas and page images go together in one folder only.
  const spineFiles = new Map();
  for (const item of assets.items) {
    if (item.type !== 'Spine' || !item.file) continue;
    const dir = unique(`${folderFor(item)}/${safe(item.name)}`);
    for (const f of [item.file, item.meta?.atlas, ...Object.values(item.meta?.pages || {})].filter(Boolean)) {
      const rel = `${dir}/${path.posix.basename(f)}`;
      if (!spineFiles.has(f)) linkFile(path.join(gameDir, f), path.join(out, rel));
      spineFiles.set(f, spineFiles.get(f) || rel);
    }
    item.output = `${dir}/${path.posix.basename(item.file)}`;
  }
  for (const item of assets.items) {
    byId.set(item.id, item);
    if (item.type === 'Spine' && item.output) continue;
    const folder = folderFor(item);
    let rel = null;
    if (item.file && spineFiles.has(item.file)) {
      rel = spineFiles.get(item.file);
    } else if (item.file) {
      const fileName = path.posix.basename(item.file);
      let sub;
      if (item.originalPath) sub = path.posix.dirname(stripAssets(item.originalPath));
      else if (item.meta?.path) sub = path.posix.dirname(stripAssets(item.meta.path)).replace(/^lib\//, '').replace(/^bin\/Data\/Managed\/?/, '');
      rel = unique(`${folder}/${sub && sub !== '.' ? `${sub.split('/').map(safe).join('/')}/` : ''}${fileName}`);
      linkFile(path.join(gameDir, item.file), path.join(out, rel));
    } else if (['json', 'material', 'tree'].includes(item.preview) && item.meta && item.status !== 'missing') {
      const base = item.originalPath ? stripAssets(item.originalPath).replace(/\.[^./]+$/, '') : safe(item.name);
      rel = unique(`${folder}/${base.split('/').map(safe).join('/')}.json`);
      fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
      fs.writeFileSync(path.join(out, rel), JSON.stringify({ name: item.name, type: item.type, ...item.meta }, null, 2));
    }
    if (rel) item.output = rel;
  }

  // 2. Android resources decoded by apktool, and the manifest.
  const resOk = stages.resources?.status === 'done';
  const apktoolDir = path.join(ws, 'apktool');
  let resFiles = 0;
  if (resOk) {
    const resDir = path.join(apktoolDir, 'res');
    for (const d of fs.existsSync(resDir) ? fs.readdirSync(resDir) : []) {
      const ui = /^(drawable|mipmap|font)/.test(d);
      resFiles += linkTree(path.join(resDir, d), path.join(out, ui ? 'UI_Assets/Android_Res' : 'Scripts_Data/Android_Res', d));
    }
    const manifest = path.join(apktoolDir, 'AndroidManifest.xml');
    if (fs.existsSync(manifest)) linkFile(manifest, path.join(out, 'Scripts_Data/AndroidManifest.xml'));
  }

  // 3. Decompiled code.
  const codeOk = stages.code?.status === 'done';
  const codeFiles = codeOk ? linkTree(path.join(ws, 'jadx', 'sources'), path.join(out, 'Scripts_Data/Decompiled_Code')) : 0;

  // 4. Every inventory entry gets its status and output location.
  for (const rec of inventory) {
    if (rec.kind === 'android') {
      Object.assign(rec, resOk
        ? { status: 'decoded', format: rec.path === 'resources.arsc' ? 'Android resource table' : rec.path.endsWith('.xml') ? 'Binary Android XML' : 'Android resource',
          reason: 'Decoded by apktool into readable resources', output: /^res\/(drawable|mipmap|font)/.test(rec.path) ? 'UI_Assets/Android_Res' : 'Scripts_Data/Android_Res' }
        : { status: 'corrupted', reason: `apktool could not decode the resources: ${(stages.resources?.error || 'unknown error').slice(0, 200)}`,
          solution: 'The resource table may be protected or malformed; the raw APK still contains it' });
      continue;
    }
    if (rec.kind === 'dex') {
      const failed = stages.code?.failedClasses || 0;
      Object.assign(rec, codeOk
        ? { status: failed ? 'partial' : 'decoded', reason: `Decompiled to Java by jadx${failed ? ` (${failed} classes across all DEX files could not be decompiled)` : ''}`,
          output: 'Scripts_Data/Decompiled_Code', ...(failed ? { solution: 'Failed classes are usually heavily optimised or obfuscated code' } : {}) }
        : { status: 'corrupted', reason: `jadx could not decompile the code: ${(stages.code?.error || 'not run').slice(0, 200)}`,
          solution: 'The DEX may be packed or protected' });
      continue;
    }
    if (!rec.file) continue; // encrypted / unsafe / failed entries keep their status
    const asset = rec.asset ? byId.get(rec.asset) : null;
    if (asset?.output) { rec.output = asset.output; continue; }
    let rel;
    if (rec.kind === 'unity') rel = `Other_Assets/Unity_Data/${stripAssets(rec.path)}`;
    else if (/^lib\//.test(rec.path)) rel = `Other_Assets/Native_Libraries/${rec.path.slice(4)}`;
    else if (/^assets\/bin\/Data\/Managed\//.test(rec.path)) rel = `Scripts_Data/Unity_Scripts/${rec.path.slice('assets/bin/Data/Managed/'.length)}`;
    else rel = `Other_Assets/${rec.path.startsWith('assets/') ? stripAssets(rec.path) : `Package_Files/${rec.path}`}`;
    rel = unique(rel.split('/').map(safe).join('/'));
    linkFile(path.join(gameDir, rec.file), path.join(out, rel));
    rec.output = rel;
  }

  // 5. Report.
  const count = (list, key) => list.reduce((m, x) => ((m[x[key] || 'unknown'] = (m[x[key] || 'unknown'] || 0) + 1), m), {});
  const folderCounts = Object.fromEntries(TOP.map(f => [f, countFiles(path.join(out, f))]));
  const summary = {
    app: overview ? { name: overview.appName, package: overview.package, version: overview.versionName, engine: assets.engine } : null,
    generated: new Date().toISOString(),
    archiveEntries: inventory.length,
    entryStatus: count(inventory, 'status'),
    assets: assets.items.length,
    assetStatus: count(assets.items, 'status'),
    folders: folderCounts,
    androidResources: resFiles,
    decompiledCodeFiles: codeFiles,
  };
  fs.writeFileSync(path.join(gameDir, 'assets.json'), JSON.stringify(assets));
  fs.writeFileSync(path.join(gameDir, 'inventory.json'), JSON.stringify(inventory));
  fs.writeFileSync(path.join(gameDir, 'summary.json'), JSON.stringify(summary));

  const reportJson = {
    summary,
    entries: inventory.map(({ ci, kind, file, asset, ...r }) => r),
    assets: assets.items.map(i => ({ name: i.name, type: i.type, category: i.category, status: i.status, output: i.output || null,
      reason: i.note || null, solution: i.solution || null })),
  };
  fs.writeFileSync(path.join(out, 'EXTRACTION_REPORT.json'), JSON.stringify(reportJson, null, 1));
  const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(path.join(out, 'EXTRACTION_REPORT.csv'), [
    ['package', 'path', 'size', 'format', 'status', 'output', 'reason', 'solution'].join(','),
    ...inventory.map(r => [r.container, r.path, r.size, r.format, r.status, r.output, r.reason, r.solution].map(csvCell).join(',')),
  ].join('\n'));
  fs.writeFileSync(path.join(out, 'EXTRACTION_REPORT.html'), reportHtml(summary, inventory, assets.items));
  if (log.length) fs.writeFileSync(path.join(out, 'extraction.log'), log.join('\n'));
  return { out, summary };
}

function countFiles(dir) {
  let n = 0;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, name);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function reportHtml(summary, inventory, items) {
  const problems = [...inventory.filter(r => !['decoded', 'extracted'].includes(r.status)).map(r => ({ name: r.path, type: r.format, status: r.status, reason: r.reason, solution: r.solution })),
    ...items.filter(i => !['decoded', 'extracted'].includes(i.status)).map(i => ({ name: i.name, type: i.type, status: i.status, reason: i.note, solution: i.solution }))];
  const kv = obj => Object.entries(obj).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const rows = (list, cols) => list.map(r => `<tr>${cols.map(c => `<td class="${c}">${esc(r[c])}</td>`).join('')}</tr>`).join('');
  const a = summary.app || {};
  return `<!doctype html><html><head><meta charset="utf-8"><title>Extraction report</title><style>
body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#1c2028}h1{margin:0}h2{margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid #dde1e8;padding:4px 6px;text-align:left;vertical-align:top}
th{color:#5f6878;font-weight:500}.grid{display:flex;gap:24px;flex-wrap:wrap}.grid table{width:auto}td.status{font-weight:600}.muted{color:#5f6878}
</style></head><body><h1>Extraction report</h1><p class="muted">${esc(a.name || '')} ${esc(a.package || '')} ${esc(a.version || '')} · engine: ${esc(a.engine || 'none detected')} · ${esc(summary.generated)}</p>
<div class="grid"><table><caption>Archive entries (${summary.archiveEntries})</caption>${kv(summary.entryStatus)}</table>
<table><caption>Assets (${summary.assets})</caption>${kv(summary.assetStatus)}</table>
<table><caption>Files per folder</caption>${kv(summary.folders)}</table></div>
<h2>Problems (${problems.length})</h2><table><tr><th>Name</th><th>Format / type</th><th>Status</th><th>Reason</th><th>Possible solution</th></tr>${rows(problems, ['name', 'type', 'status', 'reason', 'solution'])}</table>
<h2>Every archive entry (${inventory.length})</h2><table><tr><th>Package</th><th>Path</th><th>Size</th><th>Format</th><th>Status</th><th>Output</th><th>Reason</th></tr>${rows(inventory, ['container', 'path', 'size', 'format', 'status', 'output', 'reason'])}</table>
</body></html>`;
}

module.exports = { organize, STATUSES, TOP };
