"""Extracts a Unity game's assets into plain files for APK Explorer.

    python extract_unity.py <out_dir> <input_dir>

Reads every Unity file under input_dir (data.unity3d, *.assets, bundles, ...)
and writes <out_dir>/<category>/... plus <out_dir>/assets.json. Progress goes
to stdout as "PROGRESS <done> <total> <label>" lines. Runs fully offline.
"""

import collections
import json
import math
import os
import re
import sys
import time
import traceback
import types
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# UnityPy imports fmod_toolkit (which bundles proprietary FMOD) at start-up.
# We don't ship it, so give it a stub that refuses audio conversion.
_stub = types.ModuleType('fmod_toolkit')


def _no_fmod(*_a, **_k):
    raise RuntimeError('FMOD is not bundled')


_stub.raw_to_wav = _no_fmod
sys.modules.setdefault('fmod_toolkit', _stub)

import UnityPy  # noqa: E402
from UnityPy.helpers.MeshHelper import MeshHandler  # noqa: E402
from UnityPy.helpers.ResourceReader import get_resource_data  # noqa: E402

import fsb_vorbis  # noqa: E402
import unity_anim  # noqa: E402
from glb import ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, UINT, USHORT, Glb  # noqa: E402

MAX_TEXTURE_SIDE = 8192
MAX_CLIPS_PER_CHARACTER = 60
MAX_HIERARCHY_NODES = 3000
MAX_SCENE_TREE_NODES = 4000
TEX_SLOTS = ('_MainTex', '_BaseMap', '_BaseColorMap', '_Albedo', '_AlbedoMap', '_Diffuse', '_MainTexture', '_Texture')
FSB_CODECS = {1: 'PCM8', 2: 'PCM16', 3: 'PCM24', 4: 'PCM32', 5: 'PCM float', 6: 'GC ADPCM', 7: 'IMA ADPCM',
              8: 'VAG', 9: 'HEVAG', 10: 'XMA', 11: 'MPEG', 12: 'CELT', 13: 'AT9', 14: 'XWMA', 15: 'Vorbis'}

# Types we don't export, with the reason the UI shows.
NOT_EXTRACTED = {
    'MonoBehaviour': 'Script data: needs the game\'s C# type information (IL2CPP builds strip it)',
    'MonoScript': 'Script references only; game code is compiled',
    'ParticleSystem': 'Particle effects: settings only, no visual reconstruction yet',
    'PlayableDirector': 'Timelines: not reconstructed yet',
    'AudioMixerGroupController': 'Audio mixer routing',
}


def emit(kind, *parts):
    print(kind, *parts, flush=True)


_SAFE = re.compile(r'[^A-Za-z0-9._ -]+')


def safe_name(name, fallback):
    n = _SAFE.sub('_', name or '').strip(' ._')[:60]
    return n or fallback


class Extractor:
    def __init__(self, out_dir):
        self.out = out_dir
        self.items = []
        self.by_key = {}
        self.errors = []
        self.used_paths = set()
        self.cache = {}
        self.texture_files = {}  # texture key -> rel path of the exported PNG
        self.clip_users = collections.defaultdict(list)
        self.clip_index = []  # (reader, clip, path hashes, legacy path strings)
        self.container_of = {}  # object key -> original Unity project path, when the build kept it
        self.file_status = {}  # input file (relative) -> {status, reason}
        self.done = 0
        self.total = 1
        self.last_emit = 0.0

    # ---------- helpers ----------

    @staticmethod
    def key(r):
        return f'{r.assets_file.name}:{r.path_id}'

    def rd(self, r):
        if r is None:
            return None
        k = (id(r.assets_file), r.path_id)
        if k not in self.cache:
            self.cache[k] = r.read()
        return self.cache[k]

    @staticmethod
    def deref(ptr):
        if ptr is None or not getattr(ptr, 'm_PathID', 0):
            return None
        try:
            return ptr.deref()
        except Exception:
            return None

    def read_ptr(self, ptr):
        r = self.deref(ptr)
        if r is None:
            return None, None
        try:
            return r, self.rd(r)
        except Exception:
            return r, None

    def components(self, go):
        out = {}
        for cp in go.m_Component:
            r = self.deref(getattr(cp, 'component', None) or cp[-1])
            if r is not None:
                out.setdefault(r.type.name, r)
        return out

    def transform_of(self, go):
        comps = self.components(go)
        return comps.get('Transform') or comps.get('RectTransform')

    def go_name(self, transform):
        _, go = self.read_ptr(transform.m_GameObject)
        return go.m_Name if go is not None else '?'

    def rel_path(self, category, name, ext, pid):
        base = f'{category}/{safe_name(name, category)}'
        rel = f'{base}{ext}'
        if rel in self.used_paths:
            rel = f'{base}_{pid & 0xFFFFFFFF:x}{ext}'
        self.used_paths.add(rel)
        return rel

    def write(self, rel, data):
        full = os.path.join(self.out, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'wb') as f:
            f.write(data)
        return len(data)

    def add(self, r, category, type_, name, file=None, size=0, preview='none', meta=None, note=None,
            status=None, solution=None):
        """status: decoded (converted to a usable file), extracted (written as-is), partial,
        unsupported, encrypted, corrupted or missing."""
        item = {'id': f'a{len(self.items)}', 'category': category, 'type': type_, 'name': name or '(unnamed)',
                'file': file, 'size': size, 'preview': preview, 'meta': meta or {}, 'source': r.assets_file.name if r else None,
                'status': status or ('decoded' if file or preview != 'none' else 'unsupported')}
        if note:
            item['note'] = note
        if solution:
            item['solution'] = solution
        if r is not None and self.key(r) in self.container_of:
            item['originalPath'] = self.container_of[self.key(r)]
        self.items.append(item)
        if r is not None:
            item['key'] = self.key(r)
            self.by_key[item['key']] = item
        return item

    def fail(self, r, category, type_, name, err):
        msg = f'{type(err).__name__}: {err}'[:300]
        self.errors.append({'type': type_, 'name': name, 'error': msg})
        encrypted = 'encrypt' in msg.lower()
        return self.add(r, category, type_, name, note=f'Could not be extracted ({msg})',
                        status='encrypted' if encrypted else 'corrupted',
                        solution='The data is encrypted by the game; it needs the game\'s key, which isn\'t available offline'
                        if encrypted else 'The data could not be parsed: it may be damaged, or use a Unity version or '
                        'modification this extractor doesn\'t understand yet')

    def tick(self, label):
        self.done += 1
        now = time.time()
        if now - self.last_emit > 0.25:
            self.last_emit = now
            emit('PROGRESS', self.done, self.total, label)

    # ---------- textures, sprites, fonts, text ----------

    def texture(self, r):
        t = self.rd(r)
        meta = {'width': t.m_Width, 'height': t.m_Height, 'format': _enum_name('TextureFormat', t.m_TextureFormat)}
        if t.m_Width * t.m_Height == 0 or max(t.m_Width, t.m_Height) > MAX_TEXTURE_SIDE:
            return self.add(r, 'textures', 'Texture2D', t.m_Name, meta=meta, note='Empty or larger than 8192 px; not decoded',
                            status='unsupported', solution='Very large or empty textures are skipped to keep memory use safe')
        img = t.image
        rel = self.rel_path('textures', t.m_Name, '.png', r.path_id)
        from io import BytesIO
        buf = BytesIO()
        img.save(buf, 'PNG')
        size = self.write(rel, buf.getvalue())
        self.texture_files[self.key(r)] = rel
        return self.add(r, 'textures', 'Texture2D', t.m_Name, rel, size, 'image', meta)

    def sprite(self, r):
        s = self.rd(r)
        img = s.image
        rel = self.rel_path('ui', s.m_Name, '.png', r.path_id)
        from io import BytesIO
        buf = BytesIO()
        img.save(buf, 'PNG')
        size = self.write(rel, buf.getvalue())
        return self.add(r, 'ui', 'Sprite', s.m_Name, rel, size, 'image', {'width': img.width, 'height': img.height})

    def sprite_atlas(self, r):
        a = self.rd(r)
        names = list(getattr(a, 'm_PackedSpriteNamesToIndex', []) or [])
        meta = {'sprites': len(names), 'names': names[:200]}
        return self.add(r, 'ui', 'SpriteAtlas', a.m_Name, preview='json', meta=meta)

    def font(self, r):
        f = self.rd(r)
        data = bytes(f.m_FontData or b'')
        if not data:
            return self.add(r, 'ui', 'Font', f.m_Name, note='Font has no embedded file (uses a system or dynamic font)',
                            status='missing', solution='The game uses a font installed on the device, so there is nothing to extract')
        ext = '.otf' if data[:4] == b'OTTO' else '.ttf'
        rel = self.rel_path('ui', f.m_Name, ext, r.path_id)
        return self.add(r, 'ui', 'Font', f.m_Name, rel, self.write(rel, data), 'font')

    def text_asset(self, r):
        t = self.rd(r)
        data = t.m_Script
        data = data.encode('utf-8', 'surrogateescape') if isinstance(data, str) else bytes(data)
        try:
            data.decode('utf-8')
            ext, preview = '.txt', 'text'
        except UnicodeDecodeError:
            ext, preview = '.bytes', 'none'
        rel = self.rel_path('text', t.m_Name, ext, r.path_id)
        note = None if preview == 'text' else 'Binary data: no preview'
        return self.add(r, 'text', 'TextAsset', t.m_Name, rel, self.write(rel, data), preview, note=note, status='extracted')

    def shader(self, r):
        s = self.rd(r)
        name = getattr(getattr(s, 'm_ParsedForm', None), 'm_Name', None) or getattr(s, 'm_Name', '') or '(shader)'
        return self.add(r, 'shaders', 'Shader', name, note='Compiled shader: source code can\'t be reconstructed',
                        status='unsupported', solution='Only the shader name is recoverable; the GPU code is compiled per platform')

    # ---------- audio, video ----------

    def audio(self, r):
        a = self.rd(r)
        fmt = _enum_name('AudioCompressionFormat', a.m_CompressionFormat)
        meta = {'format': fmt, 'channels': a.m_Channels, 'frequency': a.m_Frequency, 'length': round(a.m_Length, 2)}
        data = bytes(a.m_AudioData) if a.m_AudioData else None
        res = a.m_Resource
        if not data and res.m_Size:
            data = bytes(get_resource_data(res.m_Source, a.object_reader.assets_file, res.m_Offset, res.m_Size))
        if not data:
            return self.add(r, 'audio', 'AudioClip', a.m_Name, meta=meta, note='No audio data found', status='missing',
                            solution='The clip\'s .resource file is not in this APK (it may be downloaded by the game later)')
        if data[:4] != b'FSB5':
            rel = self.rel_path('audio', a.m_Name, '.bin', r.path_id)
            return self.add(r, 'audio', 'AudioClip', a.m_Name, rel, self.write(rel, data), meta=meta, note='Unknown audio container',
                            status='extracted', solution='Raw data exported; try a game-audio converter such as vgmstream')
        codec, payload = _fsb5_payload(data)
        meta['codec'] = FSB_CODECS.get(codec, str(codec))
        if codec == 2 and payload is not None:  # PCM16 -> WAV
            rel = self.rel_path('audio', a.m_Name, '.wav', r.path_id)
            wav = _wav(payload, a.m_Channels or 1, a.m_Frequency or 44100)
            return self.add(r, 'audio', 'AudioClip', a.m_Name, rel, self.write(rel, wav), 'audio', meta)
        if codec == 11 and payload is not None:  # MPEG -> MP3 frames as-is
            rel = self.rel_path('audio', a.m_Name, '.mp3', r.path_id)
            return self.add(r, 'audio', 'AudioClip', a.m_Name, rel, self.write(rel, payload), 'audio', meta)
        reason = 'playback not supported yet'
        if codec == fsb_vorbis.VORBIS:
            try:
                ogg = fsb_vorbis.to_ogg(data)
                rel = self.rel_path('audio', a.m_Name, '.ogg', r.path_id)
                return self.add(r, 'audio', 'AudioClip', a.m_Name, rel, self.write(rel, ogg), 'audio', meta)
            except ValueError as e:
                reason = str(e)
        rel = self.rel_path('audio', a.m_Name, '.fsb', r.path_id)
        note = f'{meta["codec"]} audio in an FMOD sound bank: {reason}; raw .fsb exported'
        return self.add(r, 'audio', 'AudioClip', a.m_Name, rel, self.write(rel, data), meta=meta, note=note,
                        status='extracted', solution='The raw .fsb file is exported; vgmstream can usually play it')

    def video(self, r):
        v = self.rd(r)
        res = v.m_ExternalResources
        ext = os.path.splitext(getattr(v, 'm_OriginalPath', '') or '')[1] or '.mp4'
        if not res.m_Size:
            return self.add(r, 'video', 'VideoClip', v.m_Name, note='No video data found', status='missing',
                            solution='The video file is not in this APK (it may be streamed or downloaded by the game)')
        data = bytes(get_resource_data(res.m_Source, v.object_reader.assets_file, res.m_Offset, res.m_Size))
        rel = self.rel_path('video', v.m_Name, ext, r.path_id)
        preview = 'video' if ext.lower() in ('.mp4', '.webm', '.m4v', '.mov') else 'none'
        meta = {'width': getattr(v, 'Width', None), 'height': getattr(v, 'Height', None)}
        return self.add(r, 'video', 'VideoClip', v.m_Name, rel, self.write(rel, data), preview, meta)

    # ---------- materials ----------

    def material_info(self, mat):
        textures, colors, floats = {}, {}, {}
        props = mat.m_SavedProperties
        for name, env in props.m_TexEnvs:
            tr = self.deref(env.m_Texture)
            if tr is not None:
                textures[str(name)] = tr
        for name, c in getattr(props, 'm_Colors', []):
            colors[str(name)] = [round(c.r, 4), round(c.g, 4), round(c.b, 4), round(c.a, 4)]
        for name, v in getattr(props, 'm_Floats', []):
            floats[str(name)] = round(float(v), 4)
        main = next((textures[s] for s in TEX_SLOTS if s in textures), None) or next(iter(textures.values()), None)
        color = colors.get('_BaseColor') or colors.get('_Color')
        return textures, colors, floats, main, color

    def material(self, r):
        m = self.rd(r)
        textures, colors, floats, main, _ = self.material_info(m)
        _, shader = self.read_ptr(m.m_Shader)
        shader_name = getattr(getattr(shader, 'm_ParsedForm', None), 'm_Name', None) if shader is not None else None
        meta = {
            'shader': shader_name or '(unknown shader)',
            'textures': {slot: self.key(tr) for slot, tr in textures.items()},
            'mainTexture': self.key(main) if main is not None else None,
            'colors': colors,
            'floats': dict(list(floats.items())[:60]),
        }
        return self.add(r, 'materials', 'Material', m.m_Name, preview='material', meta=meta)

    # ---------- meshes and characters (GLB) ----------

    def geometry(self, mesh):
        h = MeshHandler(mesh)
        h.process()
        vc = h.m_VertexCount
        if not h.m_Vertices or not vc:
            raise ValueError('mesh has no vertex positions')
        pos = []
        for v in h.m_Vertices[:vc]:
            pos += (-v[0], v[1], v[2])
        nrm = None
        if h.m_Normals and len(h.m_Normals) >= vc:
            nrm = []
            for n in h.m_Normals[:vc]:
                ln = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) or 1.0
                nrm += (-n[0] / ln, n[1] / ln, n[2] / ln)
        uv = None
        if h.m_UV0 and len(h.m_UV0) >= vc:
            uv = []
            for t in h.m_UV0[:vc]:
                uv += (t[0], 1.0 - t[1])
        joints = weights = None
        if h.m_BoneWeights and h.m_BoneIndices and len(h.m_BoneWeights) >= vc:
            joints, weights = [], []
            for bi, bw in zip(h.m_BoneIndices[:vc], h.m_BoneWeights[:vc]):
                w = (list(bw) + [0, 0, 0, 0])[:4]
                s = sum(w) or 1.0
                weights += [x / s for x in w]
                joints += [int(x) for x in (list(bi) + [0, 0, 0, 0])[:4]]
        idx_size = 2 if h.m_Use16BitIndices else 4
        ib = h.m_IndexBuffer
        subs, tris = [], 0
        for sm in mesh.m_SubMeshes:
            if sm.topology not in (0, None):
                subs.append([])
                continue
            start = sm.firstByte // idx_size
            src = ib[start:start + sm.indexCount]
            base = sm.baseVertex or 0
            out = []
            for i in range(0, len(src) - 2, 3):
                a, b, c = src[i] + base, src[i + 1] + base, src[i + 2] + base
                if a < vc and b < vc and c < vc:
                    out += (a, c, b)  # mirrored X flips winding
            tris += len(out) // 3
            subs.append(out)
        return {'pos': pos, 'nrm': nrm, 'uv': uv, 'joints': joints, 'weights': weights, 'subs': subs, 'vc': vc, 'tris': tris}

    def glb_material(self, g, mat_ptr):
        mr, mat = self.read_ptr(mat_ptr)
        if mat is None:
            return None
        _, _, _, main, color = self.material_info(mat)
        tex = None
        if main is not None:
            rel = self.texture_files.get(self.key(main))
            if rel:
                with open(os.path.join(self.out, rel), 'rb') as f:
                    tex = g.image(f.read(), rel)
        return g.material(mat.m_Name, tex, color)

    def primitives(self, g, geo, materials, skinned):
        vc = geo['vc']
        attrs = {'POSITION': g.accessor(geo['pos'], FLOAT, 'VEC3', vc, ARRAY_BUFFER, minmax=True)}
        if geo['nrm']:
            attrs['NORMAL'] = g.accessor(geo['nrm'], FLOAT, 'VEC3', vc, ARRAY_BUFFER)
        if geo['uv']:
            attrs['TEXCOORD_0'] = g.accessor(geo['uv'], FLOAT, 'VEC2', vc, ARRAY_BUFFER)
        if skinned:
            attrs['JOINTS_0'] = g.accessor(geo['joints'], USHORT, 'VEC4', vc, ARRAY_BUFFER)
            attrs['WEIGHTS_0'] = g.accessor(geo['weights'], FLOAT, 'VEC4', vc, ARRAY_BUFFER)
        prims = []
        for i, tri in enumerate(geo['subs']):
            if not tri:
                continue
            p = {'attributes': attrs, 'indices': g.accessor(tri, UINT, 'SCALAR', len(tri), ELEMENT_ARRAY_BUFFER), 'mode': 4}
            if materials:
                m = materials[min(i, len(materials) - 1)]
                if m is not None:
                    p['material'] = m
            prims.append(p)
        if not prims:
            raise ValueError('mesh has no triangles')
        return prims

    def static_model(self, r, renderer):
        mesh = self.rd(r)
        geo = self.geometry(mesh)
        g = Glb()
        mats = [self.glb_material(g, p) for p in renderer.m_Materials] if renderer is not None else []
        mi = g.mesh(mesh.m_Name, self.primitives(g, geo, mats, False))
        g.doc['scenes'][0]['nodes'].append(g.node(name=mesh.m_Name, mesh=mi))
        rel = self.rel_path('models', mesh.m_Name, '.glb', r.path_id)
        meta = {'vertices': geo['vc'], 'triangles': geo['tris'], 'submeshes': len(mesh.m_SubMeshes),
                'textured': bool(g.doc.get('images')), 'skinned': bool(geo['joints'])}
        note = None if renderer is not None else 'No renderer uses this mesh: shown without materials'
        return self.add(r, 'models', 'Mesh', mesh.m_Name, rel, self.write(rel, g.to_bytes()), 'model', meta, note)

    def clips_for(self, anim_r):
        a = self.rd(anim_r)
        ptrs = []
        if anim_r.type.name == 'Animation':
            ptrs = list(getattr(a, 'm_Animations', []) or [])
        else:
            cr, c = self.read_ptr(a.m_Controller)
            if c is not None and cr.type.name == 'AnimatorOverrideController':
                for pair in c.m_Clips:
                    ptrs.append(pair.m_OverrideClip if pair.m_OverrideClip.m_PathID else pair.m_OriginalClip)
                _, base = self.read_ptr(c.m_Controller)
                if base is not None:
                    ptrs += list(base.m_AnimationClips)
            elif c is not None:
                ptrs = list(c.m_AnimationClips)
        out, seen = [], set()
        for p in ptrs:
            r, clip = self.read_ptr(p)
            if clip is not None and self.key(r) not in seen:
                seen.add(self.key(r))
                out.append((r, clip))
        return out

    def character(self, smr_r, smr, mesh_r):
        mesh = self.rd(mesh_r)
        _, go = self.read_ptr(smr.m_GameObject)
        tr_r = self.transform_of(go)
        # Root = nearest ancestor with an Animator / Animation, else the top of the hierarchy.
        chain, cur = [], tr_r
        while cur is not None and len(chain) < 200:
            chain.append(cur)
            cur = self.deref(self.rd(cur).m_Father)
        root_r, anim_r = chain[-1], None
        for r in chain:
            _, g_ = self.read_ptr(self.rd(r).m_GameObject)
            comps = self.components(g_) if g_ is not None else {}
            if 'Animator' in comps or 'Animation' in comps:
                root_r, anim_r = r, comps.get('Animator') or comps.get('Animation')
                break

        g = Glb()
        node_of, path_hash, path_str = {}, {}, {}

        def visit(r, parent_path, is_root):
            if len(node_of) >= MAX_HIERARCHY_NODES:
                raise ValueError('hierarchy too large')
            t = self.rd(r)
            name = self.go_name(t)
            path = '' if is_root else (name if not parent_path else f'{parent_path}/{name}')
            p, q, s = t.m_LocalPosition, t.m_LocalRotation, t.m_LocalScale
            idx = g.node(name=name, translation=None if is_root else [-p.x, p.y, p.z],
                         rotation=[q.x, -q.y, -q.z, q.w], scale=[s.x, s.y, s.z])
            node_of[self.key(r)] = idx
            path_hash[zlib.crc32(path.encode('utf-8'))] = idx
            path_str[path] = idx
            kids = [visit(c, path, False) for c in (self.deref(x) for x in t.m_Children) if c is not None]
            if kids:
                g.doc['nodes'][idx]['children'] = kids
            return idx

        root_idx = visit(root_r, '', True)
        g.doc['scenes'][0]['nodes'].append(root_idx)
        root_name = g.doc['nodes'][root_idx]['name']

        geo = self.geometry(mesh)
        bones = [node_of.get(self.key(b)) if b is not None else None for b in (self.deref(x) for x in smr.m_Bones)]
        skinned = bool(geo['joints']) and bool(bones) and all(b is not None for b in bones) and len(mesh.m_BindPose) >= len(bones)
        if skinned:
            nb = len(bones)
            geo['joints'] = [j if j < nb else 0 for j in geo['joints']]
        mats = [self.glb_material(g, p) for p in smr.m_Materials]
        mi = g.mesh(mesh.m_Name, self.primitives(g, geo, mats, skinned))
        # A skinned mesh goes on its own untransformed root node: glTF ignores
        # its node transform, but three.js and other viewers apply it anyway.
        mesh_node = None if skinned else node_of.get(self.key(tr_r))
        if mesh_node is None:
            mesh_node = g.node(name=mesh.m_Name)
            g.doc['scenes'][0]['nodes'].append(mesh_node)
        g.doc['nodes'][mesh_node]['mesh'] = mi
        if skinned:
            ibm = []
            for m in mesh.m_BindPose[:len(bones)]:
                ibm += _mirror_matrix(m)
            acc = g.accessor(ibm, FLOAT, 'MAT4', len(bones))
            g.doc.setdefault('skins', []).append({'joints': bones, 'inverseBindMatrices': acc, 'skeleton': root_idx})
            g.doc['nodes'][mesh_node]['skin'] = len(g.doc['skins']) - 1

        # Clips: the controller's first, then any clip whose bones all exist in
        # this skeleton (many games assign controllers from code at runtime).
        clips = self.clips_for(anim_r) if anim_r is not None else []
        from_controller = len(clips)
        have = {self.key(r) for r, _ in clips}
        hashes, strings = set(path_hash), set(path_str)
        matched = []
        for r, clip, ph, ps in self.clip_index:
            if self.key(r) in have:
                continue
            paths, mine = (ps, strings) if ps else (ph, hashes)
            hit = len(paths & mine)
            if hit >= 2 and hit >= 0.9 * len(paths):
                matched.append((hit, r, clip))
        matched.sort(key=lambda m: -m[0])
        clips += [(r, clip) for _, r, clip in matched]

        clip_names, skipped = [], []
        if clips:
            for clip_r, clip in clips[:MAX_CLIPS_PER_CHARACTER]:
                try:
                    if clip.m_Legacy:
                        times, tracks = unity_anim.sample_legacy_tracks(clip, path_str)
                    else:
                        times, tracks = unity_anim.sample_transform_tracks(clip, path_hash)
                except Exception as e:  # one broken clip shouldn't drop the character
                    times, tracks = None, f'{type(e).__name__}: {e}'
                if times is None:
                    skipped.append(f'{clip.m_Name}: {tracks}')
                    continue
                t_acc = g.accessor(times, FLOAT, 'SCALAR', len(times), minmax=True)
                samplers, channels = [], []
                for node, path, vals in tracks:
                    v_acc = g.accessor(vals, FLOAT, 'VEC4' if path == 'rotation' else 'VEC3', len(times))
                    samplers.append({'input': t_acc, 'output': v_acc, 'interpolation': 'LINEAR'})
                    channels.append({'sampler': len(samplers) - 1, 'target': {'node': node, 'path': path}})
                g.doc.setdefault('animations', []).append({'name': clip.m_Name, 'samplers': samplers, 'channels': channels})
                clip_names.append(clip.m_Name)
                self.clip_users[self.key(clip_r)].append(root_name)

        name = root_name if root_name and root_name != '?' else mesh.m_Name
        rel = self.rel_path('characters', name, '.glb', mesh_r.path_id)
        meta = {'mesh': mesh.m_Name, 'vertices': geo['vc'], 'triangles': geo['tris'], 'bones': len(bones),
                'skinned': skinned, 'animations': clip_names, 'textured': bool(g.doc.get('images')),
                'clipsFromController': min(from_controller, len(clip_names)),
                'clipsMatchedBySkeleton': max(0, len(clip_names) - from_controller)}
        notes = []
        if not skinned and geo['joints']:
            notes.append('Bones could not be matched: shown in bind pose without skinning')
        if not clips:
            notes.append('No animation clip fits this skeleton')
        elif from_controller == 0:
            notes.append('Animations matched by skeleton (the game assigns them at runtime)')
        if skipped:
            meta['skippedAnimations'] = skipped[:40]
            notes.append(f'{len(skipped)} animation(s) could not be reconstructed')
        item = self.add(mesh_r, 'characters', 'SkinnedMesh', name, rel, self.write(rel, g.to_bytes()), 'model', meta,
                        '; '.join(notes) or None, status='partial' if (geo['joints'] and not skinned) else 'decoded')
        return item

    # ---------- animations ----------

    def clip(self, r):
        c = self.rd(r)
        meta = unity_anim.summary(c)
        users = self.clip_users.get(self.key(r), [])
        meta['usedBy'] = sorted(set(users))[:20]
        note = None
        if not users:
            if meta['bindings']['humanoid']:
                note = 'Humanoid (muscle) animation: playback needs avatar retargeting, not supported yet'
            elif meta['bindings']['transform'] == 0:
                note = 'Animates UI or component properties, not a 3D skeleton: details only'
            else:
                note = 'Not attached to an exported character: details only'
        humanoid = bool(meta['bindings']['humanoid']) and not users
        return self.add(r, 'animations', 'AnimationClip', c.m_Name, preview='json', meta=meta, note=note,
                        status='partial' if humanoid else 'decoded',
                        solution='Humanoid clips need retargeting onto an avatar, which isn\'t supported yet' if humanoid else None)

    def controller(self, r):
        c = self.rd(r)
        clips = []
        for p in getattr(c, 'm_AnimationClips', []) or []:
            _, clip = self.read_ptr(p)
            if clip is not None:
                clips.append(clip.m_Name)
        return self.add(r, 'animations', r.type.name, c.m_Name, preview='json',
                        meta={'clips': sorted(set(clips))}, note='State machine: clip list shown')

    # ---------- scenes ----------

    def scene(self, name, sf):
        objs = sf.objects
        counts = collections.Counter(o.type.name for o in objs.values())
        roots = []
        for o in objs.values():
            if o.type.name in ('Transform', 'RectTransform'):
                try:
                    if not self.rd(o).m_Father.m_PathID:
                        roots.append(o)
                except Exception:
                    pass
        budget = [MAX_SCENE_TREE_NODES]

        def tree(r, depth):
            budget[0] -= 1
            t = self.rd(r)
            _, go = self.read_ptr(t.m_GameObject)
            node = {'name': go.m_Name if go is not None else '?'}
            if go is not None:
                node['components'] = sorted(k for k in self.components(go) if k not in ('Transform', 'RectTransform'))
            kids = [self.deref(c) for c in t.m_Children]
            kids = [k for k in kids if k is not None]
            if kids and depth < 8 and budget[0] > 0:
                node['children'] = [tree(k, depth + 1) for k in kids if budget[0] > 0]
            elif kids:
                node['more'] = len(kids)
            return node

        nodes = [tree(r, 0) for r in roots if budget[0] > 0]
        meta = {'gameObjects': counts.get('GameObject', 0), 'roots': len(roots),
                'components': dict(counts.most_common(25)), 'tree': nodes}
        note = 'Hierarchy shown; full 3D scene reconstruction is not supported yet'
        if budget[0] <= 0:
            note += f' (tree cut at {MAX_SCENE_TREE_NODES} objects)'
        return self.add(None, 'scenes', 'Scene', name, preview='tree', meta=meta, note=note, status='partial',
                        solution='The object hierarchy is extracted; rebuilding the full 3D level is not supported yet')

    # ---------- run ----------

    def load(self, input_dir):
        """Loads files one by one so a single damaged or encrypted file can't stop the rest."""
        env = UnityPy.Environment()
        paths = sorted(os.path.join(root, n) for root, _, names in os.walk(input_dir) for n in names)
        for i, path in enumerate(paths):
            rel = os.path.relpath(path, input_dir).replace(os.sep, '/')
            try:
                f = env.load_file(open(path, 'rb'), env, path)  # registers itself in env.files
                kind = type(f).__name__
                if kind in ('BundleFile', 'SerializedFile', 'WebFile'):
                    self.file_status[rel] = {'status': 'decoded', 'reason': f'Unity {kind[:-4].lower()} file'}
                elif re.search(r'\.(resS|resource|split\d+)$', path, re.I):
                    self.file_status[rel] = {'status': 'decoded', 'reason': 'Unity resource data (used by the assets that point to it)'}
                else:
                    self.file_status[rel] = {'status': 'extracted', 'reason': 'Not recognised as a Unity file; kept as-is'}
            except Exception as e:
                msg = f'{type(e).__name__}: {e}'[:200]
                encrypted = 'encrypt' in msg.lower() or 'unitycn' in msg.lower()
                self.file_status[rel] = {'status': 'encrypted' if encrypted else 'corrupted', 'reason': msg}
                self.errors.append({'type': 'file', 'name': rel, 'error': msg})
            if i % 10 == 0:
                emit('PROGRESS', 0, 1, f'Loading Unity files ({i + 1} of {len(paths)})')
        return env

    def run(self, input_dir):
        t0 = time.time()
        emit('PROGRESS', 0, 1, 'Loading Unity files')
        env = self.load(input_dir)
        files = list(_serialized_files(env))
        unity_version = next((getattr(sf, 'unity_version', None) for _, sf in files if getattr(sf, 'unity_version', None)), None)
        by = collections.defaultdict(list)
        for o in env.objects:
            by[o.type.name].append(o)
            try:
                if o.container:
                    self.container_of[self.key(o)] = o.container
            except Exception:
                pass

        jobs = [(t, o) for t in ('Texture2D', 'Sprite', 'SpriteAtlas', 'Font', 'TextAsset', 'Shader', 'Material',
                                 'AudioClip', 'VideoClip') for o in by.get(t, [])]
        self.total = len(jobs) + len(by.get('SkinnedMeshRenderer', [])) + len(by.get('Mesh', [])) \
            + len(by.get('AnimationClip', [])) + len(by.get('AnimatorController', [])) \
            + len(by.get('AnimatorOverrideController', [])) + 1
        handlers = {'Texture2D': ('textures', self.texture), 'Sprite': ('ui', self.sprite),
                    'SpriteAtlas': ('ui', self.sprite_atlas), 'Font': ('ui', self.font),
                    'TextAsset': ('text', self.text_asset), 'Shader': ('shaders', self.shader),
                    'Material': ('materials', self.material), 'AudioClip': ('audio', self.audio),
                    'VideoClip': ('video', self.video)}
        for type_, r in jobs:
            category, fn = handlers[type_]
            try:
                fn(r)
            except Exception as e:
                self.fail(r, category, type_, _peek_name(r), e)
            self.tick(f'Exporting {type_}')

        # Index every clip's animated paths so characters can find their clips.
        emit('PROGRESS', self.done, self.total, 'Indexing animations')
        for r in by.get('AnimationClip', []):
            try:
                clip = self.rd(r)
                if clip.m_Legacy:
                    self.clip_index.append((r, clip, set(), unity_anim.legacy_paths(clip)))
                else:
                    ph = unity_anim.transform_paths(clip)
                    if ph:
                        self.clip_index.append((r, clip, ph, set()))
            except Exception:
                pass

        # Characters: one per unique skinned mesh.
        char_meshes = set()
        for r in by.get('SkinnedMeshRenderer', []):
            self.tick('Building characters')
            try:
                smr = self.rd(r)
                mesh_r = self.deref(smr.m_Mesh)
                if mesh_r is None or self.key(mesh_r) in char_meshes:
                    continue
                char_meshes.add(self.key(mesh_r))
                self.character(r, smr, mesh_r)
            except Exception as e:
                self.fail(None, 'characters', 'SkinnedMesh', _peek_name(r), e)

        # Static models: first renderer that uses each mesh gives its materials.
        emit('PROGRESS', self.done, self.total, 'Matching meshes to materials')
        renderer_of = {}
        for r in by.get('MeshFilter', []):
            try:
                mf = self.rd(r)
                mk = self.deref(mf.m_Mesh)
                if mk is None or self.key(mk) in renderer_of:
                    continue
                _, go = self.read_ptr(mf.m_GameObject)
                mr = self.components(go).get('MeshRenderer') if go is not None else None
                if mr is not None:
                    renderer_of[self.key(mk)] = self.rd(mr)
            except Exception:
                pass
        for r in by.get('Mesh', []):
            self.tick('Building 3D models')
            if self.key(r) in char_meshes:
                continue
            try:
                self.static_model(r, renderer_of.get(self.key(r)))
            except Exception as e:
                self.fail(r, 'models', 'Mesh', _peek_name(r), e)

        for r in by.get('AnimationClip', []):
            self.tick('Reading animations')
            try:
                self.clip(r)
            except Exception as e:
                self.fail(r, 'animations', 'AnimationClip', _peek_name(r), e)
        for t in ('AnimatorController', 'AnimatorOverrideController'):
            for r in by.get(t, []):
                self.tick('Reading animators')
                try:
                    self.controller(r)
                except Exception as e:
                    self.fail(r, 'animations', t, _peek_name(r), e)

        emit('PROGRESS', self.done, self.total, 'Reading scenes')
        scene_names = []
        for r in by.get('BuildSettings', []):
            try:
                scene_names = list(self.rd(r).scenes)
            except Exception:
                pass
        for fname, sf in files:
            m = re.fullmatch(r'level(\d+)', fname)
            if m or (fname.startswith('BuildPlayer-') and not fname.endswith('.sharedAssets')):
                if m and int(m.group(1)) < len(scene_names):
                    label = scene_names[int(m.group(1))]
                else:
                    label = fname
                try:
                    self.scene(label, sf)
                except Exception as e:
                    self.fail(None, 'scenes', 'Scene', label, e)

        type_counts = {t: len(v) for t, v in by.items()}
        not_extracted = [{'type': t, 'count': type_counts[t], 'reason': why}
                         for t, why in NOT_EXTRACTED.items() if type_counts.get(t)]
        manifest = {
            'engine': 'Unity', 'unityVersion': unity_version,
            'seconds': round(time.time() - t0, 1),
            'objectCount': sum(type_counts.values()),
            'typeCounts': dict(sorted(type_counts.items(), key=lambda kv: -kv[1])),
            'scenes': scene_names,
            'items': self.items, 'errors': self.errors[:500], 'notExtracted': not_extracted, 'files': self.file_status,
        }
        with open(os.path.join(self.out, 'assets.json'), 'w', encoding='utf-8') as f:
            json.dump(_finite(manifest), f, ensure_ascii=False, allow_nan=False)
        emit('PROGRESS', self.total, self.total, 'Done')
        emit('DONE', len(self.items), len(self.errors))


# ---------- module helpers ----------

def _finite(v):
    """JSON has no Infinity/NaN: replace them with None."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_finite(x) for x in v]
    return v


def _enum_name(enum, value):
    try:
        import UnityPy.enums as E
        return getattr(E, enum)(value).name
    except Exception:
        return str(value)


def _peek_name(r):
    try:
        return r.peek_name() or f'#{r.path_id}'
    except Exception:
        return f'#{r.path_id}'


def _serialized_files(env):
    """Yields (name, SerializedFile) for every serialized file, inside bundles too."""
    def walk(container, name=None):
        if hasattr(container, 'objects') and isinstance(getattr(container, 'objects'), dict):
            yield name or getattr(container, 'name', '?'), container
        for child_name, child in (getattr(container, 'files', None) or {}).items():
            yield from walk(child, child_name)
    for name, f in env.files.items():
        yield from walk(f, os.path.basename(name))


def _mirror_matrix(m):
    """Unity Matrix4x4f (eRC) -> glTF column-major, mirrored on X (S*M*S)."""
    s = (-1.0, 1.0, 1.0, 1.0)
    rows = [[getattr(m, f'e{r}{c}') * s[r] * s[c] for c in range(4)] for r in range(4)]
    return [rows[r][c] for c in range(4) for r in range(4)]


def _fsb5_payload(data):
    """Returns (codec, first sample's data) of an FSB5 bank, payload None if unsure."""
    import struct
    try:
        version, num, shdr, names, size, codec = struct.unpack_from('<IIIIII', data, 4)
        header = 60 if version == 1 else 64
        start = header + shdr + names
        if num != 1:
            return codec, None
        return codec, data[start:start + size]
    except Exception:
        return None, None


def _wav(pcm, channels, rate):
    import struct
    return (b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVEfmt ' +
            struct.pack('<IHHIIHH', 16, 1, channels, rate, rate * channels * 2, channels * 2, 16) +
            b'data' + struct.pack('<I', len(pcm)) + pcm)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    out_dir, input_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    try:
        Extractor(out_dir).run(input_dir)
    except Exception:
        emit('FATAL', traceback.format_exc().replace('\n', ' | ')[-2000:])
        sys.exit(1)


if __name__ == '__main__':
    main()
