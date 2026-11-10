// Example bot: plays random legal actions. A bot exports chooseAction(state) -> action.
'use strict';
let seed = 12345;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];

// Seeded from the state, so the same game state always gives the same choice.
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }

function pickAction(state) {
  seed = hash(JSON.stringify(state));
  const L = state.legal;
  const options = [];
  if (L.buy.length) options.push({ type: 'buy', slot: pick(L.buy) });
  for (const id of Object.keys(L.place)) {
    const spots = L.place[id];
    if (spots.length) { const [x, y, rot] = pick(spots); options.push({ type: 'place', id: +id, x, y, rot }); }
  }
  if (L.merge.length) options.push({ type: 'merge', a: pick(L.merge)[0], b: pick(L.merge)[1] });
  if (L.reroll && rnd() < 0.3) options.push({ type: 'reroll' });
  if (state.stash.length === 0 && rnd() < 0.25) options.push({ type: 'fight' });
  if (options.length === 0 || rnd() < 0.1) return { type: 'fight' };
  return pick(options);
};

// A bot may return a bare action or {action, reason}. The reason is saved in the run.js log.
exports.chooseAction = function (state) {
  const action = pickAction(state);
  return { action, reason: 'random legal ' + action.type };
};
