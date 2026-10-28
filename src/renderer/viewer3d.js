// Interactive 3D preview: orbit, zoom, pan, wireframe, and animation playback.

import * as THREE from '/three/build/three.module.js';
import { OrbitControls } from '/three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from '/three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from '/three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from '/three/examples/jsm/loaders/FBXLoader.js';
import { STLLoader } from '/three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from '/three/examples/jsm/loaders/PLYLoader.js';
import { ColladaLoader } from '/three/examples/jsm/loaders/ColladaLoader.js';

const plain = () => new THREE.MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.7, side: THREE.DoubleSide });

async function load(url, ext) {
  switch (ext) {
    case 'glb':
    case 'gltf': {
      const g = await new GLTFLoader().loadAsync(url);
      return { object: g.scene, clips: g.animations };
    }
    case 'fbx': {
      const o = await new FBXLoader().loadAsync(url);
      return { object: o, clips: o.animations || [] };
    }
    case 'dae': {
      const c = await new ColladaLoader().loadAsync(url);
      return { object: c.scene, clips: c.scene.animations || [] };
    }
    case 'obj':
      return { object: await new OBJLoader().loadAsync(url), clips: [] };
    case 'stl':
      return { object: new THREE.Mesh(await new STLLoader().loadAsync(url), plain()), clips: [] };
    case 'ply': {
      const geo = await new PLYLoader().loadAsync(url);
      geo.computeVertexNormals();
      return { object: new THREE.Mesh(geo, plain()), clips: [] };
    }
    default:
      throw new Error(`No 3D loader for .${ext}`);
  }
}

// Builds a viewer inside `host`. Returns { dispose, playClip(name) }.
export async function createViewer(host, url, { ext, initialClip, onInfo } = {}) {
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    n.append(...kids.filter(Boolean));
    return n;
  };
  const stage = el('div', { className: 'v3d-stage' });
  const status = el('div', { className: 'v3d-status', textContent: 'Loading 3D model…' });
  stage.append(status);
  const bar = el('div', { className: 'v3d-bar' });
  host.append(stage, bar);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  let disposed = false;
  let mixer = null;
  let action = null;
  let playing = true;
  const clock = new THREE.Clock();

  const resize = () => {
    const w = stage.clientWidth || 400;
    const h = stage.clientHeight || 320;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  let slider;
  const tick = () => {
    if (disposed) return;
    requestAnimationFrame(tick);
    const dt = clock.getDelta();
    if (mixer && playing) mixer.update(dt);
    if (action && slider && playing) slider.value = String(action.time / (action.getClip().duration || 1));
    controls.update();
    renderer.render(scene, camera);
  };

  let object;
  let clips;
  try {
    ({ object, clips } = await load(url, ext));
  } catch (err) {
    status.textContent = `This model can't be shown: ${err.message}`;
    status.classList.add('error');
    return { dispose: () => { disposed = true; ro.disconnect(); renderer.dispose(); } };
  }
  if (disposed) return { dispose() {} };
  status.remove();
  scene.add(object);

  // Frame the model.
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const center = box.getCenter(new THREE.Vector3());
  const home = () => {
    camera.near = size / 200;
    camera.far = size * 50;
    camera.position.copy(center).add(new THREE.Vector3(size * 0.6, size * 0.4, size * 0.9));
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  };
  home();
  const grid = new THREE.GridHelper(size * 2, 20, 0x5a6378, 0x2c3240);
  grid.position.y = box.min.y;
  scene.add(grid);

  let meshes = 0;
  let tris = 0;
  object.traverse(o => {
    if (o.isMesh) {
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  if (onInfo) onInfo({ meshes, triangles: Math.round(tris), clips: clips.map(c => c.name) });

  // Controls bar: clip, play, speed, time, wireframe, reset.
  const wire = el('button', { className: 'ghost small', textContent: 'Wireframe' });
  wire.onclick = () => {
    let on;
    object.traverse(o => {
      if (o.isMesh) for (const m of [].concat(o.material)) { m.wireframe = !m.wireframe; on = m.wireframe; }
    });
    wire.classList.toggle('on', !!on);
  };
  const reset = el('button', { className: 'ghost small', textContent: 'Reset view' });
  reset.onclick = home;

  if (clips.length) {
    mixer = new THREE.AnimationMixer(object);
    const select = el('select', { className: 'small', ariaLabel: 'Animation' },
      ...clips.map((c, i) => el('option', { value: String(i), textContent: `${c.name || `Clip ${i + 1}`} (${c.duration.toFixed(2)} s)` })));
    const play = el('button', { className: 'small', textContent: 'Pause' });
    const speed = el('select', { className: 'small', ariaLabel: 'Speed' },
      ...[0.25, 0.5, 1, 1.5, 2].map(s => el('option', { value: String(s), textContent: `${s}×`, selected: s === 1 })));
    slider = el('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0', className: 'v3d-time', ariaLabel: 'Time' });

    const start = i => {
      if (action) action.stop();
      action = mixer.clipAction(clips[i]);
      action.reset().play();
      playing = true;
      play.textContent = 'Pause';
    };
    select.onchange = () => start(Number(select.value));
    play.onclick = () => {
      playing = !playing;
      play.textContent = playing ? 'Pause' : 'Play';
    };
    speed.onchange = () => { mixer.timeScale = Number(speed.value); };
    slider.oninput = () => {
      if (!action) return;
      playing = false;
      play.textContent = 'Play';
      action.time = Number(slider.value) * action.getClip().duration;
      mixer.update(0);
    };
    const first = Math.max(0, clips.findIndex(c => c.name === initialClip));
    select.value = String(first);
    start(first);
    bar.append(select, play, speed, slider);
  } else {
    bar.append(el('span', { className: 'muted small', textContent: 'No animations in this model' }));
  }
  bar.append(wire, reset);
  tick();

  return {
    canvas: renderer.domElement,
    duration: () => (action ? action.getClip().duration * 1000 : 4000),
    restart() { if (action) { action.reset().play(); playing = true; } },
    playClip(name) {
      const i = clips.findIndex(c => c.name === name);
      const sel = bar.querySelector('select');
      if (i >= 0 && sel) { sel.value = String(i); sel.onchange(); }
    },
    dispose() {
      disposed = true;
      ro.disconnect();
      controls.dispose();
      object.traverse(o => {
        if (o.isMesh) {
          o.geometry.dispose();
          for (const m of [].concat(o.material)) { m.map?.dispose(); m.dispose(); }
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
