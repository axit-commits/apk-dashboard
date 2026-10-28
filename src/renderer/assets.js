// Game assets browser: categories, search, filters, card grid and previews.
// Everything from the APK is set through textContent / src, never innerHTML.

import { createViewer } from './viewer3d.js';
import { createSpineViewer } from './spineViewer.js';
import { CATEGORY_ICON, FOLDER_ICON, icon as svgIcon } from './icons.js';
import { createViewAnimPlayer, createAnimatorPlayer, createAvdPlayer, createFramePlayer, createLottiePlayer, recordCanvas } from './animplayer.js';

// The output folders, in order: [folder, icon, asset categories, is a sub-folder].
const FOLDERS = [
  ['3D_Models', FOLDER_ICON['3D_Models'], ['models', 'characters']],
  ['3D_Models/Characters', FOLDER_ICON['3D_Models/Characters'], ['characters'], true],
  ['Animations', FOLDER_ICON.Animations, ['animations']],
  ['Textures', FOLDER_ICON.Textures, ['textures']],
  ['Materials_Shaders', FOLDER_ICON.Materials_Shaders, ['materials', 'shaders']],
  ['Audio_Music', FOLDER_ICON.Audio_Music, ['audio']],
  ['Videos_Cutscenes', FOLDER_ICON.Videos_Cutscenes, ['video']],
  ['Scenes_Maps', FOLDER_ICON.Scenes_Maps, ['scenes']],
  ['UI_Assets', FOLDER_ICON.UI_Assets, ['ui']],
  ['Scripts_Data', FOLDER_ICON.Scripts_Data, ['text']],
  ['Other_Assets', FOLDER_ICON.Other_Assets, ['packages', 'other']],
];
const STATUS_LABEL = { decoded: 'decoded', extracted: 'extracted', partial: 'partial', unsupported: 'unsupported',
  encrypted: 'encrypted', corrupted: 'corrupted', missing: 'missing' };
const OK = new Set(['decoded', 'extracted']);
const PAGE = 300;

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
const fmtBytes = b => (b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b || 0} B`);
const ext = f => (f && (f.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();

const state = {
  sha: null, data: null, byKey: new Map(), category: 'all', query: '', type: '', status: '', previewOnly: false,
  sort: 'name', shown: PAGE, selected: null, viewer: null,
};
const relUrl = rel => `apkx://ws/${state.sha}/game/${rel.split('/').map(encodeURIComponent).join('/')}`;
const fileUrl = item => relUrl(item.file);
// URL of a file relative to the workspace (e.g. apktool/res/...).
const wsUrl = rel => `apkx://ws/${state.sha}/${rel.split('/').map(encodeURIComponent).join('/')}`;
const fetchText = async url => { const r = await fetch(url); if (!r.ok) throw new Error('file not found'); return r.text(); };
let androidValues = { sha: null, data: null };
async function valuesFor() {
  if (androidValues.sha !== state.sha) {
    androidValues = { sha: state.sha, data: await fetch(relUrl('android-values.json')).then(r => (r.ok ? r.json() : {})).catch(() => ({})) };
  }
  return androidValues.data;
}
const wsRel = item => (item.output ? `${state.sha}/Extracted/${item.output}` : `${state.sha}/game/${item.file}`);
const folderCats = key => (FOLDERS.find(f => f[0] === key) || [null, null, null])[2];

export async function loadAssets(sha) {
  const res = await fetch(`apkx://ws/${sha}/game/assets.json`);
  if (!res.ok) throw new Error('assets.json not found');
  state.sha = sha;
  state.data = await res.json();
  state.byKey = new Map(state.data.items.filter(i => i.key).map(i => [i.key, i]));
  state.category = firstCategory();
  state.shown = PAGE;
  state.selected = null;
  renderCats();
  renderGrid();
  showEmptyPreview();
  return state.data;
}

const folderCount = key => (folderCats(key) || []).reduce((n, c) => n + ((state.data.counts || {})[c] || 0), 0);

function firstCategory() {
  if ((state.data.counts || {}).characters) return '3D_Models/Characters';
  return (FOLDERS.find(([k, , , sub]) => !sub && folderCount(k)) || ['all'])[0];
}

function renderCats() {
  const d = state.data;
  const c = d.counts || {};
  const btn = (key, label, icon, count) => el('button', {
    class: `cat${state.category === key ? ' active' : ''}`,
    onclick: () => { state.category = key; state.type = ''; state.shown = PAGE; renderCats(); renderGrid(); },
  }, el('span', { class: 'cat-icon' }, svgIcon(icon, 16)), el('span', { class: 'cat-label', text: label }), el('span', { class: 'cat-count', text: count.toLocaleString() }));
  const folderBtn = ([key, icon, , sub]) => {
    const b = btn(key, sub ? key.split('/').pop() : `${key}/`, icon, folderCount(key));
    if (sub) b.classList.add('sub');
    if (!folderCount(key)) b.classList.add('empty');
    return b;
  };

  const engine = el('div', { class: 'engine' },
    el('div', { class: 'k', text: 'Engine' }),
    el('div', { class: 'v', text: d.engine || 'None detected' }),
    d.unity?.version ? el('div', { class: 'muted small', text: `Unity ${d.unity.version}` }) : null,
    d.unity ? el('div', { class: 'muted small', text: `${d.unity.objectCount.toLocaleString()} objects read` }) : null);

  const extra = [];
  if (d.notExtracted?.length || d.errors?.length) {
    extra.push(el('div', { class: 'cat-note' },
      el('div', { class: 'k', text: 'Not extracted' }),
      ...(d.notExtracted || []).map(n => el('div', { class: 'small', title: n.reason },
        el('b', { text: n.count.toLocaleString() }), ` ${n.type}`)),
      d.errors?.length ? el('button', { class: 'linkish small', text: `${d.errors.length} errors…`, onclick: showErrors }) : null));
  }

  $('cats').replaceChildren(
    engine,
    btn('all', 'All assets', 'layers', d.items.length),
    ...FOLDERS.filter(([k, , , sub]) => !sub || folderCount(k)).map(folderBtn),
    ...extra);
  fillTypeFilter();
}

function fillTypeFilter() {
  const types = [...new Set(inCategory().map(i => i.type))].sort();
  $('typeFilter').replaceChildren(el('option', { value: '', text: 'All types' }),
    ...types.map(t => el('option', { value: t, text: t })));
  $('typeFilter').value = state.type;
  const counts = inCategory().reduce((m, i) => ((m[i.status] = (m[i.status] || 0) + 1), m), {});
  $('statusFilter').replaceChildren(el('option', { value: '', text: 'All statuses' }),
    ...Object.keys(STATUS_LABEL).filter(s => counts[s]).map(s => el('option', { value: s, text: `${STATUS_LABEL[s]} (${counts[s]})` })));
  $('statusFilter').value = counts[state.status] ? state.status : '';
}

const inCategory = () => {
  const cats = folderCats(state.category);
  return state.data.items.filter(i => state.category === 'all' || (cats && cats.includes(i.category)));
};

function filtered() {
  const q = state.query.trim().toLowerCase();
  let list = inCategory().filter(i =>
    (!state.type || i.type === state.type) &&
    (!state.status || i.status === state.status) &&
    (!state.previewOnly || i.preview !== 'none') &&
    (!q || i.name.toLowerCase().includes(q) || i.type.toLowerCase().includes(q)));
  list = state.sort === 'size'
    ? list.sort((a, b) => (b.size || 0) - (a.size || 0))
    : list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function card(item) {
  const thumb = item.preview === 'image' && item.file
    ? el('img', { src: fileUrl(item), loading: 'lazy', alt: '', decoding: 'async' })
    : el('span', { class: 'glyph' }, svgIcon(CATEGORY_ICON[item.category] || 'file', 30));
  const sub = [item.type, item.size ? fmtBytes(item.size) : null].filter(Boolean).join(' · ');
  return el('button', {
    class: `card${state.selected === item ? ' selected' : ''}${item.preview === 'none' ? ' nopreview' : ''}`,
    title: item.note || item.name,
    onclick: () => select(item),
  },
  el('div', { class: 'thumb' }, thumb,
    !OK.has(item.status) ? el('span', { class: `badge st-${item.status}`, text: STATUS_LABEL[item.status] || item.status })
      : item.preview === 'none' ? el('span', { class: 'badge', text: 'no preview' }) : null),
  el('div', { class: 'card-name', text: item.name }),
  el('div', { class: 'card-sub', text: sub }));
}

function renderGrid() {
  const list = filtered();
  const shown = list.slice(0, state.shown);
  $('resultCount').textContent = `${list.length.toLocaleString()} shown`;
  const more = list.length > shown.length
    ? el('button', { class: 'ghost more', text: `Show ${Math.min(PAGE, list.length - shown.length)} more`, onclick: () => { state.shown += PAGE; renderGrid(); } })
    : null;
  $('grid').replaceChildren(...shown.map(card), ...(more ? [more] : []));
  if (!list.length) $('grid').append(el('div', { class: 'placeholder', text: 'No assets match.' }));
}

function showEmptyPreview() {
  disposeViewer();
  $('preview').replaceChildren(el('div', { class: 'placeholder', text: 'Select an asset to preview it.' }));
}

function disposeViewer() {
  if (state.viewer) state.viewer.dispose();
  state.viewer = null;
}

function details(meta) {
  const rows = [];
  for (const [k, v] of Object.entries(meta || {})) {
    if (v == null || k === 'tree' || k === 'names' || k === 'files') continue;
    let text;
    if (Array.isArray(v)) text = v.length ? `${v.slice(0, 30).join(', ')}${v.length > 30 ? ` … (${v.length})` : ''}` : '—';
    else if (typeof v === 'object') text = Object.entries(v).slice(0, 30).map(([a, b]) => `${a}: ${Array.isArray(b) ? b.join(', ') : b}`).join('\n') || '—';
    else text = String(v);
    rows.push(el('tr', {}, el('th', { text: k }), el('td', { text })));
  }
  return rows.length ? el('table', { class: 'details' }, ...rows) : null;
}

function actions(item) {
  if (!item.file && !item.output) return null;
  return el('div', { class: 'preview-actions' },
    el('button', { class: 'small', text: 'Export file…', onclick: () => window.api.exportFile(wsRel(item)) }),
    el('button', { class: 'ghost small', text: 'Show in folder', onclick: () => window.api.showItem(wsRel(item)) }));
}

async function select(item, opts = {}) {
  state.selected = item;
  for (const c of $('grid').querySelectorAll('.card.selected')) c.classList.remove('selected');
  disposeViewer();
  const body = el('div', { class: 'preview-body' });
  const head = el('div', { class: 'preview-head' },
    el('div', { class: 'preview-title', text: item.name }),
    el('div', { class: 'muted small', text: [item.type, item.size ? fmtBytes(item.size) : null, item.source].filter(Boolean).join(' · ') }));
  const problem = !OK.has(item.status);
  const banner = item.note || item.solution || problem
    ? el('div', { class: `banner${problem || item.preview === 'none' ? ' warn' : ''}` },
      el('div', {}, el('span', { class: `status-pill st-${item.status}`, text: STATUS_LABEL[item.status] || item.status || '?' }),
        ' ', item.preview === 'none' && !problem ? `No preview: ${item.note || ''}` : item.note || ''),
      item.solution ? el('div', { class: 'small solution', text: `Possible solution: ${item.solution}` }) : null)
    : null;
  const saved = item.output
    ? el('div', { class: 'muted small saved', text: `Saved as Extracted/${item.output}` })
    : el('div', { class: 'muted small saved', text: 'Not saved to the output folders (nothing could be extracted)' });
  $('preview').replaceChildren(...[head, banner, body, saved, actions(item), details(item.meta)].filter(Boolean));
  renderGridSelection(item);

  try {
    await renderPreview(item, body, opts);
    if (state.viewer?.canvas && state.selected === item) addVideoButton(item, body);
  } catch (err) {
    body.replaceChildren(el('div', { class: 'banner warn', text: `Preview failed: ${err.message}` }));
  }
}

// "Download video": records one loop of the playing animation (3D, Spine, Lottie, Android) to MP4/WebM.
function addVideoButton(item, body) {
  let bar = $('preview').querySelector('.preview-actions');
  if (!bar) {
    bar = el('div', { class: 'preview-actions' });
    body.after(bar);
  }
  const label = 'Download video';
  const b = el('button', { class: 'small', title: 'Record one loop of this animation to a video file' }, svgIcon('download', 14), label);
  b.onclick = async () => {
    const v = state.viewer;
    if (!v?.canvas) return;
    const secs = Math.min(20, Math.max(1, (v.duration?.() || 3000) / 1000));
    b.disabled = true;
    b.replaceChildren(svgIcon('clock', 14), `Recording ${secs.toFixed(1)} s…`);
    try {
      const { blob, ext } = await recordCanvas(v.canvas, secs, v.restart);
      const r = await window.api.saveBuffer(`${item.name}.${ext}`, await blob.arrayBuffer());
      b.replaceChildren(svgIcon(r.ok ? 'check' : 'download', 14), r.ok ? 'Saved' : label);
    } catch (err) {
      b.replaceChildren(svgIcon('alert', 14), `Failed: ${err.message}`);
    }
    b.disabled = false;
    setTimeout(() => b.replaceChildren(svgIcon('download', 14), label), 3000);
  };
  bar.prepend(b);
}

function renderGridSelection(item) {
  const cards = [...$('grid').querySelectorAll('.card')];
  const shown = filtered().slice(0, state.shown);
  const i = shown.indexOf(item);
  if (i >= 0 && cards[i]) cards[i].classList.add('selected');
}

async function renderPreview(item, body, opts) {
  switch (item.preview) {
    case 'image': {
      const img = el('img', { class: 'preview-img', src: fileUrl(item), alt: item.name });
      const zoom = el('input', { type: 'range', min: '0.25', max: '8', step: '0.25', value: '1', 'aria-label': 'Zoom' });
      const holder = el('div', { class: 'checker' }, img);
      zoom.oninput = () => { img.style.width = `${img.naturalWidth * Number(zoom.value)}px`; img.classList.add('zoomed'); };
      img.onload = () => body.append(el('div', { class: 'muted small', text: `${img.naturalWidth} × ${img.naturalHeight} px` }));
      body.append(holder, el('label', { class: 'zoom small' }, 'Zoom ', zoom));
      return;
    }
    case 'model': {
      const host = el('div', { class: 'v3d' });
      body.append(host);
      state.viewer = await createViewer(host, fileUrl(item), {
        ext: ext(item.file),
        initialClip: opts.clip,
        onInfo: info => {
          if (!info.clips.length && item.category === 'characters') {
            body.append(el('div', { class: 'muted small', text: 'No animation clips are attached to this character.' }));
          }
        },
      });
      return;
    }
    case 'spine': {
      const host = el('div', { class: 'v3d' });
      body.append(host);
      const m = item.meta || {};
      state.viewer = await createSpineViewer(host, {
        skeletonUrl: fileUrl(item),
        atlasUrl: m.atlas ? relUrl(m.atlas) : null,
        pageUrls: Object.fromEntries(Object.entries(m.pages || {}).map(([page, rel]) => [page, relUrl(rel)])),
        initialAnimation: opts.clip,
      });
      return;
    }
    case 'android-anim': {
      const host = el('div', { class: 'v3d' });
      body.append(host);
      const [xml, values] = await Promise.all([fetchText(fileUrl(item)), valuesFor()]);
      state.viewer = item.type === 'View animation' ? createViewAnimPlayer(host, xml, values) : createAnimatorPlayer(host, xml, values);
      return;
    }
    case 'avd': {
      const host = el('div', { class: 'v3d' });
      body.append(host);
      const m = item.meta;
      const [vector, values, ...targets] = await Promise.all([fetchText(wsUrl(`apktool/${m.vector}`)), valuesFor(),
        ...m.targets.map(tg => fetchText(wsUrl(`apktool/${tg.animation}`)).then(xml => ({ name: tg.name, xml })).catch(() => null))]);
      state.viewer = createAvdPlayer(host, vector, targets.filter(Boolean), values);
      return;
    }
    case 'frames': {
      const host = el('div', { class: 'v3d' });
      body.append(host);
      state.viewer = await createFramePlayer(host, item.meta.frames.map(f => ({ url: wsUrl(f.file), duration: f.duration })), item.meta.oneshot);
      return;
    }
    case 'lottie': {
      const host = el('div', { class: 'v3d' });
      body.append(host);
      state.viewer = await createLottiePlayer(host, fileUrl(item));
      return;
    }
    case 'audio':
      body.append(el('audio', { controls: '', src: fileUrl(item), preload: 'metadata' }));
      return;
    case 'video':
      body.append(el('video', { controls: '', src: fileUrl(item), preload: 'metadata', class: 'preview-video' }));
      return;
    case 'text': {
      const res = await fetch(fileUrl(item));
      const text = await res.text();
      body.append(el('pre', { class: 'text', text: text.length > 200000 ? `${text.slice(0, 200000)}\n… (truncated)` : text }));
      return;
    }
    case 'font': {
      const family = `asset-${item.id}`;
      const face = new FontFace(family, `url("${fileUrl(item)}")`);
      await face.load();
      document.fonts.add(face);
      const sample = el('div', { class: 'font-sample', text: 'The quick brown fox jumps over the lazy dog 0123456789' });
      sample.style.fontFamily = family;
      const big = el('div', { class: 'font-sample big', text: 'Aa Bb Cc' });
      big.style.fontFamily = family;
      body.append(big, sample);
      return;
    }
    case 'material':
      body.append(materialView(item));
      return;
    case 'tree':
      body.append(sceneTree(item.meta.tree || []));
      return;
    case 'json':
      if (item.type === 'AnimationClip') body.append(clipView(item));
      if (item.meta?.files?.length) body.append(el('pre', { class: 'text', text: item.meta.files.join('\n') }));
      return;
    default:
      body.append(el('div', { class: 'noprev' }, el('div', { class: 'glyph big' }, svgIcon('alert', 36)),
        el('div', { text: item.note || 'This asset has no preview.' })));
  }
}

function materialView(item) {
  const m = item.meta || {};
  const swatches = Object.entries(m.colors || {}).map(([name, c]) => {
    const sw = el('span', { class: 'swatch' });
    sw.style.background = `rgba(${c.slice(0, 3).map(v => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')},${c[3] ?? 1})`;
    return el('div', { class: 'swatch-row' }, sw, el('span', { class: 'small', text: name }));
  });
  const texs = Object.entries(m.textures || {}).map(([slot, key]) => {
    const t = state.byKey.get(key);
    const thumb = t && t.preview === 'image' ? el('img', { src: fileUrl(t), alt: '' }) : el('span', { class: 'glyph' }, svgIcon('image', 20));
    return el('button', { class: 'tex-link', onclick: () => t && select(t), disabled: t ? null : '' },
      thumb, el('span', { class: 'small', text: `${slot}${t ? ` → ${t.name}` : ' (not exported)'}` }));
  });
  return el('div', { class: 'material' },
    el('div', { class: 'small' }, el('b', { text: 'Shader: ' }), m.shader || '?'),
    texs.length ? el('div', { class: 'tex-list' }, ...texs) : el('div', { class: 'muted small', text: 'No textures' }),
    swatches.length ? el('div', { class: 'swatches' }, ...swatches) : null);
}

function clipView(item) {
  const users = state.data.items.filter(i => i.category === 'characters' && (i.meta.animations || []).includes(item.name));
  if (!users.length) return el('div', { class: 'muted small', text: 'Not attached to an exported 3D character.' });
  return el('div', { class: 'play-on' },
    el('div', { class: 'small', text: 'Play on:' }),
    ...users.slice(0, 12).map(u => el('button', { class: 'small', text: u.name, onclick: () => select(u, { clip: item.name }) })));
}

function sceneTree(nodes) {
  const make = n => {
    const label = el('span', {}, el('b', { text: n.name }),
      n.components?.length ? el('span', { class: 'muted small', text: `  ${n.components.join(', ')}` }) : null,
      n.more ? el('span', { class: 'muted small', text: `  (+${n.more} children)` }) : null);
    if (!n.children?.length) return el('div', { class: 'tree-leaf' }, label);
    const d = el('details', {}, el('summary', {}, label), ...n.children.map(make));
    return d;
  };
  return el('div', { class: 'tree' }, ...nodes.map(make));
}

function showErrors() {
  disposeViewer();
  const errs = state.data.errors || [];
  $('preview').replaceChildren(
    el('div', { class: 'preview-head' }, el('div', { class: 'preview-title', text: `${errs.length} assets failed` })),
    el('table', { class: 'details' }, ...errs.slice(0, 300).map(e => el('tr', {}, el('th', { text: `${e.type} ${e.name}` }), el('td', { text: e.error })))));
}

export function initAssetsUi() {
  let t;
  $('search').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { state.query = $('search').value; state.shown = PAGE; renderGrid(); }, 150);
  });
  $('typeFilter').addEventListener('change', () => { state.type = $('typeFilter').value; state.shown = PAGE; renderGrid(); });
  $('sort').addEventListener('change', () => { state.sort = $('sort').value; renderGrid(); });
  $('statusFilter').addEventListener('change', () => { state.status = $('statusFilter').value; state.shown = PAGE; renderGrid(); });
  $('previewOnly').addEventListener('change', () => { state.previewOnly = $('previewOnly').checked; state.shown = PAGE; renderGrid(); });
}

// Shows one output folder (e.g. '3D_Models/Characters') in the browser.
export function openFolder(key) {
  if (!state.data) return;
  state.category = folderCats(key) ? key : 'all';
  state.type = '';
  state.status = '';
  state.shown = PAGE;
  renderCats();
  renderGrid();
}

export function resetAssets() {
  disposeViewer();
  state.data = null;
}

// For dev screenshots: open the first asset of a category.
export function devSelect(category, which = 0, opts = {}) {
  state.category = folderCats(category) ? category : (FOLDERS.find(f => !f[3] && f[2].includes(category)) || ['all'])[0];
  renderCats();
  renderGrid();
  const list = filtered();
  const item = typeof which === 'string' ? list.find(i => i.name.includes(which)) : list[which];
  if (item) select(item, opts);
}
