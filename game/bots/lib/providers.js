// LLM providers behind one small interface, so the agent does not care which model plays.
//
//   const p = makeProvider(system, tools)   // tools: [{name, description, input_schema}]
//   p.start(userText)                       // new conversation
//   const r = p.call()                      // -> {calls:[{id,name,input}], text, thoughts, usage:{in,out,cached}, model}
//   p.toolResults([{id,name,content,isError}])
//   p.userText(text)
//
// Provider is picked by LLM_PROVIDER, or automatically: GEMINI_API_KEY -> gemini, ANTHROPIC_API_KEY -> anthropic,
// otherwise a local Ollama server. All calls are blocking (run.js is synchronous) and need no npm packages.
'use strict';
const { postJsonSync, sleepMs } = require('./http_sync.js');
const fs = require('fs');
const path = require('path');

// Keys can also live in game/.env (one KEY=value per line, never committed). Real env vars win.
(function loadDotEnv() {
  const file = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*["']?([^"'\n]*?)["']?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  // a file holding only a bare key on one line is taken as the Gemini key
  if (lines.length === 1 && !lines[0].includes('=') && !process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = lines[0];
})();

function pickProvider() {
  if (process.env.LLM_PROVIDER) return process.env.LLM_PROVIDER;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'ollama';
}

const DEFAULT_MODEL = { gemini: 'gemini-3.5-flash-lite', anthropic: 'claude-opus-5-5', ollama: 'qwen2.5-coder:7b' };

// ------------------------------------------------------------------ Gemini (Google AI Studio, generateContent)
function geminiSchema(s) {
  // Gemini takes an OpenAPI subset: drop keys it does not know.
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (['additionalProperties', 'minItems', '$schema'].includes(k)) continue;
    o[k] = (typeof v === 'object') ? geminiSchema(v) : v;
  }
  return o;
}

let lastCallAt = 0;   // shared by every Gemini conversation in this process (pacing)

function gemini(system, tools, model) {
  const key = process.env.GEMINI_API_KEY;
  const base = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  let contents = [];
  const decl = tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) }));
  let n = 0;
  return {
    name: 'gemini', model,
    start(text) { contents = [{ role: 'user', parts: [{ text }] }]; },
    userText(text) { contents.push({ role: 'user', parts: [{ text }] }); },
    toolResults(rs) {
      contents.push({ role: 'user', parts: rs.map((r) => ({ functionResponse: Object.assign(r.id && !String(r.id).startsWith('g') ? { id: r.id } : {}, { name: r.name, response: { result: r.content, error: !!r.isError } }) })) });
    },
    call() {
      if (!key) throw new Error('GEMINI_API_KEY is not set');
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: decl }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },     // always answer with a tool call
        generationConfig: { temperature: 0, maxOutputTokens: 8192 },
      };
      // Free tier: 15 requests/minute. Pace calls (default one every 4.3 s) instead of tripping the limit.
      const gap = Number(process.env.LLM_MIN_INTERVAL_MS || 4300);
      let r;
      for (let attempt = 1; ; attempt++) {
        const wait = lastCallAt + gap - Date.now();
        if (wait > 0) sleepMs(wait);
        lastCallAt = Date.now();
        r = postJsonSync(`${base}/models/${model}:generateContent`, { 'content-type': 'application/json', 'x-goog-api-key': key }, body, { no429Retry: true });
        if (r.status !== 429) break;
        const msg = String(r.text);
        if (/per day/i.test(msg)) { const e = new Error('DAILY_QUOTA ' + ((msg.match(/Quota exceeded for metric:[^\n]*/) || [msg.slice(0, 300)])[0])); e.dailyQuota = true; throw e; }
        if (attempt >= 10) break;
        const sec = Number((msg.match(/retry in ([\d.]+)s/i) || [])[1] || 30);
        sleepMs(Math.min(90, sec + 1) * 1000);   // per-minute limit: wait as long as the API says
      }
      if (r.status !== 200 || !r.json) throw new Error(`Gemini ${r.status}: ${String(r.text).slice(0, 400)}`);
      const cand = (r.json.candidates || [])[0];
      if (!cand || !cand.content) throw new Error('Gemini: empty response ' + JSON.stringify(r.json).slice(0, 300));
      contents.push(cand.content);   // keep parts unchanged (thought signatures must go back as-is)
      const parts = cand.content.parts || [];
      const u = r.json.usageMetadata || {};
      return {
        calls: parts.filter((p) => p.functionCall).map((p) => ({ id: p.functionCall.id || `g${++n}`, name: p.functionCall.name, input: p.functionCall.args || {} })),
        text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n'),
        thoughts: parts.filter((p) => p.thought && p.text).map((p) => p.text).join('\n'),
        usage: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), cached: u.cachedContentTokenCount || 0 },
        model, stop: cand.finishReason, raw: parts,
      };
    },
  };
}

// ------------------------------------------------------------------ Anthropic (Claude Messages API, raw HTTP)
function anthropic(system, tools, model) {
  const key = process.env.ANTHROPIC_API_KEY;
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  let messages = [];
  return {
    name: 'anthropic', model,
    start(text) { messages = [{ role: 'user', content: text }]; },
    userText(text) { messages.push({ role: 'user', content: text }); },
    toolResults(rs) { messages.push({ role: 'user', content: rs.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: !!r.isError })) }); },
    call() {
      if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
      const body = {
        model, max_tokens: 16000,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: process.env.LLM_EFFORT || 'medium' },
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools, tool_choice: { type: 'auto' }, messages,
      };
      const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' };
      if (/^claude-(opus-5-5|sonnet-5-5)/.test(model)) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
      const r = postJsonSync(base + '/v1/messages', headers, body);
      if (r.status !== 200 || !r.json) throw new Error(`Anthropic ${r.status}: ${String(r.text).slice(0, 400)}`);
      messages.push({ role: 'assistant', content: r.json.content });
      const u = r.json.usage || {};
      const c = r.json.content || [];
      return {
        calls: c.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
        text: c.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        thoughts: c.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n'),
        usage: { in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens || 0, cached: u.cache_read_input_tokens || 0 },
        model: r.json.model, stop: r.json.stop_reason, raw: c,
      };
    },
  };
}

// ------------------------------------------------------------------ Ollama (local open models, /api/chat)
function ollama(system, tools, model) {
  const base = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  let messages = [];
  const t = tools.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.input_schema } }));
  let n = 0;
  return {
    name: 'ollama', model,
    start(text) { messages = [{ role: 'system', content: system }, { role: 'user', content: text }]; },
    userText(text) { messages.push({ role: 'user', content: text }); },
    toolResults(rs) { for (const r of rs) messages.push({ role: 'tool', tool_name: r.name, content: (r.isError ? 'ERROR: ' : '') + r.content }); },
    call() {
      const body = { model, messages, tools: t, stream: false, options: { temperature: 0, num_ctx: 16384 } };
      const r = postJsonSync(base + '/api/chat', { 'content-type': 'application/json' }, body);
      if (r.status !== 200 || !r.json) throw new Error(`Ollama ${r.status}: ${String(r.text).slice(0, 300)}`);
      const m = r.json.message || {};
      messages.push(m);
      return {
        calls: (m.tool_calls || []).map((c) => ({ id: `o${++n}`, name: c.function.name, input: typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments) : (c.function.arguments || {}) })),
        text: m.content || '', thoughts: m.thinking || '',
        usage: { in: r.json.prompt_eval_count || 0, out: r.json.eval_count || 0, cached: 0 },
        model, stop: r.json.done_reason, raw: m,
      };
    },
  };
}

function makeProvider(system, tools, opts) {
  opts = opts || {};
  const kind = opts.provider || pickProvider();
  const model = opts.model || process.env.LLM_MODEL || DEFAULT_MODEL[kind];
  if (kind === 'gemini') return gemini(system, tools, model);
  if (kind === 'anthropic') return anthropic(system, tools, model);
  if (kind === 'ollama') return ollama(system, tools, model);
  throw new Error('unknown LLM_PROVIDER ' + kind);
}

module.exports = { makeProvider, pickProvider };
