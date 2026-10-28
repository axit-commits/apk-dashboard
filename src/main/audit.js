// Release audit: checks a decoded app the way a reviewer would before
// publishing. Signing, manifest risks, Play-policy permissions, secrets in
// code and resources, R8 / debug leftovers, and native library alignment.
// Results are cached in <ws>/audit.json.

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { XMLParser } = require('fast-xml-parser');
const { readSigning } = require('./signing');
const { listEntries } = require('./zipindex');
const code = require('./code');

const AUDIT_VERSION = 1;
// Google Play has required target API 35 for new apps and updates since 31 Aug 2025.
const PLAY_MIN_TARGET = 35;
// Play requires upload keys to stay valid past 22 Oct 2033.
const PLAY_KEY_VALID_UNTIL = Date.parse('2033-10-22T00:00:00Z');
const PAGE_16K = 16384;

// Permissions Google Play restricts or asks a declaration for.
const SENSITIVE = {
  'android.permission.READ_SMS': 'SMS / call log policy: only default SMS apps and approved use cases',
  'android.permission.RECEIVE_SMS': 'SMS / call log policy: only default SMS apps and approved use cases',
  'android.permission.SEND_SMS': 'SMS / call log policy: only default SMS apps and approved use cases',
  'android.permission.RECEIVE_MMS': 'SMS / call log policy: only default SMS apps and approved use cases',
  'android.permission.READ_CALL_LOG': 'SMS / call log policy: needs a Play Console declaration',
  'android.permission.WRITE_CALL_LOG': 'SMS / call log policy: needs a Play Console declaration',
  'android.permission.PROCESS_OUTGOING_CALLS': 'SMS / call log policy: needs a Play Console declaration',
  'android.permission.QUERY_ALL_PACKAGES': 'Package visibility policy: needs a Play Console declaration',
  'android.permission.MANAGE_EXTERNAL_STORAGE': 'All files access: needs a Play Console declaration',
  'android.permission.REQUEST_INSTALL_PACKAGES': 'Installs other apps: needs a Play Console declaration',
  'android.permission.ACCESS_BACKGROUND_LOCATION': 'Background location: needs a Play Console declaration and review',
  'android.permission.USE_FULL_SCREEN_INTENT': 'Full-screen intents: limited to calling and alarm apps; declare it in Play Console',
  'android.permission.USE_EXACT_ALARM': 'Exact alarms: limited to alarm, clock and calendar apps',
  'android.permission.READ_MEDIA_IMAGES': 'Photo & video permissions policy: needs a declaration unless core to the app',
  'android.permission.READ_MEDIA_VIDEO': 'Photo & video permissions policy: needs a declaration unless core to the app',
  'android.permission.BIND_ACCESSIBILITY_SERVICE': 'Accessibility API: needs a Play Console declaration',
  'android.permission.BIND_VPN_SERVICE': 'VPN service: needs a Play Console declaration',
  'android.permission.SYSTEM_ALERT_WINDOW': 'Draws over other apps: users must grant it manually',
};

// Secret patterns: [id, regex, severity, title, fix, options].
const PATTERNS = [
  ['aws_key', 'AKIA[0-9A-Z]{16}', 'high', 'AWS access key in the app', 'Remove it from the app, rotate the key in AWS IAM, and call AWS through your own server.'],
  // A PEM header alone is usually code that parses keys; require key data after it, or a header on its own line (a .pem-style file).
  ['private_key', '^\\s*-----BEGIN [A-Z ]*PRIVATE KEY-----\\s*$|-----BEGIN [A-Z ]*PRIVATE KEY-----(\\\\n|\\s)+[A-Za-z0-9+/]{20}', 'high', 'Private key embedded in the app', 'Never ship private keys; anyone can extract them. Move signing or decryption to a server.'],
  ['stripe_live', 'sk_live_[0-9a-zA-Z]{20,}', 'high', 'Stripe live secret key', 'Revoke it in the Stripe dashboard; apps should only contain publishable keys (pk_live_).'],
  ['slack_token', 'xox[baprs]-[0-9A-Za-z-]{10,}', 'high', 'Slack token', 'Revoke the token and keep it on a server.'],
  ['github_token', 'gh[pousr]_[0-9A-Za-z]{36}', 'high', 'GitHub token', 'Revoke the token on GitHub and keep it on a server.'],
  ['google_api_key', 'AIza[0-9A-Za-z_\\-]{35}', 'low', 'Google API key', 'Google keys in apps are expected (Firebase, Maps), but restrict each one to your package name and SHA-1 and to the APIs it needs in Google Cloud Console.'],
  ['generic_secret', '(password|passwd|pwd|secret|api_?key|apikey|client_?secret|access_?token|auth_?token)\\s*[=:]\\s*"[^"\\s]{6,}"', 'medium', 'Hard-coded password or secret', 'Move secrets out of the app: fetch them from your server after the user signs in, or use Android Keystore for device-generated keys.', { flags: 'i', ownOnly: true }],
  ['http_url', '"http://[^"\\s]{4,}"', 'low', 'Plain HTTP (unencrypted) URL', 'Use https:// so traffic can\'t be read or changed on public Wi-Fi.',
    { exclude: 'schemas\\.android\\.com|www\\.w3\\.org|ns\\.adobe\\.com|xmlpull\\.org|apache\\.org|java\\.sun\\.com|xml\\.org|purl\\.org|localhost|127\\.0\\.0\\.1|10\\.0\\.2\\.2|example\\.(com|org)|schemas\\.microsoft|xmlns' }],
  ['firebase_db', 'https://[a-z0-9-]+\\.firebaseio\\.com', 'info', 'Firebase Realtime Database URL', 'Expected for Firebase apps; make sure the database rules don\'t allow public reads or writes.'],
  ['log_debug', 'Log\\.(d|v)\\(', 'low', 'Debug logging left in your code', 'Strip Log.d / Log.v in release builds (R8 rule -assumenosideeffects class android.util.Log { ... }) so internal data isn\'t written to the device log.', { ownOnly: true, max: 60 }],
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: n => ['uses-permission', 'uses-permission-sdk-23', 'activity', 'activity-alias', 'service', 'receiver', 'provider', 'intent-filter', 'action', 'category'].includes(n) });
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

function finding(id, severity, title, detail, fix, locations = []) {
  return { id, severity, title, detail, fix, locations };
}

function readMeta(ws) {
  try { return JSON.parse(fs.readFileSync(path.join(ws, 'meta.json'), 'utf8')); } catch { return {}; }
}

// The APK files to check: the bundle's extracted APKs, or the original APK.
function apkFiles(ws, meta) {
  const inputs = path.join(ws, 'inputs');
  if (fs.existsSync(inputs)) {
    return fs.readdirSync(inputs).filter(f => f.endsWith('.apk')).map(f => path.join(inputs, f))
      .sort((a, b) => (/base\.apk$/.test(b) ? 1 : 0) - (/base\.apk$/.test(a) ? 1 : 0));
  }
  return meta.inputPath && fs.existsSync(meta.inputPath) && /\.apk$/i.test(meta.inputPath) ? [meta.inputPath] : [];
}

function scanPatterns(ws, ownPrefix) {
  return new Promise(resolve => {
    const roots = code.roots(ws).map(({ id, dir, skip }) => ({ id, dir, skip }));
    const worker = new Worker(path.join(__dirname, 'codeworker.js'), {
      workerData: { roots, patterns: PATTERNS.map(([id, re, , , , o = {}]) => ({ id, re, flags: o.flags, exclude: o.exclude, max: o.max || 100 })) },
    });
    worker.on('message', m => { if (m.done) resolve(m); });
    worker.on('error', err => resolve({ results: {}, error: err.message }));
  }).then(m => {
    const own = loc => loc.root === 'java' ? loc.file.startsWith(ownPrefix) : !loc.file.startsWith('smali');
    const out = [];
    for (const [id, , severity, title, fix, o = {}] of PATTERNS) {
      let locs = (m.results[id] || []).map(l => ({ ...l, own: own(l) }));
      if (o.ownOnly) locs = locs.filter(l => l.own);
      if (!locs.length) continue;
      const mine = locs.filter(l => l.own).length;
      // Secrets only in third-party libraries are less likely to be yours to fix.
      const sev = !mine && severity === 'high' ? 'medium' : !mine && severity === 'medium' ? 'low' : severity;
      const detail = `${locs.length}${locs.length >= (o.max || 100) ? '+' : ''} place${locs.length === 1 ? '' : 's'}` +
        (mine ? `, ${mine} in your code or app resources` : ', all in third-party libraries');
      out.push(finding(id, sev, title, detail, fix, locs.sort((a, b) => b.own - a.own)));
    }
    return { findings: out, scanned: m.scanned || 0, error: m.error };
  });
}

// ELF program headers: the smallest alignment of a LOAD segment.
function elfLoadAlign(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(64);
    fs.readSync(fd, h, 0, 64, 0);
    if (h.readUInt32BE(0) !== 0x7f454c46) return null;
    const is64 = h[4] === 2;
    const phoff = is64 ? Number(h.readBigUInt64LE(0x20)) : h.readUInt32LE(0x1c);
    const phentsize = h.readUInt16LE(is64 ? 0x36 : 0x2a);
    const phnum = h.readUInt16LE(is64 ? 0x38 : 0x2c);
    const ph = Buffer.alloc(phentsize * phnum);
    fs.readSync(fd, ph, 0, ph.length, phoff);
    let min = Infinity;
    for (let i = 0; i < phnum; i++) {
      const o = i * phentsize;
      if (ph.readUInt32LE(o) !== 1) continue; // PT_LOAD
      const align = is64 ? Number(ph.readBigUInt64LE(o + 0x30)) : ph.readUInt32LE(o + 0x1c);
      min = Math.min(min, align);
    }
    return Number.isFinite(min) ? min : null;
  } finally {
    fs.closeSync(fd);
  }
}

function zipDataOffset(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    const lfh = Buffer.alloc(30);
    fs.readSync(fd, lfh, 0, 30, entry.offset);
    return entry.offset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
}

function readInventory(ws) {
  const p = path.join(ws, 'game', 'inventory.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

// Key and keystore files shipped inside the APK.
function keyFileChecks(ws) {
  const files = readInventory(ws).filter(e => /\.(pem|key|p12|pfx|jks|keystore|bks)$/i.test(e.path) && !/^META-INF\//.test(e.path));
  if (!files.length) return [];
  return [finding('key_files', 'high', 'Key or keystore files inside the APK', `${files.length} file${files.length === 1 ? '' : 's'} that may hold private keys or certificates.`,
    'Check each one: certificates for pinning are fine, but private keys and keystores must never ship in an app.',
    files.map(e => ({ root: 'file', file: e.path, text: `${e.format || 'file'} · ${e.size} bytes`, own: true })))];
}

function nativeChecks(ws, apks) {
  const out = [];
  const inventory = readInventory(ws);
  const libs = inventory.filter(e => /^lib\/[^/]+\/[^/]+\.so$/.test(e.path) && e.file);
  const abis = new Set(libs.map(e => e.path.split('/')[1]));
  if (!libs.length) return out;
  if ((abis.has('armeabi-v7a') || abis.has('armeabi')) && !abis.has('arm64-v8a')) {
    out.push(finding('no_64bit', 'high', 'No 64-bit native libraries', 'Native code ships for 32-bit ARM only.',
      'Google Play requires 64-bit (arm64-v8a) versions of all native libraries. Rebuild them with the arm64-v8a ABI.'));
  }
  const unaligned = [];
  for (const e of libs) {
    const abi = e.path.split('/')[1];
    if (abi !== 'arm64-v8a' && abi !== 'x86_64') continue;
    try {
      const align = elfLoadAlign(path.join(ws, 'game', e.file));
      if (align != null && align < PAGE_16K) unaligned.push({ root: 'lib', file: e.path, text: `LOAD segments aligned to ${align} bytes (needs 16384)`, own: true });
    } catch { /* unreadable library */ }
  }
  if (unaligned.length) {
    out.push(finding('page_16k', 'high', 'Native libraries are not 16 KB page aligned',
      `${unaligned.length} 64-bit librar${unaligned.length === 1 ? 'y is' : 'ies are'} built for 4 KB pages only.`,
      'Since 1 Nov 2025 Google Play requires apps targeting Android 15+ to support 16 KB memory pages. Rebuild with NDK r28+ (or add -Wl,-z,max-page-size=16384) and update third-party SDKs that ship .so files.',
      unaligned));
  }
  // Uncompressed libraries are mapped straight from the APK, so their zip data must be 16 KB aligned too.
  const zipBad = [];
  for (const apk of apks) {
    for (const e of listEntries(apk)) {
      if (!/^lib\/(arm64-v8a|x86_64)\/[^/]+\.so$/.test(e.name) || e.method !== 0) continue;
      const off = zipDataOffset(apk, e);
      if (off % PAGE_16K) zipBad.push({ root: 'lib', file: e.name, text: `${path.basename(apk)}: data at offset ${off} (not a multiple of 16384)`, own: true });
    }
  }
  if (zipBad.length) {
    out.push(finding('zip_16k', 'medium', 'Uncompressed native libraries are not 16 KB aligned in the APK',
      `${zipBad.length} librar${zipBad.length === 1 ? 'y' : 'ies'}`,
      'Build with Android Gradle Plugin 8.5.1+ (it aligns uncompressed libraries to 16 KB) or run zipalign -P 16.', zipBad));
  }
  return out;
}

function manifestChecks(ws, overview) {
  const out = [];
  const file = path.join(ws, 'apktool', 'AndroidManifest.xml');
  if (!fs.existsSync(file)) return { out: [finding('no_manifest', 'info', 'Manifest not decoded', 'apktool could not decode the manifest, so manifest checks were skipped.', 'Check the Decode resources step for its error.')], pkg: overview?.package };
  const xml = fs.readFileSync(file, 'utf8');
  const lines = xml.split('\n');
  const where = (needle, rel = 'AndroidManifest.xml') => {
    const i = lines.findIndex(l => l.includes(needle));
    return [{ root: 'res', file: rel, line: i + 1 || undefined, text: i >= 0 ? lines[i].trim().slice(0, 200) : undefined, own: true }];
  };
  const m = parser.parse(xml).manifest || {};
  const app = m.application || {};
  const pkg = m.package || overview?.package;
  const target = Number(overview?.targetSdk) || null;
  const min = Number(overview?.minSdk) || null;

  if (app['android:debuggable'] === 'true') {
    out.push(finding('debuggable', 'high', 'App is debuggable', 'android:debuggable="true" lets anyone attach a debugger and read the app\'s data.',
      'Build the release variant (debuggable is false by default) and remove android:debuggable from the manifest.', where('android:debuggable')));
  }
  if (app['android:testOnly'] === 'true' || m['android:testOnly'] === 'true') {
    out.push(finding('test_only', 'high', 'Marked as test-only', 'android:testOnly="true": Google Play rejects it and it only installs with adb -t.',
      'Build a release bundle from Android Studio (Build > Generate Signed App Bundle), not a run/debug build.', where('testOnly')));
  }
  if (target && target < PLAY_MIN_TARGET) {
    out.push(finding('target_sdk', 'high', `Target SDK ${target} is below Google Play's minimum`, `Google Play requires targetSdk ${PLAY_MIN_TARGET} or higher for new apps and updates (since 31 Aug 2025).`,
      `Raise targetSdk to at least ${PLAY_MIN_TARGET} in build.gradle and test the behaviour changes for each Android version in between. Check Play Console for the current requirement.`));
  }
  if (min && min < 21) {
    out.push(finding('min_sdk', 'info', `Supports very old Android (minSdk ${min})`, 'Android versions below 5.0 are no longer supported by most libraries.', 'Consider minSdk 21 or higher.'));
  }
  if (app['android:allowBackup'] !== 'false') {
    out.push(finding('allow_backup', 'low', 'App data can be backed up', app['android:allowBackup'] === 'true' ? 'android:allowBackup="true".' : 'android:allowBackup is not set, so it defaults to true.',
      'If the app stores tokens or private data, set android:allowBackup="false" or exclude those files with dataExtractionRules / fullBackupContent.', where('<application')));
  }
  if (app['android:usesCleartextTraffic'] === 'true') {
    out.push(finding('cleartext', 'medium', 'Unencrypted HTTP traffic is allowed', 'android:usesCleartextTraffic="true" allows plain http:// connections.',
      'Use https:// everywhere and remove usesCleartextTraffic, or allow cleartext only for specific domains in a network security config.', where('usesCleartextTraffic')));
  }
  const nsc = app['android:networkSecurityConfig'];
  if (nsc && nsc.startsWith('@xml/')) {
    const rel = `res/xml/${nsc.slice(5)}.xml`;
    const nscFile = path.join(ws, 'apktool', rel);
    if (fs.existsSync(nscFile)) {
      const t = fs.readFileSync(nscFile, 'utf8');
      const nl = t.split('\n');
      if (/<base-config[^>]*cleartextTrafficPermitted="true"/.test(t)) {
        const i = nl.findIndex(l => l.includes('cleartextTrafficPermitted="true"'));
        out.push(finding('nsc_cleartext', 'medium', 'Network security config allows HTTP for all domains', `${rel} sets cleartextTrafficPermitted="true" in <base-config>.`,
          'Permit cleartext only inside a <domain-config> for the hosts that really need it.', [{ root: 'res', file: rel, line: i + 1, text: nl[i]?.trim(), own: true }]));
      }
      if (/<certificates[^>]*src="user"/.test(t)) {
        const i = nl.findIndex(l => /src="user"/.test(l));
        out.push(finding('nsc_user_ca', 'medium', 'Trusts user-installed certificates', `${rel} trusts certificates the user installs, which makes interception easier.`,
          'Only trust user certificates inside <debug-overrides>.', [{ root: 'res', file: rel, line: i + 1, text: nl[i]?.trim(), own: true }]));
      }
    }
  }

  // Exported components without a permission (except the launcher activity).
  const exposed = [];
  for (const tag of ['activity', 'activity-alias', 'service', 'receiver', 'provider']) {
    for (const c of arr(app[tag])) {
      const filters = arr(c['intent-filter']);
      const exp = c['android:exported'];
      const exported = exp === 'true' || (exp == null && filters.length > 0 && (!target || target < 31)) || (tag === 'provider' && exp == null && (!target || target < 17));
      if (!exported || c['android:permission']) continue;
      const actions = filters.flatMap(f => arr(f.action).map(a => a['android:name']));
      const cats = filters.flatMap(f => arr(f.category).map(a => a['android:name']));
      if (actions.includes('android.intent.action.MAIN') && cats.includes('android.intent.category.LAUNCHER')) continue;
      const name = c['android:name'] || '';
      const full = name.startsWith('.') ? pkg + name : name;
      const ownComp = !!pkg && full.startsWith(pkg);
      exposed.push({ ...where(`android:name="${name}"`)[0], text: `${tag}: ${full}`, own: ownComp });
    }
  }
  const ownExposed = exposed.filter(e => e.own);
  if (exposed.length) {
    out.push(finding('exported', ownExposed.length ? 'medium' : 'low', 'Exported components without a permission',
      `${exposed.length} component${exposed.length === 1 ? '' : 's'} can be started by any app${ownExposed.length ? ` (${ownExposed.length} of yours)` : ' (all from libraries)'}.`,
      'Set android:exported="false" unless other apps must open it; otherwise protect it with android:permission and validate every incoming Intent extra.',
      exposed.sort((a, b) => b.own - a.own)));
  }

  const perms = [...arr(m['uses-permission']), ...arr(m['uses-permission-sdk-23'])].map(p => p['android:name']).filter(Boolean);
  const sensitive = perms.filter(p => SENSITIVE[p]);
  if (sensitive.length) {
    out.push(finding('play_permissions', 'medium', 'Permissions that Google Play restricts', `${sensitive.length} permission${sensitive.length === 1 ? '' : 's'} need a policy declaration or are limited to certain app types.`,
      'For each one, confirm it is core to the app and fill in the matching declaration under Play Console > App content; otherwise remove it (also check merged manifests from libraries).',
      sensitive.map(p => ({ ...where(p)[0], text: `${p.replace('android.permission.', '')}: ${SENSITIVE[p]}`, own: true }))));
  }
  return { out, pkg };
}

function codeChecks(ws, pkg) {
  const out = [];
  const src = path.join(ws, 'jadx', 'sources');
  if (!pkg || !fs.existsSync(src)) return out;
  const pkgDir = path.join(src, ...pkg.split('.'));
  const bc = path.join(pkgDir, 'BuildConfig.java');
  if (fs.existsSync(bc)) {
    const lines = fs.readFileSync(bc, 'utf8').split('\n');
    const i = lines.findIndex(l => /boolean DEBUG\s*=\s*true/.test(l));
    if (i >= 0) {
      out.push(finding('buildconfig_debug', 'high', 'BuildConfig.DEBUG is true', 'The app was built from a debug variant, so debug-only code paths are active.',
        'Publish the release build variant.', [{ root: 'java', file: path.relative(src, bc).split(path.sep).join('/'), line: i + 1, text: lines[i].trim(), own: true }]));
    }
  }
  // R8: count your own classes and how many still have their original names.
  if (fs.existsSync(pkgDir)) {
    let total = 0;
    let readable = 0;
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.java') && !/^(R|BuildConfig)(\$.*)?\.java$/.test(e.name)) {
          total++;
          if (e.name.replace('.java', '').length > 2) readable++;
        }
      }
    };
    walk(pkgDir);
    if (total >= 20 && readable / total > 0.8) {
      out.push(finding('no_r8', 'medium', 'Code is not obfuscated (R8 looks off)', `${readable} of your ${total} classes in ${pkg} keep their original names.`,
        'Enable minifyEnabled true and shrinkResources true for the release build type. It makes the app smaller and harder to copy; keep the mapping.txt for crash reports.',
        [{ root: 'java', file: pkg.split('.').join('/'), text: `${readable} / ${total} readable class names`, own: true }]));
    }
  }
  return out;
}

async function runAudit(ws) {
  const cached = path.join(ws, 'audit.json');
  const meta = readMeta(ws);
  const overview = meta.overview || {};
  const apks = apkFiles(ws, meta);
  const findings = [];

  let signing = null;
  if (apks.length) {
    signing = readSigning(apks[0]);
    signing.file = path.basename(apks[0]);
    const c = signing.cert;
    if (!c) {
      findings.push(finding('unsigned', 'high', 'No valid signature found', signing.error || 'The APK has no readable v1/v2/v3 signature.', 'Sign the release build with your upload key.'));
    } else {
      if (/apk ?(downloader|pure|mirror|combo|cube|monk|tool)|apkpure|apkmirror/i.test(c.subject)) {
        findings.push(finding('resigned', 'medium', 'Re-signed by a download site', `Certificate: ${c.subject}`,
          'This copy was re-signed by a third party, so it is not the developer\'s original build. Compare with the copy from Google Play before trusting its code.'));
      }
      if (signing.debug) {
        findings.push(finding('debug_key', 'high', 'Signed with the Android debug key', c.subject, 'Sign with your own release / upload key. Google Play rejects debug-signed apps.'));
      }
      if (!signing.schemes.some(s => s.startsWith('v2') || s.startsWith('v3')) && (Number(overview.minSdk) || 0) < 24) {
        findings.push(finding('v1_only', 'medium', 'Only the old v1 (JAR) signature', `Schemes: ${signing.schemes.join(', ')}`, 'Enable v2/v3 signing (the default in Android Gradle Plugin); v1-only apps install more slowly and are easier to tamper with.'));
      }
      if (Date.parse(c.validTo) < PLAY_KEY_VALID_UNTIL) {
        findings.push(finding('key_expiry', 'low', 'Signing certificate expires before 2033', `Valid until ${c.validTo}.`, 'Google Play requires keys valid until at least 22 Oct 2033. If you use Play App Signing this only applies to the upload key.'));
      }
    }
  } else {
    findings.push(finding('no_apk', 'info', 'Original APK not available', 'The file has moved, so signature and APK alignment checks were skipped.', 'Open the APK again from its new location to run every check.'));
  }

  const { out: mf, pkg } = manifestChecks(ws, overview);
  findings.push(...mf);
  findings.push(...codeChecks(ws, pkg));
  findings.push(...nativeChecks(ws, apks));
  findings.push(...keyFileChecks(ws));
  const scan = await scanPatterns(ws, (pkg || '').split('.').join('/'));
  findings.push(...scan.findings);

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  const result = { version: AUDIT_VERSION, generated: new Date().toISOString(), package: pkg, targetSdk: overview.targetSdk, minSdk: overview.minSdk,
    signing, findings, counts, scannedFiles: scan.scanned, scanError: scan.error || null };
  fs.writeFileSync(cached, JSON.stringify(result));
  return result;
}

async function getAudit(ws, force = false) {
  const cached = path.join(ws, 'audit.json');
  if (!force && fs.existsSync(cached)) {
    try {
      const r = JSON.parse(fs.readFileSync(cached, 'utf8'));
      if (r.version === AUDIT_VERSION) return r;
    } catch { /* re-run */ }
  }
  return runAudit(ws);
}

module.exports = { getAudit, apkFiles, SENSITIVE };
