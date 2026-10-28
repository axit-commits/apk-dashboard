// Runs the decode pipeline without the window, for testing:
//   npm run decode -- path/to/app.apk [workRoot]

const os = require('os');
const path = require('path');
const { decode } = require('../src/main/pipeline');

const [apk, workRoot = path.join(os.tmpdir(), 'apk-explorer-workspaces')] = process.argv.slice(2);
if (!apk) {
  console.error('Usage: npm run decode -- <file.apk> [workRoot]');
  process.exit(2);
}

const last = {};
decode(path.resolve(apk), {
  workRoot,
  onProgress: ({ stage, status, percent, message }) => {
    const line = `${stage.padEnd(10)} ${status.padEnd(8)} ${percent != null ? String(percent).padStart(3) + '% ' : ''}${message || ''}`;
    // Print stage changes, and progress only every 10%.
    const key = `${status}:${percent == null ? message : Math.floor(percent / 10)}`;
    if (status === 'running' && last[stage] === key) return;
    last[stage] = key;
    console.log(line);
  },
}).then(({ workspace, meta, fromCache }) => {
  const o = meta.overview || {};
  console.log(`\nWorkspace: ${workspace}${fromCache ? ' (cached)' : ''}`);
  console.log(JSON.stringify({
    appName: o.appName, package: o.package, version: `${o.versionName} (${o.versionCode})`,
    sdk: `min ${o.minSdk} / target ${o.targetSdk}`, frameworks: o.frameworks,
    permissions: (o.permissions || []).length, dangerous: (o.permissions || []).filter(p => p.dangerous).map(p => p.name),
    components: (o.components || []).length, launcher: (o.components || []).filter(c => c.launcher).map(c => c.name),
    animations: o.animations, seconds: meta.seconds, stages: meta.stages,
  }, null, 2));
}).catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
