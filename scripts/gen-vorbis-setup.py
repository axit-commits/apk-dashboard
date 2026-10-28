"""Developer-only: generates src/py/vorbis_setup.json.

FMOD's FSB5 Vorbis streams drop the Vorbis setup header and keep only a
CRC32 of it. The app rebuilds standard .ogg files in pure Python from this
table of known setup headers, built from two sources:

1. python-fsb5's (crc32 -> quality, channels, rate) table (MIT): each header
   is regenerated with libvorbis' encoder, which also gives its block sizes.
2. vgmstream's collection of setup packets taken from FMOD itself (ISC-style
   licence), which covers newer FMOD versions whose encoder libvorbis can't
   reproduce. Those carry no block sizes; the app picks them from the
   sample count stored in the FSB.

    python scripts/gen-vorbis-setup.py <libvorbis+libogg dylib/so/dll> <fsb5 vorbis_headers.py> [<vgmstream vorbis_codebooks_fsb.h>]
"""

import base64
import ctypes
import json
import os
import re
import runpy
import struct
import sys
import zlib

lib = ctypes.CDLL(sys.argv[1])
lookup = runpy.run_path(sys.argv[2])['lookup']
vgm_header = sys.argv[3] if len(sys.argv) > 3 else None


class OggPacket(ctypes.Structure):
    _fields_ = [('packet', ctypes.POINTER(ctypes.c_ubyte)), ('bytes', ctypes.c_long), ('b_o_s', ctypes.c_long),
                ('e_o_s', ctypes.c_long), ('granulepos', ctypes.c_longlong), ('packetno', ctypes.c_longlong)]


def opaque():
    return ctypes.create_string_buffer(16384)  # larger than any of the libvorbis state structs


lib.vorbis_encode_setup_vbr.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.c_long, ctypes.c_float]
lib.vorbis_encode_ctl.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
lib.vorbis_info_blocksize.argtypes = [ctypes.c_void_p, ctypes.c_int]
lib.vorbis_packet_blocksize.argtypes = [ctypes.c_void_p, ctypes.POINTER(OggPacket)]
lib.vorbis_packet_blocksize.restype = ctypes.c_long
lib.vorbis_synthesis_headerin.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(OggPacket)]
OV_ECTL_COUPLING_SET = 0x41


def packet(data, no, bos=0):
    buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    return OggPacket(ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)), len(data), bos, 0, 0, no), buf


def long_modes(vi, long_):
    """Which audio packets are long blocks: the mode number sits in bits 1..6
    of the first byte, so probe every 6-bit value."""
    flags = []
    for m in range(64):
        pkt, _keep = packet(bytes([(m << 1) & 0xFE]) + bytes(7), 3)
        bs = lib.vorbis_packet_blocksize(vi, ctypes.byref(pkt))
        flags.append('1' if bs == long_ else '0')
    return ''.join(flags)


def from_encoder(quality, channels, rate):
    vi, vc, vd = opaque(), opaque(), opaque()
    lib.vorbis_info_init(vi)
    lib.vorbis_comment_init(vc)
    q = -0.1 + (1.0 - -0.1) * ((quality - 1) / (100 - 1))  # same mapping python-fsb5 uses
    if lib.vorbis_encode_setup_vbr(vi, channels, rate, ctypes.c_float(q)):
        raise RuntimeError('vorbis_encode_setup_vbr failed')
    lib.vorbis_encode_ctl(vi, OV_ECTL_COUPLING_SET, ctypes.byref(ctypes.c_int(1)))
    if lib.vorbis_encode_setup_init(vi):
        raise RuntimeError('vorbis_encode_setup_init failed')
    lib.vorbis_analysis_init(vd, vi)
    ident, comment, setup = OggPacket(), OggPacket(), OggPacket()
    lib.vorbis_analysis_headerout(vd, vc, ctypes.byref(ident), ctypes.byref(comment), ctypes.byref(setup))
    setup_bytes = bytes(setup.packet[:setup.bytes])
    short, long_ = lib.vorbis_info_blocksize(vi, 0), lib.vorbis_info_blocksize(vi, 1)
    flags = long_modes(vi, long_)
    lib.vorbis_dsp_clear(vd)
    return setup_bytes, {'short': short, 'long': long_, 'longModes': flags}


def from_setup_packet(setup):
    """Mode flags for a raw setup packet, via libvorbis' decoder side."""
    for short, long_ in ((256, 2048), (512, 4096), (256, 1024), (512, 2048), (1024, 1024), (512, 512), (256, 256)):
        vi, vc = opaque(), opaque()
        lib.vorbis_info_init(vi)
        lib.vorbis_comment_init(vc)
        log2 = {1 << i: i for i in range(16)}
        ident = (b'\x01vorbis' + struct.pack('<IBIiii', 0, 2, 44100, 0, 0, 0) +
                 bytes([log2[short] | (log2[long_] << 4), 1]))
        comment = b'\x03vorbis' + struct.pack('<I', 0) + struct.pack('<I', 0) + b'\x01'
        ok = True
        for no, data in enumerate((ident, comment, setup)):
            pkt, _keep = packet(data, no, bos=1 if no == 0 else 0)
            if lib.vorbis_synthesis_headerin(vi, vc, ctypes.byref(pkt)) != 0:
                ok = False
                break
        if ok:
            return {'short': None, 'long': None, 'longModes': long_modes(vi, long_)}
    raise RuntimeError('setup packet rejected by libvorbis')


def vgmstream_packets(path):
    """crc32 -> setup bytes, from vgmstream's vorbis_codebooks_fsb.h."""
    text = open(path, encoding='utf-8').read()
    out = {}
    for name, body in re.findall(r'static const uint8_t vcb_([0-9a-f]{8})\[\] = \{(.*?)\};', text, re.S):
        data = bytes(int(x, 16) for x in re.findall(r'0x([0-9a-fA-F]{2})', body))
        crc = int(name, 16)
        if zlib.crc32(data) != crc:
            raise RuntimeError(f'vcb_{name}: CRC32 does not match its name')
        out[crc] = data
    return out


out = {}
for crc, params in sorted(lookup.items()):
    setup, info = from_encoder(*params)
    out[str(crc)] = {**info, 'setup': base64.b64encode(setup).decode()}
added = 0
if vgm_header:
    for crc, setup in sorted(vgmstream_packets(vgm_header).items()):
        if str(crc) in out:
            continue
        out[str(crc)] = {**from_setup_packet(setup), 'setup': base64.b64encode(setup).decode()}
        added += 1

dest = os.path.join(os.path.dirname(__file__), '..', 'src', 'py', 'vorbis_setup.json')
with open(dest, 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print(f'{len(out)} setup headers ({added} from vgmstream) -> {os.path.normpath(dest)} ({os.path.getsize(dest) // 1024} KB)')
