// Players for Android UI animations (view animations, property animators,
// animated vector drawables, frame animations) and Lottie, all drawn on a
// canvas so they can be recorded to video. Written from the Android XML
// formats; no Android code is used.

const STAGE = 360; // canvas size in dp-like units

// ---------- shared player shell ----------

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids.filter(Boolean));
  return n;
}

// draw(tMs) renders one frame; duration in ms (one cycle).
function shell(host, { canvas, duration, draw, loop = true, note }) {
  const stage = el('div', { className: 'v3d-stage anim-stage' }, canvas);
  const bar = el('div', { className: 'v3d-bar' });
  host.append(stage, bar);
  if (note) host.append(el('div', { className: 'muted small', textContent: note }));
  let t = 0;
  let speed = 1;
  let playing = true;
  let disposed = false;
  let last = performance.now();
  const play = el('button', { className: 'small', textContent: 'Pause' });
  play.onclick = () => { playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; };
  const speedSel = el('select', { className: 'small' }, ...[0.25, 0.5, 1, 2].map(s => el('option', { value: String(s), textContent: `${s}×`, selected: s === 1 })));
  speedSel.onchange = () => { speed = Number(speedSel.value); };
  const slider = el('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0', className: 'v3d-time' });
  slider.oninput = () => { playing = false; play.textContent = 'Play'; t = Number(slider.value) * duration; draw(t); };
  const label = el('span', { className: 'muted small', textContent: `${(duration / 1000).toFixed(2)} s${loop ? ' · loops' : ''}` });
  bar.append(play, speedSel, slider, label);
  const frame = now => {
    if (disposed) return;
    requestAnimationFrame(frame);
    const dt = Math.min(100, now - last);
    last = now;
    if (playing) {
      t += dt * speed;
      if (t > duration + (loop ? 0 : 600)) t = loop ? t % Math.max(1, duration) : 0;
      slider.value = String(Math.min(1, t / Math.max(1, duration)));
      draw(Math.min(t, duration));
    }
  };
  draw(0);
  requestAnimationFrame(frame);
  return {
    canvas,
    duration: () => duration,
    restart() { t = 0; playing = true; play.textContent = 'Pause'; },
    dispose() { disposed = true; },
  };
}

function hiDpiCanvas(w, h) {
  const c = document.createElement('canvas');
  const r = Math.min(2, window.devicePixelRatio || 1);
  c.width = w * r;
  c.height = h * r;
  c.style.width = '100%';
  c.style.height = '100%';
  c.style.objectFit = 'contain';
  c.getContext('2d').setTransform(r, 0, 0, r, 0, 0);
  return c;
}

// ---------- values, units, interpolators ----------

function makeResolver(values = {}) {
  const ref = v => {
    const m = /^@(?:android:)?(color|integer|dimen|bool|fraction)\/(.+)$/.exec(v || '');
    return m ? values[m[1]]?.[m[2]] : v;
  };
  return {
    num(v, d = 0) {
      if (v == null || v === '') return d;
      v = ref(String(v));
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : d;
    },
    raw: ref,
  };
}

const cubic = (x1, y1, x2, y2) => t => {
  let lo = 0; let hi = 1; let s = t;
  for (let i = 0; i < 20; i++) {
    s = (lo + hi) / 2;
    const x = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
    if (x < t) lo = s; else hi = s;
  }
  return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
};
const bounce = t => {
  const b = x => x * x * 8;
  t *= 1.1226;
  if (t < 0.3535) return b(t);
  if (t < 0.7408) return b(t - 0.54719) + 0.7;
  if (t < 0.9644) return b(t - 0.8526) + 0.9;
  return b(t - 1.0435) + 0.95;
};
const INTERP = {
  linear: t => t,
  accelerate: t => t * t,
  decelerate: t => 1 - (1 - t) * (1 - t),
  accelerate_decelerate: t => Math.cos((t + 1) * Math.PI) / 2 + 0.5,
  anticipate: t => t * t * ((2 + 1) * t - 2),
  overshoot: t => { t -= 1; return t * t * ((2 + 1) * t + 2) + 1; },
  anticipate_overshoot: t => {
    const a = (x, s) => x * x * ((s + 1) * x - s);
    const o = (x, s) => x * x * ((s + 1) * x + s);
    return t < 0.5 ? 0.5 * a(t * 2, 3) : 0.5 * (o(t * 2 - 2, 3) + 2);
  },
  bounce,
  cycle: t => Math.sin(2 * Math.PI * t),
  fast_out_slow_in: cubic(0.4, 0, 0.2, 1),
  linear_out_slow_in: cubic(0, 0, 0.2, 1),
  fast_out_linear_in: cubic(0.4, 0, 1, 1),
  fast_out_extra_slow_in: cubic(0.3, 0, 0.8, 0.15),
};
function interpolator(ref, fallback = INTERP.accelerate_decelerate) {
  if (!ref) return fallback;
  const name = ref.split('/').pop().replace(/_interpolator$/, '').replace(/^\$/, '');
  for (const [k, f] of Object.entries(INTERP)) if (name === k || name.endsWith(k)) return f;
  if (/emphasized/.test(name)) return INTERP.fast_out_slow_in;
  if (/standard/.test(name)) return INTERP.fast_out_slow_in;
  return fallback;
}

// ---------- view animations (res/anim) ----------

const A = (e, n) => e.getAttribute(`android:${n}`);

function parseViewAnim(node, R, inherited = {}) {
  const tag = node.tagName;
  const base = {
    duration: A(node, 'duration') != null ? R.num(A(node, 'duration')) : inherited.duration,
    offset: R.num(A(node, 'startOffset')) + (inherited.offset || 0),
    interp: A(node, 'interpolator') && !(inherited.share && inherited.interp) ? interpolator(A(node, 'interpolator')) : inherited.interp,
    repeat: A(node, 'repeatCount') != null ? Number(A(node, 'repeatCount')) : 0,
    reverse: A(node, 'repeatMode') === 'reverse' || A(node, 'repeatMode') === '2',
    fillAfter: A(node, 'fillAfter') === 'true' || inherited.fillAfter,
  };
  if (tag === 'set') {
    const share = A(node, 'shareInterpolator') !== 'false';
    const child = { ...base, share, interp: A(node, 'interpolator') ? interpolator(A(node, 'interpolator')) : inherited.interp };
    return [...node.children].flatMap(c => parseViewAnim(c, R, child));
  }
  if (!/^(alpha|scale|translate|rotate)$/.test(tag)) return [];
  const leaf = { kind: tag, ...base, duration: base.duration ?? 0, interp: base.interp || INTERP.accelerate_decelerate };
  const v = n => A(node, n);
  if (tag === 'alpha') Object.assign(leaf, { from: R.num(v('fromAlpha'), 1), to: R.num(v('toAlpha'), 1) });
  if (tag === 'rotate') Object.assign(leaf, { from: R.num(v('fromDegrees')), to: R.num(v('toDegrees')), px: v('pivotX'), py: v('pivotY') });
  if (tag === 'scale') Object.assign(leaf, { fx: R.num(v('fromXScale'), 1), tx: R.num(v('toXScale'), 1), fy: R.num(v('fromYScale'), 1), ty: R.num(v('toYScale'), 1), px: v('pivotX'), py: v('pivotY') });
  if (tag === 'translate') Object.assign(leaf, { fx: v('fromXDelta'), tx: v('toXDelta'), fy: v('fromYDelta'), ty: v('toYDelta') });
  return [leaf];
}

// "50%" of the object, "50%p" of the parent, else dp.
function dim(v, self, parent, R) {
  if (v == null) return 0;
  const s = String(R.raw(v));
  if (s.endsWith('%p')) return (parseFloat(s) / 100) * parent;
  if (s.endsWith('%')) return (parseFloat(s) / 100) * self;
  return parseFloat(s) || 0;
}

function fraction(leaf, t) {
  const d = Math.max(1, leaf.duration);
  let local = t - leaf.offset;
  if (local < 0) return { f: 0, active: false };
  const cycles = leaf.repeat < 0 ? Infinity : leaf.repeat + 1;
  const n = Math.floor(local / d);
  if (n >= cycles) return { f: leaf.reverse && cycles % 2 === 0 ? 0 : 1, ended: true };
  let f = (local % d) / d;
  if (leaf.reverse && n % 2 === 1) f = 1 - f;
  return { f, active: true };
}

const leafEnd = l => l.offset + Math.max(1, l.duration) * (l.repeat < 0 ? 3 : l.repeat + 1);

function drawCard(ctx, x, y, w, h, alpha, label) {
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#8b5cf6');
  g.addColorStop(1, '#3b82f6');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 18);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.font = '600 15px -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + h / 2 + 5);
  ctx.globalAlpha = 1;
}

function stageBackground(ctx) {
  ctx.clearRect(0, 0, STAGE, STAGE);
  ctx.strokeStyle = 'rgba(140,150,170,.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= STAGE; i += 30) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, STAGE); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(STAGE, i); ctx.stroke();
  }
}

export function createViewAnimPlayer(host, xml, values) {
  const R = makeResolver(values);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const leaves = parseViewAnim(doc.documentElement, R);
  const duration = Math.max(300, ...leaves.map(leafEnd));
  const canvas = hiDpiCanvas(STAGE, STAGE);
  const ctx = canvas.getContext('2d');
  const W = 140;
  const H = 140;
  const ox = (STAGE - W) / 2;
  const oy = (STAGE - H) / 2;
  const draw = t => {
    stageBackground(ctx);
    ctx.save();
    ctx.translate(ox, oy);
    let alpha = 1;
    for (const l of leaves) {
      const { f, ended } = fraction(l, t);
      if (ended && !l.fillAfter && l.kind !== 'alpha') continue;
      const e = l.interp(f);
      const lerp = (a, b) => a + (b - a) * e;
      if (l.kind === 'alpha') alpha *= ended && !l.fillAfter ? 1 : lerp(l.from, l.to);
      else if (l.kind === 'translate') ctx.translate(lerp(dim(l.fx, W, STAGE, R), dim(l.tx, W, STAGE, R)), lerp(dim(l.fy, H, STAGE, R), dim(l.ty, H, STAGE, R)));
      else {
        const px = dim(l.px, W, STAGE, R);
        const py = dim(l.py, H, STAGE, R);
        ctx.translate(px, py);
        if (l.kind === 'rotate') ctx.rotate((lerp(l.from, l.to) * Math.PI) / 180);
        else ctx.scale(lerp(l.fx, l.tx), lerp(l.fy, l.ty));
        ctx.translate(-px, -py);
      }
    }
    drawCard(ctx, 0, 0, W, H, alpha, 'View');
    ctx.restore();
  };
  const kinds = [...new Set(leaves.map(l => l.kind))].join(', ') || 'nothing';
  return shell(host, { canvas, duration, draw, note: `Animates: ${kinds} · played on a stand-in view` });
}

// ---------- property animators (res/animator) ----------

const PROP_DEFAULT = { alpha: 1, scaleX: 1, scaleY: 1, fillAlpha: 1, strokeAlpha: 1, trimPathEnd: 1 };

// Returns tracks: [{ target, prop, start, duration, repeat, reverse, interp, from, to, keyframes, type }]
function parseAnimator(node, R, start = 0, target = null) {
  const tag = node.tagName;
  if (tag === 'selector') {
    const first = [...node.children][0];
    return first ? [...first.children].flatMap(c => parseAnimator(c, R, start, target)) : [];
  }
  if (tag === 'set') {
    const seq = A(node, 'ordering') === 'sequentially' || A(node, 'ordering') === '1';
    let t = start;
    const out = [];
    for (const c of node.children) {
      const tracks = parseAnimator(c, R, t, target);
      out.push(...tracks);
      if (seq) t = Math.max(t, ...tracks.map(trackEnd));
    }
    return out;
  }
  if (tag !== 'objectAnimator' && tag !== 'animator') return [];
  const common = {
    target, start: start + R.num(A(node, 'startOffset')), duration: R.num(A(node, 'duration'), 300),
    repeat: A(node, 'repeatCount') != null ? R.num(A(node, 'repeatCount')) : 0,
    reverse: A(node, 'repeatMode') === 'reverse' || A(node, 'repeatMode') === '2',
    interp: interpolator(A(node, 'interpolator')), type: A(node, 'valueType'),
  };
  const tracks = [];
  const holders = [...node.children].filter(c => c.tagName === 'propertyValuesHolder');
  if (A(node, 'propertyName')) tracks.push({ ...common, prop: A(node, 'propertyName'), from: A(node, 'valueFrom'), to: A(node, 'valueTo') });
  if (A(node, 'propertyXName')) tracks.push({ ...common, prop: A(node, 'propertyXName'), path: A(node, 'pathData'), axis: 'x' });
  if (A(node, 'propertyYName')) tracks.push({ ...common, prop: A(node, 'propertyYName'), path: A(node, 'pathData'), axis: 'y' });
  for (const h of holders) {
    const kfs = [...h.children].filter(k => k.tagName === 'keyframe').map(k => ({ f: R.num(A(k, 'fraction'), 0), v: A(k, 'value'), interp: A(k, 'interpolator') ? interpolator(A(k, 'interpolator')) : null }));
    tracks.push({ ...common, prop: A(h, 'propertyName'), from: A(h, 'valueFrom'), to: A(h, 'valueTo'), keyframes: kfs.length ? kfs : null, type: A(h, 'valueType') || common.type });
  }
  return tracks;
}
const trackEnd = tr => tr.start + Math.max(1, tr.duration) * (tr.repeat < 0 ? 3 : tr.repeat + 1);

function colorParts(v) {
  const h = String(v || '').replace('#', '');
  if (!/^[0-9a-f]{3,8}$/i.test(h)) return null;
  const full = h.length === 3 ? `ff${h.split('').map(c => c + c).join('')}` : h.length === 6 ? `ff${h}` : h.length === 4 ? h.split('').map(c => c + c).join('') : h;
  return [1, 2, 3, 0].map(i => parseInt(full.slice(i * 2, i * 2 + 2), 16));
}
const rgba = p => `rgba(${p[0]},${p[1]},${p[2]},${(p[3] / 255).toFixed(3)})`;

// Path morphing: numbers between two paths with the same commands.
function pathNumbers(d) {
  return { cmds: (d.match(/[a-zA-Z]/g) || []).join(''), nums: (d.match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi) || []).map(Number), tpl: d.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi, '\u0000') };
}
function morph(a, b, e) {
  const pa = pathNumbers(a);
  const pb = pathNumbers(b);
  if (pa.cmds !== pb.cmds || pa.nums.length !== pb.nums.length) return e < 0.5 ? a : b;
  let i = 0;
  return pa.tpl.replace(/\u0000/g, () => { const v = pa.nums[i] + (pb.nums[i] - pa.nums[i]) * e; i++; return v.toFixed(3); });
}

// Value of one track at time t, or undefined before it starts.
function trackValue(tr, t, R, current) {
  const d = Math.max(1, tr.duration);
  const local = t - tr.start;
  if (local < 0) return undefined;
  const cycles = tr.repeat < 0 ? Infinity : tr.repeat + 1;
  const n = Math.floor(local / d);
  let f = n >= cycles ? (tr.reverse && cycles % 2 === 0 ? 0 : 1) : (local % d) / d;
  if (n < cycles && tr.reverse && n % 2 === 1) f = 1 - f;
  const e = tr.interp(f);
  const isPath = tr.type === 'pathType' || /pathData/i.test(tr.prop);
  const isColor = tr.type === 'colorType' || /color/i.test(tr.prop);
  const val = v => (isPath ? String(R.raw(v) ?? '') : isColor ? colorParts(R.raw(v)) : R.num(v, current));
  if (tr.keyframes) {
    const ks = tr.keyframes;
    let i = ks.length - 1;
    while (i > 0 && ks[i].f > e) i--;
    const k0 = ks[i];
    const k1 = ks[Math.min(i + 1, ks.length - 1)];
    if (k0 === k1) return val(k0.v);
    const local2 = (e - k0.f) / Math.max(1e-6, k1.f - k0.f);
    const ee = k1.interp ? k1.interp(local2) : local2;
    const a = val(k0.v);
    const b = val(k1.v);
    return isPath ? morph(a, b, ee) : isColor ? a && b ? a.map((x, j) => x + (b[j] - x) * ee) : b : a + (b - a) * ee;
  }
  const from = tr.from != null ? val(tr.from) : isPath || isColor ? null : current;
  const to = tr.to != null ? val(tr.to) : from;
  if (isPath) return from && to ? morph(from, to, e) : to || from;
  if (isColor) return from && to ? from.map((x, j) => x + (to[j] - x) * e) : to || from;
  return from + (to - from) * e;
}

export function createAnimatorPlayer(host, xml, values) {
  const R = makeResolver(values);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const tracks = parseAnimator(doc.documentElement, R);
  const duration = Math.max(300, ...tracks.map(trackEnd));
  const canvas = hiDpiCanvas(STAGE, STAGE);
  const ctx = canvas.getContext('2d');
  const W = 140;
  const H = 140;
  const draw = t => {
    stageBackground(ctx);
    const p = { alpha: 1, scaleX: 1, scaleY: 1, rotation: 0, translationX: 0, translationY: 0, elevation: 0 };
    for (const tr of tracks) {
      const name = tr.prop === 'x' ? 'translationX' : tr.prop === 'y' ? 'translationY' : tr.prop === 'translationZ' ? 'elevation' : tr.prop;
      if (!(name in p)) continue;
      const v = trackValue(tr, t, R, PROP_DEFAULT[name] ?? 0);
      if (v !== undefined) p[name] = v;
    }
    ctx.save();
    ctx.translate(STAGE / 2 + p.translationX, STAGE / 2 + p.translationY);
    ctx.rotate((p.rotation * Math.PI) / 180);
    ctx.scale(p.scaleX, p.scaleY);
    if (p.elevation > 0) { ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = p.elevation * 2; ctx.shadowOffsetY = p.elevation; }
    drawCard(ctx, -W / 2, -H / 2, W, H, p.alpha, 'View');
    ctx.restore();
  };
  const props = [...new Set(tracks.map(t => t.prop).filter(Boolean))].join(', ') || 'nothing';
  return shell(host, { canvas, duration, draw, note: `Animates: ${props} · played on a stand-in view` });
}

// ---------- animated vector drawables ----------

function parseVectorNode(node, R) {
  const tag = node.tagName;
  const n = k => A(node, k);
  if (tag === 'group') {
    return { kind: 'group', name: n('name'), props: { rotation: R.num(n('rotation')), pivotX: R.num(n('pivotX')), pivotY: R.num(n('pivotY')),
      scaleX: R.num(n('scaleX'), 1), scaleY: R.num(n('scaleY'), 1), translateX: R.num(n('translateX')), translateY: R.num(n('translateY')) },
    children: [...node.children].map(c => parseVectorNode(c, R)).filter(Boolean) };
  }
  if (tag === 'path' || tag === 'clip-path') {
    const color = v => { const c = R.raw(v); return /^#/.test(c || '') ? colorParts(c) : v ? [220, 225, 235, 255] : null; };
    return { kind: tag, name: n('name'), props: { pathData: n('pathData') || '', fillColor: color(n('fillColor')), strokeColor: color(n('strokeColor')),
      strokeWidth: R.num(n('strokeWidth'), 0), fillAlpha: R.num(n('fillAlpha'), 1), strokeAlpha: R.num(n('strokeAlpha'), 1),
      trimPathStart: R.num(n('trimPathStart'), 0), trimPathEnd: R.num(n('trimPathEnd'), 1), trimPathOffset: R.num(n('trimPathOffset'), 0),
      lineCap: (n('strokeLineCap') || 'butt').toLowerCase(), lineJoin: (n('strokeLineJoin') || 'miter').toLowerCase(), evenOdd: n('fillType') === 'evenOdd' } };
  }
  return null;
}

let measureSvg = null;
const lengths = new Map();
function pathLength(d) {
  if (lengths.has(d)) return lengths.get(d);
  if (!measureSvg) {
    measureSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    measureSvg.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden';
    document.body.append(measureSvg);
  }
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  measureSvg.append(p);
  let len = 0;
  try { len = p.getTotalLength(); } catch { /* invalid path */ }
  p.remove();
  lengths.set(d, len);
  return len;
}

export function createAvdPlayer(host, vectorXml, targets, values) {
  const R = makeResolver(values);
  const doc = new DOMParser().parseFromString(vectorXml, 'application/xml');
  const root = doc.documentElement;
  const vw = R.num(A(root, 'viewportWidth'), 24);
  const vh = R.num(A(root, 'viewportHeight'), 24);
  const tree = [...root.children].map(c => parseVectorNode(c, R)).filter(Boolean);
  const byName = new Map();
  const index = nodes => { for (const n of nodes) { if (n.name) byName.set(n.name, n); if (n.children) index(n.children); } };
  index(tree);
  const tracks = [];
  for (const tg of targets) {
    const d = new DOMParser().parseFromString(tg.xml, 'application/xml');
    tracks.push(...parseAnimator(d.documentElement, R, 0, tg.name));
  }
  const duration = Math.max(300, ...tracks.map(trackEnd));
  const canvas = hiDpiCanvas(STAGE, STAGE);
  const ctx = canvas.getContext('2d');
  const size = STAGE * 0.7;
  const k = size / Math.max(vw, vh);

  const drawNodes = (nodes, state) => {
    for (const n of nodes) {
      const p = state.get(n) || n.props;
      if (n.kind === 'group') {
        ctx.save();
        ctx.translate(p.translateX + p.pivotX, p.translateY + p.pivotY);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.scale(p.scaleX, p.scaleY);
        ctx.translate(-p.pivotX, -p.pivotY);
        drawNodes(n.children, state);
        ctx.restore();
      } else if (n.kind === 'clip-path') {
        try { ctx.clip(new Path2D(p.pathData)); } catch { /* bad path */ }
      } else {
        let path;
        try { path = new Path2D(p.pathData); } catch { continue; }
        if (p.fillColor && p.fillAlpha > 0) {
          ctx.fillStyle = rgba([...p.fillColor.slice(0, 3), p.fillColor[3] * p.fillAlpha]);
          ctx.fill(path, p.evenOdd ? 'evenodd' : 'nonzero');
        }
        if (p.strokeColor && p.strokeWidth > 0 && p.strokeAlpha > 0) {
          ctx.strokeStyle = rgba([...p.strokeColor.slice(0, 3), p.strokeColor[3] * p.strokeAlpha]);
          ctx.lineWidth = p.strokeWidth;
          ctx.lineCap = p.lineCap;
          ctx.lineJoin = p.lineJoin;
          if (p.trimPathStart !== 0 || p.trimPathEnd !== 1 || p.trimPathOffset !== 0) {
            const len = pathLength(p.pathData) || 1;
            const s = ((p.trimPathStart + p.trimPathOffset) % 1) * len;
            const visible = Math.max(0, p.trimPathEnd - p.trimPathStart) * len;
            ctx.setLineDash([visible, len]);
            ctx.lineDashOffset = -s;
          }
          ctx.stroke(path);
          ctx.setLineDash([]);
        }
      }
    }
  };

  const draw = t => {
    stageBackground(ctx);
    const state = new Map();
    for (const tr of tracks) {
      const node = byName.get(tr.target);
      if (!node) continue;
      const cur = state.get(node) || { ...node.props };
      if (!(tr.prop in cur)) continue;
      const v = trackValue(tr, t, R, cur[tr.prop]);
      if (v !== undefined && v !== null) cur[tr.prop] = v;
      state.set(node, cur);
    }
    ctx.save();
    ctx.translate((STAGE - vw * k) / 2, (STAGE - vh * k) / 2);
    ctx.scale(k, k);
    drawNodes(tree, state);
    ctx.restore();
  };
  const missing = targets.filter(tg => !byName.has(tg.name)).length;
  return shell(host, { canvas, duration, draw, loop: true,
    note: `${tracks.length} animated propert${tracks.length === 1 ? 'y' : 'ies'} on ${targets.length} target${targets.length === 1 ? '' : 's'}${missing ? ` · ${missing} target(s) not found in the vector` : ''} · colours from the app theme are shown as light grey` });
}

// ---------- frame animations ----------

export async function createFramePlayer(host, frames, oneshot) {
  const images = await Promise.all(frames.map(f => new Promise(res => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = f.url;
  })));
  const list = frames.map((f, i) => ({ ...f, img: images[i] })).filter(f => f.img);
  const duration = list.reduce((s, f) => s + f.duration, 0) || 100;
  const canvas = hiDpiCanvas(STAGE, STAGE);
  const ctx = canvas.getContext('2d');
  const draw = t => {
    stageBackground(ctx);
    let acc = 0;
    let frame = list[list.length - 1];
    for (const f of list) { acc += f.duration; if (t < acc) { frame = f; break; } }
    if (!frame) return;
    const s = Math.min((STAGE * 0.8) / frame.img.width, (STAGE * 0.8) / frame.img.height);
    ctx.imageSmoothingEnabled = frame.img.width >= 64;
    ctx.drawImage(frame.img, (STAGE - frame.img.width * s) / 2, (STAGE - frame.img.height * s) / 2, frame.img.width * s, frame.img.height * s);
  };
  return shell(host, { canvas, duration, draw, loop: !oneshot, note: `${list.length} frames${oneshot ? ' · plays once' : ''}` });
}

// ---------- Lottie ----------

let lottieLoad = null;
function loadLottie() {
  if (!lottieLoad) {
    lottieLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      // The "light canvas" build: no expressions, so files can't run code.
      s.src = '/lottie/lottie_light_canvas.min.js';
      s.onload = () => resolve(window.lottie);
      s.onerror = () => reject(new Error('Lottie player could not be loaded'));
      document.head.append(s);
    });
  }
  return lottieLoad;
}

export async function createLottiePlayer(host, url) {
  const lottie = await loadLottie();
  // The canvas renderer sizes itself from its container, so load it on the page.
  const box = el('div', { className: 'lottie-box' });
  box.style.cssText = `width:${STAGE}px;height:${STAGE}px;position:absolute;left:-10000px;top:0`;
  document.body.append(box);
  const anim = lottie.loadAnimation({ container: box, renderer: 'canvas', loop: false, autoplay: false, path: url,
    rendererSettings: { clearCanvas: true, preserveAspectRatio: 'xMidYMid meet' } });
  try {
    await new Promise((resolve, reject) => {
      anim.addEventListener('DOMLoaded', resolve);
      anim.addEventListener('data_failed', () => reject(new Error('This Lottie file could not be read')));
    });
  } catch (err) {
    anim.destroy();
    box.remove();
    throw err;
  }
  const canvas = box.querySelector('canvas');
  box.remove();
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.objectFit = 'contain';
  const frames = anim.totalFrames;
  const fps = anim.frameRate || 30;
  const duration = (frames / fps) * 1000;
  const player = shell(host, { canvas, duration, draw: t => anim.goToAndStop(Math.min(frames - 0.01, (t / 1000) * fps), true),
    note: `${Math.round(frames)} frames at ${fps} fps · ${anim.animationData?.w || '?'}×${anim.animationData?.h || '?'}` });
  const dispose = player.dispose;
  player.dispose = () => { dispose(); anim.destroy(); };
  return player;
}

// ---------- recording ----------

// Records `seconds` of a canvas to a video Blob, restarting the animation first.
export async function recordCanvas(canvas, seconds, restart) {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mimeType = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('Video recording is not available');
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(res => { rec.onstop = res; });
  restart?.();
  rec.start(250);
  await new Promise(r => setTimeout(r, seconds * 1000));
  rec.stop();
  await done;
  stream.getTracks().forEach(t => t.stop());
  return { blob: new Blob(chunks, { type: mimeType }), ext: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' };
}
