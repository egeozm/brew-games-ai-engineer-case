// Blocking HTTP POST for plain Node. run.js calls chooseAction() synchronously, so the bot cannot await;
// we run one fetch() in a child process and wait for it with execFileSync. Retries 429 / 5xx / network errors.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'http_child.js');

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function postOnce(url, headers, body, timeoutMs) {
  const out = execFileSync(process.execPath, [CHILD], {
    input: JSON.stringify({ url, headers, body, timeoutMs }),
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs + 15000,
  });
  return JSON.parse(out.toString('utf8'));
}

// Returns {status, json, text, attempts}. Throws only if every attempt failed.
function postJsonSync(url, headers, bodyObj, opts) {
  opts = opts || {};
  const tries = opts.retries == null ? 6 : opts.retries;
  const body = JSON.stringify(bodyObj);
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { last = postOnce(url, headers, body, opts.timeoutMs || 600000); } catch (e) { last = { status: 0, text: String(e.message || e), headers: {} }; }
    const retryable = last.status === 0 || last.status === 408 || last.status === 409 || (last.status === 429 && !opts.no429Retry) || last.status >= 500;
    if (!retryable) {
      let json = null; try { json = JSON.parse(last.text); } catch (_) { /* not json */ }
      return { status: last.status, json, text: last.text, attempts: attempt };
    }
    const ra = Number(last.headers && last.headers['retry-after']);
    sleepMs(Math.min(60000, (isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** (attempt - 1))));
  }
  throw new Error(`HTTP failed after ${tries} attempts: status ${last && last.status} ${last && String(last.text).slice(0, 300)}`);
}

module.exports = { postJsonSync, sleepMs };
