// Builds the Overview from apktool's output and the APK's entry list:
// app identity, permissions, components, framework and animation counts.

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

// Runtime ("dangerous") permissions and a plain-language meaning.
const DANGEROUS = {
  'android.permission.READ_CALENDAR': 'Read your calendar',
  'android.permission.WRITE_CALENDAR': 'Change your calendar',
  'android.permission.CAMERA': 'Use the camera',
  'android.permission.READ_CONTACTS': 'Read your contacts',
  'android.permission.WRITE_CONTACTS': 'Change your contacts',
  'android.permission.GET_ACCOUNTS': 'See accounts on the device',
  'android.permission.ACCESS_FINE_LOCATION': 'Precise location',
  'android.permission.ACCESS_COARSE_LOCATION': 'Approximate location',
  'android.permission.ACCESS_BACKGROUND_LOCATION': 'Location in the background',
  'android.permission.RECORD_AUDIO': 'Record audio',
  'android.permission.READ_PHONE_STATE': 'Read phone status and identity',
  'android.permission.READ_PHONE_NUMBERS': 'Read phone numbers',
  'android.permission.CALL_PHONE': 'Make phone calls',
  'android.permission.ANSWER_PHONE_CALLS': 'Answer phone calls',
  'android.permission.READ_CALL_LOG': 'Read call log',
  'android.permission.WRITE_CALL_LOG': 'Change call log',
  'android.permission.BODY_SENSORS': 'Body sensors',
  'android.permission.ACTIVITY_RECOGNITION': 'Physical activity',
  'android.permission.SEND_SMS': 'Send SMS',
  'android.permission.RECEIVE_SMS': 'Receive SMS',
  'android.permission.READ_SMS': 'Read SMS',
  'android.permission.READ_EXTERNAL_STORAGE': 'Read shared storage',
  'android.permission.WRITE_EXTERNAL_STORAGE': 'Change shared storage',
  'android.permission.READ_MEDIA_IMAGES': 'Read photos',
  'android.permission.READ_MEDIA_VIDEO': 'Read videos',
  'android.permission.READ_MEDIA_AUDIO': 'Read audio files',
  'android.permission.POST_NOTIFICATIONS': 'Show notifications',
  'android.permission.NEARBY_WIFI_DEVICES': 'Find nearby Wi-Fi devices',
  'android.permission.BLUETOOTH_SCAN': 'Scan for Bluetooth devices',
  'android.permission.BLUETOOTH_CONNECT': 'Connect to Bluetooth devices',
};

const COMPONENT_TAGS = ['activity', 'activity-alias', 'service', 'receiver', 'provider'];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: name => ['uses-permission', 'uses-permission-sdk-23', 'uses-feature', 'intent-filter',
    'action', 'category', 'meta-data', ...COMPONENT_TAGS].includes(name),
});

const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

// apktool.yml is simple enough to read the few keys we need by line.
function readApktoolYml(dir) {
  const text = fs.readFileSync(path.join(dir, 'apktool.yml'), 'utf8');
  const get = key => {
    const m = text.match(new RegExp(`^\\s*${key}:\\s*'?([^'\\n]*)'?\\s*$`, 'm'));
    return m ? m[1].trim() : null;
  };
  return {
    minSdk: get('minSdkVersion'),
    targetSdk: get('targetSdkVersion'),
    versionCode: get('versionCode'),
    versionName: get('versionName'),
  };
}

function component(tag, node, pkg) {
  const name = node['android:name'] || '';
  const filters = arr(node['intent-filter']);
  const actions = filters.flatMap(f => arr(f.action).map(a => a['android:name']));
  const categories = filters.flatMap(f => arr(f.category).map(c => c['android:name']));
  // Exported explicitly, or implicitly by having an intent filter (pre-Android 12 rule).
  const exp = node['android:exported'];
  const exported = exp === 'true' || (exp == null && filters.length > 0);
  return {
    type: tag,
    name: name.startsWith('.') ? pkg + name : name,
    exported,
    launcher: actions.includes('android.intent.action.MAIN') && categories.includes('android.intent.category.LAUNCHER'),
  };
}

function readManifest(dir) {
  const xml = fs.readFileSync(path.join(dir, 'AndroidManifest.xml'), 'utf8');
  const m = parser.parse(xml).manifest || {};
  const pkg = m.package || '';
  const app = m.application || {};
  const permissions = [...arr(m['uses-permission']), ...arr(m['uses-permission-sdk-23'])]
    .map(p => p['android:name'])
    .filter(Boolean)
    .map(name => ({ name, dangerous: name in DANGEROUS, meaning: DANGEROUS[name] || '' }));
  const components = COMPONENT_TAGS.flatMap(tag => arr(app[tag]).map(n => component(tag, n, pkg)));
  return {
    package: pkg,
    compileSdk: m['android:compileSdkVersion'] || null,
    label: app['android:label'] || null,
    icon: app['android:icon'] || null,
    debuggable: app['android:debuggable'] === 'true',
    permissions,
    components,
  };
}

// Resolves "@string/app_name" against res/values/strings.xml.
function resolveString(dir, ref) {
  if (!ref || !ref.startsWith('@string/')) return ref;
  const key = ref.slice('@string/'.length);
  try {
    const xml = fs.readFileSync(path.join(dir, 'res', 'values', 'strings.xml'), 'utf8');
    const m = xml.match(new RegExp(`<string name="${key}"[^>]*>([^<]*)</string>`));
    return m ? m[1] : ref;
  } catch {
    return ref;
  }
}

// Android VectorDrawable XML -> SVG text (paths, groups with transforms, solid
// fill/stroke colours). Gradients and other attributes are dropped.
function vectorToSvg(xml, color) {
  const attr = (s, n) => (s.match(new RegExp(`android:${n}="([^"]*)"`)) || [])[1];
  const head = (xml.match(/<vector\b[^>]*>/) || [])[0];
  if (!head) return null;
  const vw = Number.parseFloat(attr(head, 'viewportWidth')) || 24;
  const vh = Number.parseFloat(attr(head, 'viewportHeight')) || 24;
  const col = v => {
    if (!v) return null;
    if (v.startsWith('@color/')) v = color(v.slice(7));
    if (!v || !v.startsWith('#')) return null;
    const h = v.slice(1);
    if (h.length === 8) return `rgba(${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${parseInt(h.slice(6, 8), 16)},${(parseInt(h.slice(0, 2), 16) / 255).toFixed(3)})`;
    return `#${h}`;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let out = '';
  for (const tag of xml.match(/<\/?(group|path)\b[^>]*>/g) || []) {
    if (tag.startsWith('</group')) { out += '</g>'; continue; }
    if (tag.startsWith('<group')) {
      const n = k => Number.parseFloat(attr(tag, k) || '0');
      const px = n('pivotX');
      const py = n('pivotY');
      const sx = attr(tag, 'scaleX') ? n('scaleX') : 1;
      const sy = attr(tag, 'scaleY') ? n('scaleY') : 1;
      out += `<g transform="translate(${n('translateX') + px} ${n('translateY') + py}) rotate(${n('rotation')}) scale(${sx} ${sy}) translate(${-px} ${-py})">`;
      if (tag.endsWith('/>')) out += '</g>';
      continue;
    }
    const d = attr(tag, 'pathData');
    if (!d) continue;
    const fill = col(attr(tag, 'fillColor'));
    const stroke = col(attr(tag, 'strokeColor'));
    const sw = attr(tag, 'strokeWidth');
    const alpha = attr(tag, 'fillAlpha');
    out += `<path d="${esc(d)}" fill="${fill || 'none'}"${alpha ? ` fill-opacity="${alpha}"` : ''}${stroke ? ` stroke="${stroke}" stroke-width="${sw || 1}"` : ''}${attr(tag, 'fillType') === 'evenOdd' ? ' fill-rule="evenodd"' : ''}/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}">${out}</svg>`;
}

// App icon: the highest-density bitmap for the manifest's icon, or the layers
// of an adaptive icon. Returns { file, bg } with file relative to the workspace.
const DENSITY = { xxxhdpi: 6, xxhdpi: 5, xhdpi: 4, hdpi: 3, mdpi: 2, ldpi: 1 };

function resolveIcon(apktoolDir, ref, depth = 0) {
  const m = /^@(mipmap|drawable|color)\/(.+)$/.exec(ref || '');
  const resDir = path.join(apktoolDir, 'res');
  if (!m || depth > 3 || !fs.existsSync(resDir)) return null;
  const [, type, name] = m;
  const ws = path.dirname(apktoolDir);
  if (type === 'color') {
    try {
      const xml = fs.readFileSync(path.join(resDir, 'values', 'colors.xml'), 'utf8');
      const c = xml.match(new RegExp(`<color name="${name}">([^<]*)</color>`));
      return c ? { color: c[1].trim() } : null;
    } catch {
      return null;
    }
  }
  const rank = d => DENSITY[(d.match(/-(x*[hml]dpi|ldpi)/) || [])[1]] || 0;
  const dirs = fs.readdirSync(resDir).filter(d => d === type || d.startsWith(`${type}-`)).sort((a, b) => rank(b) - rank(a));
  for (const d of dirs) {
    for (const ext of ['.png', '.webp', '.jpg']) {
      const f = path.join(resDir, d, name + ext);
      if (fs.existsSync(f)) return { file: path.relative(ws, f).split(path.sep).join('/') };
    }
  }
  for (const d of dirs) {
    const f = path.join(resDir, d, `${name}.xml`);
    if (!fs.existsSync(f)) continue;
    const xml = fs.readFileSync(f, 'utf8');
    const grad = /<shape\b/.test(xml) && xml.match(/<gradient\b[^>]*>/);
    if (grad) {
      const g = k => (grad[0].match(new RegExp(`android:${k}="([^"]+)"`)) || [])[1];
      const c = v => (v && v.startsWith('@color/') ? resolveIcon(apktoolDir, v, depth + 1)?.color : v);
      const stops = [c(g('startColor')), c(g('centerColor')), c(g('endColor'))].filter(Boolean);
      // Android 0° points right and 90° up; CSS 0° points up and 90° right.
      if (stops.length) return { color: `linear-gradient(${90 - Number.parseFloat(g('angle') || '0')}deg, ${stops.join(', ')})` };
    }
    const solid = /<shape\b/.test(xml) && (xml.match(/<solid[^>]*android:color="([^"]+)"/) || [])[1];
    if (solid) return solid.startsWith('@color/') ? resolveIcon(apktoolDir, solid, depth + 1) : { color: solid };
    if (/<vector\b/.test(xml)) {
      const color = c => resolveIcon(apktoolDir, `@color/${c}`, depth + 1)?.color || null;
      const svg = vectorToSvg(xml, color);
      if (!svg) continue;
      const out = path.join(ws, 'icons', `${type}-${name}.svg`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, svg);
      return { file: path.relative(ws, out).split(path.sep).join('/') };
    }
    const layer = tag => (xml.match(new RegExp(`<${tag}[^>]*android:drawable="([^"]+)"`)) || [])[1];
    const fg = resolveIcon(apktoolDir, layer('foreground'), depth + 1);
    const bg = resolveIcon(apktoolDir, layer('background'), depth + 1);
    if (fg?.file) return { file: fg.file, bg: bg?.file || bg?.color || null };
  }
  return null;
}

function detectFrameworks(names, jadxDir) {
  const has = re => names.some(n => re.test(n));
  const found = [];
  if (has(/^lib\/[^/]+\/libflutter\.so$/) || has(/^assets\/flutter_assets\//)) found.push('Flutter');
  if (has(/^assets\/index\.android\.bundle$/)) {
    found.push(has(/^lib\/[^/]+\/libhermes\.so$/) ? 'React Native (Hermes)' : 'React Native');
  }
  if (has(/^lib\/[^/]+\/libunity\.so$/)) {
    found.push(has(/^lib\/[^/]+\/libil2cpp\.so$/) ? 'Unity (IL2CPP)' : 'Unity (Mono)');
  }
  if (has(/^lib\/[^/]+\/libmonodroid\.so$/) || has(/^assemblies\//)) found.push('Xamarin / .NET MAUI');
  if (has(/^assets\/www\/cordova\.js$/)) found.push('Cordova');
  if (has(/^assets\/capacitor\.config\.json$/)) found.push('Capacitor');
  if (has(/^lib\/[^/]+\/libgodot_android\.so$/)) found.push('Godot');

  const src = jadxDir && path.join(jadxDir, 'sources');
  const pkgDir = (...p) => src && fs.existsSync(path.join(src, ...p));
  if (pkgDir('androidx', 'compose')) found.push('Jetpack Compose');
  if (has(/^kotlin\//) || pkgDir('kotlin')) found.push('Kotlin');
  if (!found.length) found.push('Java');
  return found;
}

function countAnimations(dir, names) {
  const list = sub => {
    const res = path.join(dir, 'res');
    if (!fs.existsSync(res)) return [];
    return fs.readdirSync(res)
      .filter(d => d === sub || d.startsWith(sub + '-'))
      .flatMap(d => fs.readdirSync(path.join(res, d)).map(f => path.join(res, d, f)));
  };
  const drawables = list('drawable').filter(f => f.endsWith('.xml'));
  const head = f => {
    try { return fs.readFileSync(f, 'utf8').slice(0, 400); } catch { return ''; }
  };
  const lottieJson = names.filter(n => /^(assets|res\/raw)\/.*\.json$/.test(n));
  return {
    viewAnimations: list('anim').length,
    propertyAnimators: list('animator').length,
    animatedVectors: drawables.filter(f => head(f).includes('<animated-vector')).length,
    frameAnimations: drawables.filter(f => head(f).includes('<animation-list')).length,
    lottie: names.filter(n => n.endsWith('.lottie')).length + lottieJson.length,
    gifs: names.filter(n => /\.gif$/i.test(n)).length,
    rive: names.filter(n => /\.riv$/i.test(n)).length,
  };
}

function analyze({ apkPath, apktoolDir, jadxDir, entries }) {
  const names = entries.map(e => e.name);
  const yml = readApktoolYml(apktoolDir);
  const manifest = readManifest(apktoolDir);
  const abis = {};
  for (const e of entries) {
    const m = e.name.match(/^lib\/([^/]+)\/[^/]+\.so$/);
    if (m) abis[m[1]] = (abis[m[1]] || 0) + e.size;
  }
  return {
    file: path.basename(apkPath),
    fileSize: fs.statSync(apkPath).size,
    appName: resolveString(apktoolDir, manifest.label),
    package: manifest.package,
    icon: resolveIcon(apktoolDir, manifest.icon),
    versionName: yml.versionName,
    versionCode: yml.versionCode,
    minSdk: yml.minSdk,
    targetSdk: yml.targetSdk,
    compileSdk: manifest.compileSdk,
    debuggable: manifest.debuggable,
    dexFiles: names.filter(n => /^classes\d*\.dex$/.test(n)).length,
    frameworks: detectFrameworks(names, jadxDir),
    nativeLibs: Object.entries(abis).map(([abi, bytes]) => ({ abi, bytes })),
    permissions: manifest.permissions,
    components: manifest.components,
    animations: countAnimations(apktoolDir, names),
    entryCount: entries.length,
  };
}

module.exports = { analyze, resolveIcon };
