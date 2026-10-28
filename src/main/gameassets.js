// Game assets: records every archive entry, extracts every accessible file,
// identifies formats by extension and signature, runs the Unity extractor
// (bundled Python + UnityPy), reads Unreal .pak / Godot .pck headers and finds
// Spine skeletons. Writes <ws>/game/assets.json and <ws>/game/inventory.json.

const fs = require('fs');
const path = require('path');
const { listEntries, extractEntry, safeEntryPath } = require('./zipindex');
const { runPython } = require('./tools');
const { detectSpine } = require('./spinedetect');

const SCRIPT = path.join(__dirname, '..', 'py', 'extract_unity.py');

const ENGINE_SIGNALS = [
  ['Unity', /^lib\/[^/]+\/libunity\.so$|^assets\/bin\/Data\//],
  ['Unreal Engine', /^lib\/[^/]+\/lib(UE4|Unreal)\.so$|\.(pak|utoc|ucas)$/i],
  ['Godot', /^lib\/[^/]+\/libgodot_android\.so$|\.pck$/i],
  ['Cocos', /^lib\/[^/]+\/libcocos[^/]*\.so$/],
  ['Defold', /^lib\/[^/]+\/libdmengine\.so$/],
  ['libGDX', /^lib\/[^/]+\/libgdx\.so$/],
  ['GameMaker', /^lib\/[^/]+\/libyoyo\.so$/],
];

const GPU_TEX = 'GPU-compressed texture: no preview yet';
// By extension: [category, preview, note when not previewable].
const BY_EXT = {
  glb: ['models', 'model'], gltf: ['models', 'model'], obj: ['models', 'model'], fbx: ['models', 'model'],
  dae: ['models', 'model'], stl: ['models', 'model'], ply: ['models', 'model'],
  png: ['textures', 'image'], jpg: ['textures', 'image'], jpeg: ['textures', 'image'], webp: ['textures', 'image'],
  bmp: ['textures', 'image'], gif: ['textures', 'image'],
  ktx: ['textures', 'none', GPU_TEX], ktx2: ['textures', 'none', GPU_TEX], pvr: ['textures', 'none', GPU_TEX],
  astc: ['textures', 'none', GPU_TEX], dds: ['textures', 'none', GPU_TEX], tga: ['textures', 'none', 'TGA: no preview yet'],
  ogg: ['audio', 'audio'], mp3: ['audio', 'audio'], wav: ['audio', 'audio'], m4a: ['audio', 'audio'],
  aac: ['audio', 'audio'], flac: ['audio', 'audio'], opus: ['audio', 'audio'],
  mp4: ['video', 'video'], webm: ['video', 'video'], m4v: ['video', 'video'],
  ttf: ['ui', 'font'], otf: ['ui', 'font'],
  fnt: ['ui', 'text'], plist: ['ui', 'text'], atlas: ['animations', 'text', 'Spine/libGDX atlas: text'],
  skel: ['animations', 'none', 'Binary Spine skeleton: listed under its Spine entry'],
  riv: ['animations', 'none', 'Rive animation: playback not supported yet'],
  json: ['text', 'text'], xml: ['text', 'text'], txt: ['text', 'text'], csv: ['text', 'text'],
  lua: ['text', 'text'], js: ['text', 'text'], yaml: ['text', 'text'], yml: ['text', 'text'], ini: ['text', 'text'],
  properties: ['text', 'text'], html: ['text', 'text'], css: ['text', 'text'],
  bnk: ['audio', 'none', 'Wwise sound bank: playback not supported'],
  wem: ['audio', 'none', 'Wwise audio: playback not supported'],
  fsb: ['audio', 'none', 'FMOD sound bank: playback not supported for loose banks'],
};
const WWISE_FIX = 'Convert it with a Wwise-aware tool such as vgmstream (not bundled)';
const MAX_TEXT_PREVIEW = 2 * 1024 * 1024;

const ext = name => (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

// Format from the first bytes of a file: [format, ext-like key or null].
function sniff(buf) {
  const s = (o, n) => buf.toString('latin1', o, o + n);
  if (buf.length < 4) return ['Empty or tiny file', null];
  if (s(0, 7) === 'UnityFS' || s(0, 8) === 'UnityWeb' || s(0, 8) === 'UnityRaw' || s(0, 12) === 'UnityArchive') return ['Unity asset bundle', 'unity'];
  if (buf.readUInt32BE(0) === 0x89504e47) return ['PNG image', 'png'];
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ['JPEG image', 'jpg'];
  if (s(0, 4) === 'GIF8') return ['GIF image', 'gif'];
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return ['WebP image', 'webp'];
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') {
    const fmt = buf.length >= 22 && s(12, 4) === 'fmt ' ? buf.readUInt16LE(20) : 1;
    return fmt === 0xffff ? ['Wwise audio (WEM)', 'wem'] : ['WAV audio', 'wav'];
  }
  if (s(0, 4) === 'OggS') return ['Ogg audio', 'ogg'];
  if (s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return ['MP3 audio', 'mp3'];
  if (s(0, 4) === 'fLaC') return ['FLAC audio', 'flac'];
  if (s(4, 4) === 'ftyp') return ['MP4 media', 'mp4'];
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return ['WebM/Matroska video', 'webm'];
  if (s(0, 4) === 'glTF') return ['glTF binary model', 'glb'];
  if (s(0, 18) === 'Kaydara FBX Binary') return ['FBX model', 'fbx'];
  if (s(0, 4) === 'FSB5') return ['FMOD sound bank', 'fsb'];
  if (s(0, 4) === 'BKHD') return ['Wwise sound bank', 'bnk'];
  if (s(0, 4) === 'AKPK') return ['Wwise file package', 'bnk'];
  if (s(0, 4) === 'GDPC') return ['Godot package', 'pck'];
  if (s(0, 4) === 'PK\x03\x04') return ['ZIP archive', null];
  if (buf[0] === 0x1f && buf[1] === 0x8b) return ['GZIP data', null];
  if (s(0, 4) === 'dex\n') return ['Android DEX code', null];
  if (s(0, 4) === '\x7fELF') return ['Native library (ELF)', null];
  if (s(0, 4) === 'OTTO' || buf.readUInt32BE(0) === 0x00010000) return ['Font', 'ttf'];
  if (s(0, 4) === 'wOFF' || s(0, 4) === 'wOF2') return ['Web font', null];
  if (s(1, 3) === 'KTX') return ['KTX texture', 'ktx'];
  if (s(0, 4) === 'DDS ') return ['DDS texture', 'dds'];
  if (s(0, 4) === 'PVR\x03') return ['PVR texture', 'pvr'];
  if (buf.readUInt32LE(0) === 0x5ca1ab13) return ['ASTC texture', 'astc'];
  if (s(0, 5) === '<?xml') return ['XML text', 'xml'];
  if (buf.readUInt32LE(0) === 0x00080003) return ['Binary Android XML', null];
  const head = buf.toString('utf8', 0, Math.min(buf.length, 512));
  if (/^\s*[{[]/.test(head) && !head.includes('�')) return ['JSON text', 'json'];
  if (!/[\x00-\x08\x0e-\x1f]/.test(head)) return ['Text', 'txt'];
  return ['Unknown binary format', null];
}

function readHead(file, n = 64) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0));
  } finally {
    fs.closeSync(fd);
  }
}

function detectEngine(containers) {
  const found = new Map();
  for (const c of containers) {
    for (const e of c.entries) {
      for (const [engine, re] of ENGINE_SIGNALS) {
        if (re.test(e.name) && !found.has(engine)) found.set(engine, `${c.label}: ${e.name}`);
      }
    }
  }
  const order = ENGINE_SIGNALS.map(s => s[0]);
  const engines = [...found.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { engine: engines[0] || null, engines, signals: Object.fromEntries(found) };
}

const isUnityPath = n =>
  (/^assets\/bin\/Data\//.test(n) && !/^assets\/bin\/Data\/Managed\//.test(n)) ||
  /^assets\/aa\//.test(n) ||
  (/^assets\//.test(n) && /\.(bundle|unity3d|ab|assetbundle)$/i.test(n));
const isAndroidDecoded = n => n === 'AndroidManifest.xml' || n === 'resources.arsc' || (/^res\//.test(n) && !/^res\/raw\//.test(n));
const isDex = n => /^classes\d*\.dex$/.test(n);

// Unreal .pak footer: magic 0x5A6F12E1 near the end, preceded by the encrypted-index flag.
function pakInfo(file, size) {
  const fd = fs.openSync(file, 'r');
  let tail;
  try {
    const n = Math.min(size, 512);
    tail = Buffer.alloc(n);
    fs.readSync(fd, tail, 0, n, size - n);
  } finally {
    fs.closeSync(fd);
  }
  for (let i = tail.length - 44; i >= 1; i--) {
    if (tail.readUInt32LE(i) === 0x5a6f12e1) {
      return { version: tail.readUInt32LE(i + 4), indexSize: Number(tail.readBigUInt64LE(i + 16)), encryptedIndex: tail[i - 1] === 1 };
    }
  }
  return { note: 'No .pak footer found (IoStore or unknown format)' };
}

// Godot .pck: "GDPC" header and a file table.
function pckInfo(file) {
  const head = fs.readFileSync(file).subarray(0, 4 * 1024 * 1024);
  if (head.toString('latin1', 0, 4) !== 'GDPC') return { note: 'No GDPC header found' };
  const fmt = head.readUInt32LE(4);
  const godot = `${head.readUInt32LE(8)}.${head.readUInt32LE(12)}.${head.readUInt32LE(16)}`;
  let p = 20 + (fmt >= 2 ? 4 + 8 : 0) + 16 * 4;
  if (fmt >= 3) return { format: fmt, godot, note: 'Godot 4.4+ package: file table not read yet' };
  const count = head.readUInt32LE(p);
  p += 4;
  const files = [];
  for (let i = 0; i < count && p + 4 < head.length && files.length < 2000; i++) {
    const len = head.readUInt32LE(p);
    files.push(head.toString('utf8', p + 4, p + 4 + len).replace(/\0+$/, ''));
    p += 4 + len + 8 + 8 + 16 + (fmt >= 2 ? 4 : 0);
  }
  return { format: fmt, godot, fileCount: count, files };
}

async function runUnity(inputDir, outDir, { onProgress, signal }) {
  let fatal = null;
  const { code, tail } = await runPython([SCRIPT, outDir, inputDir], {
    signal,
    onLine: line => {
      const m = line.match(/^PROGRESS (\d+) (\d+) (.*)$/);
      if (m) onProgress({ percent: Math.min(99, Math.round((100 * m[1]) / Math.max(1, m[2]))), message: m[3] });
      if (line.startsWith('FATAL ')) fatal = line.slice(6);
    },
  });
  const manifest = path.join(outDir, 'assets.json');
  if (code !== 0 || !fs.existsSync(manifest)) {
    throw new Error(fatal || tail.slice(-6).join('\n') || `Unity extractor exited with ${code}`);
  }
  return JSON.parse(fs.readFileSync(manifest, 'utf8'));
}

// Links (or copies) src to dest, creating folders.
function linkFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.linkSync(src, dest); } catch { fs.copyFileSync(src, dest); }
}

async function extractGameAssets({ containers, bundle = null, ws, onProgress = () => {}, signal }) {
  const gameDir = path.join(ws, 'game');
  fs.rmSync(gameDir, { recursive: true, force: true });
  fs.mkdirSync(gameDir, { recursive: true });
  const detected = detectEngine(containers);
  const result = { ...detected, items: [], notExtracted: [], errors: [], unity: null };
  const inventory = [];
  const addItem = item => { const it = { ...item, id: `${item.id || 'i'}${result.items.length}` }; result.items.push(it); return it; };

  // The bundle (.xapk / .apks) itself: each inner APK/OBB is opened as a package.
  if (bundle) {
    for (const e of bundle.entries) {
      if (e.name.endsWith('/')) continue;
      const opened = containers.some(c => c.label === e.name);
      inventory.push({
        container: path.basename(bundle.file), path: e.name, size: e.size, format: opened ? 'Android package' : 'Bundle metadata',
        status: e.encrypted ? 'encrypted' : 'extracted', kind: opened ? 'package' : 'raw', category: opened ? null : 'other',
        reason: opened ? 'Opened and processed as a package below' : 'Bundle metadata, kept as-is',
      });
    }
  }

  // 1. Every entry: record it, and write out every file that isn't decoded by apktool / jadx.
  const all = containers.flatMap((c, ci) => c.entries.filter(e => !e.name.endsWith('/')).map(e => ({ c, ci, e })));
  const totalBytes = all.reduce((t, x) => t + x.e.size, 0) || 1;
  let doneBytes = 0;
  const unityFiles = [];
  for (const [i, { c, ci, e }] of all.entries()) {
    const rec = { container: c.label, ci, path: e.name, size: e.size, packed: e.compressedSize };
    inventory.push(rec);
    doneBytes += e.size;
    if (i % 50 === 0) onProgress({ percent: Math.round((10 * doneBytes) / totalBytes), message: `Extracting files (${i + 1} of ${all.length})` });
    if (e.encrypted) {
      Object.assign(rec, { status: 'encrypted', format: 'Encrypted zip entry', reason: 'The archive entry is encrypted', solution: 'It needs the password or key the game uses, which isn\'t available offline' });
      continue;
    }
    if (!safeEntryPath(e.name)) {
      Object.assign(rec, { status: 'unsupported', format: 'Unsafe path', reason: 'The entry name points outside the archive (possible zip-slip attack); not written to disk' });
      continue;
    }
    if (isAndroidDecoded(e.name) && /\.apk$/i.test(c.file)) { Object.assign(rec, { kind: 'android' }); continue; }
    if (isDex(e.name)) { Object.assign(rec, { kind: 'dex', format: 'Android DEX code' }); continue; }
    const rel = path.posix.join('files', String(ci), e.name);
    try {
      await extractEntry(c.file, e, path.join(gameDir, 'files', String(ci)), signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      Object.assign(rec, { status: 'corrupted', reason: `Could not be decompressed: ${err.message}`, solution: 'The archive may be damaged or use an unusual compression method' });
      result.errors.push({ type: 'file', name: e.name, error: err.message });
      continue;
    }
    rec.file = rel;
    const [format, sniffKey] = sniff(readHead(path.join(gameDir, rel)));
    rec.format = format;
    rec.status = 'extracted';
    if (isUnityPath(e.name) || sniffKey === 'unity') {
      rec.kind = 'unity';
      unityFiles.push({ rec, src: path.join(gameDir, rel), rel: path.posix.join(String(ci), e.name) });
    }
  }

  // 2. Unity: the extracted data files (linked, not copied) go through UnityPy.
  if (unityFiles.length) {
    const inputDir = path.join(ws, 'unity-input');
    fs.rmSync(inputDir, { recursive: true, force: true });
    for (const f of unityFiles) linkFile(f.src, path.join(inputDir, ...f.rel.split('/')));
    try {
      const unity = await runUnity(inputDir, path.join(gameDir, 'unity'), {
        signal,
        onProgress: p => onProgress({ percent: 10 + Math.round(p.percent * 0.85), message: p.message }),
      });
      for (const item of unity.items) {
        if (item.file) item.file = `unity/${item.file}`;
        result.items.push(item);
      }
      result.unity = { version: unity.unityVersion, objectCount: unity.objectCount, typeCounts: unity.typeCounts, scenes: unity.scenes, seconds: unity.seconds };
      result.notExtracted.push(...unity.notExtracted);
      result.errors.push(...unity.errors);
      for (const f of unityFiles) {
        const st = unity.files?.[f.rel];
        if (st) Object.assign(f.rec, { status: st.status, reason: st.reason });
        if (st?.status === 'decoded') f.rec.format = `Unity data (${st.reason})`;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      result.errors.push({ type: 'Unity', name: 'extractor', error: err.message });
      for (const f of unityFiles) Object.assign(f.rec, { reason: `Unity extraction failed: ${err.message.slice(0, 200)}`, solution: 'The raw file is still exported in Other_Assets' });
    } finally {
      fs.rmSync(inputDir, { recursive: true, force: true });
    }
  }

  // 3. Every other extracted file: categorise, and list the useful ones as assets.
  onProgress({ percent: 96, message: 'Identifying files' });
  for (const rec of inventory) {
    if (!rec.file || rec.kind === 'unity') continue;
    const name = rec.path;
    if (/^META-INF\//.test(name)) { Object.assign(rec, { category: 'other', reason: 'APK signature and build metadata' }); continue; }
    if (/^lib\/[^/]+\/[^/]+\.so$/.test(name)) {
      Object.assign(rec, { category: 'other', reason: 'Compiled native code (machine code); exported as-is' });
      rec.asset = addItem({ id: 'n', category: 'other', type: `Native library (${name.split('/')[1]})`, name: path.posix.basename(name), file: rec.file,
        size: rec.size, preview: 'none', status: 'extracted', source: rec.container, meta: { path: name },
        note: 'Compiled machine code: it can\'t be turned back into source code here' }).id;
      continue;
    }
    if (/^assets\/bin\/Data\/Managed\//.test(name)) {
      const il2cpp = /global-metadata\.dat$/.test(name);
      Object.assign(rec, { category: 'text', reason: il2cpp ? 'IL2CPP metadata (names of the game\'s compiled C# code)' : 'Unity C# assembly / script data' });
      rec.asset = addItem({ id: 'm', category: 'text', type: il2cpp ? 'IL2CPP metadata' : 'Unity script data', name: path.posix.basename(name), file: rec.file,
        size: rec.size, preview: 'none', status: 'extracted', source: rec.container, meta: { path: name },
        note: il2cpp ? 'Holds type and method names; the code itself is compiled into libil2cpp.so' : 'Managed code or data: exported as-is' }).id;
      continue;
    }
    if (!/^(assets|res\/raw)\//.test(name)) {
      Object.assign(rec, { category: 'other', reason: 'Library or build file outside assets/; exported as-is' });
      continue;
    }
    // assets/ and res/raw/: known extension first, then the signature.
    const x = ext(name);
    let key = BY_EXT[x] ? x : null;
    if (!key || ['bin', 'dat', 'bytes', ''].includes(x)) {
      const [, sk] = sniff(readHead(path.join(gameDir, rec.file)));
      if (sk && BY_EXT[sk]) key = sk;
    }
    if (x === 'wav' && rec.format === 'Wwise audio (WEM)') key = 'wem';
    if (['pak', 'utoc', 'ucas', 'pck'].includes(x)) {
      engineItem(rec, gameDir, x, addItem);
      continue;
    }
    if (!key) {
      Object.assign(rec, { category: 'other', reason: `${rec.format}: exported as-is` });
      rec.asset = addItem({ id: 'o', category: 'other', type: rec.format, name: path.posix.basename(name), file: rec.file, size: rec.size,
        preview: 'none', status: 'extracted', source: rec.container, meta: { path: name }, note: 'Unknown or unsupported format: exported as-is, no preview' }).id;
      continue;
    }
    const [category, preview0, note0] = BY_EXT[key];
    let preview = preview0;
    let note = note0;
    if (preview === 'text' && rec.size > MAX_TEXT_PREVIEW) { preview = 'none'; note = 'Text file too large to preview'; }
    rec.category = category;
    const wwise = key === 'bnk' || key === 'wem';
    const item = addItem({
      id: 'l', category, type: (key === x ? x : key).toUpperCase(), name: path.posix.basename(name), file: rec.file, size: rec.size,
      preview, status: 'extracted', source: rec.container, meta: { path: name, format: rec.format, container: rec.container },
      ...(note ? { note } : {}), ...(wwise ? { solution: WWISE_FIX } : {}),
    });
    rec.asset = item.id;
  }

  // 4. Spine skeletons among the extracted text and image files.
  onProgress({ percent: 98, message: 'Looking for Spine animations' });
  try {
    for (const s of detectSpine(result.items, gameDir)) addItem({ ...s, id: 's', status: s.preview === 'spine' ? (s.meta.atlas && !s.meta.missingPages ? 'decoded' : 'partial') : 'unsupported' });
  } catch (err) {
    result.errors.push({ type: 'Spine', name: 'detection', error: err.message });
  }

  result.counts = result.items.reduce((m, i) => ((m[i.category] = (m[i.category] || 0) + 1), m), {});
  fs.writeFileSync(path.join(gameDir, 'assets.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(gameDir, 'inventory.json'), JSON.stringify(inventory));
  onProgress({ percent: 100, message: `${result.items.length} assets` });
  return result;
}

// Engine packages we can describe but not unpack yet.
function engineItem(rec, gameDir, x, addItem) {
  const file = path.join(gameDir, rec.file);
  let meta = { path: rec.path, container: rec.container, bytes: rec.size };
  let note;
  let status = 'unsupported';
  let solution;
  try {
    if (x === 'pak') {
      const info = pakInfo(file, rec.size);
      meta = { ...meta, ...info };
      if (info.encryptedIndex) {
        status = 'encrypted';
        note = 'Unreal .pak with an encrypted index: its contents can\'t be listed or extracted';
        solution = 'It needs the game\'s AES key, which isn\'t available offline';
      } else {
        note = 'Unreal .pak: unpacking is not supported yet; the raw package is exported';
        solution = 'Open the exported .pak with an Unreal asset tool such as FModel';
      }
    } else if (x === 'pck') {
      meta = { ...meta, ...pckInfo(file) };
      status = 'partial';
      note = 'Godot package: file list shown; imported resources aren\'t converted yet';
    } else {
      note = 'Unreal IoStore container: unpacking is not supported yet; the raw file is exported';
      solution = 'Open the exported files with an Unreal asset tool such as FModel';
    }
  } catch (err) {
    note = `Could not read header: ${err.message}`;
    status = 'corrupted';
  }
  Object.assign(rec, { category: 'packages', reason: note, ...(solution ? { solution } : {}), status: status === 'encrypted' ? 'encrypted' : rec.status });
  rec.asset = addItem({ id: 'p', category: 'packages', type: x.toUpperCase(), name: path.posix.basename(rec.path), file: rec.file, size: rec.size,
    preview: 'json', status, meta, note, ...(solution ? { solution } : {}), source: rec.container }).id;
}

// Splits an input file into its containers: one APK, or the APKs and OBBs
// inside an .xapk / .apks / .apkm bundle.
async function openContainers(file, ws, signal) {
  const entries = listEntries(file);
  if (entries.some(e => e.name === 'AndroidManifest.xml')) {
    return { base: file, containers: [{ file, label: path.basename(file), entries }], bundle: null };
  }
  const inner = entries.filter(e => /\.(apk|obb)$/i.test(e.name) && safeEntryPath(e.name));
  if (!inner.length) throw new Error('No AndroidManifest.xml or APKs inside: this is not an Android app');
  const dir = path.join(ws, 'inputs');
  const containers = [];
  for (const e of inner) {
    const out = await extractEntry(file, e, dir, signal);
    if (out) containers.push({ file: out, label: e.name, entries: listEntries(out) });
  }
  const apks = containers.filter(c => /\.apk$/i.test(c.file) && c.entries.some(e => e.name === 'AndroidManifest.xml'));
  const base = apks.find(c => /(^|\/)base\.apk$/i.test(c.label)) ||
    apks.filter(c => !/(^|\/)(split_)?config\./i.test(c.label)).sort((a, b) => b.entries.length - a.entries.length)[0] ||
    apks[0];
  if (!base) throw new Error('No base APK found inside the bundle');
  return { base: base.file, containers, bundle: { file, entries } };
}

module.exports = { extractGameAssets, openContainers, detectEngine, sniff };
