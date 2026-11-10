#!/usr/bin/env node
// Count mistake patterns in every game of a bot, from the run.js logs (+ traces for illegal actions).
// Complements the manual reading of 5 lost games: the reading explains WHY, this counts HOW OFTEN.
//   node part2/mistakes.js llm_v1 [rule ...]     -> prints a table, writes part2/out/mistakes_<bot>.json
//
// Checks made on the bag at the moment the bot pressed "fight" (one row per build phase):
//   unpowered_weapon   a weapon in the bag with 0 links (paid for, does nothing)
//   idle_soldier       a soldier in the bag with 0 links
//   useless_buff       whetstone not touching a blade / anvil not touching a heavy weapon
//   fought_known_loss  the simulator says this fight is lost, and it fought anyway (true for the last wave of
//                      EVERY lost game, since the simulator is exact; a symptom, not a cause)
//   blind_losing_fight fought a lost battle via then_fight, without ever seeing the preview
//   soldier_merge      merged two soldiers that were both placed in the bag (removes a placed soldier and its links)
//   illegal_actions    actions the game refused (from the agent trace)
'use strict';
const fs = require('fs');
const path = require('path');
const GAME = path.join(__dirname, '..', 'game');
const Game = require(path.join(GAME, 'game.js'));

const readJsonl = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const BLADE = new Set(['sword', 'dagger']), HEAVY = new Set(['hammer', 'axe']);

function analyzeGame(bot, seed) {
  const log = readJsonl(path.join(GAME, 'logs', bot, `game-${seed}.jsonl`));
  const trace = readJsonl(path.join(GAME, 'traces', bot, `trace-${seed}.jsonl`));
  const final = log[log.length - 1].state;
  const waves = [];
  for (const r of log) {
    if (!r.action || r.action.type !== 'fight') continue;
    const st = r.state, w = st.wave;
    const items = st.bag.items;
    const byId = new Map(items.map((i) => [i.id, i]));
    const nb = (it) => {  // ids of items touching it
      const cells = new Set(it.cells.map((c) => c.join(',')));
      const out = new Set();
      for (const [x, y] of it.cells) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${x + dx},${y + dy}`;
        if (cells.has(k)) continue;
        const v = st.bag.grid[y + dy] && st.bag.grid[y + dy][x + dx];
        if (v) out.add(v);
      }
      return [...out].map((id) => byId.get(id));
    };
    const unpowered = items.filter((i) => i.role === 'weapon' && !i.powered).length;
    const idle = items.filter((i) => i.role === 'soldier' && !i.links).length;
    const useless = items.filter((i) => (i.kind === 'whetstone' && !nb(i).some((n) => BLADE.has(n.kind))) ||
      (i.kind === 'anvil' && !nb(i).some((n) => HEAVY.has(n.kind)))).length;
    const sim = Game.fromState(st).simulate(w, false);
    // merging two soldiers that are BOTH already placed removes one placed soldier (and its links);
    // merging a newly bought (stash) soldier into a placed one is fine, so it is not counted
    const soldierMerges = log.filter((x) => x.state.wave === w && x.action && x.action.type === 'merge' &&
      [x.action.a, x.action.b].every((id) => x.state.bag.items.some((i) => i.id === Number(id) && i.kind === 'soldier'))).length;
    const illegal = trace.filter((e) => e.t === 'illegal' && e.wave === w).length;
    waves.push({ wave: w, type: st.nextWave.type, unpowered_weapon: unpowered, idle_soldier: idle, useless_buff: useless,
      fought_known_loss: sim.won ? 0 : 1,
      blind_losing_fight: !sim.won && /\(then fight\)$/.test(r.reason || '') ? 1 : 0,   // used then_fight, never looked at the preview
      soldier_merge: soldierMerges, illegal_actions: illegal, gold_left: st.gold, hp: st.hp });
  }
  return { seed, won: final.won, lostWave: final.won ? null : final.wave, waves };
}

function trace_illegal(bot, seed, wave) {
  return readJsonl(path.join(GAME, 'traces', bot, `trace-${seed}.jsonl`)).filter((e) => e.t === 'illegal' && e.wave === wave).length;
}

function main() {
  const bots = process.argv.slice(2);
  const out = {};
  const keys = ['unpowered_weapon', 'idle_soldier', 'useless_buff', 'fought_known_loss', 'blind_losing_fight', 'soldier_merge', 'illegal_actions'];
  console.log('bot'.padEnd(10) + 'games  ' + keys.map((k) => k.padEnd(18)).join('') + '  (share of build phases with >=1 / total count)');
  for (const bot of bots) {
    const dir = path.join(GAME, 'logs', bot);
    const seeds = fs.readdirSync(dir).map((f) => Number((f.match(/game-(\d+)\.jsonl/) || [])[1])).filter(Boolean).sort((a, b) => a - b);
    const games = seeds.map((s) => analyzeGame(bot, s));
    const phases = games.flatMap((g) => g.waves);
    const lostGames = games.filter((g) => !g.won);
    const lastPhase = lostGames.map((g) => g.waves[g.waves.length - 1]).filter(Boolean);
    const summary = {};
    for (const k of keys) {
      summary[k] = {
        phases_with: phases.filter((p) => p[k] > 0).length, total: phases.reduce((s, p) => s + p[k], 0),
        lost_games_with_any: lostGames.filter((g) => g.waves.some((p) => p[k] > 0)).length,
        in_losing_phase: lastPhase.filter((p) => p[k] > 0).length,
      };
    }
    // The build phase that lost each game: what did the bag and the decision look like?
    const losing = lostGames.map((g) => {
      const log = readJsonl(path.join(GAME, 'logs', bot, `game-${g.seed}.jsonl`));
      const f = log.filter((x) => x.action && x.action.type === 'fight').pop();
      const st = f.state, W = st.bag.items.filter((i) => i.role === 'weapon');
      return { seed: g.seed, wave: st.wave, type: st.nextWave.type, hp: st.hp, gold: st.gold,
        no_weapon: W.length === 0, only_unpowered: W.length > 0 && !W.some((i) => i.powered),
        blind: /\(then fight\)$/.test(f.reason || ''), forced: /^\[cap\]/.test(f.reason || ''), gold_5plus: st.gold >= 5,
        illegal_in_wave: trace_illegal(bot, g.seed, st.wave) };
    });
    const losingSummary = {
      blind_fight_into_loss: losing.filter((x) => x.blind).length,
      no_working_weapon: losing.filter((x) => x.no_weapon || x.only_unpowered).length,
      gold_5plus_unspent: losing.filter((x) => x.gold_5plus).length,
      forced_by_call_cap: losing.filter((x) => x.forced).length,
      illegal_action_in_losing_wave: losing.filter((x) => x.illegal_in_wave > 0).length,
    };
    console.log(''.padEnd(17) + 'losing wave: ' + JSON.stringify(losingSummary));
    out[bot] = { games: games.length, phases: phases.length, lost: lostGames.length, summary, losingSummary, losing, perGame: games };
    console.log(bot.padEnd(10) + String(games.length).padEnd(7) + keys.map((k) => `${summary[k].phases_with}/${phases.length} (${summary[k].total})`.padEnd(18)).join(''));
    console.log(''.padEnd(17) + keys.map((k) => `lost games: ${summary[k].lost_games_with_any}/${lostGames.length}`.padEnd(18)).join(''));
    fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'out', `mistakes_${bot}.json`), JSON.stringify(out[bot], null, 1));
  }
}
main();
