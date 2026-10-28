// Spine player: draws a skeleton with three.js (one dynamic mesh per slot, in
// draw order) and offers animation, skin, speed, timeline and bone controls.

import * as THREE from '/three/build/three.module.js';
import { OrbitControls } from '/three/examples/jsm/controls/OrbitControls.js';
import { applyAnimation, createPose, findAttachment, parseAtlas, parseSkeleton, regionUv, updateWorld, worldVertices } from './spine.js';

const BLENDS = {
  normal: [THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor],
  additive: [THREE.SrcAlphaFactor, THREE.OneFactor],
  multiply: [THREE.DstColorFactor, THREE.OneMinusSrcAlphaFactor],
  screen: [THREE.OneFactor, THREE.OneMinusSrcColorFactor],
};

export async function createSpineViewer(host, { skeletonUrl, atlasUrl, pageUrls = {}, initialAnimation, onInfo } = {}) {
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    n.append(...kids.filter(Boolean));
    return n;
  };
  const stage = el('div', { className: 'v3d-stage' });
  const status = el('div', { className: 'v3d-status', textContent: 'Loading Spine skeleton…' });
  stage.append(status);
  const bar = el('div', { className: 'v3d-bar' });
  host.append(stage, bar);

  let disposed = false;
  const fail = msg => {
    status.textContent = msg;
    status.classList.add('error');
    return { dispose() { disposed = true; } };
  };

  let data;
  let atlas = { pages: [], regions: new Map() };
  try {
    data = parseSkeleton(await (await fetch(skeletonUrl)).json());
    if (atlasUrl) atlas = parseAtlas(await (await fetch(atlasUrl)).text());
  } catch (err) {
    return fail(`This skeleton can't be read: ${err.message}`);
  }
  if (disposed) return { dispose() {} };

  // Textures per atlas page.
  const loader = new THREE.TextureLoader();
  const textures = new Map();
  await Promise.all(atlas.pages.map(async page => {
    const url = pageUrls[page.name];
    if (!url) return;
    try {
      const tex = await loader.loadAsync(url);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      textures.set(page, tex);
    } catch { /* page shows untextured */ }
  }));

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  status.remove();
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  camera.position.z = 10;
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableRotate = false;
  controls.screenSpacePanning = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

  // Materials keyed by page + blend mode.
  const materials = new Map();
  const material = (page, blend) => {
    const key = `${page ? page.name : '-'}|${blend}`;
    if (!materials.has(key)) {
      const pma = !!page?.pma;
      const [src, dst] = BLENDS[blend] || BLENDS.normal;
      materials.set(key, new THREE.MeshBasicMaterial({
        map: (page && textures.get(page)) || null, color: 0xffffff, vertexColors: true, transparent: true,
        side: THREE.DoubleSide, depthTest: false, depthWrite: false, premultipliedAlpha: pma,
        blending: THREE.CustomBlending, blendSrc: pma && src === THREE.SrcAlphaFactor ? THREE.OneFactor : src, blendDst: dst,
      }));
    }
    return materials.get(key);
  };

  // One mesh per slot, sized for the largest attachment that slot can show.
  const slotMeshes = data.slots.map((_, si) => {
    let maxV = 4;
    let maxI = 6;
    for (const skin of data.skins.values()) {
      for (const att of skin.get(si)?.values() || []) {
        if (att.type === 'mesh') { maxV = Math.max(maxV, att.uvs.length / 2); maxI = Math.max(maxI, att.triangles.length); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxV * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(maxV * 2), 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxV * 4), 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(maxI), 1).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.Mesh(g, material(null, 'normal'));
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });

  // Bone overlay.
  const boneGeo = new THREE.BufferGeometry();
  boneGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.bones.length * 6), 3));
  const boneLines = new THREE.LineSegments(boneGeo, new THREE.LineBasicMaterial({ color: 0x5ff2ff, depthTest: false, transparent: true, opacity: 1 }));
  boneLines.renderOrder = 1e6;
  boneLines.frustumCulled = false;
  boneLines.visible = false;
  scene.add(boneLines);

  const pose = createPose(data);
  const skins = [...data.skins.keys()];
  let skin = skins.find(s => s !== 'default') || 'default';
  const animNames = [...data.animations.keys()];
  let anim = data.animations.get(initialAnimation) || data.animations.get(animNames[0]) || null;
  let t = 0;
  let speed = 1;
  let playing = true;
  const missing = new Set();

  const draw = () => {
    applyAnimation(pose, anim, t);
    updateWorld(pose);
    pose.drawOrder.forEach((si, order) => {
      const mesh = slotMeshes[si];
      const slot = pose.slots[si];
      const sd = data.slots[si];
      const att = findAttachment(data, skin, si, slot.attachmentName);
      if (!att || att.unsupported || (att.type !== 'region' && att.type !== 'mesh')) { mesh.visible = false; return; }
      const region = atlas.regions.get(att.path);
      if (!region && atlas.regions.size) missing.add(att.path);
      const verts = worldVertices(pose, si, att, region);
      const g = mesh.geometry;
      const pos = g.attributes.position.array;
      const uv = g.attributes.uv.array;
      const col = g.attributes.color.array;
      const n = verts.length / 2;
      const c = slot.color.map((v, i) => v * att.color[i]);
      const pma = !!region?.page.pma;
      for (let i = 0; i < n; i++) {
        pos[i * 3] = verts[i * 2];
        pos[i * 3 + 1] = verts[i * 2 + 1];
        pos[i * 3 + 2] = 0;
        col.set(pma ? [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]] : c, i * 4);
      }
      const idx = g.index.array;
      if (att.type === 'region') {
        const corners = [[0, 1], [0, 0], [1, 0], [1, 1]]; // BL, TL, TR, BR in image space
        corners.forEach(([s, tt], i) => uv.set(region ? regionUv(region, s, tt) : [s, tt], i * 2));
        idx.set([0, 1, 2, 2, 3, 0]);
        g.setDrawRange(0, 6);
      } else {
        for (let i = 0; i < n; i++) uv.set(region ? regionUv(region, att.uvs[i * 2], att.uvs[i * 2 + 1]) : [att.uvs[i * 2], att.uvs[i * 2 + 1]], i * 2);
        idx.set(att.triangles);
        g.setDrawRange(0, att.triangles.length);
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.uv.needsUpdate = true;
      g.attributes.color.needsUpdate = true;
      g.index.needsUpdate = true;
      mesh.userData.n = n;
      mesh.material = material(region?.page || null, sd.blend);
      mesh.renderOrder = order;
      mesh.visible = true;
    });
    if (boneLines.visible) {
      const a = boneGeo.attributes.position.array;
      pose.bones.forEach((b, i) => {
        const len = b.length || 4;
        a.set([b.worldX, b.worldY, 0, b.worldX + b.a * len, b.worldY + b.c * len, 0], i * 6);
      });
      boneGeo.attributes.position.needsUpdate = true;
    }
  };

  // Fit the view to the setup pose plus the current animation's frames.
  const fit = () => {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const keep = t;
    for (let k = 0; k <= 4; k++) {
      t = anim ? (anim.duration * k) / 4 : 0;
      draw();
      for (const m of slotMeshes) {
        if (!m.visible) continue;
        const a = m.geometry.attributes.position.array;
        const n = m.userData.n || 0;
        for (let i = 0; i < n; i++) {
          const x = a[i * 3]; const y = a[i * 3 + 1];
          if (Number.isFinite(x) && Number.isFinite(y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
        }
      }
    }
    t = keep;
    if (!Number.isFinite(minX)) { minX = -100; maxX = 100; minY = -100; maxY = 100; }
    view.cx = (minX + maxX) / 2;
    view.cy = (minY + maxY) / 2;
    view.h = Math.max(maxY - minY, (maxX - minX) / view.aspect) * 1.15 || 200;
    camera.zoom = 1;
    camera.position.set(view.cx, view.cy, 10);
    controls.target.set(view.cx, view.cy, 0);
    resize();
  };
  const view = { cx: 0, cy: 0, h: 400, aspect: 1 };
  const resize = () => {
    const w = stage.clientWidth || 400;
    const h = stage.clientHeight || 320;
    renderer.setSize(w, h, false);
    view.aspect = w / h;
    camera.left = (-view.h * view.aspect) / 2;
    camera.right = (view.h * view.aspect) / 2;
    camera.top = view.h / 2;
    camera.bottom = -view.h / 2;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();
  fit();

  // Controls.
  let slider = null;
  const play = el('button', { className: 'small', textContent: 'Pause' });
  play.onclick = () => { playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; };
  if (animNames.length) {
    const select = el('select', { className: 'small', ariaLabel: 'Animation' },
      ...animNames.map(n => el('option', { value: n, textContent: `${n} (${data.animations.get(n).duration.toFixed(2)} s)` })));
    select.value = anim ? animNames.find(n => data.animations.get(n) === anim) : animNames[0];
    select.onchange = () => { anim = data.animations.get(select.value); t = 0; playing = true; play.textContent = 'Pause'; };
    bar.append(select);
  }
  if (skins.length > 1) {
    const skinSel = el('select', { className: 'small', ariaLabel: 'Skin' }, ...skins.map(s => el('option', { value: s, textContent: `Skin: ${s}` })));
    skinSel.value = skin;
    skinSel.onchange = () => { skin = skinSel.value; };
    bar.append(skinSel);
  }
  if (animNames.length) {
    const speedSel = el('select', { className: 'small', ariaLabel: 'Speed' },
      ...[0.25, 0.5, 1, 1.5, 2].map(s => el('option', { value: String(s), textContent: `${s}×`, selected: s === 1 })));
    speedSel.onchange = () => { speed = Number(speedSel.value); };
    slider = el('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0', className: 'v3d-time', ariaLabel: 'Time' });
    slider.oninput = () => {
      playing = false;
      play.textContent = 'Play';
      t = Number(slider.value) * (anim?.duration || 0);
    };
    bar.append(play, speedSel, slider);
  } else {
    bar.append(el('span', { className: 'muted small', textContent: 'No animations: setup pose' }));
  }
  const bonesBtn = el('button', { className: 'ghost small', textContent: 'Bones' });
  bonesBtn.onclick = () => { boneLines.visible = !boneLines.visible; bonesBtn.classList.toggle('on', boneLines.visible); };
  const reset = el('button', { className: 'ghost small', textContent: 'Reset view' });
  reset.onclick = fit;
  bar.append(bonesBtn, reset);

  if (onInfo) {
    onInfo({
      version: data.version, bones: data.bones.length, slots: data.slots.length, skins, animations: animNames,
      unsupported: data.unsupported, textured: textures.size > 0, missingPages: atlas.pages.filter(p => !textures.has(p)).map(p => p.name),
    });
  }

  const clock = new THREE.Clock();
  const tick = () => {
    if (disposed) return;
    requestAnimationFrame(tick);
    const dt = clock.getDelta();
    if (anim && playing && anim.duration > 0) {
      t = (t + dt * speed) % anim.duration;
      if (slider) slider.value = String(t / anim.duration);
    }
    draw();
    controls.update();
    renderer.render(scene, camera);
  };
  tick();

  return {
    canvas: renderer.domElement,
    duration: () => (anim ? anim.duration * 1000 : 3000),
    restart() { t = 0; playing = true; },
    playAnimation(name) { if (data.animations.has(name)) { anim = data.animations.get(name); t = 0; } },
    missingRegions: () => [...missing],
    dispose() {
      disposed = true;
      ro.disconnect();
      controls.dispose();
      for (const m of slotMeshes) m.geometry.dispose();
      boneGeo.dispose();
      for (const m of materials.values()) m.dispose();
      for (const tex of textures.values()) tex.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
