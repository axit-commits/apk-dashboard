// Signing certificate of an APK: parsed from the APK Signing Block (schemes
// v2/v3) with Node's X.509 parser, falling back to the bundled keytool for
// v1-only (JAR) signatures.

const { X509Certificate } = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { listEntries } = require('./zipindex');
const { vendorDir } = require('./tools');

const V2 = 0x7109871a;
const V3 = 0xf05368c0;
const V31 = 0x1b93ad61;

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  return b.subarray(0, fs.readSync(fd, b, 0, len, pos));
}

// Finds the central directory offset via the end-of-central-directory record.
function cdOffset(fd, size) {
  const n = Math.min(size, 0xffff + 22);
  const tail = readAt(fd, size - n, n);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) return tail.readUInt32LE(i + 16);
  }
  return null;
}

// First certificate (DER) of the first signer in a v2/v3 signature value.
function firstCert(value) {
  let p = 0;
  const u32 = () => { const v = value.readUInt32LE(p); p += 4; return v; };
  u32(); // signers sequence length
  u32(); // first signer length
  u32(); // signed data length
  const digests = u32();
  p += digests;
  u32(); // certificates sequence length
  const certLen = u32();
  return value.subarray(p, p + certLen);
}

function signingBlock(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const cd = cdOffset(fd, size);
    if (cd == null || cd < 32) return null;
    const footer = readAt(fd, cd - 24, 24);
    if (footer.toString('latin1', 8, 24) !== 'APK Sig Block 42') return null;
    const blockSize = Number(footer.readBigUInt64LE(0));
    const block = readAt(fd, cd - blockSize - 8, blockSize + 8);
    const pairs = new Map();
    let p = 8;
    while (p + 12 <= block.length - 24) {
      const len = Number(block.readBigUInt64LE(p));
      const id = block.readUInt32LE(p + 8);
      pairs.set(id, block.subarray(p + 12, p + 8 + len));
      p += 8 + len;
    }
    return pairs;
  } finally {
    fs.closeSync(fd);
  }
}

function describe(der) {
  const c = new X509Certificate(der);
  return {
    subject: c.subject.replace(/\n/g, ', '),
    issuer: c.issuer.replace(/\n/g, ', '),
    validFrom: c.validFrom,
    validTo: c.validTo,
    sha256: c.fingerprint256,
    sha1: c.fingerprint,
    serial: c.serialNumber,
  };
}

function keytool(file) {
  const exe = path.join(vendorDir(), 'jre', 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  if (!fs.existsSync(exe)) return null;
  try {
    const out = execFileSync(exe, ['-printcert', '-jarfile', file], { encoding: 'utf8', timeout: 30000 });
    const get = re => (out.match(re) || [])[1]?.trim() || null;
    if (!get(/SHA256:\s*([0-9A-F:]+)/)) return null;
    return {
      subject: get(/Owner:\s*(.+)/), issuer: get(/Issuer:\s*(.+)/), serial: get(/Serial number:\s*(\S+)/),
      validFrom: get(/Valid from:\s*(.+?)\s+until:/), validTo: get(/until:\s*(.+)/),
      sha256: get(/SHA256:\s*([0-9A-F:]+)/), sha1: get(/SHA1:\s*([0-9A-F:]+)/),
    };
  } catch {
    return null;
  }
}

// { schemes: ['v1','v2','v3'], cert: {...} | null, debug: bool, error? }
function readSigning(file) {
  const out = { schemes: [], cert: null };
  try {
    if (listEntries(file).some(e => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(e.name))) out.schemes.push('v1');
    const pairs = signingBlock(file);
    if (pairs) {
      if (pairs.has(V2)) out.schemes.push('v2');
      if (pairs.has(V3)) out.schemes.push('v3');
      if (pairs.has(V31)) out.schemes.push('v3.1');
      const value = pairs.get(V3) || pairs.get(V2);
      if (value) out.cert = describe(firstCert(value));
    }
    if (!out.cert && out.schemes.includes('v1')) out.cert = keytool(file);
  } catch (err) {
    out.error = err.message;
  }
  out.debug = !!out.cert && /CN=Android Debug/i.test(out.cert.subject || '');
  return out;
}

module.exports = { readSigning };
