"""Minimal glTF 2.0 binary (GLB) writer: meshes, skins, animations, PNG textures."""

import json
import struct
from array import array

FLOAT, UINT, USHORT = 5126, 5125, 5123
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.doc = {
            'asset': {'version': '2.0', 'generator': 'APK Explorer'},
            'scene': 0, 'scenes': [{'nodes': []}],
            'nodes': [], 'meshes': [], 'buffers': [], 'bufferViews': [], 'accessors': [],
        }
        self._images = {}

    def _list(self, key):
        return self.doc.setdefault(key, [])

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            view['target'] = target
        self.bin += data
        self.doc['bufferViews'].append(view)
        return len(self.doc['bufferViews']) - 1

    def accessor(self, flat, comp, kind, count, target=None, minmax=False):
        """flat: flat list of numbers; kind: SCALAR/VEC2/VEC3/VEC4/MAT4."""
        code = {FLOAT: 'f', UINT: 'I', USHORT: 'H'}[comp]
        acc = {'bufferView': self._view(array(code, flat).tobytes(), target),
               'componentType': comp, 'count': count, 'type': kind}
        if minmax and count:
            n = len(flat) // count
            acc['min'] = [min(flat[i::n]) for i in range(n)]
            acc['max'] = [max(flat[i::n]) for i in range(n)]
        self.doc['accessors'].append(acc)
        return len(self.doc['accessors']) - 1

    def image(self, png_bytes, key):
        if key in self._images:
            return self._images[key]
        self._list('images').append({'bufferView': self._view(png_bytes), 'mimeType': 'image/png'})
        samplers = self._list('samplers')
        if not samplers:
            samplers.append({'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497})
        self._list('textures').append({'source': len(self.doc['images']) - 1, 'sampler': 0})
        self._images[key] = len(self.doc['textures']) - 1
        return self._images[key]

    def material(self, name, texture=None, color=None):
        pbr = {'metallicFactor': 0.0, 'roughnessFactor': 0.8}
        if texture is not None:
            pbr['baseColorTexture'] = {'index': texture}
        if color:
            pbr['baseColorFactor'] = [max(0.0, min(1.0, float(c))) for c in color]
        self._list('materials').append({'name': name, 'pbrMetallicRoughness': pbr, 'doubleSided': True})
        return len(self.doc['materials']) - 1

    def mesh(self, name, primitives):
        self.doc['meshes'].append({'name': name, 'primitives': primitives})
        return len(self.doc['meshes']) - 1

    def node(self, **fields):
        self.doc['nodes'].append({k: v for k, v in fields.items() if v is not None})
        return len(self.doc['nodes']) - 1

    def to_bytes(self):
        if self.bin:
            self.doc['buffers'] = [{'byteLength': len(self.bin)}]
        else:
            self.doc.pop('buffers')
        js = json.dumps(self.doc, separators=(',', ':')).encode()
        js += b' ' * (-len(js) % 4)
        binary = bytes(self.bin) + b'\0' * (-len(self.bin) % 4)
        chunks = struct.pack('<II', len(js), 0x4E4F534A) + js
        if binary:
            chunks += struct.pack('<II', len(binary), 0x004E4942) + binary
        return struct.pack('<III', 0x46546C67, 2, 12 + len(chunks)) + chunks
