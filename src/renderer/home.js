// Home screen: the history of opened apps, with search and per-app actions.

import { icon } from './icons.js';

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
const fmtBytes = b => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`);

export function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

// App icon element: the decoded launcher icon, or a letter avatar.
export function appIcon({ sha, icon: ic, name }, size = '') {
  const box = el('div', { class: `app-icon ${size}`.trim() });
  if (ic?.file && sha) {
    if (ic.bg) {
      box.classList.add('adaptive');
      box.style.background = /^#|^rgb|gradient/.test(ic.bg) ? ic.bg : `center / cover url("apkx://ws/${sha}/${encodeURI(ic.bg)}")`;
    }
    const img = el('img', { src: `apkx://ws/${sha}/${ic.file.split('/').map(encodeURIComponent).join('/')}`, alt: '' });
    img.onerror = () => { img.remove(); box.classList.add('letter'); box.textContent = (name || '?').trim().charAt(0).toUpperCase(); };
    box.append(img);
  } else {
    box.classList.add('letter');
    box.textContent = (name || '?').trim().charAt(0).toUpperCase();
  }
  return box;
}

const state = { list: [], query: '', onOpen: null };

export async function loadHistory(onOpen) {
  if (onOpen) state.onOpen = onOpen;
  state.list = await window.api.historyList();
  render();
}

function card(e) {
  const stats = [
    e.engine ? el('span', { class: 'chip accent' }, icon('cpu', 12), e.engine) : el('span', { class: 'chip quiet', text: 'No game engine' }),
    e.assets != null ? el('span', { class: 'chip' }, icon('layers', 12), `${e.assets.toLocaleString()} assets`) : null,
    e.version ? el('span', { class: 'chip quiet', text: `v${e.version}` }) : null,
    e.fileSize ? el('span', { class: 'chip quiet', text: fmtBytes(e.fileSize) }) : null,
  ];
  const open = () => state.onOpen?.(e);
  const actions = el('div', { class: 'h-actions' },
    el('button', { class: 'icon-btn', title: 'Open extracted folders', 'aria-label': 'Open extracted folders',
      onclick: ev => { ev.stopPropagation(); window.api.openExtracted(e.sha); } }, icon('folder', 16)),
    el('button', { class: 'icon-btn', title: 'Remove from history', 'aria-label': 'Remove from history',
      onclick: async ev => { ev.stopPropagation(); if (await window.api.historyRemove(e.sha, e.name)) loadHistory(); } }, icon('trash', 16)));
  return el('div', { class: 'h-card', role: 'button', tabindex: '0', title: `Open ${e.name}`, onclick: open,
    onkeydown: ev => { if (ev.key === 'Enter') open(); } },
  actions,
  el('div', { class: 'h-top' }, appIcon(e),
    el('div', { class: 'h-title' }, el('div', { class: 'h-name', text: e.name }), el('div', { class: 'h-pkg mono', text: e.package || e.inputName || '' }))),
  el('div', { class: 'h-stats' }, ...stats),
  el('div', { class: 'h-foot' }, icon('clock', 13), el('span', { text: timeAgo(e.openedAt) }),
    el('span', { class: 'grow', title: e.inputPath || '', text: e.inputName ? `· ${e.inputName}` : '' }),
    e.fileExists ? null : el('span', { class: 'chip quiet', title: 'The original file has moved; the extracted results are still available', text: 'file moved' }),
    el('button', { class: 'btn small primary h-open', onclick: ev => { ev.stopPropagation(); open(); } }, 'Open')));
}

function render() {
  const q = state.query.trim().toLowerCase();
  const list = state.list.filter(e => !q || [e.name, e.package, e.inputName, e.engine].some(v => String(v || '').toLowerCase().includes(q)));
  $('historyCount').textContent = state.list.length
    ? `${state.list.length} app${state.list.length === 1 ? '' : 's'} opened on this computer`
    : 'Apps you open will appear here';
  const grid = $('historyList');
  if (!state.list.length) {
    grid.replaceChildren(el('div', { class: 'empty-state' }, icon('clock', 34),
      el('div', { text: 'No apps yet. Add an APK to get started.' })));
    return;
  }
  grid.replaceChildren(...(list.length ? list.map(card) : [el('div', { class: 'empty-state', text: 'No apps match your search.' })]));
}

export function initHome(onOpen) {
  state.onOpen = onOpen;
  let t;
  $('historySearch').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { state.query = $('historySearch').value; render(); }, 120);
  });
}
