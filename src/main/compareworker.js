// Worker thread: runs a version comparison and posts { progress } then { result } or { error }.

const { parentPort, workerData } = require('worker_threads');
const { compareWithAudit } = require('./compare');

compareWithAudit(workerData.wsA, workerData.wsB, message => parentPort.postMessage({ progress: message }))
  .then(result => parentPort.postMessage({ result }))
  .catch(err => parentPort.postMessage({ error: err.message }));
