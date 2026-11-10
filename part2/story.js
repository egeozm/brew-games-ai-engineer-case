#!/usr/bin/env node
// Turn one LLM game (trace + run.js log) into a readable story for error analysis.
//   node part2/story.js llm_v1 7            -> prints the story of seed 7
//   node part2/story.js llm_v1 7 --out f.md
// Reads game/traces/<bot>/trace-<seed>.jsonl and game/logs/<bot>/game-<seed>.jsonl.
'use strict';
const fs = require('fs');
const path = require('path');
const GAME = path.join(__dirname, '..', 'game');
const Game = require(path.join(GAME, 'game.js'));

const [bot, seedS] = process.argv.slice(2);
const seed = Number(seedS);
const outI = process.argv.indexOf('--out');
const readJsonl = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const trace = readJsonl(path.join(GAME, 'traces', bot, `trace-${seed}.jsonl`));
const log = readJsonl(path.join(GAME, 'logs', bot, `game-${seed}.jsonl`));

const g = new Game(seed);
const L = [];
const final = log[log.length - 1].state;
L.push(`# ${bot}, seed ${seed}: ${final.won ? 'WON' : `LOST in wave ${final.wave}`} (final HP ${final.hp})`);
L.push(`Wave types: ${g.waveTypes.map((t, i) => `${i + 1}:${t}`).join(' ')}`);

// bag at the end of each build phase (= state right before each fight action)
const fights = log.filter((r) => r.action && r.action.type === 'fight');
const bagText = (st) => st.bag.grid.map((row) => '    ' + row.map((v) => (v ? String(v).padStart(2) : ' .')).join(' ')).join('\n') + '\n' +
  st.bag.items.map((it) => `    #${it.id} ${it.kind} L${it.level}${it.role === 'weapon' ? (it.powered ? ` links ${it.links} dmg ${it.fireDamage.join('/')}` : ' NOT POWERED') : ''}`).join('\n');

for (let w = 1; w <= final.wave; w++) {
  L.push(`\n## Wave ${w} (${g.waveTypes[w - 1]})`);
  for (const e of trace.filter((x) => x.wave === w)) {
    if (e.t === 'call') {
      for (const c of e.calls || []) {
        const inp = c.input || {};
        L.push(`- **${c.name}** ${inp.reason ? `_"${inp.reason}"_` : ''} ${c.name === 'act' ? '`' + JSON.stringify(inp.actions) + '`' : ''}`);
      }
      if (e.thoughts) L.push(`  - thinking: ${e.thoughts.replace(/\s+/g, ' ').slice(0, 400)}`);
    } else if (e.t === 'illegal') L.push(`  - ILLEGAL \`${JSON.stringify(e.action)}\`: ${e.error}`);
    else if (e.t === 'forced_fight') L.push(`  - FORCED FIGHT (call/action cap)`);
    else if (e.t === 'api_error') L.push(`  - API ERROR: ${String(e.error).slice(0, 150)}`);
  }
  const f = fights.find((r) => r.state.wave === w);
  if (f) {
    const st = f.state;
    L.push(`- bag at fight (gold left ${st.gold}, HP ${st.hp}, shield ${st.shield}, heal ${st.heal}):\n${bagText(st)}`);
    const sim = Game.fromState(st).simulate(w, false);
    L.push(`- battle: ${sim.won ? 'won' : 'LOST'} in ${sim.ticks} ticks, HP ${st.hp} -> ${sim.hpAfter}${sim.won ? '' : `, enemies left ${sim.enemiesLeft} (${sim.enemyHpLeft} HP)`}`);
  }
}
const text = L.join('\n');
if (outI > 0) fs.writeFileSync(process.argv[outI + 1], text + '\n'); else console.log(text);
