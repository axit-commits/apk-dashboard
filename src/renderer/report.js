// Extraction report: status summary, files per output folder, and every
// archive entry with its format, status, output location, reason and fix.

const PAGE = 500;
const STATUSES = ['decoded', 'extracted', 'partial', 'unsupported', 'encrypted', 'corrupted', 'missing'];
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

const state = { sha: null, summary: null, entries: [], query: '', status: '', pkg: '', shown: PAGE };

export async function loadReport(sha) {
  const get = async f => {
    const r = await fetch(`apkx://ws/${sha}/game/${f}`);
    if (!r.ok) throw new Error(`${f} not found`);
    return r.json();
  };
  state.sha = sha;
  [state.summary, state.entries] = await Promise.all([get('summary.json'), get('inventory.json')]);
  state.shown = PAGE;
  renderSummary();
  fillFilters();
  renderTable();
  return state.summary;
}

function statusCards(title, counts, total) {
  return el('div', { class: 'rs-block' },
    el('div', { class: 'rs-title', text: `${title} (${total.toLocaleString()})` }),
    el('div', { class: 'rs-pills' }, ...STATUSES.filter(s => counts[s]).map(s =>
      el('button', { class: `status-pill st-${s}`, title: `Show ${s} entries`, onclick: () => { state.status = s; $('reportStatus').value = s; state.shown = PAGE; renderTable(); } },
        `${s} ${counts[s].toLocaleString()}`))));
}

function renderSummary() {
  const s = state.summary;
  const folders = el('div', { class: 'rs-block' },
    el('div', { class: 'rs-title', text: 'Files in the output folders' }),
    el('div', { class: 'rs-folders' }, ...Object.entries(s.folders).map(([f, n]) =>
      el('div', { class: `rs-folder${n ? '' : ' empty'}` }, el('span', { class: 'mono', text: `${f}/` }), el('b', { text: n.toLocaleString() })))));
  $('reportSummary').replaceChildren(
    statusCards('Archive entries', s.entryStatus, s.archiveEntries),
    statusCards('Assets', s.assetStatus, s.assets),
    folders);
}

function fillFilters() {
  const counts = state.entries.reduce((m, e) => ((m[e.status] = (m[e.status] || 0) + 1), m), {});
  $('reportStatus').replaceChildren(el('option', { value: '', text: 'All statuses' }),
    ...STATUSES.filter(s => counts[s]).map(s => el('option', { value: s, text: `${s} (${counts[s]})` })));
  const pkgs = [...new Set(state.entries.map(e => e.container))];
  $('reportPackage').replaceChildren(el('option', { value: '', text: 'All packages' }), ...pkgs.map(p => el('option', { value: p, text: p })));
  $('reportPackage').hidden = pkgs.length < 2;
}

// Problems first (most serious first), then everything else by path.
const SEVERITY = { encrypted: 0, corrupted: 1, missing: 2, unsupported: 3, partial: 4, decoded: 5, extracted: 5 };

function filtered() {
  const q = state.query.trim().toLowerCase();
  return state.entries.filter(e =>
    (!state.status || e.status === state.status) &&
    (!state.pkg || e.container === state.pkg) &&
    (!q || [e.path, e.format, e.reason, e.output].some(v => String(v || '').toLowerCase().includes(q))))
    .sort((a, b) => (SEVERITY[a.status] ?? 5) - (SEVERITY[b.status] ?? 5) || a.path.localeCompare(b.path));
}

function renderTable() {
  const list = filtered();
  const rows = list.slice(0, state.shown).map(e => el('tr', {},
    el('td', { class: 'mono path', text: e.path, title: e.container }),
    el('td', { class: 'num', text: fmtBytes(e.size) }),
    el('td', { text: e.format || '—' }),
    el('td', {}, el('span', { class: `status-pill st-${e.status}`, text: e.status || '?' })),
    el('td', { class: 'mono', text: e.output || '—' }),
    el('td', {}, e.reason || '', e.solution ? el('div', { class: 'solution small', text: `Possible solution: ${e.solution}` }) : null)));
  const more = list.length > state.shown
    ? el('tr', {}, el('td', { colspan: '6' }, el('button', { class: 'ghost small', text: `Show ${Math.min(PAGE, list.length - state.shown)} more`, onclick: () => { state.shown += PAGE; renderTable(); } })))
    : null;
  $('reportTable').replaceChildren(
    el('tr', {}, ...['Archive path', 'Size', 'Detected format', 'Status', 'Saved as', 'Reason'].map(h => el('th', { text: h }))),
    ...rows, more);
  $('reportCount').textContent = `${list.length.toLocaleString()} of ${state.entries.length.toLocaleString()} entries`;
}

export function initReportUi() {
  let t;
  $('reportSearch').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { state.query = $('reportSearch').value; state.shown = PAGE; renderTable(); }, 150);
  });
  $('reportStatus').addEventListener('change', () => { state.status = $('reportStatus').value; state.shown = PAGE; renderTable(); });
  $('reportPackage').addEventListener('change', () => { state.pkg = $('reportPackage').value; state.shown = PAGE; renderTable(); });
  $('openReportBtn').addEventListener('click', () => state.sha && window.api.openReport(state.sha));
}

export function contentSummary() {
  return state.summary;
}
