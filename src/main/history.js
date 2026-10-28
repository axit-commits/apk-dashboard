// History of opened apps, kept in <userData>/history.json. Each entry points at
// a finished workspace, so a project reopens from its cache even when the
// original APK file has moved. Built from existing workspaces on first use.

const fs = require('fs');
const path = require('path');
const { resolveIcon } = require('./analyze');

const MAX = 200;

function readMeta(ws) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ws, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function entryFromWorkspace(ws, openedAt) {
  const meta = readMeta(ws);
  if (!meta || !meta.done) return null;
  const o = meta.overview || {};
  let icon = o.icon;
  if (icon === undefined && fs.existsSync(path.join(ws, 'apktool'))) {
    const manifest = path.join(ws, 'apktool', 'AndroidManifest.xml');
    const ref = fs.existsSync(manifest) ? (fs.readFileSync(manifest, 'utf8').match(/<application[^>]*android:icon="([^"]+)"/) || [])[1] : null;
    icon = resolveIcon(path.join(ws, 'apktool'), ref);
  }
  const ex = meta.extracted || {};
  const inputPath = meta.inputPath || meta.apkPath || null;
  return {
    sha: meta.sha256 || path.basename(ws),
    inputPath,
    inputName: inputPath ? path.basename(inputPath) : null,
    name: o.appName || o.package || (inputPath ? path.basename(inputPath) : 'Unknown app'),
    package: o.package || null,
    version: o.versionName || null,
    versionCode: o.versionCode != null ? Number(o.versionCode) : null,
    engine: meta.stages?.assets?.engine || o.engine || null,
    icon: icon || null,
    fileSize: o.fileSize || null,
    assets: ex.assets ?? meta.stages?.assets?.items ?? null,
    entries: ex.archiveEntries ?? null,
    seconds: meta.seconds || null,
    openedAt: openedAt || fs.statSync(path.join(ws, 'meta.json')).mtimeMs,
  };
}

class History {
  constructor(file, workRoot) {
    this.file = file;
    this.workRoot = workRoot;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // First run: build it from the workspaces already on disk.
      const root = this.workRoot();
      const list = fs.existsSync(root)
        ? fs.readdirSync(root).map(d => entryFromWorkspace(path.join(root, d))).filter(Boolean)
        : [];
      this.save(list);
      return list;
    }
  }

  // Apps removed from history whose files were kept: never re-added by the scan.
  hidden() {
    try { return new Set(JSON.parse(fs.readFileSync(this.file.replace(/\.json$/, '-hidden.json'), 'utf8'))); } catch { return new Set(); }
  }

  setHidden(set) {
    fs.writeFileSync(this.file.replace(/\.json$/, '-hidden.json'), JSON.stringify([...set]));
  }

  save(list) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    list.sort((a, b) => b.openedAt - a.openedAt);
    fs.writeFileSync(this.file, JSON.stringify(list.slice(0, MAX), null, 1));
  }

  record(ws) {
    const entry = entryFromWorkspace(ws, Date.now());
    if (!entry) return null;
    const list = this.load().filter(e => e.sha !== entry.sha);
    list.unshift(entry);
    const hidden = this.hidden();
    if (hidden.delete(entry.sha)) this.setHidden(hidden);
    this.save(list);
    return entry;
  }

  // Entries whose workspace still exists, with whether the original file is still there.
  list() {
    const root = this.workRoot();
    let changed = false;
    // Fill in fields older entries lack, and pick up finished workspaces that
    // were processed outside the window (for example from the command line).
    const list = this.load().map(e => {
      if (e.versionCode !== undefined) return e;
      changed = true;
      return entryFromWorkspace(path.join(root, e.sha), e.openedAt) || e;
    });
    const known = new Set([...list.map(e => e.sha), ...this.hidden()]);
    for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      if (known.has(d)) continue;
      const entry = entryFromWorkspace(path.join(root, d));
      if (entry) { list.push(entry); changed = true; }
    }
    if (changed) this.save(list);
    return list
      .filter(e => fs.existsSync(path.join(root, e.sha, 'meta.json')))
      .sort((a, b) => b.openedAt - a.openedAt)
      .map(e => ({ ...e, fileExists: !!e.inputPath && fs.existsSync(e.inputPath) }));
  }

  remove(sha, deleteData) {
    this.save(this.load().filter(e => e.sha !== sha));
    if (!deleteData) {
      const hidden = this.hidden();
      hidden.add(sha);
      this.setHidden(hidden);
    }
    if (deleteData && /^[0-9a-f]{64}$/.test(sha)) fs.rmSync(path.join(this.workRoot(), sha), { recursive: true, force: true });
  }
}

module.exports = { History };
