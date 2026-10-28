// Electron main process: window, file picker, the decode job, and the
// private apkx:// protocol that serves the UI and workspace files.

const { app, BrowserWindow, dialog, ipcMain, protocol, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { decode, openCached } = require('./pipeline');
const { History } = require('./history');
const code = require('./code');
const { getAudit } = require('./audit');
const { diffFile, COMPARE_VERSION } = require('./compare');
const { Worker } = require('worker_threads');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const THREE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'three');
const LOTTIE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'lottie-web', 'build', 'player');
const workRoot = () => path.join(app.getPath('userData'), 'workspaces');
const INPUT_EXTENSIONS = ['apk', 'xapk', 'apks', 'apkm'];
const history = new History(path.join(app.getPath('userData'), 'history.json'), workRoot);

let win;
let job = null; // { controller }

protocol.registerSchemesAsPrivileged([
  { scheme: 'apkx', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'text/plain', '.fbx': 'application/octet-stream',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.opus': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
};

// Maps an apkx:// URL to a file inside an allowed root, or null.
function resolveUrl(url) {
  const u = new URL(url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  let root;
  let file;
  if (u.host === 'app' && rel.startsWith('lottie/')) {
    root = LOTTIE_DIR;
    file = path.join(LOTTIE_DIR, rel.slice('lottie/'.length));
  } else if (u.host === 'app' && rel.startsWith('three/')) {
    root = THREE_DIR;
    file = path.join(THREE_DIR, rel.slice('three/'.length));
  } else if (u.host === 'app') {
    root = RENDERER_DIR;
    file = path.join(RENDERER_DIR, rel || 'index.html');
  } else if (u.host === 'ws') {
    root = workRoot();
    file = path.join(root, rel);
  } else {
    return null;
  }
  const resolved = path.resolve(file);
  return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
}

async function serve(request) {
  const file = resolveUrl(request.url);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' apkx://ws blob: data:; media-src apkx://ws blob:; font-src apkx://ws; " +
      "connect-src 'self' apkx://ws blob: data:; object-src 'none'; base-uri 'none'",
  };

  // three.js addons import the bare specifier 'three'; point it at the build.
  if (file.startsWith(THREE_DIR) && file.endsWith('.js')) {
    const src = fs.readFileSync(file, 'utf8').replace(/from 'three'/g, "from '/three/build/three.module.js'");
    return new Response(src, { headers });
  }

  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    headers: { ...headers, 'Content-Length': String(size) },
  });
}

// A path inside the workspaces folder, from a renderer-supplied relative path.
function workspacePath(rel) {
  const p = path.resolve(workRoot(), String(rel || ''));
  return p.startsWith(path.resolve(workRoot()) + path.sep) ? p : null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 600,
    title: 'APK Explorer',
    backgroundColor: '#15171c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadURL('apkx://app/index.html');

  // The page never navigates or opens windows.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // "Open with" / command line: electron . path/to/app.apk
  const re = new RegExp(`\\.(${INPUT_EXTENSIONS.join('|')})$`, 'i');
  const apkArg = process.argv.slice(1).find(a => re.test(a));
  if (apkArg) win.webContents.once('did-finish-load', () => win.webContents.send('open-path', path.resolve(apkArg)));
  else if (process.env.APKX_SCREENSHOT) win.webContents.once('did-finish-load', () => devScreenshot());
}

// Dev only: APKX_SCREENSHOT=out.png saves the window after a decode, then quits.
// APKX_SCRIPT=file.js runs that script in the page first (to open a view).
async function devScreenshot() {
  const out = process.env.APKX_SCREENSHOT;
  if (!out || !win || win.isDestroyed()) return;
  await new Promise(r => setTimeout(r, 800));
  if (process.env.APKX_SCRIPT) {
    await win.webContents.executeJavaScript(fs.readFileSync(process.env.APKX_SCRIPT, 'utf8'));
    await new Promise(r => setTimeout(r, Number(process.env.APKX_WAIT || 2500)));
  }
  fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
  app.quit();
}

// Offline by design: refuse every request that isn't the app's own protocol.
function blockNetwork() {
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = /^(apkx|devtools|blob|data):/.test(details.url);
    cb({ cancel: !ok });
  });
}

ipcMain.handle('pick-apk', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open Android app',
    properties: ['openFile'],
    filters: [{ name: 'Android apps (APK, XAPK, APKS, APKM)', extensions: INPUT_EXTENSIONS }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('decode', async (_e, apkPath) => {
  if (job) job.controller.abort();
  const controller = new AbortController();
  job = { controller };
  const send = (ch, data) => !win.isDestroyed() && win.webContents.send(ch, data);
  try {
    const r = await decode(apkPath, {
      workRoot: workRoot(),
      signal: controller.signal,
      onProgress: p => send('progress', p),
      onOverview: o => send('overview', o),
      onAssets: ws => send('assets', path.basename(ws)),
      onReport: ws => send('report', path.basename(ws)),
    });
    history.record(r.workspace);
    return { ok: true, workspace: r.workspace, sha: path.basename(r.workspace), fromCache: r.fromCache, seconds: r.meta.seconds, stages: r.meta.stages };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (job && job.controller === controller) job = null;
    devScreenshot();
  }
});

ipcMain.handle('history-list', () => history.list());

// Code browser.
const wsOf = sha => workspacePath(String(sha || ''));
ipcMain.handle('code-roots', (_e, sha) => { const ws = wsOf(sha); return ws ? code.roots(ws).map(({ id, label, sub }) => ({ id, label, sub })) : []; });
ipcMain.handle('code-list', (_e, sha, root, rel) => { const ws = wsOf(sha); return ws ? code.listDir(ws, root, rel) : []; });
ipcMain.handle('code-file', (_e, sha, root, rel) => { const ws = wsOf(sha); return ws ? code.readFile(ws, root, rel) : { error: 'No project' }; });
ipcMain.handle('code-search', (_e, sha, opts) => {
  const ws = wsOf(sha);
  if (!ws || !opts?.query) return null;
  return code.startSearch(ws, opts, (id, m) => !win.isDestroyed() && win.webContents.send('code-search', { id, ...m }));
});
ipcMain.handle('code-search-cancel', (_e, id) => code.cancelSearch(id));

// Version comparison: cached per pair in <userData>/compares/, computed in a worker.
ipcMain.handle('compare-run', (_e, shaA, shaB, force) => {
  const wsA = wsOf(shaA);
  const wsB = wsOf(shaB);
  if (!wsA || !wsB || !fs.existsSync(wsA) || !fs.existsSync(wsB)) return { error: 'Both versions must be processed first' };
  const dir = path.join(app.getPath('userData'), 'compares');
  const cache = path.join(dir, `${shaA}_${shaB}.json`);
  if (!force && fs.existsSync(cache)) {
    try {
      const r = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (r.version === COMPARE_VERSION) return r;
    } catch { /* recompute */ }
  }
  return new Promise(resolve => {
    const worker = new Worker(path.join(__dirname, 'compareworker.js'), { workerData: { wsA, wsB } });
    worker.on('message', m => {
      if (m.progress && !win.isDestroyed()) win.webContents.send('compare-progress', m.progress);
      if (m.result) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cache, JSON.stringify(m.result));
        resolve(m.result);
      }
      if (m.error) resolve({ error: m.error });
    });
    worker.on('error', err => resolve({ error: err.message }));
  });
});

ipcMain.handle('compare-diff', (_e, shaA, shaB, root, rel) => {
  const wsA = wsOf(shaA);
  const wsB = wsOf(shaB);
  if (!wsA || !wsB) return { error: 'No project' };
  try {
    return diffFile(wsA, wsB, root === 'res' ? 'res' : 'java', String(rel || ''));
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('audit-run', async (_e, sha, force) => {
  const ws = wsOf(sha);
  if (!ws) return { error: 'No project' };
  try {
    return await getAudit(ws, !!force);
  } catch (err) {
    return { error: err.message };
  }
});

// Opens a finished project straight from its workspace (no need for the original file).
ipcMain.handle('open-workspace', (_e, sha) => {
  const ws = workspacePath(String(sha || ''));
  const send = (ch, data) => !win.isDestroyed() && win.webContents.send(ch, data);
  const r = ws && openCached(ws, {
    onProgress: p => send('progress', p),
    onOverview: o => send('overview', o),
    onAssets: w => send('assets', path.basename(w)),
    onReport: w => send('report', path.basename(w)),
  });
  if (!r) return { ok: false, error: 'This project is no longer available' };
  history.record(ws);
  return { ok: true, workspace: ws, sha: path.basename(ws), fromCache: true, seconds: r.meta.seconds, inputPath: r.meta.inputPath, stages: r.meta.stages };
});

ipcMain.handle('history-remove', async (_e, sha, name) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    message: `Remove "${name || 'this app'}" from history?`,
    detail: 'Removing it from history keeps its extracted files. Deleting also removes the extracted folders and cache from this computer.',
    buttons: ['Remove from history', 'Remove and delete files', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });
  if (r.response === 2) return false;
  history.remove(String(sha || ''), r.response === 1);
  return true;
});

ipcMain.handle('cancel', () => {
  if (job) job.controller.abort();
});

ipcMain.handle('show-folder', (_e, dir) => {
  const p = path.resolve(String(dir || ''));
  if (p.startsWith(path.resolve(workRoot()) + path.sep)) shell.openPath(p);
});

ipcMain.handle('show-item', (_e, rel) => {
  const p = workspacePath(rel);
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});

const extractedDir = sha => workspacePath(path.join(String(sha || ''), 'Extracted'));

ipcMain.handle('open-extracted', (_e, sha) => {
  const dir = extractedDir(sha);
  if (dir && fs.existsSync(dir)) shell.openPath(dir);
});

ipcMain.handle('open-report', (_e, sha) => {
  const dir = extractedDir(sha);
  const file = dir && path.join(dir, 'EXTRACTION_REPORT.html');
  if (file && fs.existsSync(file)) shell.openPath(file);
});

// Copies the whole Extracted folder (real files, not links) to a folder the user picks.
ipcMain.handle('export-all', async (_e, sha, name) => {
  const src = extractedDir(sha);
  if (!src || !fs.existsSync(src)) return { ok: false, error: 'Nothing extracted yet' };
  const r = await dialog.showOpenDialog(win, { title: 'Export all extracted files to…', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  const dest = path.join(r.filePaths[0], `${String(name || 'APK').replace(/[^A-Za-z0-9._ -]+/g, '_')} - extracted`);
  await fs.promises.cp(src, dest, { recursive: true, force: true });
  shell.openPath(dest);
  return { ok: true, path: dest };
});

// Saves data made in the page (e.g. a recorded animation video) where the user picks.
ipcMain.handle('save-buffer', async (_e, name, data) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: String(name || 'animation').replace(/[\\/:*?"<>|]+/g, '_') });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return { ok: true, path: r.filePath };
});

ipcMain.handle('export-file', async (_e, rel) => {
  const src = workspacePath(rel);
  if (!src || !fs.existsSync(src)) return { ok: false, error: 'File not found' };
  const r = await dialog.showSaveDialog(win, { defaultPath: path.basename(src) });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.copyFileSync(src, r.filePath);
  return { ok: true, path: r.filePath };
});

app.whenReady().then(() => {
  protocol.handle('apkx', serve);
  blockNetwork();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (job) job.controller.abort();
  if (process.platform !== 'darwin') app.quit();
});
