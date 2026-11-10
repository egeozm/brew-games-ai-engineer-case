// Rule bot (baseline). Greedy one-step improvement with a hand-written bag score (lib/eval.js).
// Each call: look at every legal merge / place / move / buy, simulate it on a copy of the game,
// and take the one that raises the score most. If nothing helps: reroll a little, then fight.
// No LLM, no lookahead beyond one action, deterministic.
'use strict';
const { Game, score, tryAct, bestSpot } = require('./lib/eval.js');

const MAX_REROLLS_PER_WAVE = 3;
const MIN_GAIN = 0.5;          // ignore improvements smaller than this (avoids shuffling items forever)
const MAX_MOVES_PER_WAVE = 6;  // cap on rearranging bag items in one build phase
let waveSeen = -1, rerolls = 0, moves = 0;

function chooseAction(state) {
  if (state.wave !== waveSeen) { waveSeen = state.wave; rerolls = 0; moves = 0; }
  const g = Game.fromState(state);
  const base = score(g);
  let best = null;
  const consider = (action, sc, why) => { if (!best || sc > best.sc) best = { action, sc, why }; };

  // 1. merges
  for (const [a, b] of state.legal.merge) {
    const t = tryAct(g, { type: 'merge', a, b });
    if (t) consider({ type: 'merge', a, b }, score(t.g), `merge #${a}+#${b}`);
  }
  // 2. place stash items
  for (const it of state.stash) {
    const s = bestSpot(g, it.id, 'place');
    if (s) consider(s.action, s.score, `place ${it.kind} #${it.id}`);
  }
  // 3. move bag items (limited per wave)
  if (moves < MAX_MOVES_PER_WAVE) {
    for (const it of state.bag.items) {
      const s = bestSpot(g, it.id, 'move');
      if (s && s.score > base + MIN_GAIN) consider(s.action, s.score - 0.25, `move ${it.kind} #${it.id}`);
    }
  }
  // 4. buy: value of an item = score after buying it and then placing or merging it in the best way.
  // Rule: while the next fight is lost, only buy weapons (or a soldier for a weapon that has none).
  const losingNow = !g.simulate(g.wave, false).won;
  const hasUnpowered = state.bag.items.some((i) => i.role === 'weapon' && !i.powered);
  const hasSoldier = state.bag.items.some((i) => i.role === 'soldier');
  const buyOk = (kind) => {
    if (!losingNow) return true;
    const role = state.catalog[kind].role;
    return role === 'weapon' || (role === 'soldier' && (hasUnpowered || !hasSoldier));
  };
  for (const slot of state.legal.buy) {
    if (!buyOk(state.shop[slot].kind)) continue;
    const t = tryAct(g, { type: 'buy', slot });
    if (!t) continue;
    const id = t.res.id;
    let after = -Infinity;
    const s = bestSpot(t.g, id, 'place');
    if (s) after = s.score;
    for (const [a, b] of t.g.mergePairs()) {
      if (a !== id && b !== id) continue;
      const m = tryAct(t.g, { type: 'merge', a, b });
      if (m) after = Math.max(after, score(m.g));
    }
    const cost = state.shop[slot].cost;
    // small cost penalty so equal gains prefer the cheaper item
    if (after > -Infinity) consider({ type: 'buy', slot }, after - 0.1 * cost, `buy ${state.shop[slot].kind} for ${cost}`);
  }

  if (best && best.sc > base + MIN_GAIN) {
    if (best.action.type === 'move') moves++;
    return { action: best.action, reason: `${best.why} (score ${base.toFixed(1)} -> ${best.sc.toFixed(1)})` };
  }
  // stash full of things we cannot use: sell the cheapest so we can keep buying
  if (state.stash.length >= 3) {
    const cheap = state.stash.slice().sort((a, b) => a.value - b.value)[0];
    return { action: { type: 'sell', id: cheap.id }, reason: `stash full, sell unused ${cheap.kind}` };
  }
  // rescue: losing, a weapon is in the shop but too expensive -> sell a non-weapon to pay for it
  const losing = losingNow;
  if (losing) {
    const want = state.shop.filter((s) => s && !s.affordable && state.catalog[s.kind].role === 'weapon')
      .sort((a, b) => a.cost - b.cost)[0];
    const spare = state.bag.items.concat(state.stash).filter((i) => i.role !== 'weapon' && !(i.role === 'soldier' && i.links > 0))
      .sort((a, b) => b.sellPrice - a.sellPrice)[0];
    if (want && spare && state.gold + spare.sellPrice >= want.cost) {
      return { action: { type: 'sell', id: spare.id }, reason: `losing; sell ${spare.kind} to afford ${want.kind}` };
    }
  }
  // the simulator says we would lose the next fight: keep rerolling while we have gold
  if (losing && state.legal.reroll) {
    rerolls++;
    return { action: { type: 'reroll' }, reason: 'simulator says we lose the next fight, reroll for a better shop' };
  }
  if (state.legal.reroll && rerolls < MAX_REROLLS_PER_WAVE && state.gold >= 4) {
    rerolls++;
    return { action: { type: 'reroll' }, reason: 'nothing in the shop helps, reroll' };
  }
  return { action: { type: 'fight' }, reason: `no improving action, fight (score ${base.toFixed(1)})` };
}

module.exports = { chooseAction };
