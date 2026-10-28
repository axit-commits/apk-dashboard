// Developer-only setup: downloads jadx + apktool and builds a trimmed Java
// runtime into vendor/. This is the only step that touches the network; the
// app itself runs fully offline from what lands in vendor/.
//
//   npm run setup-tools
//
// Needs a JDK 17+ on this machine (for jlink). JAVA_HOME wins if set.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const JADX_VERSION = '1.5.6';
const APKTOOL_VERSION = '3.0.3';
const PYTHON_BUILD = '20261026';
const PYTHON_VERSION = '3.12.16';

// Portable CPython builds (python-build-standalone) per platform.
const PYTHON_TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};

// Modules jadx and apktool need. Add one here if a tool fails with
// NoClassDefFoundError for a java.* / javax.* class.
const JRE_MODULES = [
  'java.base', 'java.desktop', 'java.logging', 'java.management', 'java.naming',
  'java.prefs', 'java.sql', 'java.xml', 'jdk.unsupported', 'jdk.zipfs', 'jdk.crypto.ec',
];

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'vendor');
const isWin = process.platform === 'win32';

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, dest) {
  if (fs.existsSync(dest)) {
    console.log(`  cached ${path.basename(dest)}`);
    return;
  }
  console.log(`  downloading ${url}`);
  sh('curl', ['-fsSL', '--retry', '3', '-o', dest + '.part', url]);
  fs.renameSync(dest + '.part', dest);
}

function unzip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // bsdtar reads zips on macOS and Windows 10+; GNU tar on Linux does not.
  if (process.platform === 'linux') sh('unzip', ['-q', '-o', zip, '-d', dir]);
  else sh('tar', ['-xf', zip, '-C', dir]);
}

function findJdk() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  if (process.platform === 'darwin') {
    return execFileSync('/usr/libexec/java_home', ['-v', '17+']).toString().trim();
  }
  throw new Error('Set JAVA_HOME to a JDK 17 or newer.');
}

function main() {
  fs.mkdirSync(path.join(vendor, 'downloads'), { recursive: true });

  console.log('jadx');
  const jadxZip = path.join(vendor, 'downloads', `jadx-${JADX_VERSION}.zip`);
  download(`https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip`, jadxZip);
  const jadxDir = path.join(vendor, 'jadx');
  fs.rmSync(jadxDir, { recursive: true, force: true });
  unzip(jadxZip, jadxDir);

  console.log('apktool');
  const apktoolJar = path.join(vendor, 'downloads', `apktool_${APKTOOL_VERSION}.jar`);
  download(`https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar`, apktoolJar);
  fs.mkdirSync(path.join(vendor, 'apktool'), { recursive: true });
  fs.copyFileSync(apktoolJar, path.join(vendor, 'apktool', 'apktool.jar'));

  console.log('java runtime (jlink)');
  const jdk = findJdk();
  const jreDir = path.join(vendor, 'jre');
  fs.rmSync(jreDir, { recursive: true, force: true });
  sh(path.join(jdk, 'bin', isWin ? 'jlink.exe' : 'jlink'), [
    '--add-modules', JRE_MODULES.join(','),
    '--strip-debug', '--no-man-pages', '--no-header-files', '--compress=2',
    '--output', jreDir,
  ]);

  // Python + UnityPy for game assets. UnityPy is installed without its
  // fmod_toolkit dependency, which bundles the proprietary FMOD library.
  console.log('python + UnityPy');
  const triple = PYTHON_TRIPLES[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error(`No portable Python build for ${process.platform}-${process.arch}`);
  const pyName = `cpython-${PYTHON_VERSION}+${PYTHON_BUILD}-${triple}-install_only_stripped.tar.gz`;
  const pyTar = path.join(vendor, 'downloads', pyName);
  download(`https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}/${encodeURIComponent(pyName)}`, pyTar);
  const pyDir = path.join(vendor, 'python');
  fs.rmSync(pyDir, { recursive: true, force: true });
  sh('tar', ['-xzf', pyTar, '-C', vendor]); // unpacks to vendor/python
  const py = path.join(pyDir, isWin ? 'python.exe' : path.join('bin', 'python3'));
  const pip = ['-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', '--no-warn-script-location'];
  sh(py, [...pip, '--no-deps', '-r', path.join(__dirname, 'python-requirements.txt')]);
  const pyPackages = execFileSync(py, ['-m', 'pip', 'freeze']).toString().trim().split('\n');

  const versions = {
    jadx: JADX_VERSION,
    apktool: APKTOOL_VERSION,
    python: PYTHON_VERSION,
    pyPackages,
    jdk,
    sha256: {
      [path.basename(jadxZip)]: sha256(jadxZip),
      [path.basename(apktoolJar)]: sha256(apktoolJar),
      [pyName]: sha256(pyTar),
    },
  };
  fs.writeFileSync(path.join(vendor, 'versions.json'), JSON.stringify(versions, null, 2));
  console.log('\nDone. Tools are in vendor/:');
  console.log(JSON.stringify(versions, null, 2));
}

main();
