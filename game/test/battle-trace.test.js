'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Game = require('../game.js');
const { traceBattle } = require('../ui/battle-trace.js');

function checkBot(botFile, name) {
  const bot = require(path.resolve(__dirname, '..', botFile));
  let fights = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const g = new Game(seed);
    let steps = 0, bad = 0;
    while (!g.over && steps < 1000) {
      steps++;
      const st = g.getState();
      let out;
      try { out = bot.chooseAction(st); } catch (e) { out = { type: 'fight' }; }
      const action = out && out.action && typeof out.action === 'object' ? out.action : out;
      if (action && action.type === 'fight') {
        const t = traceBattle(g.clone());
        const sim = g.simulate();
        fights++;
        assert.strictEqual(t.won, sim.won, `${name} seed ${seed} wave ${g.wave}: won`);
        assert.strictEqual(t.hpAfter, sim.hpAfter, `${name} seed ${seed} wave ${g.wave}: hpAfter`);
        assert.strictEqual(t.ticks, sim.ticks, `${name} seed ${seed} wave ${g.wave}: ticks`);
        assert.strictEqual(t.turns.length, sim.ticks);
        if (t.turns.length) assert.strictEqual(t.turns[t.turns.length - 1].hpAfter, sim.hpAfter);
      }
      const r = g.act(action);
      if (!r.ok) { bad++; if (bad > 25) { g.act({ type: 'fight' }); bad = 0; } } else bad = 0;
    }
    if (!g.over) g.act({ type: 'fight' });
  }
  return fights;
}

test('traceBattle matches simulate() on 50 random games', () => {
  const n = checkBot('bots/random.js', 'random');
  assert.ok(n > 50, 'expected many fights, got ' + n);
});
test('traceBattle matches simulate() on 50 random games', () => {
  const n = checkBot('bots/random.js', 'random');
  assert.ok(n >= 50, 'expected fights, got ' + n);
});
test('traceBattle does not change the game', () => {
  const g = new Game(3);
  const before = JSON.stringify(g.getState());
  traceBattle(g);
  assert.strictEqual(JSON.stringify(g.getState()), before);
});
