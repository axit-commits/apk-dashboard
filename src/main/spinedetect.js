// Finds Spine skeletons among extracted files (loose JSON/atlas/PNG, or Unity
// TextAssets + Texture2Ds) and pairs each skeleton with its atlas and pages.

const fs = require('fs');
const path = require('path');

const MAX_JSON = 40 * 1024 * 1024;
const STRIP = /\.(txt|bytes|json|atlas|skel|png|jpe?g|webp)$/i;

function base(name) {
  let b = path.posix.basename(String(name)).toLowerCase();
  while (STRIP.test(b)) b = b.replace(STRIP, '');
  return b;
}

function head(file, n = 8192) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, n, 0));
  } finally {
    fs.closeSync(fd);
  }
}

// Page and region names from a libGDX/Spine atlas (3.x and 4.x layouts).
function atlasNames(text) {
  const pages = [];
  const regions = new Set();
  let expectPage = true;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) { expectPage = true; continue; }
    if (/^\s/.test(raw) || raw.includes(':')) continue;
    if (expectPage) { pages.push(raw.trim()); expectPage = false; } else regions.add(raw.trim());
  }
  return { pages, regions };
}

function skeletonInfo(json) {
  const paths = new Set();
  const unsupported = new Set();
  const skins = Array.isArray(json.skins) ? json.skins.map(s => [s.name, s.attachments || {}]) : Object.entries(json.skins || {});
  for (const [, slots] of skins) {
    for (const atts of Object.values(slots)) {
      for (const [key, a] of Object.entries(atts)) {
        const type = a.type || 'region';
        if (type === 'region' || type === 'mesh' || type === 'linkedmesh') paths.add(a.path || a.name || key);
        if (type === 'clipping' || type === 'path') unsupported.add(`${type} attachments`);
        if (a.sequence) unsupported.add('sequence attachments');
      }
    }
  }
  if (json.path?.length) unsupported.add('path constraints');
  if (json.physics?.length) unsupported.add('physics constraints');
  return {
    version: json.skeleton?.spine || 'unknown',
    bones: (json.bones || []).length,
    slots: (json.slots || []).length,
    skins: skins.map(s => s[0]),
    animations: Object.keys(json.animations || {}),
    paths,
    unsupported: [...unsupported],
  };
}

function detectSpine(items, gameDir) {
  const full = rel => path.join(gameDir, ...rel.split('/'));
  const atlases = [];
  const skeletons = [];
  const binaries = [];
  for (const item of items) {
    if (!item.file || !item.size) continue;
    const lower = item.file.toLowerCase();
    const name = String(item.name || '').toLowerCase();
    if (/\.skel(\.bytes)?$/.test(lower) || (lower.endsWith('.bytes') && name.endsWith('.skel'))) {
      binaries.push(item);
      continue;
    }
    if (!/\.(json|txt|atlas)$/.test(lower) || item.size > MAX_JSON) continue;
    let text;
    try { text = head(full(item.file)); } catch { continue; }
    if (/^\s*size\s*:\s*\d+\s*,\s*\d+/m.test(text) && /^\s*(bounds|xy)\s*:/m.test(text)) {
      try { atlases.push({ item, ...atlasNames(fs.readFileSync(full(item.file), 'utf8')) }); } catch { /* unreadable */ }
    } else if (/"skeleton"\s*:\s*\{/.test(text) && /"(bones|slots)"\s*:/.test(text + (item.size > 8192 ? '"bones":' : ''))) {
      try {
        const json = JSON.parse(fs.readFileSync(full(item.file), 'utf8'));
        if (Array.isArray(json.bones)) skeletons.push({ item, info: skeletonInfo(json) });
      } catch { /* not JSON after all */ }
    }
  }

  const images = items.filter(i => i.file && i.preview === 'image');
  const out = [];
  for (const { item, info } of skeletons) {
    // Best atlas: same base name wins, else most attachment names covered.
    let best = null;
    let bestScore = 0;
    for (const a of atlases) {
      let hit = 0;
      for (const p of info.paths) if (a.regions.has(p)) hit++;
      const same = base(a.item.name || a.item.file) === base(item.name || item.file);
      const score = (same ? 1e6 : 0) + hit;
      if ((same || hit >= Math.max(1, info.paths.size * 0.5)) && score > bestScore) { best = a; bestScore = score; }
    }
    const pages = {};
    const missingPages = [];
    if (best) {
      const dir = path.posix.dirname(best.item.file);
      for (const page of best.pages) {
        const pb = base(page);
        const img = images.find(i => path.posix.dirname(i.file) === dir && path.posix.basename(i.file) === page) ||
          images.find(i => i.category === 'textures' && base(i.name) === pb) ||
          images.find(i => base(i.name) === pb || base(i.file) === pb);
        if (img) pages[page] = img.file; else missingPages.push(page);
      }
    }
    const notes = [];
    if (!best) notes.push('No matching atlas found: shown as untextured shapes');
    else if (missingPages.length) notes.push(`Atlas page image not found: ${missingPages.join(', ')}`);
    if (info.unsupported.length) notes.push(`Not drawn: ${info.unsupported.join(', ')}`);
    const { paths, ...meta } = info;
    out.push({
      id: `s${out.length}`, category: 'animations', type: 'Spine', name: base(item.name || item.file) || item.name,
      file: item.file, size: item.size, preview: 'spine', source: item.source,
      meta: { ...meta, attachments: paths.size, skeletonFile: item.file, atlas: best ? best.item.file : null, pages, ...(missingPages.length ? { missingPages } : {}) },
      ...(notes.length ? { note: notes.join('; ') } : {}),
    });
  }
  for (const item of binaries) {
    out.push({
      id: `s${out.length}`, category: 'animations', type: 'Spine (binary)', name: base(item.name || item.file),
      file: item.file, size: item.size, preview: 'none', source: item.source, meta: { file: item.file },
      note: 'Binary Spine skeleton (.skel): playback isn\'t supported yet; JSON exports play',
    });
  }
  return out;
}

module.exports = { detectSpine };
