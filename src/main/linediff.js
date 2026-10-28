// Line diff (Myers' O(ND) algorithm) and unified-diff hunks.

const MAX_D = 4000; // edit distance beyond which the files are shown as replaced

// Returns ops: [{ t: '=' | '-' | '+', a, b }] where a / b are 0-based line indexes.
function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  v[max + 1] = 0;
  const trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    // Keep only the diagonals reachable at this step: k in [-(d+1), d+1].
    trace.push(v.slice(max - d - 1 < 0 ? 0 : max - d - 1, max + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[max + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const get = (d, k) => {
    const lo = max - d - 1 < 0 ? 0 : max - d - 1;
    const i = max + k - lo;
    return i >= 0 && i < trace[d].length ? trace[d][i] : -1;
  };
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const k = x - y;
    const prevK = k === -d || (k !== d && get(d, k - 1) < get(d, k + 1)) ? k + 1 : k - 1;
    const prevX = get(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY && x > 0 && y > 0) { ops.push({ t: '=', a: x - 1, b: y - 1 }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', b: y - 1 });
      else ops.push({ t: '-', a: x - 1 });
      x = prevX;
      y = prevY;
    }
  }
  while (x > 0 && y > 0) { ops.push({ t: '=', a: x - 1, b: y - 1 }); x--; y--; }
  return ops.reverse();
}

// Unified-diff hunks with `context` unchanged lines around each change.
function hunks(aText, bText, context = 3) {
  const a = aText.split('\n');
  const b = bText.split('\n');
  let ops = diffOps(a, b);
  let replaced = false;
  if (!ops) {
    replaced = true;
    ops = [...a.map((_, i) => ({ t: '-', a: i })), ...b.map((_, i) => ({ t: '+', b: i }))];
  }
  const out = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === '=') { i++; continue; }
    let start = Math.max(0, i - context);
    let end = i;
    // Extend the hunk while changes are within 2 * context lines of each other.
    while (end < ops.length) {
      if (ops[end].t !== '=') { end++; continue; }
      let j = end;
      while (j < ops.length && ops[j].t === '=') j++;
      if (j < ops.length && j - end <= context * 2) end = j;
      else break;
    }
    const stop = Math.min(ops.length, end + context);
    const lines = [];
    for (let k = start; k < stop; k++) {
      const o = ops[k];
      if (o.t === '=') lines.push({ t: ' ', text: a[o.a], a: o.a + 1, b: o.b + 1 });
      else if (o.t === '-') { lines.push({ t: '-', text: a[o.a], a: o.a + 1 }); removed++; }
      else { lines.push({ t: '+', text: b[o.b], b: o.b + 1 }); added++; }
    }
    out.push({ lines });
    i = stop;
  }
  return { hunks: out, added, removed, replaced };
}

module.exports = { hunks, diffOps };
