// Code browser: lazy file tree of the decompiled sources and decoded
// resources, a highlighted viewer with line numbers, and search across all
// files (run in a worker in the main process).

import { icon } from './icons.js';

const LINE_H = 19; // must match .code-text line-height in styles.css
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
const fmtBytes = b => (b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const fileIcon = name => (/\.(java|kt|smali)$/i.test(name) ? 'code' : /\.(png|jpe?g|webp|gif)$/i.test(name) ? 'image' : 'file');

const state = { sha: null, roots: [], search: null, results: new Map(), resultCount: 0, current: null };

export async function loadCode(sha) {
  state.sha = sha;
  state.roots = await window.api.codeRoots(sha);
  const tree = $('codeFiles');
  tree.replaceChildren(...state.roots.map(r => rootNode(r)));
  if (!state.roots.length) tree.append(el('div', { class: 'placeholder', text: 'No decompiled code or resources yet.' }));
  $('codePath').replaceChildren(el('span', { class: 'muted', text: 'Select a file, or search all code.' }));
  $('codeView').replaceChildren();
  return state.roots.length;
}

export function resetCode() {
  cancelSearch();
  state.sha = null;
  state.roots = [];
  $('codeFiles').replaceChildren();
  $('codeResults').replaceChildren();
  $('codeView').replaceChildren();
}

// ---------- tree ----------

function rootNode(root) {
  const children = el('div', { class: 'tree-children' });
  const head = el('button', { class: 'tree-row root open' }, icon('chevronDown', 14), icon(root.id === 'java' ? 'code' : 'layers', 15),
    el('span', { class: 'tree-name', text: root.label }), el('span', { class: 'tree-sub', text: root.sub }));
  const node = el('div', { class: 'tree-node' }, head, children);
  head.onclick = () => toggle(head, children, root.id, '', 0);
  toggle(head, children, root.id, '', 0, true);
  return node;
}

async function toggle(head, children, root, rel, depth, force = false) {
  const open = force || !head.classList.contains('open') || !children.childElementCount;
  head.classList.toggle('open', open);
  children.hidden = !open;
  if (!open || children.childElementCount) return;
  const list = await window.api.codeList(state.sha, root, rel);
  children.replaceChildren(...list.map(e => entryNode(root, rel ? `${rel}/${e.name}` : e.name, e, depth + 1)));
}

function entryNode(root, rel, e, depth) {
  const pad = `${8 + depth * 14}px`;
  if (!e.dir) {
    const row = el('button', { class: 'tree-row file', title: rel, 'data-key': `${root}:${rel}` },
      el('span', { class: 'caret-space' }), icon(fileIcon(e.name), 14), el('span', { class: 'tree-name', text: e.name }),
      el('span', { class: 'tree-sub', text: fmtBytes(e.size) }));
    row.style.paddingLeft = pad;
    row.onclick = () => openFile(root, rel);
    return row;
  }
  const children = el('div', { class: 'tree-children', hidden: '' });
  const head = el('button', { class: 'tree-row' }, icon('chevronDown', 14), icon('folder', 14), el('span', { class: 'tree-name', text: e.name }));
  head.style.paddingLeft = pad;
  head.onclick = () => toggle(head, children, root, rel, depth);
  return el('div', { class: 'tree-node' }, head, children);
}

// ---------- viewer ----------

export async function openFile(root, rel, line = 0, query = null) {
  if (!state.sha) return;
  for (const r of document.querySelectorAll('.tree-row.file.selected')) r.classList.remove('selected');
  document.querySelector(`.tree-row.file[data-key="${CSS.escape(`${root}:${rel}`)}"]`)?.classList.add('selected');
  const rootLabel = state.roots.find(r => r.id === root)?.label || root;
  $('codePath').replaceChildren(el('span', { class: 'muted', text: `${rootLabel} / ` }), el('span', { class: 'mono', text: rel }));
  const view = $('codeView');
  view.replaceChildren(el('div', { class: 'placeholder pad', text: 'Loading…' }));
  const f = await window.api.codeFile(state.sha, root, rel);
  state.current = { root, rel };
  if (f.error || f.binary) {
    view.replaceChildren(el('div', { class: 'noprev' }, icon('file', 32),
      el('div', { text: f.error || `Binary file (${fmtBytes(f.size)}): open it from the Game assets view or the extracted folders` })));
    return;
  }
  const gutter = el('div', { class: 'code-gutter', 'aria-hidden': 'true' });
  gutter.textContent = Array.from({ length: f.lines }, (_, i) => i + 1).join('\n');
  const code = el('code', {});
  // highlight.js output: the file text is HTML-escaped, only hljs <span> tags are markup.
  if (f.html != null) code.innerHTML = f.html;
  else code.textContent = f.text;
  const mark = el('div', { class: 'code-mark', hidden: '' });
  const scroll = el('div', { class: 'code-scroll' }, gutter, el('pre', { class: `code-text hljs lang-${f.lang}` }, code), mark);
  const info = el('div', { class: 'code-info muted small' },
    `${f.lines.toLocaleString()} lines · ${fmtBytes(f.size)} · ${f.lang}`,
    f.highlighted ? null : ' · too large to highlight', f.truncated ? ' · truncated' : null);
  view.replaceChildren(info, scroll);
  if (line) jumpTo(scroll, mark, line);
  if (query) state.lastQuery = query;
}

function jumpTo(scroll, mark, line) {
  const top = 12 + (line - 1) * LINE_H;
  mark.hidden = false;
  mark.style.top = `${top}px`;
  scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 3);
}

// ---------- search ----------

function cancelSearch() {
  if (state.search?.id) window.api.codeSearchCancel(state.search.id);
  state.search = null;
}

async function runSearch() {
  cancelSearch();
  const query = $('codeQuery').value.trim();
  state.results.clear();
  state.resultCount = 0;
  $('codeResults').replaceChildren();
  if (query.length < 2 || !state.sha) {
    $('codeSearchStatus').textContent = query ? 'Type at least 2 characters' : '';
    return;
  }
  const opts = { query, mode: $('codeMode').value, regex: $('codeRegex').checked, caseSensitive: $('codeCase').checked };
  $('codeSearchStatus').textContent = 'Searching…';
  const search = { opts, id: null, pending: [] };
  state.search = search;
  search.id = await window.api.codeSearch(state.sha, opts);
  for (const m of search.pending) onSearchMessage(m);
}

function onSearchMessage(m) {
  const s = state.search;
  if (!s) return;
  if (s.id == null) { s.pending.push(m); return; }
  if (m.id !== s.id) return;
  if (m.error) { $('codeSearchStatus').textContent = m.error; return; }
  if (m.hits) addHits(m.hits, s.opts);
  if (m.done) {
    $('codeSearchStatus').textContent = `${m.hits.toLocaleString()} ${s.opts.mode === 'file' ? 'files' : 'matches'} in ${state.results.size.toLocaleString()} files` +
      ` · ${m.files.toLocaleString()} files searched${m.truncated ? ' · showing the first 2,000' : ''}`;
    state.search = null;
  }
}

function highlightMatch(text, opts) {
  const out = el('span', { class: 'r-text' });
  let i = -1;
  let len = opts.query.length;
  if (opts.regex) {
    try {
      const m = new RegExp(opts.query, opts.caseSensitive ? '' : 'i').exec(text);
      if (m) { i = m.index; len = m[0].length; }
    } catch { /* shown plain */ }
  } else {
    i = (opts.caseSensitive ? text : text.toLowerCase()).indexOf(opts.caseSensitive ? opts.query : opts.query.toLowerCase());
  }
  if (i < 0) { out.textContent = text; return out; }
  out.append(text.slice(0, i), el('mark', { text: text.slice(i, i + len) }), text.slice(i + len));
  return out;
}

function addHits(hits, opts) {
  const box = $('codeResults');
  for (const h of hits) {
    const key = `${h.root}:${h.file}`;
    let group = state.results.get(key);
    if (!group) {
      const name = h.file.split('/').pop();
      const dir = h.file.slice(0, -name.length);
      const head = el('button', { class: 'r-file', title: h.file, onclick: () => openFile(h.root, h.file) },
        icon(fileIcon(name), 14), el('span', { class: 'r-name', text: name }), el('span', { class: 'r-dir', text: dir }));
      group = { node: el('div', { class: 'r-group' }, head), count: 0 };
      state.results.set(key, group);
      box.append(group.node);
    }
    if (h.line) {
      group.node.append(el('button', { class: 'r-line', onclick: () => openFile(h.root, h.file, h.line, opts.query) },
        el('span', { class: 'r-num', text: String(h.line) }), highlightMatch(h.text, opts)));
    }
    state.resultCount++;
  }
  $('codeSearchStatus').textContent = `Searching… ${state.resultCount.toLocaleString()} so far`;
}

function showTab(which) {
  for (const b of document.querySelectorAll('.code-tabs button')) b.classList.toggle('active', b.dataset.ct === which);
  $('codeFiles').hidden = which !== 'files';
  $('codeSearchPane').hidden = which !== 'search';
  if (which === 'search') $('codeQuery').focus();
}

// Opens the Search tab with a query already run (used by the audit view).
export function searchFor(query, { regex = false } = {}) {
  showTab('search');
  $('codeQuery').value = query;
  $('codeRegex').checked = regex;
  $('codeMode').value = 'text';
  runSearch();
}

export function initCode() {
  $('codeQueryIcon').append(icon('search', 15));
  for (const b of document.querySelectorAll('.code-tabs button')) b.addEventListener('click', () => showTab(b.dataset.ct));
  let t;
  $('codeQuery').addEventListener('input', () => { clearTimeout(t); t = setTimeout(runSearch, 350); });
  $('codeQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); runSearch(); } });
  for (const id of ['codeMode', 'codeRegex', 'codeCase']) $(id).addEventListener('change', runSearch);
  window.api.onCodeSearch(onSearchMessage);
}
