// Decode pipeline: hash -> inspect -> apktool + jadx + game assets in
// parallel -> analyze. Results live in <workRoot>/<sha256>/ so reopening an
// APK is instant.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJava, toolPaths } = require('./tools');
const { analyze, resolveIcon } = require('./analyze');
const { extractGameAssets, openContainers } = require('./gameassets');
const { organize } = require('./organize');
const { applyAndroidAnimations } = require('./androidanim');

const META_VERSION = 3;
const MAX_UNPACKED_BYTES = 16 * 1024 ** 3; // zip-bomb guard: 16 GB unpacked
const MAX_RATIO = 200; // and no more than 200:1 overall

const STAGES = ['hash', 'inspect', 'resources', 'assets', 'code', 'analyze', 'organize'];

function hashFile(file, signal) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    const abort = () => s.destroy(new Error('Cancelled'));
    if (signal) signal.addEventListener('abort', abort, { once: true });
    s.on('data', d => h.update(d));
    s.on('error', reject);
    s.on('end', () => {
      if (signal) signal.removeEventListener('abort', abort);
      resolve(h.digest('hex'));
    });
  });
}

function readMeta(ws) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ws, 'meta.json'), 'utf8'));
    return meta.version === META_VERSION ? meta : null;
  } catch {
    return null;
  }
}

function writeMeta(ws, meta) {
  fs.writeFileSync(path.join(ws, 'meta.json'), JSON.stringify(meta, null, 2));
}

async function decode(inputPath, { workRoot, onProgress = () => {}, onOverview = () => {}, onAssets = () => {}, onReport = () => {}, signal } = {}) {
  toolPaths(); // fail fast if vendor/ is missing
  const started = Date.now();
  const log = [];
  const lastStatus = {};
  const stage = (name, status, extra = {}) => {
    if (lastStatus[name] !== status || (status !== 'running' && extra.message)) {
      log.push(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${name}: ${status}${extra.message ? ` - ${extra.message}` : ''}`);
      lastStatus[name] = status;
    }
    onProgress({ stage: name, status, ...extra });
  };

  stage('hash', 'running');
  const sha = await hashFile(inputPath, signal);
  stage('hash', 'done', { message: sha.slice(0, 12) });

  const ws = path.join(workRoot, sha);
  const cached = openCached(ws, { onProgress, onOverview, onAssets, onReport });
  if (cached) return cached;
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  const meta = { version: META_VERSION, sha256: sha, inputPath, stages: {}, done: false };

  stage('inspect', 'running');
  const { base: apkPath, containers, bundle } = await openContainers(inputPath, ws, signal);
  const all = containers.flatMap(c => c.entries);
  const unpacked = all.reduce((t, e) => t + e.size, 0);
  const packed = all.reduce((t, e) => t + e.compressedSize, 0) || 1;
  if (unpacked > MAX_UNPACKED_BYTES || unpacked / packed > MAX_RATIO) {
    throw new Error(`Refusing to unpack: ${(unpacked / 1024 ** 3).toFixed(1)} GB unpacked, ratio ${(unpacked / packed).toFixed(0)}:1`);
  }
  const entries = containers.find(c => c.file === apkPath).entries;
  meta.containers = containers.map(c => ({ label: c.label, files: c.entries.length }));
  meta.stages.inspect = { status: 'done', entries: all.length };
  stage('inspect', 'done', {
    message: containers.length > 1 ? `${containers.length} packages, ${all.length} files` : `${all.length} files`,
  });

  const apktoolDir = path.join(ws, 'apktool');
  const jadxDir = path.join(ws, 'jadx');
  const { apktool, jadx } = toolPaths();

  // Resources: manifest + res/ + assets/ (smali comes in a later phase).
  stage('resources', 'running');
  const resources = runJava(['-jar', apktool, 'd', '-f', '-s', '-o', apktoolDir, apkPath], {
    signal,
    onLine: line => {
      if (line.startsWith('I: ')) stage('resources', 'running', { message: line.slice(3) });
    },
  }).then(({ code, tail }) => {
    const ok = code === 0 && fs.existsSync(path.join(apktoolDir, 'AndroidManifest.xml'));
    meta.stages.resources = ok ? { status: 'done' } : { status: 'failed', error: tail.slice(-8).join('\n') };
    stage('resources', meta.stages.resources.status, { message: ok ? 'manifest, res/ and assets/ decoded' : meta.stages.resources.error });
    if (ok) {
      // Overview as soon as the manifest is readable; frameworks refine after jadx.
      meta.overview = { ...analyze({ apkPath, apktoolDir, jadxDir: null, entries }), sha };
      onOverview(meta.overview);
    }
    return ok;
  });
  resources.catch(() => {}); // awaited below; don't report it unhandled if assets fail first

  // Game assets: engine detection and extraction across every package.
  stage('assets', 'running', { percent: 0 });
  const assets = extractGameAssets({
    containers, bundle, ws, signal,
    onProgress: p => stage('assets', 'running', p),
  }).then(r => {
    meta.stages.assets = { status: 'done', engine: r.engine, items: r.items.length, errors: r.errors.length };
    stage('assets', 'done', {
      percent: 100,
      message: `${r.engine || 'No game engine'} · ${r.items.length} assets${r.errors.length ? ` · ${r.errors.length} errors` : ''}`,
    });
    onAssets(ws);
  }, err => {
    if (signal?.aborted) throw err;
    meta.stages.assets = { status: 'failed', error: err.message };
    stage('assets', 'failed', { message: err.message });
  });

  // Code: every DEX to Java source, after the assets so they don't compete
  // for CPU (game APKs carry large SDKs). Failed classes don't fail the stage.
  stage('code', 'running', { message: 'waiting for game assets' });
  await assets;
  stage('code', 'running', { percent: 0 });
  const threads = Math.max(1, Math.min(os.cpus().length - 1, 8));
  const code = runJava(['-cp', jadx, 'jadx.cli.JadxCLI', '--no-res', '-j', String(threads),
    '--log-level', 'progress', '-d', jadxDir, apkPath], {
    signal,
    onLine: line => {
      const m = line.match(/progress: (\d+) of (\d+)/);
      if (m) stage('code', 'running', { percent: Math.round((100 * m[1]) / m[2]), message: `${m[1]} of ${m[2]} classes` });
    },
  }).then(({ code: exit, tail }) => {
    const errors = Number((tail.join('\n').match(/finished with errors, count: (\d+)/) || [])[1] || 0);
    const ok = fs.existsSync(path.join(jadxDir, 'sources'));
    meta.stages.code = ok ? { status: 'done', failedClasses: errors, exit } : { status: 'failed', error: tail.slice(-8).join('\n') };
    stage('code', meta.stages.code.status, {
      percent: 100,
      message: ok ? (errors ? `${errors} classes could not be decompiled` : 'all classes decompiled') : meta.stages.code.error,
    });
    return ok;
  });

  const [resOk, codeOk] = await Promise.all([resources, code]);

  stage('analyze', 'running');
  if (resOk) {
    meta.overview = { ...analyze({ apkPath, apktoolDir, jadxDir: codeOk ? jadxDir : null, entries }), sha };
    meta.overview.engine = meta.stages.assets?.engine || null;
    meta.overview.containers = meta.containers;
    onOverview(meta.overview);
    meta.stages.analyze = { status: 'done' };
  } else {
    meta.stages.analyze = { status: 'skipped' };
  }
  stage('analyze', meta.stages.analyze.status);

  // Android UI animations and Lottie files join the game assets.
  try { if (resOk) applyAndroidAnimations(ws); } catch (err) { log.push(`android animations: ${err.message}`); }

  // Category folders, statuses for apktool/jadx entries, and the report.
  stage('organize', 'running', { message: 'Building the category folders' });
  try {
    const { summary } = organize({ ws, stages: meta.stages, overview: meta.overview, log });
    meta.stages.organize = { status: 'done' };
    meta.extracted = summary;
    const files = Object.values(summary.folders).reduce((a, b) => a + b, 0);
    stage('organize', 'done', { message: `${files.toLocaleString()} files in 10 folders · report written` });
    onReport(ws);
  } catch (err) {
    meta.stages.organize = { status: 'failed', error: err.message };
    stage('organize', 'failed', { message: err.message });
  }

  meta.done = true;
  meta.seconds = Math.round((Date.now() - started) / 1000);
  writeMeta(ws, meta);
  return { workspace: ws, meta, fromCache: false };
}

// Replays a finished workspace (from the cache or the history list).
function openCached(ws, { onProgress = () => {}, onOverview = () => {}, onAssets = () => {}, onReport = () => {} } = {}) {
  const cached = readMeta(ws);
  if (!cached || !cached.done) return null;
  onProgress({ stage: 'hash', status: 'done', message: path.basename(ws).slice(0, 12) });
  for (const s of STAGES.slice(1)) onProgress({ stage: s, status: cached.stages[s]?.status || 'done', message: 'from cache' });
  const o = { ...cached.overview, sha: path.basename(ws) };
  if (o.icon === undefined) {
    // Workspaces from before icons were recorded: resolve it now.
    const manifest = path.join(ws, 'apktool', 'AndroidManifest.xml');
    const ref = fs.existsSync(manifest) ? (fs.readFileSync(manifest, 'utf8').match(/<application[^>]*android:icon="([^"]+)"/) || [])[1] : null;
    o.icon = resolveIcon(path.join(ws, 'apktool'), ref);
  }
  onOverview(o);
  // Projects processed before Android animations were listed get them now.
  try {
    const assets = JSON.parse(fs.readFileSync(path.join(ws, 'game', 'assets.json'), 'utf8'));
    if (assets.androidAnims === undefined) applyAndroidAnimations(ws);
  } catch { /* no game assets */ }
  if (cached.stages.assets?.status === 'done') onAssets(ws);
  if (cached.stages.organize?.status === 'done') onReport(ws);
  return { workspace: ws, meta: cached, fromCache: true };
}

module.exports = { decode, openCached, STAGES };
