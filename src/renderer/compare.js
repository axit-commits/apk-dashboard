// Compare versions: pick two processed apps and see what changed between them.

import { icon } from './icons.js';
import { appIcon } from './home.js';

const $ = id => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}
const fmtBytes = b => {
  const v = Math.abs(b || 0);
  const s = v >= 1024 ** 2 ? `${(v / 1024 ** 2).toFixed(2)} MB` : v >= 1024 ? `${(v / 1024).toFixed(1)} KB` : `${v} B`;
  return b < 0 ? `−${s}` : s;
};
const signed = (d, fmt = x => x.toLocaleString()) => (d > 0 ? `+${fmt(d)}` : d < 0 ? `−${fmt(-d)}` : '0');
const PAGE = 300;

const state = { history: [], a: null, b: null, result: null, tab: 'overview', codeFilter: '', codeOwn: false, codeKind: 'changed', fileKind: 'changed', diffKey: null, running: false, onAddApk: null };

export function initCompare({ onAddApk }) {
  state.onAddApk = onAddApk;
  window.api.onCompareProgress(m => { const p = document.getElementById('cmpProgress'); if (p) p.textContent = m; });
}

// Opens the compare view; `preferB` is the sha of the app to treat as the newer one.
export async function openCompare(preferB = null) {
  state.history = await window.api.historyList();
  const h = state.history;
  if (preferB && h.some(e => e.sha === preferB)) {
    state.b = preferB;
    const b = h.find(e => e.sha === preferB);
    const older = h.filter(e => e.sha !== preferB && e.package === b.package)
      .sort((x, y) => (y.versionCode ?? 0) - (x.versionCode ?? 0));
    state.a = (older.find(e => (e.versionCode ?? 0) < (b.versionCode ?? 0)) || older[0] || null)?.sha || null;
  }
  if (!state.a || !state.b || !h.some(e => e.sha === state.a) || !h.some(e => e.sha === state.b)) {
    // Default: the two newest versions of the app with the most versions processed.
    const byPkg = new Map();
    for (const e of h) byPkg.set(e.package, [...(byPkg.get(e.package) || []), e]);
    const best = [...byPkg.values()].sort((x, y) => y.length - x.length)[0] || [];
    const sorted = best.slice().sort((x, y) => (x.versionCode ?? 0) - (y.versionCode ?? 0));
    state.a = sorted.length >= 2 ? sorted[sorted.length - 2].sha : h[1]?.sha || null;
    state.b = sorted.length >= 2 ? sorted[sorted.length - 1].sha : h[0]?.sha || null;
  }
  state.result = null;
  render();
}

function entryLabel(e) {
  return `${e.name}  ·  v${e.version ?? '?'}${e.versionCode != null ? ` (${e.versionCode})` : ''}${e.inputName ? `  ·  ${e.inputName}` : ''}`;
}

function picker(which) {
  const sel = el('select', { class: 'cmp-select', 'aria-label': which === 'a' ? 'Older version' : 'Newer version' });
  const byPkg = new Map();
  for (const e of state.history) byPkg.set(e.package || e.name, [...(byPkg.get(e.package || e.name) || []), e]);
  for (const [pkg, list] of byPkg) {
    const g = el('optgroup', { label: pkg });
    for (const e of list.sort((x, y) => (y.versionCode ?? 0) - (x.versionCode ?? 0))) g.append(el('option', { value: e.sha, text: entryLabel(e) }));
    sel.append(g);
  }
  sel.value = state[which] || '';
  sel.onchange = () => { state[which] = sel.value; state.result = null; render(); };
  const e = state.history.find(x => x.sha === state[which]);
  return el('div', { class: 'cmp-pick' },
    el('div', { class: 'cmp-pick-label', text: which === 'a' ? 'Older version' : 'Newer version' }),
    el('div', { class: 'cmp-pick-row' }, e ? appIcon(e) : el('div', { class: 'app-icon letter', text: '?' }), sel));
}

function render() {
  const box = $('compare');
  const h = state.history;
  const swap = el('button', { class: 'icon-btn swap', title: 'Swap older and newer', onclick: () => { [state.a, state.b] = [state.b, state.a]; state.result = null; render(); } }, icon('swap', 16));
  const run = el('button', { class: 'btn primary', disabled: !state.a || !state.b || state.a === state.b || state.running ? '' : null, onclick: () => runCompare(false) },
    icon('compare', 15), 'Compare');
  const add = el('button', { class: 'btn', onclick: () => state.onAddApk?.() }, icon('plus', 15), 'Add another APK');
  const head = el('div', { class: 'cmp-head' },
    el('div', {}, el('h1', { text: 'Compare versions' }),
      el('div', { class: 'muted', text: 'Pick two builds of the same app to see what changed: signing, size, permissions, SDKs, code, files and audit findings.' })));
  const pickers = h.length >= 2
    ? el('div', { class: 'cmp-pickers' }, picker('a'), swap, picker('b'), el('div', { class: 'cmp-actions' }, run, add))
    : el('div', { class: 'empty-state' }, icon('compare', 32), el('div', { text: 'Open at least two APKs first (for example two versions of one of your apps); then pick them here.' }), el('div', { style: 'margin-top:12px' }, add));
  const a = h.find(e => e.sha === state.a);
  const b = h.find(e => e.sha === state.b);
  const warn = a && b && a.package !== b.package
    ? el('div', { class: 'banner warn', text: `These are different apps (${a.package} and ${b.package}). The comparison still works, but most things will differ.` }) : null;
  box.replaceChildren(head, pickers, warn, el('div', { id: 'cmpBody' }));
  if (state.result) renderResult();
}

async function runCompare(force) {
  if (state.running) return;
  state.running = true;
  render();
  $('cmpBody').replaceChildren(el('div', { class: 'audit-loading' }, el('span', { class: 'spinner' }),
    el('div', {}, el('div', { class: 'h-name', text: 'Comparing…' }), el('div', { class: 'muted small', id: 'cmpProgress', text: 'Starting' }))));
  const r = await window.api.compareRun(state.a, state.b, force);
  state.running = false;
  state.result = r;
  state.diffKey = null;
  render();
}

// ---------- results ----------

function verdictChips(r) {
  const chips = [];
  if (r.signing.same === true) chips.push(el('span', { class: 'chip good-chip' }, icon('check', 12), 'Same signing key'));
  else if (r.signing.same === false) chips.push(el('span', { class: 'chip bad-chip' }, icon('alert', 12), 'Different signing key: users can\'t update'));
  else chips.push(el('span', { class: 'chip quiet', text: 'Signing key unknown (original APK moved)' }));
  if (r.size.apkA && r.size.apkB) {
    const d = r.size.apkB - r.size.apkA;
    chips.push(el('span', { class: `chip ${d > 0 ? 'warn' : 'quiet'}`, text: `APK size ${d > 0 ? '+' : ''}${fmtBytes(d)} (${fmtBytes(r.size.apkB)})` }));
  }
  const ta = r.facts.find(f => f[0] === 'Target SDK');
  if (ta && ta[1] !== ta[2]) chips.push(el('span', { class: 'chip accent', text: `Target SDK ${ta[1]} → ${ta[2]}` }));
  const p = r.permissions;
  if (p.added.length || p.removed.length) chips.push(el('span', { class: `chip ${p.added.some(x => x.dangerous || x.play) ? 'warn' : ''}`, text: `Permissions +${p.added.length} −${p.removed.length}` }));
  if (r.code.available) chips.push(el('span', { class: 'chip', text: `Classes +${r.code.addedCount} −${r.code.removedCount} ~${r.code.changedCount}` }));
  if (r.sdks.added.length || r.sdks.removed.length) chips.push(el('span', { class: 'chip', text: `SDKs +${r.sdks.added.length} −${r.sdks.removed.length}` }));
  if (r.audit && !r.audit.error && (r.audit.added.length || r.audit.fixed.length)) chips.push(el('span', { class: `chip ${r.audit.added.length ? 'warn' : 'good-chip'}`, text: `Audit: ${r.audit.added.length} new, ${r.audit.fixed.length} fixed` }));
  return chips;
}

const TABS = [['overview', 'Overview'], ['manifest', 'Permissions & components'], ['sdks', 'SDKs'], ['code', 'Code'], ['files', 'Files'], ['audit', 'Release audit']];

function renderResult() {
  const r = state.result;
  const body = $('cmpBody');
  if (r.error) { body.replaceChildren(el('div', { class: 'banner warn', text: `The comparison failed: ${r.error}` })); return; }
  const ver = s => `${s.versionName ?? '?'} (${s.versionCode ?? '?'})`;
  const rerun = el('button', { class: 'btn small', onclick: () => runCompare(true) }, icon('clock', 13), 'Compare again');
  const tabs = el('div', { class: 'cmp-tabs' }, ...TABS.map(([id, label]) => el('button', {
    class: state.tab === id ? 'active' : '', onclick: () => { state.tab = id; renderResult(); },
  }, label, tabCount(r, id))));
  body.replaceChildren(
    el('div', { class: 'cmp-summary' },
      el('div', { class: 'cmp-title' },
        el('h2', {}, `${r.b.name || r.b.package}  `, el('span', { class: 'muted', text: `${ver(r.a)} → ${ver(r.b)}` })),
        rerun),
      el('div', { class: 'chips' }, ...verdictChips(r))),
    tabs,
    el('div', { class: 'cmp-pane' }, ...tabContent(r)));
}

function tabCount(r, id) {
  const n = { manifest: r.permissions.added.length + r.permissions.removed.length + r.components.added.length + r.components.removed.length,
    sdks: r.sdks.added.length + r.sdks.removed.length, code: r.code.addedCount + r.code.removedCount + r.code.changedCount,
    files: r.files.addedCount + r.files.removedCount + r.files.changedCount, audit: r.audit && !r.audit.error ? r.audit.added.length + r.audit.fixed.length : 0 }[id];
  return n ? el('span', { class: 'count', text: n.toLocaleString() }) : null;
}

function tabContent(r) {
  switch (state.tab) {
    case 'manifest': return manifestTab(r);
    case 'sdks': return sdkTab(r);
    case 'code': return codeTab(r);
    case 'files': return filesTab(r);
    case 'audit': return auditTab(r);
    default: return overviewTab(r);
  }
}

function changeCell(a, b, unit) {
  if (a === b || a == null || b == null) return el('td', { class: 'muted', text: a === b ? '—' : '' });
  if (typeof a === 'number' && typeof b === 'number') {
    const d = b - a;
    return el('td', { class: d > 0 ? 'up' : 'down', text: unit === 'bytes' ? `${d > 0 ? '+' : ''}${fmtBytes(d)}` : signed(d) });
  }
  return el('td', { class: 'changed', text: 'changed' });
}

function overviewTab(r) {
  const facts = el('table', { class: 'cmp-table' },
    el('tr', {}, el('th', { text: '' }), el('th', { text: 'Older' }), el('th', { text: 'Newer' }), el('th', { text: 'Change' })),
    ...r.facts.map(([k, a, b, unit]) => {
      const num = v => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
      const fa = num(a);
      const fb = num(b);
      const show = v => (v == null || v === '' ? '—' : unit === 'bytes' ? fmtBytes(v) : typeof v === 'number' ? v.toLocaleString() : String(v));
      return el('tr', { class: fa !== fb ? 'diff-row' : '' }, el('th', { text: k }), el('td', { text: show(fa) }), el('td', { text: show(fb) }), changeCell(fa, fb, unit));
    }));
  const max = Math.max(1, ...r.size.kinds.flatMap(k => [k.a.packed, k.b.packed]));
  const sizes = el('div', { class: 'size-bars' }, ...r.size.kinds.sort((x, y) => y.b.packed - x.b.packed).map(k => el('div', { class: 'size-row' },
    el('div', { class: 'size-kind', text: k.kind }),
    el('div', { class: 'size-track' },
      el('div', { class: 'bar a', style: `width:${(100 * k.a.packed) / max}%`, title: `Older: ${fmtBytes(k.a.packed)}` }),
      el('div', { class: 'bar b', style: `width:${(100 * k.b.packed) / max}%`, title: `Newer: ${fmtBytes(k.b.packed)}` })),
    el('div', { class: `size-delta ${k.b.packed > k.a.packed ? 'up' : k.b.packed < k.a.packed ? 'down' : ''}`, text: `${k.b.packed >= k.a.packed ? '+' : ''}${fmtBytes(k.b.packed - k.a.packed)}` }))));
  const signing = r.signing.a || r.signing.b ? el('div', { class: 'card-box cmp-sign' },
    el('table', { class: 'cmp-table' },
      el('tr', {}, el('th', { text: 'Signing' }), el('th', { text: 'Older' }), el('th', { text: 'Newer' })),
      el('tr', {}, el('th', { text: 'SHA-256' }), el('td', { class: 'mono', text: r.signing.a?.sha256 || '—' }), el('td', { class: 'mono', text: r.signing.b?.sha256 || '—' })),
      el('tr', {}, el('th', { text: 'Subject' }), el('td', { text: r.signing.a?.subject || '—' }), el('td', { text: r.signing.b?.subject || '—' })))) : null;
  return [
    el('h3', {}, icon('overview', 16), 'Key facts'), el('div', { class: 'card-box' }, facts),
    el('h3', {}, icon('archive', 16), 'Download size by part ', el('span', { class: 'legend' }, el('i', { class: 'a' }), 'older ', el('i', { class: 'b' }), 'newer')),
    el('div', { class: 'card-box' }, sizes),
    signing ? el('h3', {}, icon('shield', 16), 'Signing certificate') : null, signing,
    r.assets.counts.length ? el('h3', {}, icon('box', 16), 'Game assets') : null,
    r.assets.counts.length ? el('div', { class: 'card-box' }, el('table', { class: 'cmp-table' },
      el('tr', {}, el('th', { text: 'Category' }), el('th', { text: 'Older' }), el('th', { text: 'Newer' }), el('th', { text: 'Change' })),
      ...r.assets.counts.map(c => el('tr', {}, el('th', { text: c.category }), el('td', { text: c.a.toLocaleString() }), el('td', { text: c.b.toLocaleString() }), changeCell(c.a, c.b))))) : null,
  ];
}

function listCard(title, rows, empty) {
  return el('div', { class: 'card-box cmp-list' }, el('div', { class: 'cmp-list-title', text: title }),
    rows.length ? el('div', {}, ...rows) : el('div', { class: 'muted small pad-y', text: empty }));
}

function manifestTab(r) {
  const perm = (p, sign) => el('div', { class: `cmp-item ${sign === '+' ? 'add' : 'del'}` },
    el('span', { class: 'sign', text: sign }), el('span', { class: 'mono', text: p.name.replace('android.permission.', '') }),
    p.dangerous ? el('span', { class: 'tag warn', text: 'dangerous' }) : null,
    p.play ? el('span', { class: 'tag warn', title: p.play, text: 'Play policy' }) : null,
    p.meaning ? el('span', { class: 'muted small', text: p.meaning }) : null);
  const comp = (c, sign, extra) => el('div', { class: `cmp-item ${sign === '+' ? 'add' : sign === '−' ? 'del' : 'mod'}` },
    el('span', { class: 'sign', text: sign }), el('span', { class: 'tag', text: c.type }), el('span', { class: 'mono', text: c.name }),
    c.exported ? el('span', { class: 'tag warn', text: 'exported' }) : null, extra);
  return [
    el('div', { class: 'cmp-grid2' },
      listCard(`Permissions added (${r.permissions.added.length})`, r.permissions.added.map(p => perm(p, '+')), 'None'),
      listCard(`Permissions removed (${r.permissions.removed.length})`, r.permissions.removed.map(p => perm(p, '−')), 'None')),
    el('div', { class: 'cmp-grid2' },
      listCard(`Components added (${r.components.added.length})`, r.components.added.map(c => comp(c, '+')), 'None'),
      listCard(`Components removed (${r.components.removed.length})`, r.components.removed.map(c => comp(c, '−')), 'None')),
    r.components.exportChanged.length ? listCard(`Export changed (${r.components.exportChanged.length})`,
      r.components.exportChanged.map(c => comp(c, '~', el('span', { class: 'muted small', text: c.exported ? 'now exported' : 'no longer exported' }))), '') : null,
    el('div', { class: 'muted small', text: `${r.permissions.unchanged} permissions and ${r.components.unchanged} components unchanged.` }),
  ];
}

function sdkTab(r) {
  const row = (s, sign) => el('div', { class: `cmp-item ${sign === '+' ? 'add' : 'del'}` }, el('span', { class: 'sign', text: sign }),
    el('span', { class: 'mono', text: s.name }), el('span', { class: 'muted small', text: `${s.classes.toLocaleString()} classes` }));
  return [
    el('div', { class: 'muted small', style: 'margin-bottom:12px', text: 'SDKs are recognised from package names in the decompiled code. Obfuscated packages can\'t be named.' }),
    el('div', { class: 'cmp-grid2' },
      listCard(`SDKs added (${r.sdks.added.length})`, r.sdks.added.map(s => row(s, '+')), 'None'),
      listCard(`SDKs removed (${r.sdks.removed.length})`, r.sdks.removed.map(s => row(s, '−')), 'None')),
    listCard(`SDKs that changed size (${r.sdks.changed.length})`, r.sdks.changed.slice(0, 60).map(s => el('div', { class: 'cmp-item mod' },
      el('span', { class: 'sign', text: '~' }), el('span', { class: 'mono', text: s.name }),
      el('span', { class: 'muted small', text: `${s.a.toLocaleString()} → ${s.b.toLocaleString()} classes (${signed(s.b - s.a)})` }))), 'None'),
  ];
}

function codeTab(r) {
  const c = r.code;
  if (!c.available) return [el('div', { class: 'banner warn', text: 'Decompiled code is missing for one of the versions.' })];
  const own = p => !!c.ownPrefix && p.startsWith(`${c.ownPrefix}/`);
  const kinds = [['changed', 'Changed', c.changedCount, c.changedOwn], ['added', 'Added', c.addedCount, c.addedOwn], ['removed', 'Removed', c.removedCount, c.removedOwn]];
  const q = state.codeFilter.toLowerCase();
  const list = (c[state.codeKind] || []).filter(p => (!state.codeOwn || own(p)) && (!q || p.toLowerCase().includes(q)));
  const listBox = el('div', { class: 'cmp-code-list' }, ...list.slice(0, PAGE).map(p => el('button', {
    class: `cmp-file ${state.diffKey === p ? 'selected' : ''}`, title: p, onclick: () => showDiff(p),
  }, el('span', { class: `sign ${state.codeKind}`, text: state.codeKind === 'added' ? '+' : state.codeKind === 'removed' ? '−' : '~' }),
  el('span', { class: 'r-name', text: p.split('/').pop() }), el('span', { class: 'r-dir', text: p.split('/').slice(0, -1).join('/') }),
  own(p) ? el('span', { class: 'tag good', text: 'yours' }) : null)));
  if (list.length > PAGE) listBox.append(el('div', { class: 'muted small pad-y', text: `Showing ${PAGE} of ${list.length.toLocaleString()}; filter to narrow down.` }));
  if (!list.length) listBox.append(el('div', { class: 'muted small pad-y', text: 'No classes match.' }));
  const filter = el('input', { type: 'search', placeholder: 'Filter classes', value: state.codeFilter, 'aria-label': 'Filter classes' });
  filter.oninput = () => { state.codeFilter = filter.value; const pos = filter.selectionStart; renderResult(); const f = document.querySelector('.cmp-code-tools input'); f?.focus(); f?.setSelectionRange(pos, pos); };
  const ownBox = el('input', { type: 'checkbox' });
  ownBox.checked = state.codeOwn;
  ownBox.onchange = () => { state.codeOwn = ownBox.checked; renderResult(); };
  return [
    el('div', { class: 'cmp-code-tools' },
      el('div', { class: 'seg' }, ...kinds.map(([k, label, n, mine]) => el('button', { class: state.codeKind === k ? 'active' : '', onclick: () => { state.codeKind = k; renderResult(); } },
        `${label} ${n.toLocaleString()}`, mine ? el('span', { class: 'muted small', text: ` (${mine} yours)` }) : null))),
      el('div', { class: 'search-box grow' }, icon('search', 15), filter),
      el('label', { class: 'check' }, ownBox, `Only ${c.ownPrefix ? c.ownPrefix.split('/').join('.') : 'my package'}`)),
    el('div', { class: 'muted small', style: 'margin:0 0 10px', text: 'With R8 on, obfuscated names (a, b, c…) often change between builds, so many classes look added and removed. Your own unobfuscated classes are the most meaningful.' }),
    el('div', { class: 'cmp-code' }, listBox, el('div', { class: 'cmp-diff', id: 'cmpDiff' },
      el('div', { class: 'placeholder pad', text: 'Select a class to see what changed, line by line.' }))),
  ];
}

async function showDiff(p) {
  state.diffKey = p;
  for (const b of document.querySelectorAll('.cmp-file.selected')) b.classList.remove('selected');
  [...document.querySelectorAll('.cmp-file')].find(b => b.title === p)?.classList.add('selected');
  const box = $('cmpDiff');
  box.replaceChildren(el('div', { class: 'placeholder pad', text: 'Comparing…' }));
  const d = await window.api.compareDiff(state.a, state.b, 'java', p);
  if (state.diffKey !== p) return;
  if (d.error) { box.replaceChildren(el('div', { class: 'banner warn', text: d.error })); return; }
  const head = el('div', { class: 'diff-head' }, el('span', { class: 'mono', text: p }),
    el('span', { class: 'up', text: `+${d.added}` }), el('span', { class: 'down', text: `−${d.removed}` }),
    d.replaced ? el('span', { class: 'muted small', text: 'too different to align; shown as replaced' }) : null);
  if (!d.hunks.length) { box.replaceChildren(head, el('div', { class: 'placeholder pad', text: 'Only comments added by the decompiler differ.' })); return; }
  const rows = [];
  for (const h of d.hunks) {
    const first = h.lines[0];
    rows.push(el('div', { class: 'hunk-head mono', text: `@@ ${first.a ?? '?'} → ${first.b ?? '?'} @@` }));
    for (const l of h.lines) {
      rows.push(el('div', { class: `dl ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}` },
        el('span', { class: 'ln', text: l.a ?? '' }), el('span', { class: 'ln', text: l.b ?? '' }),
        el('span', { class: 'mk', text: l.t }), el('span', { class: 'tx', text: l.text })));
    }
  }
  box.replaceChildren(head, el('div', { class: 'diff-body' }, ...rows));
}

function filesTab(r) {
  const f = r.files;
  const kinds = [['changed', 'Changed', f.changedCount], ['added', 'Added', f.addedCount], ['removed', 'Removed', f.removedCount]];
  const rows = (f[state.fileKind] || []).slice(0, 1000).map(x => el('tr', {},
    el('td', { class: 'mono path', text: x.path }),
    el('td', { class: 'num', text: x.sizeA != null ? fmtBytes(x.sizeA) : '—' }),
    el('td', { class: 'num', text: x.sizeB != null ? fmtBytes(x.sizeB) : '—' }),
    el('td', { class: `num ${x.delta > 0 ? 'up' : x.delta < 0 ? 'down' : ''}`, text: x.delta != null ? `${x.delta > 0 ? '+' : ''}${fmtBytes(x.delta)}` : x.sizeB != null ? `+${fmtBytes(x.sizeB)}` : `−${fmtBytes(x.sizeA)}` })));
  return [
    el('div', { class: 'cmp-code-tools' }, el('div', { class: 'seg' }, ...kinds.map(([k, label, n]) => el('button', {
      class: state.fileKind === k ? 'active' : '', onclick: () => { state.fileKind = k; renderResult(); } }, `${label} ${n.toLocaleString()}`))),
    el('span', { class: 'muted small', text: `${f.unchanged.toLocaleString()} files unchanged${f.exact ? '' : ' · compared by size (original APK moved)'}` })),
    el('div', { class: 'card-box' }, el('table', { class: 'cmp-table files' },
      el('tr', {}, el('th', { text: 'Path in the APK' }), el('th', { class: 'num', text: 'Older' }), el('th', { class: 'num', text: 'Newer' }), el('th', { class: 'num', text: 'Change' })),
      ...rows)),
    (f[state.fileKind] || []).length > 1000 ? el('div', { class: 'muted small pad-y', text: 'Showing the 1,000 biggest changes.' }) : null,
  ];
}

function auditTab(r) {
  const a = r.audit;
  if (!a || a.error) return [el('div', { class: 'banner warn', text: `The audit could not run: ${a?.error || 'unknown'}` })];
  const item = (f, kind) => el('div', { class: `cmp-item ${kind}` }, el('span', { class: `sev sev-${f.severity}`, text: f.severity }),
    el('span', { text: f.title }), el('span', { class: 'muted small', text: f.detail || '' }));
  const counts = c => ['high', 'medium', 'low', 'info'].map(s => `${c?.[s] || 0} ${s}`).join(' · ');
  return [
    el('div', { class: 'muted small', style: 'margin-bottom:12px', text: `Older: ${counts(a.countsA)}   |   Newer: ${counts(a.countsB)}` }),
    el('div', { class: 'cmp-grid2' },
      listCard(`New findings (${a.added.length})`, a.added.map(f => item(f, 'del')), 'No new findings'),
      listCard(`Fixed since the older version (${a.fixed.length})`, a.fixed.map(f => item(f, 'add')), 'Nothing fixed')),
    a.changed.length ? listCard(`Changed (${a.changed.length})`, a.changed.map(f => el('div', { class: 'cmp-item mod' },
      el('span', { class: `sev sev-${f.severity}`, text: f.severity }), el('span', { text: f.title }),
      el('span', { class: 'muted small', text: `${f.wasSeverity !== f.severity ? `${f.wasSeverity} → ${f.severity}, ` : ''}${f.wasPlaces} → ${f.places} places` }))), '') : null,
  ];
}
