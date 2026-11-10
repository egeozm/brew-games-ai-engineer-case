#!/usr/bin/env node
// Usage: node run.js --bot bots/random.js --games 200 --seed 1 [--seeds file.txt] [--log dir] [--verbose]
// A bot may return an action, or {action, reason}. --log writes dir/game-<seed>.jsonl: {step,state,action,reason} per line.
'use strict';
const path = require('path');
const fs = require('fs');
const Game = require('./game.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

function playGame(bot, seed, opts) {
  opts = opts || {};
  const g = new Game(seed);
  let steps = 0, bad = 0, errors = 0;
  const lines = [];
  const slim = (st) => { const c = Object.assign({}, st); delete c.catalog; return c; };
  while (!g.over && steps < 1000) {
    steps++;
    let action, reason = null;
    const st = g.getState();
    try {
      const out = bot.chooseAction(st);
      if (out && out.action && typeof out.action === 'object') { action = out.action; reason = out.reason == null ? null : String(out.reason); } else action = out;
    } catch (e) { errors++; if (opts.verbose) console.error('bot threw:', e.message); action = { type: 'fight' }; reason = 'bot threw: ' + e.message; }
    if (opts.log) lines.push(JSON.stringify({ step: steps, state: slim(st), action, reason }));
    const r = g.act(action);
    if (!r.ok) { bad++; if (bad > 25) { g.act({ type: 'fight' }); bad = 0; } } else bad = 0;
  }
  if (!g.over) { g.act({ type: 'fight' }); }
  if (opts.log) {
    lines.push(JSON.stringify({ step: steps + 1, state: slim(g.getState()), action: null, reason: null }));
    fs.mkdirSync(opts.log, { recursive: true });
    fs.writeFileSync(path.join(opts.log, 'game-' + seed + '.jsonl'), lines.join('\n') + '\n');
  }
  return { seed, won: g.won, wave: g.wave, hp: g.hp, steps, errors };
}

function main() {
  const botFile = arg('bot', 'bots/random.js');
  const seedsFile = arg('seeds', null);
  let seeds;
  if (seedsFile && seedsFile !== true) {
    seeds = fs.readFileSync(seedsFile, 'utf8').split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 10));
    if (arg('games', null)) seeds = seeds.slice(0, parseInt(arg('games'), 10));
  } else {
    const n = parseInt(arg('games', 20), 10), s0 = parseInt(arg('seed', 1), 10);
    seeds = Array.from({ length: n }, (_, i) => s0 + i);
  }
  const games = seeds.length, seed = seeds[0];
  const logDir = arg('log', null);
  const bot = require(path.resolve(botFile));
  const res = [];
  for (const sd of seeds) res.push(playGame(bot, sd, { verbose: !!arg('verbose', false), log: logDir && logDir !== true ? logDir : null }));
  const wins = res.filter((r) => r.won).length;
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const summary = {
    bot: botFile, games, firstSeed: seed,
    winRate: +(wins / games).toFixed(3),
    avgWavesReached: +avg(res.map((r) => r.wave)).toFixed(2),
    avgFinalHp: +avg(res.map((r) => r.hp)).toFixed(2),
    avgFinalHpOfWins: +avg(res.filter((r) => r.won).map((r) => r.hp)).toFixed(2),
    botErrors: res.reduce((s, r) => s + r.errors, 0),
  };
  console.log(JSON.stringify(summary));
  console.log('');
  const name = path.basename(botFile);
  console.log('bot'.padEnd(16) + 'games'.padEnd(7) + 'win%'.padEnd(8) + 'waves'.padEnd(8) + 'finalHP'.padEnd(9) + 'winHP');
  console.log(name.padEnd(16) + String(games).padEnd(7) + (summary.winRate * 100).toFixed(1).padEnd(8) + String(summary.avgWavesReached).padEnd(8) + String(summary.avgFinalHp).padEnd(9) + summary.avgFinalHpOfWins);
  if (arg('per-game', false)) console.log(JSON.stringify(res));
}
if (require.main === module) main();
module.exports = { playGame };
