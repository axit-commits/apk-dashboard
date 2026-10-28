"""Rebuilds standard Ogg Vorbis files from FMOD FSB5 banks, in pure Python.

FSB5 Vorbis keeps the raw audio packets but drops the three Vorbis headers,
storing only a CRC32 of the setup header. vorbis_setup.json (generated once by
scripts/gen-vorbis-setup.py) maps that CRC to the header bytes and to which
packet modes use long blocks, which is all an Ogg muxer needs.
"""

import base64
import json
import os
import struct

FREQUENCIES = {1: 8000, 2: 11000, 3: 11025, 4: 16000, 5: 22050, 6: 24000, 7: 32000, 8: 44100, 9: 48000}
CHUNK_CHANNELS, CHUNK_FREQUENCY, CHUNK_VORBISDATA = 1, 2, 11
VORBIS = 15

_setup = None


def _table():
    global _setup
    if _setup is None:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vorbis_setup.json')) as f:
            _setup = json.load(f)
    return _setup


def parse(data):
    """Returns (codec, [sample dicts with channels, frequency, crc32, data])."""
    version, num, shdr, names, size, codec = struct.unpack_from('<IIIIII', data, 4)
    pos = 60 if version == 1 else 64
    samples = []
    for _ in range(num):
        raw, = struct.unpack_from('<Q', data, pos)
        pos += 8
        more = raw & 1
        s = {'frequency': FREQUENCIES.get((raw >> 1) & 0xF), 'channels': ((raw >> 5) & 1) + 1,
             'offset': ((raw >> 6) & 0xFFFFFFF) * 16, 'samples': (raw >> 34) & 0x3FFFFFFF, 'crc32': None}
        while more:
            c, = struct.unpack_from('<I', data, pos)
            pos += 4
            more, csize, ctype = c & 1, (c >> 1) & 0xFFFFFF, (c >> 25) & 0x7F
            if ctype == CHUNK_VORBISDATA:
                s['crc32'], = struct.unpack_from('<I', data, pos)
            elif ctype == CHUNK_FREQUENCY:
                s['frequency'], = struct.unpack_from('<I', data, pos)
            elif ctype == CHUNK_CHANNELS:
                s['channels'] = data[pos]
            pos += csize
        samples.append(s)
    start = (60 if version == 1 else 64) + shdr + names
    for i, s in enumerate(samples):
        end = samples[i + 1]['offset'] if i + 1 < len(samples) else size
        s['data'] = data[start + s['offset']:start + end]
    return codec, samples


# ---------- Ogg muxing ----------

def _crc_table():
    t = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) if r & 0x80000000 else (r << 1)
        t.append(r & 0xFFFFFFFF)
    return t


_CRC = _crc_table()


def _ogg_crc(data):
    crc = 0
    for b in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC[((crc >> 24) & 0xFF) ^ b]
    return crc


class _OggWriter:
    def __init__(self, serial=1):
        self.serial, self.seq, self.out = serial, 0, bytearray()
        self.lacing, self.body, self.granule, self.continued = [], bytearray(), -1, False

    def _flush(self, flags=0):
        if not self.lacing and not flags & 4:
            return
        header = struct.pack('<4sBBqIIIB', b'OggS', 0, flags | (1 if self.continued else 0), self.granule,
                             self.serial, self.seq, 0, len(self.lacing)) + bytes(self.lacing)
        page = bytearray(header + self.body)
        struct.pack_into('<I', page, 22, _ogg_crc(page))
        self.out += page
        self.seq += 1
        self.lacing, self.body, self.granule = [], bytearray(), -1

    def packet(self, data, granule, flush_after=False, bos=False):
        n = len(data)
        lacing = [255] * (n // 255) + [n % 255]
        pos = 0
        self.continued = False
        while lacing:
            take = min(255 - len(self.lacing), len(lacing))
            chunk = lacing[:take]
            lacing = lacing[take:]
            nbytes = sum(chunk)
            self.lacing += chunk
            self.body += data[pos:pos + nbytes]
            pos += nbytes
            if not lacing:
                self.granule = granule
            if lacing or len(self.lacing) == 255:
                self._flush(2 if bos else 0)
                bos = False
                self.continued = bool(lacing)
        if flush_after or len(self.body) >= 4096:
            self._flush(2 if bos else 0)

    def finish(self):
        # Mark the last page end-of-stream; if it was already flushed, add an empty EOS page.
        if self.lacing:
            self._flush(4)
        else:
            self.granule = self._last_granule
            self._flush(4)


def to_ogg(data):
    """FSB5 bytes -> Ogg Vorbis bytes (first sample). Raises ValueError if unsupported."""
    codec, samples = parse(data)
    if codec != VORBIS or not samples:
        raise ValueError('not a Vorbis FSB5 bank')
    s = samples[0]
    info = _table().get(str(s['crc32']))
    if info is None:
        raise ValueError(f'unknown Vorbis setup header (crc32 {s["crc32"]})')
    long_modes = info['longModes']
    log2 = {1 << i: i for i in range(16)}

    packets = []
    audio = s['data']
    pos = 0
    while pos + 2 <= len(audio):
        n, = struct.unpack_from('<H', audio, pos)
        pos += 2
        if n == 0 or pos + n > len(audio):
            break
        packets.append(audio[pos:pos + n])
        pos += n
    is_long = [long_modes[(p[0] >> 1) & 63] == '1' for p in packets]

    def granules(short, long_):
        out, g, prev = [], 0, 0
        for lng in is_long:
            bs = long_ if lng else short
            g = g + (bs + prev) // 4 if prev else 0
            prev = bs
            out.append(g)
        return out

    short, long_ = info['short'], info['long']
    if short is None:
        # Headers taken from FMOD carry no block sizes: pick the pair whose
        # timeline ends on the sample count the FSB records.
        candidates = [(256, 2048), (512, 4096), (256, 1024), (512, 2048), (128, 1024), (1024, 1024), (512, 512), (256, 256)]
        short, long_ = min(candidates, key=lambda c: abs((granules(*c) or [0])[-1] - s['samples']))
    marks = granules(short, long_)

    ident = (b'\x01vorbis' + struct.pack('<IBIiii', 0, s['channels'], s['frequency'], 0, 0, 0) +
             bytes([log2[short] | (log2[long_] << 4), 1]))
    vendor = b'APK Explorer'
    comment = b'\x03vorbis' + struct.pack('<I', len(vendor)) + vendor + struct.pack('<I', 0) + b'\x01'
    setup = base64.b64decode(info['setup'])

    w = _OggWriter()
    w.packet(ident, 0, flush_after=True, bos=True)
    w.packet(comment, 0)
    w.packet(setup, 0, flush_after=True)

    for pkt, granule in zip(packets, marks):
        w.packet(pkt, granule)
    w._last_granule = marks[-1] if marks else 0
    w.finish()
    return bytes(w.out)
