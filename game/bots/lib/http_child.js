// Child process used by http_sync.js: reads {url, headers, body, timeoutMs} as JSON on stdin,
// does one fetch(), prints {status, headers, text} as JSON on stdout. Plain Node (>=18), no packages.
'use strict';
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  const req = JSON.parse(raw);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeoutMs || 600000);
  try {
    const r = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: ctl.signal });
    const text = await r.text();
    const headers = {};
    for (const k of ['retry-after', 'request-id']) if (r.headers.get(k)) headers[k] = r.headers.get(k);
    process.stdout.write(JSON.stringify({ status: r.status, headers, text }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ status: 0, headers: {}, text: String(e && e.message || e) }));
  } finally {
    clearTimeout(timer);
  }
});
