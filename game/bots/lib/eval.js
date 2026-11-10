// Shared helpers for the rule bot and the LLM agent: rebuild a game from state, score a bag, enumerate moves.
// Pure functions on top of game.js. Nothing here changes the real game.
'use strict';
const Game = require('../../game.js');

const BOSS_WAVE = 10;

// Damage per tick a bag deals to a given enemy wave, counting armor, hits, cleave and cooldown.
function dpsAgainst(an, info) {
  let dps = 0;
  for (const w of an.weapons) {
    if (!w.powered) continue;
    const perHit = Math.max(1, w.dmg - info.armor);
    dps += (perHit * w.hits * Math.min(w.cleave, Math.max(1, info.count))) / w.cd;
  }
  return dps;
}

// Damage an UNPOWERED weapon would add if a soldier touched it (used as "potential", so buying a
// weapon before its soldier is not worth zero).
function unpoweredPotential(an, info) {
  let p = 0;
  for (const w of an.weapons) {
    if (w.powered) continue;
    p += (Math.max(1, w.dmg - info.armor) * w.hits * Math.min(w.cleave, Math.max(1, info.count))) / w.cd;
  }
  return p;
}

// Soldiers with unused links that still have an empty neighbouring cell: room to grow.
function freeSoldierSlots(g, an) {
  const used = new Map();
  for (const l of an.links) used.set(l.soldier, (used.get(l.soldier) || 0) + 1);
  const occ = g._occupancy();
  const W = g.cfg.gridW, H = g.cfg.gridH;
  let n = 0;
  for (const it of g.items) {
    if (it.loc !== 'bag' || it.kind !== 'soldier') continue;
    const free = g.cfg.soldier.linksPerSoldier - (used.get(it.id) || 0);
    if (free <= 0) continue;
    let empty = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = it.x + dx, y = it.y + dy;
      if (x >= 0 && y >= 0 && x < W && y < H && !occ[y * W + x]) empty++;
    }
    n += Math.min(free, empty);
  }
  return n;
}

// One number for "how good is this bag right now". Higher is better.
//  - winning the next wave (and how much HP is left) dominates,
//  - then damage per tick vs the next enemy and vs the boss (the boss decides the game),
//  - small credit for shields, heals, weapons waiting for a soldier, and soldiers with room to link.
function score(g) {
  const an = g.analyze();
  const next = g.waveInfo(g.wave);
  const boss = g.waveInfo(BOSS_WAVE);
  const sim = g.simulate(g.wave, false);
  let s = 0;
  s += sim.won ? 60 + sim.hpAfter : -sim.enemyHpLeft * 0.2;
  const dNext = dpsAgainst(an, next);
  s += 1.0 * dNext + 1.2 * dpsAgainst(an, boss);
  // defence is only worth much once we can deal damage at all
  s += (dNext > 0 ? 1 : 0.2) * (3 * an.shield + 1.5 * an.heal);
  s += 0.35 * (unpoweredPotential(an, next) + unpoweredPotential(an, boss));
  s += 1.5 * freeSoldierSlots(g, an);
  return s;
}

// Apply an action to a copy of g. Returns {g, res} or null if illegal.
function tryAct(g, action) {
  const c = g.clone();
  const res = c.act(action);
  return res.ok ? { g: c, res } : null;
}

// Best place for a stash item (or best move for a bag item). Returns {action, g, score} or null.
function bestSpot(g, id, type) {
  let best = null;
  for (const [x, y, rot] of g.placementsFor(id)) {
    const a = { type, id, x, y, rot };
    const t = tryAct(g, a);
    if (!t) continue;
    const sc = score(t.g);
    if (!best || sc > best.score + 1e-9) best = { action: a, g: t.g, score: sc };
  }
  return best;
}

module.exports = { Game, score, dpsAgainst, tryAct, bestSpot, BOSS_WAVE };
