// Plumbing test for the LLM agent without calling any API: a fake "model" answers through the same
// tool interface (act / preview_fight / fight), choosing actions with the rule bot. If the queueing,
// validation and "last"-id logic are right, it must play exactly like the rule bot.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAgent } = require('../bots/lib/agent.js');
const { playGame } = require('../run.js');
const { Game, tryAct, bestSpot } = require('../bots/lib/eval.js');

function makeRule() {   // fresh copy of the rule bot (it keeps per-wave counters in module scope)
  delete require.cache[require.resolve('../bots/rule.js')];
  return require('../bots/rule.js');
}

function fakeModel(rule) {
  let n = 0, illegalSent = false;
  const wrap = (c) => ({ calls: [{ id: c.id, name: c.name, input: c.input }], text: '', thoughts: '', usage: { in: 0, out: 0, cached: 0 }, model: 'mock' });
  const decide = (state) => {
    n++;
    const id = `toolu_${n}`;
    if (!illegalSent) {  // once per game: an impossible placement, the agent must report it as an error
      illegalSent = true;
      return { content: [{ type: 'tool_use', id, name: 'act', input: { reason: 'bad move on purpose', actions: [{ type: 'place', id: 999, x: 0, y: 0, rot: 0 }] } }] };
    }
    if (n % 7 === 0) return { content: [{ type: 'tool_use', id, name: 'preview_fight', input: {} }] };
    const out = rule.chooseAction(state);
    const a = out.action;
    if (a.type === 'fight') return { content: [{ type: 'tool_use', id, name: 'fight', input: { reason: 'rule says fight' } }] };
    if (a.type === 'buy') {   // buy and place in one act() call using the "last" alias
      const g = Game.fromState(state);
      const t = tryAct(g, a);
      const spot = t && bestSpot(t.g, t.res.id, 'place');
      const acts = [a];
      if (spot && !t.g.mergePairs().some((p) => p.includes(t.res.id))) acts.push(Object.assign({}, spot.action, { id: 'last' }));
      return { content: [{ type: 'tool_use', id, name: 'act', input: { reason: out.reason, actions: acts } }] };
    }
    return { content: [{ type: 'tool_use', id, name: 'act', input: { reason: out.reason, actions: [a] } }] };
  };
  return { name: 'mock', model: 'mock', start() {}, userText() {}, toolResults() {}, call: (state) => wrap(decide(state).content[0]) };
}

test('agent plumbing: fake model through tools wins like the rule bot', () => {
  let agentWins = 0, ruleWins = 0, errorsReported = 0;
  for (let seed = 7001; seed <= 7020; seed++) {
    const agent = createAgent({ name: 'mock', mock: fakeModel(makeRule()) });
    const r = playGame(agent, seed);
    agentWins += r.won ? 1 : 0;
    errorsReported += agent.getStats().illegal;
    ruleWins += playGame(makeRule(), seed).won ? 1 : 0;
  }
  assert.strictEqual(errorsReported, 20, 'every illegal action must be caught and reported');
  assert.ok(Math.abs(agentWins - ruleWins) <= 3, `agent ${agentWins} vs rule ${ruleWins}`);
});

test('agent plumbing: v2 state text (spatial facts) works through the same loop', () => {
  const { renderStateV2 } = require('../bots/lib/state_v2.js');
  let wins = 0;
  for (let seed = 7001; seed <= 7005; seed++) {
    const agent = createAgent({ name: 'mock_v2', mock: fakeModel(makeRule()), renderState: renderStateV2 });
    wins += playGame(agent, seed).won ? 1 : 0;
  }
  assert.ok(wins >= 3, `mock v2 agent won ${wins}/5`);
  const text = renderStateV2(new (require('../game.js'))(1).getState());
  assert.match(text, /SPATIAL FACTS/);
});
