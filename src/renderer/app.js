// App shell: sidebar navigation, home / history, project header, processing
// stepper and the Overview. All APK-derived text goes through textContent
// (el() below), never innerHTML.

import { initAssetsUi, loadAssets, resetAssets, devSelect, openFolder } from './assets.js';
import { initReportUi, loadReport } from './report.js';
import { initHome, loadHistory, appIcon } from './home.js';
import { icon, FOLDER_ICON } from './icons.js';
import { initCode, loadCode, resetCode, openFile } from './code.js';
import { initAudit, showAudit, resetAudit } from './audit.js';
import { initCompare, openCompare } from './compare.js';

const STAGES = [
  ['hash', 'Read file'],
  ['inspect', 'Check contents'],
  ['resources', 'Resources'],
  ['assets', 'Game assets'],
  ['code', 'Decompile code'],
  ['analyze', 'Analyse'],
  ['organize', 'Folders & report'],
];
const INPUT_RE = /\.(apk|xapk|apks|apkm)$/i;

const $ = id => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}
const withIcon = (name, label, size = 16) => [icon(name, size), el('span', { text: label })];
const fmtBytes = b => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`);
const fmtTime = s => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
const short = name => name.replace(/^android\.permission\./, '');

const app = { busy: false, sha: null, name: null, summary: null, overview: null, view: 'home' };

// ---------- static chrome ----------

function setupChrome() {
  $('brandMark').append(icon('logo', 20));
  $('addBtn').append(...withIcon('plus', 'Add APK'));
  $('heroAddBtn').append(...withIcon('plus', 'Choose an app file', 18));
  $('heroIcon').append(icon('download', 30));
  $('navHome').append(...withIcon('clock', 'History'));
  $('navCompare').append(...withIcon('compare', 'Compare versions'));
  $('compareBtn').append(...withIcon('compare', 'Compare'));
  $('navOverview').append(...withIcon('overview', 'Overview'));
  $('navAssets').append(...withIcon('box', 'Game assets'), el('span', { class: 'count', id: 'navAssetsCount' }));
  $('navCode').append(...withIcon('code', 'Code'));
  $('navAudit').append(...withIcon('shield', 'Release audit'));
  $('navReport').append(...withIcon('report', 'Report'));
  $('offlineNote').append(icon('shield', 14), el('span', { text: 'Offline · nothing is uploaded' }));
  $('cancelBtn').append(...withIcon('stop', 'Cancel'));
  $('folderBtn').append(...withIcon('folder', 'Open folders'));
  $('exportAllBtn').append(...withIcon('download', 'Export all'));
  $('historySearchIcon').append(icon('search', 15));
  $('assetSearchIcon').append(icon('search', 15));
  $('reportSearchIcon').append(icon('search', 15));
  setTheme(readTheme());
}

function readTheme() {
  try { return localStorage.getItem('theme') || 'dark'; } catch { return 'dark'; }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch { /* not persisted */ }
  $('themeBtn').replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon', 16));
}

// ---------- views ----------

function showView(name) {
  app.view = name;
  const home = name === 'home';
  const top = home || name === 'compare';
  $('home').hidden = !home;
  $('compare').hidden = name !== 'compare';
  $('project').hidden = top;
  for (const pane of ['overview', 'assets', 'code', 'audit', 'report']) $(pane).hidden = pane !== name;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === name);
  if (home) loadHistory();
  if (name === 'compare' && !app.compareOpened) { app.compareOpened = true; openCompare(app.sha); }
  if (name === 'audit' && app.sha) showAudit(app.sha);
}

// Code and audit become available once the workspace is known.
async function enableCode(sha) {
  if (!sha || app.codeSha === sha) return;
  app.codeSha = sha;
  const n = await loadCode(sha);
  $('navCode').disabled = !n;
  $('navAudit').disabled = false;
}

// ---------- processing stepper ----------

function renderStages() {
  $('pipeline').classList.remove('collapsed');
  $('pipelineToggle').hidden = true;
  $('stageList').replaceChildren(...STAGES.map(([id, label], i) => el('li', { class: 'step', id: `stage-${id}`, 'data-status': 'pending' },
    el('div', { class: 'step-head' }, el('span', { class: 'step-dot', text: String(i + 1) }), el('span', { class: 'step-name', text: label }), el('span', { class: 'step-pct' })),
    el('div', { class: `step-bar${id === 'code' || id === 'assets' ? '' : ' indeterminate'}` }, el('div')),
    el('div', { class: 'step-msg', text: 'Waiting' }))));
}

function onProgress({ stage, status, percent, message }) {
  const row = $(`stage-${stage}`);
  if (!row) return;
  row.dataset.status = status;
  const dot = row.querySelector('.step-dot');
  if (status === 'done') dot.replaceChildren(icon('check', 12));
  else if (status === 'failed') dot.replaceChildren(icon('x', 12));
  row.querySelector('.step-pct').textContent = status === 'running' && percent != null ? `${percent}%` : '';
  const bar = row.querySelector('.step-bar > div');
  if (percent != null) bar.style.width = `${percent}%`;
  else if (status !== 'running') bar.style.width = status === 'done' ? '100%' : '0';
  const msg = row.querySelector('.step-msg');
  if (message != null) { msg.textContent = message; msg.title = message; } else if (status === 'running') msg.textContent = 'Working…';
}

function finishPipeline(text, ok) {
  $('summary').replaceChildren(ok ? icon('check', 14) : icon('alert', 14), el('span', { text }));
  const toggle = $('pipelineToggle');
  toggle.hidden = false;
  $('pipeline').classList.add('collapsed');
  toggle.textContent = 'Show details';
}

// ---------- project header & overview ----------

function renderHeader(o) {
  app.name = o.appName || o.package || app.name;
  $('projName').textContent = app.name || 'Opening…';
  $('projPackage').textContent = o.package || '';
  const ic = appIcon({ sha: o.sha || app.sha, icon: o.icon, name: app.name }, 'xl');
  ic.id = 'projIcon';
  $('projIcon').replaceWith(ic);
  $('projChips').replaceChildren(...[
    o.engine ? el('span', { class: 'chip accent' }, icon('cpu', 12), `${o.engine} game`) : null,
    o.versionName ? el('span', { class: 'chip', text: `v${o.versionName} (${o.versionCode ?? '?'})` }) : null,
    ...o.frameworks.map(f => el('span', { class: 'chip quiet', text: f })),
    o.fileSize ? el('span', { class: 'chip quiet', text: fmtBytes(o.fileSize) }) : null,
    o.debuggable ? el('span', { class: 'chip warn', text: 'Debuggable build' }) : null,
  ].filter(Boolean));
  $('navApp').replaceChildren(appIcon({ sha: o.sha || app.sha, icon: o.icon, name: app.name }, 'sm'), el('span', { class: 'name', text: app.name }));
}

function stat(k, v) {
  return el('div', { class: 'stat' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v ?? '—' }));
}

function renderOverview(o) {
  app.overview = o;
  if (o.sha) app.sha = o.sha;
  renderHeader(o);
  const a = o.animations || {};
  const animTotal = Object.values(a).reduce((t, n) => t + n, 0);
  const dangerous = o.permissions.filter(p => p.dangerous);
  const exported = o.components.filter(c => c.exported);

  const perms = el('table', {},
    el('tr', {}, el('th', { text: 'Permission' }), el('th', { text: 'Meaning' })),
    ...o.permissions
      .slice()
      .sort((x, y) => y.dangerous - x.dangerous || x.name.localeCompare(y.name))
      .map(p => el('tr', {},
        el('td', { class: 'mono' }, short(p.name), p.dangerous ? el('span', { class: 'tag warn', text: 'dangerous' }) : null),
        el('td', { text: p.meaning }))));

  const comps = el('table', {},
    el('tr', {}, el('th', { text: 'Component' }), el('th', { text: 'Type' })),
    ...o.components
      .slice()
      .sort((x, y) => y.launcher - x.launcher || y.exported - x.exported)
      .map(c => el('tr', {},
        el('td', { class: 'mono' }, c.name,
          c.launcher ? el('span', { class: 'tag good', text: 'launcher' }) : null,
          c.exported ? el('span', { class: 'tag warn', text: 'exported' }) : null),
        el('td', { text: c.type }))));

  const anims = el('table', {},
    el('tr', {}, el('th', { text: 'Android animation type' }), el('th', { text: 'Files' })),
    ...[
      ['View animations (res/anim)', a.viewAnimations],
      ['Property animators (res/animator)', a.propertyAnimators],
      ['Animated vector drawables', a.animatedVectors],
      ['Frame animations (animation-list)', a.frameAnimations],
      ['Lottie candidates (.json, .lottie)', a.lottie],
      ['GIF', a.gifs],
      ['Rive (.riv)', a.rive],
    ].map(([k, v]) => el('tr', {}, el('td', { text: k }), el('td', { text: String(v ?? 0) }))));

  const first = !$('contentSummary');
  $('overview').replaceChildren(
    el('div', { id: 'contentSummary' }),
    el('h3', {}, icon('overview', 16), 'App details'),
    el('div', { class: 'grid' },
      stat('Version', `${o.versionName ?? '?'} (${o.versionCode ?? '?'})`),
      stat('Min / target SDK', `${o.minSdk ?? '?'} / ${o.targetSdk ?? '?'}`),
      stat('APK size', fmtBytes(o.fileSize)),
      stat('Files inside', o.entryCount.toLocaleString()),
      o.containers && o.containers.length > 1 ? stat('Packages in bundle', String(o.containers.length)) : null,
      stat('DEX files', String(o.dexFiles)),
      stat('Permissions', `${o.permissions.length} (${dangerous.length} dangerous)`),
      stat('Components', `${o.components.length} (${exported.length} exported)`),
      stat('Android animation files', String(animTotal)),
      ...o.nativeLibs.map(l => stat(`Native ${l.abi}`, fmtBytes(l.bytes)))),
    el('h3', {}, icon('shield', 16), 'Permissions'), el('div', { class: 'card-box' }, perms),
    el('h3', {}, icon('cpu', 16), 'Components'), el('div', { class: 'card-box' }, comps),
    el('h3', {}, icon('play', 16), 'Android UI animations'), el('div', { class: 'card-box' }, anims));
  if (first) $('overview').scrollTop = 0;
  renderContent();
}

function renderContent() {
  const box = document.getElementById('contentSummary');
  if (!box || !app.summary) return;
  const s = app.summary;
  const ok = (s.entryStatus.decoded || 0) + (s.entryStatus.extracted || 0);
  box.replaceChildren(
    el('h3', {}, icon('folder', 16), 'Available content'),
    el('div', { class: 'muted small', style: 'margin:-6px 0 12px', text: `${s.archiveEntries.toLocaleString()} archive entries, ${ok.toLocaleString()} extracted or decoded · ${s.assets.toLocaleString()} assets` }),
    el('div', { class: 'grid content-grid' }, ...Object.entries(s.folders).map(([f, n]) => el('button', {
      class: 'folder-card', disabled: n ? null : '', title: `Show ${f}`,
      onclick: () => { showView('assets'); openFolder(f); },
    }, el('div', { class: 'fi' }, icon(FOLDER_ICON[f] || 'folder', 18)), el('div', { class: 'fname', text: `${f}/` }),
    el('div', { class: 'fcount', text: `${n.toLocaleString()} files` })))));
}

// ---------- events from the pipeline ----------

async function onAssets(sha) {
  try {
    app.sha = sha;
    const data = await loadAssets(sha);
    $('navAssets').disabled = false;
    $('navAssetsCount').textContent = data.items.length.toLocaleString();
    if (data.engine && app.view === 'overview' && !app.busyOpenedFromHistory) showView('assets');
  } catch (err) {
    $('summary').textContent = `Could not load assets: ${err.message}`;
  }
}

async function onReport(sha) {
  try {
    app.sha = sha;
    app.summary = await loadReport(sha);
    enableCode(sha);
    $('navReport').disabled = false;
    $('folderBtn').hidden = false;
    $('exportAllBtn').hidden = false;
    $('compareBtn').hidden = false;
    renderContent();
  } catch (err) {
    $('summary').textContent = `Could not load the report: ${err.message}`;
  }
}

// ---------- opening ----------

function beginProject(label) {
  app.busy = true;
  app.sha = null;
  app.summary = null;
  app.name = null;
  resetAssets();
  resetCode();
  resetAudit();
  app.codeSha = null;
  $('navCode').disabled = true;
  $('navAudit').disabled = true;
  $('navProject').hidden = false;
  $('navApp').replaceChildren(el('div', { class: 'app-icon sm letter', text: '…' }), el('span', { class: 'name', text: label }));
  $('navAssets').disabled = true;
  $('navReport').disabled = true;
  $('navAssetsCount').textContent = '';
  $('projName').textContent = label;
  $('projPackage').textContent = '';
  $('projChips').replaceChildren();
  const ph = el('div', { class: 'app-icon xl letter', id: 'projIcon', text: (label || '?').charAt(0).toUpperCase() });
  $('projIcon').replaceWith(ph);
  $('folderBtn').hidden = true;
  $('exportAllBtn').hidden = true;
  $('compareBtn').hidden = true;
  $('summary').replaceChildren();
  $('overview').replaceChildren(el('div', { class: 'placeholder', text: 'The overview appears as soon as the manifest is decoded…' }));
  $('overview').scrollTop = 0;
  renderStages();
  showView('overview');
}

function endProject(r) {
  app.busy = false;
  $('cancelBtn').hidden = true;
  if (r.ok) enableCode(r.sha);
  if (r.ok) finishPipeline(r.fromCache ? 'Opened from history · results are cached on this computer' : `Finished in ${fmtTime(r.seconds || 0)}`, true);
  else finishPipeline(r.error === 'Cancelled' ? 'Cancelled' : `Stopped: ${r.error}`, false);
  loadHistory();
}

async function openApk(file) {
  if (!file) return;
  if (!INPUT_RE.test(file)) {
    alert('Please choose an .apk, .xapk, .apks or .apkm file.');
    return;
  }
  app.busyOpenedFromHistory = false;
  beginProject(file.split(/[\\/]/).pop());
  $('cancelBtn').hidden = false;
  endProject(await window.api.decode(file));
}

async function openFromHistory(entry) {
  app.busyOpenedFromHistory = true;
  beginProject(entry.name);
  endProject(await window.api.openWorkspace(entry.sha));
}

const pickAndOpen = async () => openApk(await window.api.pickApk());

// ---------- wiring ----------

setupChrome();
initHome(entry => openFromHistory(entry));
initCode();
initAudit((root, file, line) => { showView('code'); openFile(root, file, line); });
initCompare({ onAddApk: () => pickAndOpen() });
$('compareBtn').addEventListener('click', () => { app.compareOpened = true; showView('compare'); openCompare(app.sha); });
initAssetsUi();
initReportUi();
window.api.onProgress(onProgress);
window.api.onOverview(renderOverview);
window.api.onAssets(onAssets);
window.api.onReport(onReport);
window.api.onOpenPath(openApk);

for (const b of document.querySelectorAll('.nav-item')) b.addEventListener('click', () => !b.disabled && showView(b.dataset.view));
$('addBtn').addEventListener('click', pickAndOpen);
$('heroAddBtn').addEventListener('click', e => { e.stopPropagation(); pickAndOpen(); });
$('drop').addEventListener('click', pickAndOpen);
$('drop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') pickAndOpen(); });
$('themeBtn').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$('cancelBtn').addEventListener('click', () => app.busy && window.api.cancel());
$('folderBtn').addEventListener('click', () => app.sha && window.api.openExtracted(app.sha));
$('pipelineToggle').addEventListener('click', () => {
  const collapsed = $('pipeline').classList.toggle('collapsed');
  $('pipelineToggle').textContent = collapsed ? 'Show details' : 'Hide details';
});
$('exportAllBtn').addEventListener('click', async () => {
  if (!app.sha) return;
  const btn = $('exportAllBtn');
  btn.disabled = true;
  btn.replaceChildren(...withIcon('download', 'Exporting…'));
  const r = await window.api.exportAll(app.sha, app.name);
  btn.disabled = false;
  btn.replaceChildren(...withIcon('download', 'Export all'));
  if (r.ok) $('summary').replaceChildren(icon('check', 14), el('span', { text: `Exported to ${r.path}` }));
  else if (r.error) $('summary').textContent = `Export failed: ${r.error}`;
});
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pickAndOpen(); }
});

// Drag-and-drop anywhere in the window.
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) { $('dropOverlay').hidden = false; $('drop').classList.add('over'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; $('drop').classList.remove('over'); } });
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  $('drop').classList.remove('over');
  const file = e.dataTransfer.files[0];
  if (file) openApk(window.api.pathForFile(file));
});

showView('home');

// Hooks for dev screenshots (APKX_SCRIPT); harmless in normal use.
window.__dev = { showView, showTab: showView, devSelect, openFromHistory, setTheme, openFile, openCompare };
