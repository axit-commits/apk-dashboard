// Spine skeleton model, written from the JSON export format (3.x and 4.x):
// atlas and skeleton parsing, animation sampling, bone world transforms,
// IK and transform constraints, and attachment vertex computation.
// Independent of the official Spine Runtimes, which carry a paid licence.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const wrap180 = d => d - Math.round(d / 360) * 360;
const num = (v, d) => (typeof v === 'number' ? v : d);
const time = k => num(k.time, 0);

// ---------- atlas (libGDX / Spine text format, 3.x "xy/size" and 4.x "bounds") ----------

export function parseAtlas(text) {
  const pages = [];
  const regions = new Map();
  let page = null;
  let region = null;
  const ints = v => v.split(',').map(s => Number(s.trim()));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { page = null; region = null; continue; }
    const colon = line.indexOf(':');
    if (!page) {
      page = { name: line, width: 0, height: 0, pma: false };
      pages.push(page);
      region = null;
      continue;
    }
    if (colon < 0) {
      region = { name: line, page, x: 0, y: 0, w: 0, h: 0, rotate: 0, offsetX: 0, offsetY: 0, origW: 0, origH: 0 };
      regions.set(line, region);
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!region) {
      if (key === 'size') [page.width, page.height] = ints(value);
      else if (key === 'pma') page.pma = value === 'true';
      continue;
    }
    if (key === 'bounds') [region.x, region.y, region.w, region.h] = ints(value);
    else if (key === 'xy') [region.x, region.y] = ints(value);
    else if (key === 'size') [region.w, region.h] = ints(value);
    else if (key === 'orig') [region.origW, region.origH] = ints(value);
    else if (key === 'offset') [region.offsetX, region.offsetY] = ints(value);
    else if (key === 'offsets') [region.offsetX, region.offsetY, region.origW, region.origH] = ints(value);
    else if (key === 'rotate') region.rotate = value === 'true' ? 90 : value === 'false' ? 0 : Number(value) || 0;
  }
  for (const r of regions.values()) {
    if (!r.origW) r.origW = r.w;
    if (!r.origH) r.origH = r.h;
  }
  return { pages, regions };
}

// Maps a point (s, t) of the unrotated region image (t down) to page UVs.
export function regionUv(r, s, t) {
  const pw = r.page.width || 1;
  const ph = r.page.height || 1;
  const rot = ((r.rotate % 360) + 360) % 360;
  const areaW = rot === 90 || rot === 270 ? r.h : r.w;
  const areaH = rot === 90 || rot === 270 ? r.w : r.h;
  let a;
  let b;
  if (rot === 90) [a, b] = [1 - t, s];
  else if (rot === 180) [a, b] = [1 - s, 1 - t];
  else if (rot === 270) [a, b] = [t, 1 - s];
  else [a, b] = [s, t];
  return [(r.x + a * areaW) / pw, (r.y + b * areaH) / ph];
}

// ---------- skeleton data ----------

function color(hex, fallback = [1, 1, 1, 1]) {
  if (typeof hex !== 'string' || hex.length < 6) return fallback.slice();
  const c = [0, 2, 4, 6].map(i => parseInt(hex.slice(i, i + 2) || 'ff', 16) / 255);
  return c.map(v => (Number.isFinite(v) ? v : 1));
}

function parseAttachment(name, a) {
  const type = a.type || 'region';
  const base = { name, type, path: a.path || a.name || name, color: color(a.color) };
  if (type === 'region') {
    return { ...base, x: num(a.x, 0), y: num(a.y, 0), rotation: num(a.rotation, 0), scaleX: num(a.scaleX, 1),
      scaleY: num(a.scaleY, 1), width: num(a.width, 32), height: num(a.height, 32), sequence: !!a.sequence };
  }
  if (type === 'mesh') {
    const uvs = a.uvs || [];
    const raw = a.vertices || [];
    const weighted = raw.length > uvs.length;
    let vertices = raw;
    let bones = null;
    if (weighted) {
      vertices = [];
      bones = [];
      for (let i = 0; i < raw.length;) {
        const n = raw[i++];
        const infl = [];
        for (let j = 0; j < n; j++, i += 4) infl.push([raw[i], raw[i + 1], raw[i + 2], raw[i + 3]]);
        bones.push(infl);
      }
    }
    return { ...base, uvs, triangles: a.triangles || [], vertices, weighted, influences: bones, sequence: !!a.sequence };
  }
  if (type === 'linkedmesh') {
    return { ...base, parent: a.parent, skin: a.skin || 'default', inheritDeform: a.timelines ?? a.deform ?? true };
  }
  return { ...base, unsupported: true }; // boundingbox, path, point, clipping
}

export function parseSkeleton(json) {
  const version = json.skeleton?.spine || '3';
  const v4 = Number.parseInt(version, 10) >= 4;
  const boneIndex = new Map();
  const bones = (json.bones || []).map((b, i) => {
    boneIndex.set(b.name, i);
    return {
      name: b.name, parent: b.parent != null ? boneIndex.get(b.parent) ?? null : null, length: num(b.length, 0),
      x: num(b.x, 0), y: num(b.y, 0), rotation: num(b.rotation, 0), scaleX: num(b.scaleX, 1), scaleY: num(b.scaleY, 1),
      shearX: num(b.shearX, 0), shearY: num(b.shearY, 0), inherit: b.inherit || b.transform || 'normal',
    };
  });
  const slotIndex = new Map();
  const slots = (json.slots || []).map((s, i) => {
    slotIndex.set(s.name, i);
    return { name: s.name, bone: boneIndex.get(s.bone) ?? 0, color: color(s.color), attachment: s.attachment ?? null, blend: s.blend || 'normal' };
  });

  // Skins: an array in 3.8+, an object of skin name -> slots before that.
  const skinList = Array.isArray(json.skins)
    ? json.skins.map(s => [s.name, s.attachments || {}])
    : Object.entries(json.skins || {});
  const skins = new Map();
  const unsupported = new Set();
  for (const [skinName, slotsMap] of skinList) {
    const bySlot = new Map();
    for (const [slotName, atts] of Object.entries(slotsMap)) {
      const si = slotIndex.get(slotName);
      if (si == null) continue;
      const m = new Map();
      for (const [attName, a] of Object.entries(atts)) {
        const att = parseAttachment(attName, a);
        if (att.unsupported && att.type !== 'boundingbox' && att.type !== 'point') unsupported.add(`${att.type} attachments`);
        if (att.sequence) unsupported.add('sequence attachments');
        m.set(attName, att);
      }
      bySlot.set(si, m);
    }
    skins.set(skinName, bySlot);
  }
  // Linked meshes take their geometry from a parent mesh.
  for (const bySlot of skins.values()) {
    for (const [si, m] of bySlot) {
      for (const att of m.values()) {
        if (att.type !== 'linkedmesh') continue;
        const parent = skins.get(att.skin)?.get(si)?.get(att.parent) || bySlot.get(si)?.get(att.parent);
        if (!parent || parent.type !== 'mesh') { att.unsupported = true; continue; }
        Object.assign(att, { type: 'mesh', uvs: parent.uvs, triangles: parent.triangles, vertices: parent.vertices,
          weighted: parent.weighted, influences: parent.influences, deformKey: att.inheritDeform ? parent.name : att.name });
      }
    }
  }

  const ik = (json.ik || []).map(c => ({
    name: c.name, order: num(c.order, 0), kind: 'ik', bones: (c.bones || []).map(n => boneIndex.get(n)).filter(i => i != null),
    target: boneIndex.get(c.target), mix: num(c.mix, 1), bendPositive: c.bendPositive ?? true,
  }));
  const transform = (json.transform || []).map(c => {
    if (c.local || c.relative) unsupported.add('local/relative transform constraints');
    const t = v4
      ? { rotate: num(c.mixRotate, 1), x: num(c.mixX, 1), scaleX: num(c.mixScaleX, 1), shearY: num(c.mixShearY, 1) }
      : { rotate: num(c.rotateMix, 1), x: num(c.translateMix, 1), scaleX: num(c.scaleMix, 1), shearY: num(c.shearMix, 1) };
    t.y = v4 ? num(c.mixY, t.x) : t.x;
    t.scaleY = v4 ? num(c.mixScaleY, t.scaleX) : t.scaleX;
    return {
      name: c.name, order: num(c.order, 0), kind: 'transform', bones: (c.bones || []).map(n => boneIndex.get(n)).filter(i => i != null),
      target: boneIndex.get(c.target), mix: t,
      offset: { rotation: num(c.rotation, 0), x: num(c.x, 0), y: num(c.y, 0), scaleX: num(c.scaleX, 0), scaleY: num(c.scaleY, 0), shearY: num(c.shearY, 0) },
    };
  });
  if (json.path?.length) unsupported.add('path constraints');
  if (json.physics?.length) unsupported.add('physics constraints');
  const constraints = [...ik, ...transform].filter(c => c.target != null && c.bones.length)
    .sort((a, b) => a.order - b.order);

  const animations = new Map();
  for (const [name, a] of Object.entries(json.animations || {})) animations.set(name, parseAnimation(a, { v4, boneIndex, slotIndex, ik, transform }));
  return { version, v4, bones, slots, skins, constraints, animations, unsupported: [...unsupported], boneIndex, slotIndex,
    events: Object.keys(json.events || {}) };
}

function parseAnimation(a, ctx) {
  const { v4, boneIndex, slotIndex, ik, transform } = ctx;
  let duration = 0;
  const seen = keys => { for (const k of keys || []) duration = Math.max(duration, time(k)); return keys || []; };
  const boneTl = [];
  for (const [boneName, tls] of Object.entries(a.bones || {})) {
    const bi = boneIndex.get(boneName);
    if (bi == null) continue;
    for (const [type, keys] of Object.entries(tls)) boneTl.push({ bone: bi, type: type.toLowerCase(), keys: seen(keys) });
  }
  const slotTl = [];
  for (const [slotName, tls] of Object.entries(a.slots || {})) {
    const si = slotIndex.get(slotName);
    if (si == null) continue;
    for (const [type, keys] of Object.entries(tls)) slotTl.push({ slot: si, type: type.toLowerCase(), keys: seen(keys) });
  }
  const deform = [];
  const addDeform = (skin, slotName, attName, keys) => {
    const si = slotIndex.get(slotName);
    if (si != null) deform.push({ skin, slot: si, attachment: attName, keys: seen(keys) });
  };
  for (const [skin, slots] of Object.entries(a.deform || a.ffd || {})) {
    for (const [slotName, atts] of Object.entries(slots)) for (const [attName, keys] of Object.entries(atts)) addDeform(skin, slotName, attName, keys);
  }
  for (const [skin, slots] of Object.entries(a.attachments || {})) {
    for (const [slotName, atts] of Object.entries(slots)) {
      for (const [attName, tls] of Object.entries(atts)) if (tls.deform) addDeform(skin, slotName, attName, tls.deform);
    }
  }
  const drawOrder = seen(a.drawOrder || a.draworder || []).map(k => ({
    time: time(k), offsets: k.offsets ? k.offsets.map(o => ({ slot: slotIndex.get(o.slot), offset: o.offset })).filter(o => o.slot != null) : null,
  }));
  const ikTl = Object.entries(a.ik || {}).map(([n, keys]) => ({ c: ik.find(c => c.name === n), keys: seen(keys) })).filter(t => t.c);
  const tcTl = Object.entries(a.transform || {}).map(([n, keys]) => ({ c: transform.find(c => c.name === n), keys: seen(keys) })).filter(t => t.c);
  return { duration, v4, boneTl, slotTl, deform, drawOrder, ikTl, tcTl, events: (a.events || []).length };
}

// ---------- curves ----------

function bezier(x0, y0, cx1, cy1, cx2, cy2, x1, y1, x) {
  let lo = 0;
  let hi = 1;
  let s = 0.5;
  for (let i = 0; i < 24; i++) {
    s = (lo + hi) / 2;
    const u = 1 - s;
    const bx = u * u * u * x0 + 3 * u * u * s * cx1 + 3 * u * s * s * cx2 + s * s * s * x1;
    if (bx < x) lo = s; else hi = s;
  }
  const u = 1 - s;
  return u * u * u * y0 + 3 * u * u * s * cy1 + 3 * u * s * s * cy2 + s * s * s * y1;
}

// Value between keys k0 (value a) and k1 (value b) at t, for channel ch.
function curveValue(k0, k1, t, ch, a, b, v4) {
  if (k0.curve === 'stepped') return a;
  const t0 = time(k0);
  const t1 = time(k1);
  if (t1 <= t0) return b;
  if (v4) {
    const c = Array.isArray(k0.curve) ? k0.curve.slice(4 * ch, 4 * ch + 4) : null;
    if (c && c.length === 4) return bezier(t0, a, c[0], c[1], c[2], c[3], t1, b, t);
    return a + ((b - a) * (t - t0)) / (t1 - t0);
  }
  let p = (t - t0) / (t1 - t0);
  const c = Array.isArray(k0.curve) ? k0.curve : typeof k0.curve === 'number' ? [k0.curve, num(k0.c2, 0), num(k0.c3, 1), num(k0.c4, 1)] : null;
  if (c) p = bezier(0, 0, c[0], c[1], c[2], c[3], 1, 1, p);
  return a + (b - a) * p;
}

// Samples keyed values (vals(k) -> number[]) at t; null before the first key.
function sample(keys, t, vals, v4, angle = false) {
  if (!keys.length || t < time(keys[0])) return null;
  let i = keys.length - 1;
  while (i > 0 && time(keys[i]) > t) i--;
  const a = vals(keys[i]);
  if (i === keys.length - 1) return a;
  const b = vals(keys[i + 1]);
  return a.map((av, ch) => {
    let bv = b[ch];
    if (angle && !v4) bv = av + wrap180(bv - av);
    return curveValue(keys[i], keys[i + 1], t, ch, av, bv, v4);
  });
}

function lastKey(keys, t) {
  if (!keys.length || t < time(keys[0])) return null;
  let i = keys.length - 1;
  while (i > 0 && time(keys[i]) > t) i--;
  return keys[i];
}

// ---------- pose ----------

export function createPose(data) {
  const bones = data.bones.map(b => ({ ...b, a: 1, b: 0, c: 0, d: 1, worldX: 0, worldY: 0 }));
  const children = data.bones.map(() => []);
  data.bones.forEach((b, i) => { if (b.parent != null) children[b.parent].push(i); });
  return {
    data, bones, children,
    slots: data.slots.map(s => ({ attachmentName: s.attachment, color: s.color.slice() })),
    drawOrder: data.slots.map((_, i) => i),
    deforms: new Map(), // `${slot}|${attachment}` -> offsets
    constraints: data.constraints.map(c => ({ ...c, mix: typeof c.mix === 'object' ? { ...c.mix } : c.mix })),
  };
}

function resetPose(p) {
  p.data.bones.forEach((b, i) => Object.assign(p.bones[i], { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX,
    scaleY: b.scaleY, shearX: b.shearX, shearY: b.shearY }));
  p.data.slots.forEach((s, i) => { p.slots[i].attachmentName = s.attachment; p.slots[i].color = s.color.slice(); });
  p.drawOrder = p.data.slots.map((_, i) => i);
  p.deforms.clear();
  p.data.constraints.forEach((c, i) => { p.constraints[i].mix = typeof c.mix === 'object' ? { ...c.mix } : c.mix; p.constraints[i].bendPositive = c.bendPositive; });
}

export function applyAnimation(p, anim, t) {
  resetPose(p);
  if (!anim) return;
  const { v4 } = anim;
  for (const tl of anim.boneTl) {
    const bone = p.bones[tl.bone];
    const setup = p.data.bones[tl.bone];
    const k = tl.keys;
    switch (tl.type) {
      case 'rotate': {
        const v = sample(k, t, key => [v4 ? num(key.value, 0) : num(key.angle, 0)], v4, true);
        if (v) bone.rotation = setup.rotation + v[0];
        break;
      }
      case 'translate': {
        const v = sample(k, t, key => [num(key.x, 0), num(key.y, 0)], v4);
        if (v) { bone.x = setup.x + v[0]; bone.y = setup.y + v[1]; }
        break;
      }
      case 'translatex': { const v = sample(k, t, key => [num(key.value, 0)], v4); if (v) bone.x = setup.x + v[0]; break; }
      case 'translatey': { const v = sample(k, t, key => [num(key.value, 0)], v4); if (v) bone.y = setup.y + v[0]; break; }
      case 'scale': {
        const v = sample(k, t, key => [num(key.x, 1), num(key.y, 1)], v4);
        if (v) { bone.scaleX = setup.scaleX * v[0]; bone.scaleY = setup.scaleY * v[1]; }
        break;
      }
      case 'scalex': { const v = sample(k, t, key => [num(key.value, 1)], v4); if (v) bone.scaleX = setup.scaleX * v[0]; break; }
      case 'scaley': { const v = sample(k, t, key => [num(key.value, 1)], v4); if (v) bone.scaleY = setup.scaleY * v[0]; break; }
      case 'shear': {
        const v = sample(k, t, key => [num(key.x, 0), num(key.y, 0)], v4);
        if (v) { bone.shearX = setup.shearX + v[0]; bone.shearY = setup.shearY + v[1]; }
        break;
      }
      case 'shearx': { const v = sample(k, t, key => [num(key.value, 0)], v4); if (v) bone.shearX = setup.shearX + v[0]; break; }
      case 'sheary': { const v = sample(k, t, key => [num(key.value, 0)], v4); if (v) bone.shearY = setup.shearY + v[0]; break; }
      default: break;
    }
  }
  for (const tl of anim.slotTl) {
    const slot = p.slots[tl.slot];
    if (tl.type === 'attachment') {
      const key = lastKey(tl.keys, t);
      if (key) slot.attachmentName = key.name ?? null;
    } else if (tl.type === 'color' || tl.type === 'rgba') {
      const v = sample(tl.keys, t, key => color(key.color), v4);
      if (v) slot.color = v;
    } else if (tl.type === 'rgb') {
      const v = sample(tl.keys, t, key => color(key.color).slice(0, 3), v4);
      if (v) slot.color = [...v, slot.color[3]];
    } else if (tl.type === 'alpha') {
      const v = sample(tl.keys, t, key => [num(key.value, 1)], v4);
      if (v) slot.color[3] = v[0];
    } else if (tl.type === 'twocolor' || tl.type === 'rgba2') {
      const v = sample(tl.keys, t, key => color(key.light), v4);
      if (v) slot.color = v;
    }
  }
  for (const tl of anim.ikTl) {
    const c = p.constraints.find(x => x.name === tl.c.name && x.kind === 'ik');
    const v = sample(tl.keys, t, key => [num(key.mix, 1)], v4);
    if (c && v) { c.mix = v[0]; c.bendPositive = (lastKey(tl.keys, t)?.bendPositive) ?? true; }
  }
  for (const tl of anim.tcTl) {
    const c = p.constraints.find(x => x.name === tl.c.name && x.kind === 'transform');
    const v = sample(tl.keys, t, key => (v4
      ? [num(key.mixRotate, 1), num(key.mixX, 1), num(key.mixY, num(key.mixX, 1)), num(key.mixScaleX, 1), num(key.mixScaleY, num(key.mixScaleX, 1)), num(key.mixShearY, 1)]
      : [num(key.rotateMix, 1), num(key.translateMix, 1), num(key.translateMix, 1), num(key.scaleMix, 1), num(key.scaleMix, 1), num(key.shearMix, 1)]), v4);
    if (c && v) c.mix = { rotate: v[0], x: v[1], y: v[2], scaleX: v[3], scaleY: v[4], shearY: v[5] };
  }
  for (const tl of anim.deform) {
    const k = tl.keys;
    if (!k.length || t < time(k[0])) continue;
    let i = k.length - 1;
    while (i > 0 && time(k[i]) > t) i--;
    const expand = key => ({ off: num(key.offset, 0), v: key.vertices || [] });
    const a = expand(k[i]);
    const b = i < k.length - 1 ? expand(k[i + 1]) : null;
    const pct = b ? curveValue(k[i], k[i + 1], t, 0, 0, 1, v4) : 0;
    p.deforms.set(`${tl.slot}|${tl.attachment}`, { a, b, pct });
  }
  const dk = lastKey(anim.drawOrder, t);
  if (dk && dk.offsets) p.drawOrder = drawOrderFrom(dk.offsets, p.data.slots.length);
}

function drawOrderFrom(offsets, n) {
  const order = new Array(n).fill(-1);
  const unchanged = [];
  let original = 0;
  for (const { slot, offset } of offsets) {
    while (original !== slot && original < n) unchanged.push(original++);
    if (original + offset >= 0 && original + offset < n) order[original + offset] = original;
    original++;
  }
  while (original < n) unchanged.push(original++);
  for (let i = n - 1; i >= 0; i--) if (order[i] === -1) order[i] = unchanged.pop();
  return order;
}

// Deform offsets (length = vertex coordinate count) for an attachment, or null.
export function deformFor(p, slot, att) {
  const d = p.deforms.get(`${slot}|${att.deformKey || att.name}`);
  if (!d) return null;
  const at = i => { const j = i - d.a.off; return j >= 0 && j < d.a.v.length ? d.a.v[j] : 0; };
  const bt = i => { const j = i - d.b.off; return j >= 0 && j < d.b.v.length ? d.b.v[j] : 0; };
  return i => (d.b ? at(i) + (bt(i) - at(i)) * d.pct : at(i));
}

// ---------- world transforms and constraints ----------

function updateBone(p, i) {
  const bone = p.bones[i];
  const rx = (bone.rotation + bone.shearX) * D2R;
  const ry = (bone.rotation + 90 + bone.shearY) * D2R;
  const la = Math.cos(rx) * bone.scaleX;
  const lb = Math.cos(ry) * bone.scaleY;
  const lc = Math.sin(rx) * bone.scaleX;
  const ld = Math.sin(ry) * bone.scaleY;
  if (bone.parent == null) {
    Object.assign(bone, { a: la, b: lb, c: lc, d: ld, worldX: bone.x, worldY: bone.y });
    return;
  }
  const pa = p.bones[bone.parent];
  bone.worldX = pa.a * bone.x + pa.b * bone.y + pa.worldX;
  bone.worldY = pa.c * bone.x + pa.d * bone.y + pa.worldY;
  switch (bone.inherit) {
    case 'onlyTranslation':
      Object.assign(bone, { a: la, b: lb, c: lc, d: ld });
      break;
    case 'noRotationOrReflection': {
      const sx = Math.hypot(pa.a, pa.c);
      const sy = Math.hypot(pa.b, pa.d);
      Object.assign(bone, { a: la * sx, b: lb * sy, c: lc * sx, d: ld * sy });
      break;
    }
    case 'noScale':
    case 'noScaleOrReflection': {
      const pr = Math.atan2(pa.c, pa.a);
      const cr = Math.cos(pr);
      const sr = Math.sin(pr);
      Object.assign(bone, { a: cr * la - sr * lc, b: cr * lb - sr * ld, c: sr * la + cr * lc, d: sr * lb + cr * ld });
      break;
    }
    default:
      Object.assign(bone, { a: pa.a * la + pa.b * lc, b: pa.a * lb + pa.b * ld, c: pa.c * la + pa.d * lc, d: pa.c * lb + pa.d * ld });
  }
}

function updateSubtree(p, i, includeSelf = true) {
  if (includeSelf) updateBone(p, i);
  for (const c of p.children[i]) updateSubtree(p, c);
}

function ikOne(p, bi, tx, ty, mix) {
  const bone = p.bones[bi];
  const pa = bone.parent != null ? p.bones[bone.parent] : { a: 1, b: 0, c: 0, d: 1, worldX: 0, worldY: 0 };
  const det = pa.a * pa.d - pa.b * pa.c || 1;
  const dx = tx - pa.worldX;
  const dy = ty - pa.worldY;
  const lx = (dx * pa.d - dy * pa.b) / det - bone.x;
  const ly = (dy * pa.a - dx * pa.c) / det - bone.y;
  let rot = Math.atan2(ly, lx) * R2D - bone.shearX;
  if (bone.scaleX < 0) rot += 180;
  bone.rotation += wrap180(rot - bone.rotation) * mix;
  updateSubtree(p, bi);
}

function ikTwo(p, pi, ci, tx, ty, mix, bendPositive) {
  const parent = p.bones[pi];
  const child = p.bones[ci];
  const px = parent.worldX;
  const py = parent.worldY;
  const l1 = Math.hypot(child.worldX - px, child.worldY - py);
  const l2 = Math.hypot(child.a * child.length, child.c * child.length);
  if (!l1 || !l2) return ikOne(p, pi, tx, ty, mix);
  const d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, Math.hypot(tx - px, ty - py)));
  const base = Math.atan2(ty - py, tx - px);
  const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const flip = parent.a * parent.d - parent.b * parent.c < 0 ? -1 : 1;
  const desired = base - (bendPositive ? 1 : -1) * flip * Math.acos(cosA);
  const current = Math.atan2(child.worldY - py, child.worldX - px);
  parent.rotation += wrap180((desired - current) * R2D) * mix * flip;
  updateSubtree(p, pi);
  const want = Math.atan2(ty - child.worldY, tx - child.worldX);
  const has = Math.atan2(child.c, child.a);
  child.rotation += wrap180((want - has) * R2D) * mix * flip;
  updateSubtree(p, ci);
}

function applyTransformConstraint(p, c) {
  const t = p.bones[c.target];
  const m = c.mix;
  const o = c.offset;
  const tr = Math.atan2(t.c, t.a);
  for (const bi of c.bones) {
    const b = p.bones[bi];
    if (m.rotate) {
      let r = tr - Math.atan2(b.c, b.a) + o.rotation * D2R;
      r = Math.atan2(Math.sin(r), Math.cos(r)) * m.rotate;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      Object.assign(b, { a: cos * b.a - sin * b.c, b: cos * b.b - sin * b.d, c: sin * b.a + cos * b.c, d: sin * b.b + cos * b.d });
    }
    if (m.x || m.y) {
      const wx = t.a * o.x + t.b * o.y + t.worldX;
      const wy = t.c * o.x + t.d * o.y + t.worldY;
      b.worldX += (wx - b.worldX) * m.x;
      b.worldY += (wy - b.worldY) * m.y;
    }
    if (m.scaleX) {
      const s = Math.hypot(b.a, b.c);
      if (s > 1e-5) { const f = (s + (Math.hypot(t.a, t.c) - s + o.scaleX) * m.scaleX) / s; b.a *= f; b.c *= f; }
    }
    if (m.scaleY) {
      const s = Math.hypot(b.b, b.d);
      if (s > 1e-5) { const f = (s + (Math.hypot(t.b, t.d) - s + o.scaleY) * m.scaleY) / s; b.b *= f; b.d *= f; }
    }
    updateSubtree(p, bi, false);
  }
}

export function updateWorld(p) {
  p.bones.forEach((_, i) => updateBone(p, i));
  for (const c of p.constraints) {
    const target = p.bones[c.target];
    if (c.kind === 'ik') {
      if (!c.mix) continue;
      if (c.bones.length === 1) ikOne(p, c.bones[0], target.worldX, target.worldY, c.mix);
      else ikTwo(p, c.bones[0], c.bones[c.bones.length - 1], target.worldX, target.worldY, c.mix, c.bendPositive);
    } else {
      applyTransformConstraint(p, c);
    }
  }
}

// ---------- attachments ----------

export function findAttachment(data, skinName, slot, name) {
  if (name == null) return null;
  return data.skins.get(skinName)?.get(slot)?.get(name) || data.skins.get('default')?.get(slot)?.get(name) || null;
}

// World vertices [x0, y0, x1, y1, ...] for a region (4 corners: BL, TL, TR, BR) or mesh.
export function worldVertices(p, slotIndex, att, region) {
  const bone = p.bones[p.data.slots[slotIndex].bone];
  if (att.type === 'region') {
    const w = region ? region.w : att.width;
    const h = region ? region.h : att.height;
    const ow = region ? region.origW : att.width;
    const oh = region ? region.origH : att.height;
    const rsx = (att.width / ow) * att.scaleX;
    const rsy = (att.height / oh) * att.scaleY;
    const x1 = (-att.width / 2) * att.scaleX + (region ? region.offsetX : 0) * rsx;
    const y1 = (-att.height / 2) * att.scaleY + (region ? region.offsetY : 0) * rsy;
    const x2 = x1 + w * rsx;
    const y2 = y1 + h * rsy;
    const r = att.rotation * D2R;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const out = [];
    for (const [lx, ly] of [[x1, y1], [x1, y2], [x2, y2], [x2, y1]]) {
      const ax = lx * cos - ly * sin + att.x;
      const ay = lx * sin + ly * cos + att.y;
      out.push(bone.a * ax + bone.b * ay + bone.worldX, bone.c * ax + bone.d * ay + bone.worldY);
    }
    return out;
  }
  const deform = deformFor(p, slotIndex, att);
  const out = [];
  if (!att.weighted) {
    for (let i = 0; i < att.vertices.length; i += 2) {
      const x = att.vertices[i] + (deform ? deform(i) : 0);
      const y = att.vertices[i + 1] + (deform ? deform(i + 1) : 0);
      out.push(bone.a * x + bone.b * y + bone.worldX, bone.c * x + bone.d * y + bone.worldY);
    }
    return out;
  }
  let f = 0;
  for (const infl of att.influences) {
    let wx = 0;
    let wy = 0;
    for (const [bi, bx, by, w] of infl) {
      const b = p.bones[bi];
      const x = bx + (deform ? deform(f) : 0);
      const y = by + (deform ? deform(f + 1) : 0);
      f += 2;
      wx += (b.a * x + b.b * y + b.worldX) * w;
      wy += (b.c * x + b.d * y + b.worldY) * w;
    }
    out.push(wx, wy);
  }
  return out;
}
