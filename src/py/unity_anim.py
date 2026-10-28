"""Decodes compiled Unity AnimationClips (Mecanim generic curves) into
per-transform position / rotation / scale samples.

A compiled clip stores its float curves in three blocks, in this order:
streamed (cubic segments per key), dense (fixed-rate samples) and constant.
genericBindings say which transform path (CRC32 of "A/B/C") and property each
run of curves drives.
"""

import bisect
import math
import struct
from array import array

TRANSFORM = 4
ANIMATOR = 95  # humanoid muscle curves bind to the Animator
ATTR_POS, ATTR_ROT, ATTR_SCALE, ATTR_EULER = 1, 2, 3, 4
TRANSFORM_DIMS = {ATTR_POS: 3, ATTR_ROT: 4, ATTR_SCALE: 3, ATTR_EULER: 3}


def _inner(clip):
    c = clip.m_MuscleClip.m_Clip
    return getattr(c, 'data', c)


class Curves:
    """Evaluates curve i at time t, whatever block it lives in."""

    def __init__(self, clip):
        inner = _inner(clip)
        streamed = inner.m_StreamedClip
        self.s_count = streamed.curveCount
        self.keys = [[] for _ in range(self.s_count)]
        raw = array('I', streamed.data).tobytes()
        off = 0
        while off + 8 <= len(raw):
            t, n = struct.unpack_from('<fi', raw, off)
            off += 8
            for _ in range(n):
                if off + 20 > len(raw):
                    break
                idx, a, b, c, d = struct.unpack_from('<iffff', raw, off)
                off += 20
                if 0 <= idx < self.s_count:
                    self.keys[idx].append((t if math.isfinite(t) else (-1e30 if t < 0 else 1e30), a, b, c, d))
        self.key_times = [[k[0] for k in ks] for ks in self.keys]

        dense = inner.m_DenseClip
        self.d_count = dense.m_CurveCount
        self.d_frames = dense.m_FrameCount
        self.d_rate = dense.m_SampleRate or 30.0
        self.d_begin = dense.m_BeginTime
        self.d_samples = dense.m_SampleArray
        self.constants = inner.m_ConstantClip.data
        self.total = self.s_count + self.d_count + len(self.constants)

    def value(self, i, t):
        if i < self.s_count:
            ks = self.keys[i]
            if not ks:
                return 0.0
            j = max(0, bisect.bisect_right(self.key_times[i], t) - 1)
            kt, a, b, c, d = ks[j]
            dt = max(0.0, t - kt) if kt > -1e29 else 0.0
            return ((a * dt + b) * dt + c) * dt + d
        i -= self.s_count
        if i < self.d_count:
            if not self.d_frames:
                return 0.0
            pos = max(0.0, (t - self.d_begin) * self.d_rate)
            f0 = min(int(pos), self.d_frames - 1)
            f1 = min(f0 + 1, self.d_frames - 1)
            w = pos - f0 if f1 != f0 else 0.0
            v0 = self.d_samples[f0 * self.d_count + i]
            v1 = self.d_samples[f1 * self.d_count + i]
            return v0 + (v1 - v0) * w
        i -= self.d_count
        return self.constants[i] if i < len(self.constants) else 0.0


def bindings(clip):
    """Yields (binding, first_curve_index, dimension) for every float binding."""
    idx = 0
    for b in clip.m_ClipBindingConstant.genericBindings:
        if b.isPPtrCurve:
            continue
        dim = TRANSFORM_DIMS.get(b.attribute, 1) if b.typeID == TRANSFORM else 1
        yield b, idx, dim
        idx += dim


def transform_paths(clip):
    """Path hashes of the transforms a compiled clip animates (empty for legacy clips)."""
    return {b.path for b, _, _ in bindings(clip) if b.typeID == TRANSFORM and b.attribute in TRANSFORM_DIMS}


def legacy_paths(clip):
    """Path strings a legacy clip animates."""
    out = set()
    for key in ('m_PositionCurves', 'm_RotationCurves', 'm_ScaleCurves', 'm_EulerCurves'):
        for c in getattr(clip, key, None) or []:
            out.add(c.path)
    return out


def summary(clip):
    mc = clip.m_MuscleClip
    kinds = {'transform': 0, 'humanoid': 0, 'other': 0}
    for b, _, _ in bindings(clip):
        kinds['transform' if b.typeID == TRANSFORM else 'humanoid' if b.typeID == ANIMATOR else 'other'] += 1
    return {
        'length': round(max(0.0, mc.m_StopTime - mc.m_StartTime), 3),
        'sampleRate': clip.m_SampleRate,
        'loop': bool(getattr(mc, 'm_LoopTime', False)),
        'legacy': bool(clip.m_Legacy),
        'bindings': kinds,
        'events': len(getattr(clip, 'm_Events', []) or []),
    }


def _euler_to_quat(x, y, z):
    """Unity euler degrees (applied Z, then X, then Y) -> quaternion (x, y, z, w)."""
    hx, hy, hz = (math.radians(v) / 2 for v in (x, y, z))
    cx, sx, cy, sy, cz, sz = math.cos(hx), math.sin(hx), math.cos(hy), math.sin(hy), math.cos(hz), math.sin(hz)
    # q = qy * qx * qz
    return (cy * sx * cz + sy * cx * sz,
            sy * cx * cz - cy * sx * sz,
            cy * cx * sz - sy * sx * cz,
            cy * cx * cz + sy * sx * sz)


def sample_transform_tracks(clip, path_to_node, fps=30.0):
    """Returns (times, tracks) where tracks = [(node, 'translation'|'rotation'|'scale', flat values)]
    in glTF (right-handed) space, or (None, reason) when nothing maps."""
    mc = clip.m_MuscleClip
    start, stop = mc.m_StartTime, mc.m_StopTime
    length = max(0.0, stop - start)
    rate = min(fps, clip.m_SampleRate or fps)
    n = max(2, int(math.ceil(length * rate)) + 1)
    times = [start + length * k / (n - 1) for k in range(n)]
    curves = Curves(clip)
    tracks = []
    humanoid = False
    for b, first, dim in bindings(clip):
        if b.typeID == ANIMATOR:
            humanoid = True
        if b.typeID != TRANSFORM or b.attribute not in TRANSFORM_DIMS:
            continue
        node = path_to_node.get(b.path)
        if node is None or first + dim > curves.total:
            continue
        vals = []
        prev = None
        for t in times:
            v = [curves.value(first + k, t) for k in range(dim)]
            if b.attribute == ATTR_POS:
                vals += [-v[0], v[1], v[2]]
            elif b.attribute == ATTR_SCALE:
                vals += v
            else:
                q = _euler_to_quat(*v) if b.attribute == ATTR_EULER else tuple(v)
                q = (q[0], -q[1], -q[2], q[3])
                norm = math.sqrt(sum(c * c for c in q)) or 1.0
                q = [c / norm for c in q]
                if prev and sum(a * b2 for a, b2 in zip(prev, q)) < 0:
                    q = [-c for c in q]  # keep sign continuous so interpolation takes the short way
                prev = q
                vals += q
        path = 'translation' if b.attribute == ATTR_POS else 'scale' if b.attribute == ATTR_SCALE else 'rotation'
        tracks.append((node, path, vals))
    if not tracks:
        return None, 'humanoid (muscle) clip: needs avatar retargeting' if humanoid else 'no curves match this skeleton'
    return [t - start for t in times], tracks


def _hermite(keys, t, dim):
    """Evaluates a Unity AnimationCurve (Keyframe list) at t; values are vectors of dim."""
    def vec(v):
        return [v.x, v.y, v.z, v.w][:dim] if dim == 4 else [v.x, v.y, v.z]
    if not keys:
        return [0.0] * dim
    if t <= keys[0].time:
        return vec(keys[0].value)
    if t >= keys[-1].time:
        return vec(keys[-1].value)
    times = [k.time for k in keys]
    j = bisect.bisect_right(times, t) - 1
    k0, k1 = keys[j], keys[j + 1]
    dt = k1.time - k0.time
    if dt <= 0:
        return vec(k0.value)
    s = (t - k0.time) / dt
    h00, h10, h01, h11 = 2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2
    p0, p1, m0, m1 = vec(k0.value), vec(k1.value), vec(k0.outSlope), vec(k1.inSlope)
    out = []
    for a, b, ma, mb in zip(p0, p1, m0, m1):
        if not (math.isfinite(ma) and math.isfinite(mb)):  # stepped key
            out.append(a)
        else:
            out.append(h00 * a + h10 * dt * ma + h01 * b + h11 * dt * mb)
    return out


def sample_legacy_tracks(clip, path_to_node, fps=30.0):
    """Like sample_transform_tracks for legacy clips, whose curves keep path strings."""
    curves = [(key, c) for key in ('m_PositionCurves', 'm_RotationCurves', 'm_ScaleCurves', 'm_EulerCurves')
              for c in (getattr(clip, key, None) or [])]
    if not curves:
        return None, 'legacy clip without transform curves'
    length = max((c.curve.m_Curve[-1].time for _, c in curves if c.curve.m_Curve), default=0.0)
    rate = min(fps, clip.m_SampleRate or fps)
    n = max(2, int(math.ceil(length * rate)) + 1)
    times = [length * k / (n - 1) for k in range(n)]
    tracks = []
    for key, c in curves:
        node = path_to_node.get(c.path)
        if node is None:
            continue
        keys = c.curve.m_Curve
        vals, prev = [], None
        for t in times:
            if key == 'm_RotationCurves':
                q = _hermite(keys, t, 4)
            elif key == 'm_EulerCurves':
                q = list(_euler_to_quat(*_hermite(keys, t, 3)))
            else:
                v = _hermite(keys, t, 3)
                vals += [-v[0], v[1], v[2]] if key == 'm_PositionCurves' else v
                continue
            q = (q[0], -q[1], -q[2], q[3])
            norm = math.sqrt(sum(x * x for x in q)) or 1.0
            q = [x / norm for x in q]
            if prev and sum(a * b for a, b in zip(prev, q)) < 0:
                q = [-x for x in q]
            prev = q
            vals += q
        path = {'m_PositionCurves': 'translation', 'm_ScaleCurves': 'scale'}.get(key, 'rotation')
        tracks.append((node, path, vals))
    if not tracks:
        return None, 'no curves match this skeleton'
    return times, tracks
