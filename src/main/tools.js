// Runs the bundled Java tools (apktool, jadx) as child processes.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// In a packaged app vendor/ sits in resources/; in development, at the repo root.
function vendorDir() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'vendor');
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'vendor');
}

function toolPaths() {
  const v = vendorDir();
  const java = path.join(v, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const jadxLib = path.join(v, 'jadx', 'lib');
  const jadxJar = fs.existsSync(jadxLib)
    ? path.join(jadxLib, fs.readdirSync(jadxLib).find(f => /^jadx-.*-all\.jar$/.test(f)) || '')
    : '';
  const python = path.join(v, 'python', process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
  const paths = { java, apktool: path.join(v, 'apktool', 'apktool.jar'), jadx: jadxJar, python };
  for (const [name, p] of Object.entries(paths)) {
    if (!p || !fs.existsSync(p)) throw new Error(`Missing ${name} at ${p}. Run "npm run setup-tools".`);
  }
  return paths;
}

function runJava(args, { heapMb = 2048, ...opts } = {}) {
  return runProcess(toolPaths().java, [`-Xmx${heapMb}m`, '-Djava.awt.headless=true', ...args], opts);
}

// -I: isolated mode, so nothing from the user's environment or the APK's
// folders lands on the import path.
function runPython(args, opts = {}) {
  return runProcess(toolPaths().python, ['-I', '-u', ...args], opts);
}

// Runs a bundled tool; calls onLine for every stdout/stderr line (jadx
// rewrites its progress line with \r, so split on both).
function runProcess(cmd, args, { onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const tail = [];
    const feed = chunk => {
      for (const line of chunk.toString().split(/\r?\n|\r/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (onLine) onLine(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);

    const abort = () => child.kill();
    if (signal) {
      if (signal.aborted) abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    child.on('error', reject);
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', abort);
      if (signal && signal.aborted) return reject(new Error('Cancelled'));
      resolve({ code, tail });
    });
  });
}

module.exports = { toolPaths, runJava, runPython, vendorDir };
