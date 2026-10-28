// Reads zip (APK / XAPK / OBB) entries from the central directory and
// extracts single entries by streaming. Entry names are validated before any
// file is written, so hostile names (zip-slip) can't escape the target folder.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

function findEocd(fd, size) {
  const tailLen = Math.min(size, 0xffff + 22);
  const tail = readAt(fd, size - tailLen, tailLen);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) return { buf: tail, at: i, pos: size - tailLen + i };
  }
  throw new Error('Not a zip file (no end-of-central-directory record)');
}

// Zip64 extra field (0x0001) holds the real values of any 0xFFFFFFFF field.
function applyZip64(extra, e) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const take = () => { const v = Number(extra.readBigUInt64LE(q)); q += 8; return v; };
      if (e.size === 0xffffffff) e.size = take();
      if (e.compressedSize === 0xffffffff) e.compressedSize = take();
      if (e.offset === 0xffffffff) e.offset = take();
      return;
    }
    p += 4 + len;
  }
}

function listEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const eocd = findEocd(fd, size);
    let count = eocd.buf.readUInt16LE(eocd.at + 10);
    let cdSize = eocd.buf.readUInt32LE(eocd.at + 12);
    let cdOffset = eocd.buf.readUInt32LE(eocd.at + 16);

    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = readAt(fd, eocd.pos - 20, 20);
      if (loc.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) throw new Error('Broken zip64 record');
      const z = readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOffset = Number(z.readBigUInt64LE(48));
    }

    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CDH_SIG) break;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const e = {
        name: cd.toString('utf8', p + 46, p + 46 + nameLen),
        encrypted: (cd.readUInt16LE(p + 8) & 1) === 1,
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      };
      applyZip64(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), e);
      entries.push(e);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

// A safe relative path for an entry name, or null to skip it.
function safeEntryPath(name) {
  if (!name || name.endsWith('/') || name.includes('\0') || name.includes('\\')) return null;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split('/');
  if (parts.some(s => s === '..' || s === '.' || s === '')) return null;
  return path.join(...parts);
}

// Streams one entry to destDir/<entry name>. Returns the written path, or null if skipped.
async function extractEntry(zipFile, entry, destDir, signal) {
  const rel = safeEntryPath(entry.name);
  if (!rel) return null;
  const dest = path.join(destDir, rel);
  if (!dest.startsWith(path.resolve(destDir) + path.sep)) return null;

  const fd = fs.openSync(zipFile, 'r');
  let dataStart;
  try {
    const lfh = readAt(fd, entry.offset, 30);
    if (lfh.readUInt32LE(0) !== LFH_SIG) throw new Error(`Bad local header for ${entry.name}`);
    dataStart = entry.offset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }

  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (entry.compressedSize === 0) {
    fs.writeFileSync(dest, '');
    return dest;
  }
  const src = fs.createReadStream(zipFile, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  const stages = entry.method === 8 ? [src, zlib.createInflateRaw()] : [src];
  await pipeline(...stages, fs.createWriteStream(dest), { signal });
  return dest;
}

module.exports = { listEntries, extractEntry, safeEntryPath };
