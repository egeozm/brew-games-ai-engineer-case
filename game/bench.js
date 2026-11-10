#!/usr/bin/env node
// Benchmark harness. Uses run.js's own playGame() (same game loop, same log format) and adds what run.js
// does not measure: wall time, LLM calls, tokens and cost per game (from the bot's getStats(), if any).
//
//   node bench.js --bot bots/rule.js --seeds 1-30 --out results/rule.json --log logs/rule
//   node bench.js --bot bots/llm_v1.js --seeds 1-30 --shard 0/5 --out results/llm_v1.s0.json --log logs/llm_v1 --trace traces/llm_v1
//
// --seeds a-b or a,b,c.  --shard k/n plays every n-th seed starting at k (to run several processes in parallel).
'use strict';
const fs = require('fs');
const path = require('path');
const { playGame } = require('./run.js');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; }
function parseSeeds(s) {
  if (/^\d+-\d+$/.test(s)) { const [a, b] = s.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
  return s.split(',').map(Number);
}

const botFile = arg('bot');
let seeds = parseSeeds(arg('seeds', '1-30'));
const shard = arg('shard', '0/1').split('/').map(Number);
seeds = seeds.filter((_, i) => i % shard[1] === shard[0]);
const out = arg('out');
const logDir = arg('log', null);
const traceDir = arg('trace', null);
const bot = require(path.resolve(botFile));

// Resume: seeds already in the output file are not played again.
const rows = out && fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
const done = new Set(rows.map((r) => r.seed));
for (const seed of seeds) {
  if (done.has(seed)) continue;
  if (bot.reset) bot.reset();
  const traceFile = traceDir ? path.join(traceDir, `trace-${seed}.jsonl`) : null;
  if (bot.setTrace) bot.setTrace(traceFile);
  const t0 = Date.now();
  const r = playGame(bot, seed, { log: logDir });
  const row = Object.assign({ bot: path.basename(botFile, '.js') }, r, { ms: Date.now() - t0 }, bot.getStats ? bot.getStats() : {});
  if (row.quotaExhausted) {
    // The API's daily quota ran out mid-game: this game is NOT a real result. Drop it and stop; rerun later to resume.
    if (logDir) fs.rmSync(path.join(logDir, `game-${seed}.jsonl`), { force: true });
    if (traceFile) fs.rmSync(traceFile, { force: true });
    console.error('quota message: ' + (bot.lastError ? bot.lastError() : ''));
    console.error(`DAILY QUOTA reached during seed ${seed}; game discarded. ${rows.length} games saved. Rerun the same command later to resume.`);
    process.exit(3);
  }
  if (row.llmCalls === 0 && row.apiErrors > 0) {
    // The API never answered (bad key, network down): not a real game either. Drop it and stop.
    if (logDir) fs.rmSync(path.join(logDir, `game-${seed}.jsonl`), { force: true });
    if (traceFile) fs.rmSync(traceFile, { force: true });
    console.error('api error: ' + (bot.lastError ? bot.lastError() : '').slice(0, 300));
    console.error(`API unreachable during seed ${seed}; game discarded. ${rows.length} games saved. Fix the key/network and rerun to resume.`);
    process.exit(4);
  }
  rows.push(row);
  console.error(`${row.bot} seed ${seed}: ${r.won ? 'WIN ' : 'loss'} wave ${r.wave} hp ${r.hp} steps ${r.steps} ${(row.ms / 1000).toFixed(1)}s` +
    (row.llmCalls ? ` calls ${row.llmCalls} tok ${row.inputTokens}/${row.outputTokens} $${(row.costUsd || 0).toFixed(3)}` : ''));
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rows, null, 1)); }
}
const wins = rows.filter((r) => r.won).length;
console.log(`${path.basename(botFile)}: ${wins}/${rows.length} wins, avg wave ${(rows.reduce((s, r) => s + r.wave, 0) / rows.length).toFixed(2)}`);
