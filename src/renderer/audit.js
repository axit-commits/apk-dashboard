// Release audit view: signing certificate, and findings with severity,
// locations (opening the Code view at the line) and how to fix them.

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

const SEVERITY = [['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['info', 'Info']];
const state = { sha: null, result: null, filter: '', onOpenCode: null, running: false };

export function initAudit(onOpenCode) {
  state.onOpenCode = onOpenCode;
}

export function resetAudit() {
  state.sha = null;
  state.result = null;
  $('audit').replaceChildren();
}

// Loads the cached audit, or runs it the first time.
export async function showAudit(sha, force = false) {
  if (state.running) return;
  if (!force && state.sha === sha && state.result) { render(); return; }
  state.sha = sha;
  state.running = true;
  $('audit').replaceChildren(el('div', { class: 'audit-loading' }, el('span', { class: 'spinner' }),
    el('div', {}, el('div', { class: 'h-name', text: 'Running release checks…' }),
      el('div', { class: 'muted small', text: 'Signing, manifest, permissions, secrets in code and resources, R8 and native libraries' }))));
  const r = await window.api.runAudit(sha, force);
  state.running = false;
  if (state.sha !== sha) return;
  state.result = r;
  render();
}

function copyButton(value, label) {
  const b = el('button', { class: 'btn small', title: `Copy ${label}` }, icon('file', 13), 'Copy');
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      b.replaceChildren(icon('check', 13), 'Copied');
      setTimeout(() => b.replaceChildren(icon('file', 13), 'Copy'), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return b;
}

function signingCard(s) {
  if (!s) return null;
  const c = s.cert;
  const rows = c ? [
    ['SHA-256', c.sha256, true],
    ['SHA-1', c.sha1, true],
    ['Subject', c.subject],
    ['Issuer', c.issuer],
    ['Valid', `${c.validFrom}  →  ${c.validTo}`],
  ] : [['Certificate', s.error || 'No readable signature']];
  return el('div', { class: 'audit-card signing' },
    el('div', { class: 'ac-head' }, el('div', { class: 'ac-icon' }, icon('shield', 18)),
      el('div', { class: 'grow' }, el('div', { class: 'ac-title', text: 'Signing certificate' }),
        el('div', { class: 'muted small', text: `${s.file || ''} · scheme${s.schemes.length === 1 ? '' : 's'} ${s.schemes.join(', ') || 'none'}` })),
      s.debug ? el('span', { class: 'sev sev-high', text: 'Debug key' }) : null),
    el('table', { class: 'kv' }, ...rows.map(([k, v, copy]) => el('tr', {},
      el('th', { text: k }), el('td', { class: copy ? 'mono' : '' }, el('span', { text: v || '—' })), el('td', { class: 'copy' }, copy && v ? copyButton(v, k) : null)))),
    c ? el('div', { class: 'muted small', text: 'Use the SHA-1 and SHA-256 above in Firebase, Google Sign-In and API key restrictions.' }) : null);
}

function locationRow(l) {
  const canOpen = l.root === 'java' || l.root === 'res';
  return el(canOpen ? 'button' : 'div', {
    class: `loc${canOpen ? ' link-row' : ''}`, title: canOpen ? 'Open in the Code view' : '',
    onclick: canOpen ? () => state.onOpenCode?.(l.root, l.file, l.line || 0) : null,
  },
  el('span', { class: 'loc-file mono', text: `${l.file}${l.line ? `:${l.line}` : ''}` }),
  l.own === false ? el('span', { class: 'tag', text: 'library' }) : el('span', { class: 'tag good', text: 'yours' }),
  l.text ? el('span', { class: 'loc-text mono', text: l.text }) : null);
}

function findingCard(f) {
  const shown = 5;
  const list = el('div', { class: 'locs' }, ...f.locations.slice(0, shown).map(locationRow));
  if (f.locations.length > shown) {
    const more = el('button', { class: 'link small', text: `Show all ${f.locations.length} locations` });
    more.onclick = () => { list.replaceChildren(...f.locations.map(locationRow)); };
    list.append(more);
  }
  return el('div', { class: `audit-card finding sev-border-${f.severity}` },
    el('div', { class: 'ac-head' },
      el('span', { class: `sev sev-${f.severity}`, text: f.severity }),
      el('div', { class: 'grow' }, el('div', { class: 'ac-title', text: f.title }), el('div', { class: 'muted small', text: f.detail }))),
    f.fix ? el('div', { class: 'fix' }, el('b', { text: 'How to fix: ' }), f.fix) : null,
    f.locations.length ? list : null);
}

function render() {
  const r = state.result;
  const box = $('audit');
  if (!r || r.error) {
    box.replaceChildren(el('div', { class: 'noprev' }, icon('alert', 32), el('div', { text: `The audit could not run: ${r?.error || 'unknown error'}` })));
    return;
  }
  const counts = r.counts || {};
  const filters = el('div', { class: 'sev-filters' },
    el('button', { class: `chip${state.filter ? '' : ' accent'}`, onclick: () => { state.filter = ''; render(); }, text: `All ${r.findings.length}` }),
    ...SEVERITY.filter(([s]) => counts[s]).map(([s, label]) => el('button', {
      class: `chip sev-chip sev-${s}${state.filter === s ? ' active' : ''}`, onclick: () => { state.filter = s; render(); },
    }, `${label} ${counts[s]}`)));
  const list = r.findings.filter(f => !state.filter || f.severity === state.filter);
  const rerun = el('button', { class: 'btn small' }, icon('clock', 13), 'Run again');
  rerun.onclick = () => showAudit(state.sha, true);
  box.replaceChildren(
    el('div', { class: 'audit-head' },
      el('div', { class: 'grow' },
        el('h2', { text: 'Release audit' }),
        el('div', { class: 'muted small', text: [r.package, r.targetSdk ? `target SDK ${r.targetSdk}` : null, r.minSdk ? `min SDK ${r.minSdk}` : null,
          `${(r.scannedFiles || 0).toLocaleString()} files scanned`, `checked ${new Date(r.generated).toLocaleString()}`].filter(Boolean).join(' · ') })),
      rerun),
    el('div', { class: 'audit-summary' }, ...SEVERITY.map(([s, label]) => el('div', { class: `sum-box sum-${s}` },
      el('div', { class: 'sum-n', text: String(counts[s] || 0) }), el('div', { class: 'sum-l', text: label })))),
    signingCard(r.signing),
    el('div', { class: 'audit-list-head' }, el('h3', { text: 'Findings' }), filters),
    list.length ? el('div', { class: 'audit-list' }, ...list.map(findingCard))
      : el('div', { class: 'empty-state' }, icon('check', 30), el('div', { text: r.findings.length ? 'Nothing at this level.' : 'No issues found.' })),
    r.scanError ? el('div', { class: 'banner warn', text: `The code scan stopped early: ${r.scanError}` }) : null,
    el('p', { class: 'notice', text: 'Checks are automatic hints, not a full security review. Library findings are usually for the SDK vendor to fix.' }));
}
