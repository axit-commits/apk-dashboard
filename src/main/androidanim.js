// Android UI animations as assets: view animations (res/anim), property
// animators (res/animator), animated vector drawables, frame animations
// (animation-list), and Lottie JSON files. Adds them to <ws>/game/assets.json
// and writes the resource values they reference to android-values.json.

const fs = require('fs');
const path = require('path');
const { resolveIcon } = require('./analyze');

const LIB_PREFIX = /^(abc_|mtrl_|design_|m3_|material_|btn_checkbox|btn_radio|fragment_|nav_default|catalyst_|exo_|com_facebook|applovin_|mbridge_|ironsource|tt_|pangle|admob|gms_|common_google|fui_|ucrop|lottie_|avd_hide_password|avd_show_password|bottomsheet_|linear_indeterminate|mtrl|design|abc|m3|ic_mtrl|al_|ad_|ads_|unity_|vungle|inmobi|bigo|fyber|moloco|chartboost|ia_|ifa_|my_target|yandex|appodeal|max_|tp_|startapp)/i;
const VALUE_TYPES = ['color', 'integer', 'dimen', 'bool', 'fraction'];
// Picks the most specific API level of a resource that exists in several folders.
const apiOf = d => Number((d.match(/-v(\d+)/) || [])[1] || 0);

function readValues(resDir) {
  const out = Object.fromEntries(VALUE_TYPES.map(t => [t, {}]));
  const dir = path.join(resDir, 'values');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.xml')) continue;
    const xml = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of xml.matchAll(/<(color|integer|dimen|bool|fraction|item)\s+([^>]*?)>([^<]*)</g)) {
      const attrs = m[2];
      const name = (attrs.match(/name="([^"]+)"/) || [])[1];
      let type = m[1];
      if (type === 'item') type = (attrs.match(/type="([^"]+)"/) || [])[1];
      if (name && VALUE_TYPES.includes(type)) out[type][name] = m[3].trim();
    }
  }
  return out;
}

function rootTag(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
  return (head.match(/<([A-Za-z][\w.-]*)[\s>]/g) || []).map(t => t.slice(1).trim().replace('>', '')).find(t => t !== '?xml') || '';
}

// Resolves @type/name to a res-relative XML file path, or null.
function resFile(resDir, ref, types) {
  const m = /^@(?:\+)?([a-z]+)\/(.+)$/.exec(ref || '');
  if (!m) return null;
  const want = types || [m[1]];
  const dirs = fs.readdirSync(resDir).filter(d => want.some(t => d === t || d.startsWith(`${t}-`))).sort((a, b) => apiOf(b) - apiOf(a));
  for (const d of dirs) {
    const f = path.join(resDir, d, `${m[2]}.xml`);
    if (fs.existsSync(f)) return `res/${d}/${m[2]}.xml`;
  }
  return null;
}

function scanAndroidAnimations(ws) {
  const apktoolDir = path.join(ws, 'apktool');
  const resDir = path.join(apktoolDir, 'res');
  if (!fs.existsSync(resDir)) return { items: [], values: null };
  const values = readValues(resDir);
  const items = [];
  const seen = new Set();
  const dirs = fs.readdirSync(resDir).sort((a, b) => apiOf(b) - apiOf(a));
  const add = (dir, file, type, preview, meta = {}, note) => {
    const name = file.replace(/\.xml$/, '');
    const key = `${type}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rel = `res/${dir}/${file}`;
    const library = LIB_PREFIX.test(name.replace(/^\$/, ''));
    items.push({
      id: 'aa', category: 'animations', type, name, file: `../apktool/${rel}`, size: fs.statSync(path.join(resDir, dir, file)).size,
      preview, status: preview === 'none' ? 'extracted' : 'decoded', source: 'Android resources',
      meta: { path: rel, androidAnim: true, library, ...meta }, ...(note ? { note } : {}),
    });
  };

  for (const dir of dirs) {
    const isAnim = /^anim(-|$)/.test(dir);
    const isAnimator = /^animator(-|$)/.test(dir);
    const isDrawable = /^drawable(-|$)/.test(dir);
    if (!isAnim && !isAnimator && !isDrawable) continue;
    for (const file of fs.readdirSync(path.join(resDir, dir))) {
      if (!file.endsWith('.xml') || file.startsWith('$')) continue; // $name__N parts belong to their parent
      const full = path.join(resDir, dir, file);
      let tag;
      try { tag = rootTag(full); } catch { continue; }
      if (isAnim) {
        if (/^(set|alpha|scale|translate|rotate)$/.test(tag)) add(dir, file, 'View animation', 'android-anim');
        else if (/layoutAnimation$/i.test(tag)) add(dir, file, 'Layout animation', 'none', {}, 'Applies another animation to each child of a list: details only');
        else if (/Interpolator$/i.test(tag)) add(dir, file, 'Interpolator', 'none', {}, 'Timing curve used by other animations');
        else if (/^(objectAnimator|animator|propertyValuesHolder)$/.test(tag)) add(dir, file, 'Property animator', 'android-anim');
      } else if (isAnimator) {
        if (tag === 'selector') add(dir, file, 'State list animator', 'android-anim', {}, 'Runs a different animator per view state; the first one is played');
        else if (/^(set|objectAnimator|animator|propertyValuesHolder)$/.test(tag)) add(dir, file, 'Property animator', 'android-anim');
      } else if (tag === 'animated-vector') {
        const xml = fs.readFileSync(full, 'utf8');
        const drawable = resFile(resDir, (xml.match(/<animated-vector[^>]*android:drawable="([^"]+)"/) || [])[1], ['drawable']);
        const targets = [...xml.matchAll(/<target\b([^>]*)\/?>/g)].map(m => ({
          name: (m[1].match(/android:name="([^"]+)"/) || [])[1],
          animation: resFile(resDir, (m[1].match(/android:animation="([^"]+)"/) || [])[1], ['animator', 'anim', 'drawable']),
        })).filter(t => t.name && t.animation);
        if (drawable) add(dir, file, 'Animated vector', 'avd', { vector: drawable, targets });
        else add(dir, file, 'Animated vector', 'none', {}, 'Its vector drawable could not be found');
      } else if (tag === 'animation-list') {
        const xml = fs.readFileSync(full, 'utf8');
        const frames = [...xml.matchAll(/<item\b([^>]*)\/?>/g)].map(m => {
          const ref = (m[1].match(/android:drawable="([^"]+)"/) || [])[1];
          const img = resolveIcon(apktoolDir, ref);
          return { ref, file: img?.file || null, duration: Number((m[1].match(/android:duration="(\d+)"/) || [])[1] || 100) };
        });
        const oneshot = /android:oneshot="true"/.test(xml);
        const ok = frames.filter(f => f.file);
        if (ok.length) add(dir, file, 'Frame animation', 'frames', { frames: ok, oneshot, missingFrames: frames.length - ok.length });
        else add(dir, file, 'Frame animation', 'none', {}, 'Its frame images could not be found');
      } else if (tag === 'animated-selector') {
        add(dir, file, 'Animated state list', 'none', {}, 'Switches between animated vectors per state: open the animated vectors it uses');
      }
    }
  }
  return { items, values };
}

// Lottie files: JSON with Lottie's top-level keys (v, fr, ip, op, layers).
function lottieInfo(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
  if (!/"layers"\s*:/.test(head) && !/"layers"/.test(fs.readFileSync(file, 'utf8').slice(-4000))) return null;
  if (!/"v"\s*:\s*"\d/.test(head) || !/"ip"\s*:/.test(head + fs.readFileSync(file, 'utf8').slice(-4000)) || !/"fr"\s*:/.test(head)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(j.layers)) return null;
    return { version: j.v, fps: j.fr, frames: (j.op || 0) - (j.ip || 0), width: j.w, height: j.h, seconds: j.fr ? Math.round((100 * ((j.op || 0) - (j.ip || 0))) / j.fr) / 100 : null, images: (j.assets || []).filter(a => a.p).length };
  } catch {
    return null;
  }
}

// Adds the animations to assets.json (replacing earlier ones). Returns how many.
function applyAndroidAnimations(ws) {
  const gameDir = path.join(ws, 'game');
  const assetsPath = path.join(gameDir, 'assets.json');
  if (!fs.existsSync(assetsPath)) return 0;
  const assets = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
  assets.items = assets.items.filter(i => !i.meta?.androidAnim);
  let lottie = 0;
  for (const item of assets.items) {
    const jsonLike = item.file && (/\.(json|txt)$/i.test(item.file) || item.meta?.format === 'JSON text');
    if (!jsonLike || item.size > 30 * 1024 * 1024 || item.type === 'Lottie') continue;
    try {
      const info = lottieInfo(path.join(gameDir, item.file));
      if (!info) continue;
      Object.assign(item, { category: 'animations', type: 'Lottie', preview: 'lottie', status: 'decoded', meta: { ...item.meta, lottie: info } });
      delete item.note;
      lottie++;
    } catch { /* unreadable */ }
  }
  const { items, values } = scanAndroidAnimations(ws);
  items.sort((a, b) => a.meta.library - b.meta.library || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  for (const it of items) assets.items.push({ ...it, id: `aa${assets.items.length}` });
  // Projects whose folders were already built: file the new animations in too.
  const out = path.join(ws, 'Extracted');
  if (fs.existsSync(out)) {
    for (const item of assets.items) {
      if (item.output || !item.file || !(item.meta?.androidAnim || item.type === 'Lottie')) continue;
      const rel = item.type === 'Lottie' ? `Animations/Lottie/${path.posix.basename(item.file)}` : `Animations/Android_UI/${item.meta.path}`;
      const dest = path.join(out, ...rel.split('/'));
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(dest)) { try { fs.linkSync(path.join(gameDir, item.file), dest); } catch { fs.copyFileSync(path.join(gameDir, item.file), dest); } }
        item.output = rel;
      } catch { /* leave it unfiled */ }
    }
  }
  assets.androidAnims = items.length;
  assets.lottie = lottie;
  assets.counts = assets.items.reduce((m, i) => ((m[i.category] = (m[i.category] || 0) + 1), m), {});
  fs.writeFileSync(assetsPath, JSON.stringify(assets));
  if (values) fs.writeFileSync(path.join(gameDir, 'android-values.json'), JSON.stringify(values));
  return items.length + lottie;
}

module.exports = { applyAndroidAnimations };
