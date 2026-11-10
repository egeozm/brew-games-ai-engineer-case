/*
 * Bag Battler - pure, deterministic game logic. No DOM. Works in the browser
 * (global `BagGame`) and in Node (`require('./game.js')`).
 *
 * Every number lives in CONFIG below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BagGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------
  // CONFIG: all tunable numbers in one place.
  // ------------------------------------------------------------------
  const CONFIG = {
    gridW: 5,
    gridH: 5,
    waves: 10,
    startHp: 50,
    maxHp: 50,
    startGold: 12,
    income: { base: 8, perWave: 1.5 },          // income at the start of wave w (w>=2) = base + perWave*(w-1)
    // Unspent gold is NOT lost. It earns interest: `rate` gold per `per` unspent, capped at `cap`.
    interest: { per: 5, rate: 1, cap: 2 },
    shopSize: 3,
    guaranteeSoldier: true,                   // every shop roll has a soldier in slot 0
    rerollCost: 1,
    stashSize: 3,
    sellRefund: 0.5,                          // fraction of the gold paid (all merged copies) returned on sell
    maxLevel: 3,
    levelMult: [1, 1.8, 3.0],                 // stat multiplier per item level (index = level-1)
    soldier: { linksPerSoldier: 2, linksPerWeapon: 2, levelBonus: 0.25 }, // caps per soldier / per weapon; soldier level L: its fires get x(1 + 0.25*(L-1))
    battle: { maxTicks: 60, maxAttackers: 6 },
    // Item catalog. shape = list of [dx, dy] cells at rotation 0.
    items: {
      soldier:   { name: 'Soldier',   glyph: 'S', color: '#4f8cff', role: 'soldier', shape: [[0, 0]], cost: 3, weight: 5 },
      sword:     { name: 'Sword',     glyph: 'W', color: '#c0c7d1', role: 'weapon', shape: [[0, 0], [0, 1]], cost: 4, weight: 4,
                   dmg: 5, hits: 1, cd: 1, cleave: 1, tags: ['blade'] },
      dagger:    { name: 'Dagger',    glyph: 'D', color: '#9ad0ff', role: 'weapon', shape: [[0, 0]], cost: 2, weight: 4,
                   dmg: 2, hits: 2, cd: 1, cleave: 1, tags: ['blade'] },
      hammer:    { name: 'Hammer',    glyph: 'H', color: '#d98c3f', role: 'weapon', shape: [[0, 0], [1, 0], [0, 1], [1, 1]], cost: 7, weight: 2,
                   dmg: 14, hits: 1, cd: 2, cleave: 1, tags: ['heavy'] },
      axe:       { name: 'Axe',       glyph: 'A', color: '#c85a5a', role: 'weapon', shape: [[0, 0], [0, 1], [1, 1]], cost: 6, weight: 3,
                   dmg: 4, hits: 1, cd: 1, cleave: 3, tags: ['heavy'] },
      whetstone: { name: 'Whetstone', glyph: 'w', color: '#8fd18f', role: 'buff', shape: [[0, 0]], cost: 3, weight: 3,
                   boosts: 'blade', flat: 2 },    // adjacent blade weapons: +flat damage per hit (x level mult)
      anvil:     { name: 'Anvil',     glyph: 'a', color: '#b48cd9', role: 'buff', shape: [[0, 0]], cost: 3, weight: 3,
                   boosts: 'heavy', mult: 0.5 },  // adjacent heavy weapons: +50% damage (x level mult)
      shield:    { name: 'Shield',    glyph: 'L', color: '#e0c060', role: 'defense', shape: [[0, 0], [0, 1]], cost: 4, weight: 2,
                   reduce: 2 },                   // reduces damage you take each tick (x level mult)
      herb:      { name: 'Herb',      glyph: 'h', color: '#5fd0a0', role: 'heal', shape: [[0, 0]], cost: 3, weight: 2,
                   heal: 3 },                     // heals after a won wave (x level mult)
    },
    // Enemy types. Value for wave w = floor(base + perWave*(w-1)).
    enemies: {
      normal:  { name: 'Raiders', count: [2, 0.5], hp: [10, 4], dmg: [1, 0.35], armor: [0, 0] },
      armored: { name: 'Armored knights', count: [2, 0.35], hp: [15, 6.5], dmg: [2, 0.4], armor: [2, 0.6] },
      swarm:   { name: 'Swarm', count: [5, 1.0], hp: [4, 1.25], dmg: [1, 0.15], armor: [0, 0] },
      boss:    { name: 'Warlord', count: [1, 0], hp: [200, 0], dmg: [9, 0], armor: [5, 0] },
    },
    wavePool: ['normal', 'armored', 'swarm', 'armored', 'swarm'], // wave types are drawn from this list (seeded)
    bossWave: true,                                               // last wave is always the boss
  };

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function deepMerge(base, over) {
    if (!over) return base;
    for (const k of Object.keys(over)) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') deepMerge(base[k], over[k]);
      else base[k] = over[k];
    }
    return base;
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function rotShape(shape, rot) {
    let cells = shape.map((c) => [c[0], c[1]]);
    for (let r = 0; r < ((rot % 4) + 4) % 4; r++) cells = cells.map(([x, y]) => [-y, x]);
    const mx = Math.min(...cells.map((c) => c[0])), my = Math.min(...cells.map((c) => c[1]));
    cells = cells.map(([x, y]) => [x - mx, y - my]);
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return cells;
  }
  const shapeKey = (cells) => cells.map((c) => c.join(',')).join(';');

  // ------------------------------------------------------------------
  // Game
  // ------------------------------------------------------------------
  class Game {
    constructor(seed, configOverride) {
      this.cfg = configOverride ? deepMerge(clone(CONFIG), configOverride) : CONFIG;
      this.seed = seed >>> 0;
      this.rngState = (this.seed ^ 0x9E3779B9) >>> 0;
      this.hp = this.cfg.startHp;
      this.gold = this.cfg.startGold;
      this.wave = 1;
      this.items = [];
      this.nextId = 1;
      this.shop = [];
      this.over = false;
      this.won = false;
      this.lastBattle = null;
      this.battles = 0;
      // wave types: drawn once from a separate stream so they do not depend on shop luck.
      const wr = mulberry32((this.seed ^ 0x51ED270B) >>> 0);
      this.waveTypes = [];
      for (let w = 1; w <= this.cfg.waves; w++) {
        if (this.cfg.bossWave && w === this.cfg.waves) this.waveTypes.push('boss');
        else if (w === 1) this.waveTypes.push('normal');
        else this.waveTypes.push(this.cfg.wavePool[Math.floor(wr() * this.cfg.wavePool.length)]);
      }
      this._rollShop();
    }

    // ---- rng (state kept in the object so clones stay deterministic) ----
    _rand() {
      this.rngState = (this.rngState + 0x6D2B79F5) | 0;
      let t = Math.imul(this.rngState ^ (this.rngState >>> 15), 1 | this.rngState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    _rollShop() {
      const kinds = Object.keys(this.cfg.items);
      const total = kinds.reduce((s, k) => s + this.cfg.items[k].weight, 0);
      this.shop = [];
      for (let i = 0; i < this.cfg.shopSize; i++) {
        let r = this._rand() * total, pick = kinds[kinds.length - 1];
        for (const k of kinds) { r -= this.cfg.items[k].weight; if (r < 0) { pick = k; break; } }
        if (i === 0 && this.cfg.guaranteeSoldier) pick = 'soldier';
        this.shop.push({ kind: pick, cost: this.cfg.items[pick].cost });
      }
    }

    clone() {
      const g = Object.create(Game.prototype);
      g.cfg = this.cfg; g.seed = this.seed; g.rngState = this.rngState;
      g.hp = this.hp; g.gold = this.gold; g.wave = this.wave;
      g.items = this.items.map((it) => Object.assign({}, it));
      g.nextId = this.nextId;
      g.shop = this.shop.map((s) => (s ? Object.assign({}, s) : null));
      g.over = this.over; g.won = this.won; g.lastBattle = this.lastBattle; g.battles = this.battles;
      g.waveTypes = this.waveTypes;
      return g;
    }

    // Rebuild a game from getState() output (for planners). Future shop rolls and
    // wave types beyond the next wave are NOT known: they are re-drawn from a state-derived seed.
    static fromState(state, configOverride) {
      const g = new Game((state.wave * 7919 + state.gold * 104729 + state.hp * 1299709) >>> 0, configOverride);
      g.hp = state.hp; g.gold = state.gold; g.wave = state.wave;
      g.over = !!state.over; g.won = !!state.won;
      g.items = []; g.nextId = 1;
      const add = (it, loc) => {
        g.items.push({ id: it.id, kind: it.kind, level: it.level, value: it.value, loc, x: it.x, y: it.y, rot: it.rot || 0 });
        g.nextId = Math.max(g.nextId, it.id + 1);
      };
      state.bag.items.forEach((it) => add(it, 'bag'));
      state.stash.forEach((it) => add(it, 'stash'));
      g.shop = state.shop.map((s) => (s ? { kind: s.kind, cost: s.cost } : null));
      g.waveTypes = g.waveTypes.map((t, i) => (i === state.wave - 1 ? state.nextWave.type : (i < state.wave - 1 ? 'normal' : t)));
      if (state.nextWave) g.waveTypes[state.wave - 1] = state.nextWave.type;
      return g;
    }

    // ---- geometry ----
    cellsOf(it, x, y, rot) {
      const def = this.cfg.items[it.kind];
      return rotShape(def.shape, rot === undefined ? it.rot : rot).map(([dx, dy]) => [dx + (x === undefined ? it.x : x), dy + (y === undefined ? it.y : y)]);
    }
    _occupancy(ignoreId) {
      const occ = new Array(this.cfg.gridW * this.cfg.gridH).fill(0);
      for (const it of this.items) {
        if (it.loc !== 'bag' || it.id === ignoreId) continue;
        for (const [cx, cy] of this.cellsOf(it)) occ[cy * this.cfg.gridW + cx] = it.id;
      }
      return occ;
    }
    _fits(it, x, y, rot) {
      const occ = this._occupancy(it.id);
      for (const [cx, cy] of this.cellsOf(it, x, y, rot)) {
        if (cx < 0 || cy < 0 || cx >= this.cfg.gridW || cy >= this.cfg.gridH) return false;
        if (occ[cy * this.cfg.gridW + cx]) return false;
      }
      return true;
    }
    // All legal [x, y, rot] for an item (distinct shapes only).
    placementsFor(id) {
      const it = this._item(id);
      if (!it) return [];
      const out = [];
      const seen = new Set();
      const def = this.cfg.items[it.kind];
      const occ = this._occupancy(it.id);
      for (let rot = 0; rot < 4; rot++) {
        const shp = rotShape(def.shape, rot), key = shapeKey(shp);
        if (seen.has(key)) continue;
        seen.add(key);
        for (let y = 0; y < this.cfg.gridH; y++) for (let x = 0; x < this.cfg.gridW; x++) {
          let ok = true;
          for (const [dx, dy] of shp) {
            const cx = x + dx, cy = y + dy;
            if (cx >= this.cfg.gridW || cy >= this.cfg.gridH || occ[cy * this.cfg.gridW + cx]) { ok = false; break; }
          }
          if (ok) out.push([x, y, rot]);
        }
      }
      return out;
    }
    _item(id) { return this.items.find((i) => i.id === id); }

    // ---- analysis: links, effective stats ----
    /*
     * LINK RULE (deterministic):
     *  - Every soldier-weapon pair that shares an edge (orthogonal touch) can be a LINK.
     *    A pair is one link, however many cell edges it shares.
     *  - A soldier makes at most `linksPerSoldier` (2) links; a weapon takes at most `linksPerWeapon` (2).
     *  - Each link makes the weapon fire once per attack: 2 links = it fires twice.
     *  - When the caps leave a choice, the game picks a MAXIMUM link set (as many links as possible).
     *    Ties: candidate pairs are sorted in reading order (soldier's top-left cell, row first, then column,
     *    ties by id; then the weapon in the same order), and each pair is kept if a maximum set that keeps it
     *    still exists. So the result is the reading-order-first of all maximum link sets.
     */
    analyze() {
      const cfg = this.cfg, W = cfg.gridW;
      const bag = this.items.filter((i) => i.loc === 'bag');
      const cellsMap = new Map();
      const owner = new Array(W * cfg.gridH).fill(0);
      for (const it of bag) { const c = this.cellsOf(it); cellsMap.set(it.id, c); for (const [x, y] of c) owner[y * W + x] = it.id; }
      const nbrs = new Map();
      for (const it of bag) {
        const s = new Set();
        for (const [x, y] of cellsMap.get(it.id)) {
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= cfg.gridH) continue;
            const o = owner[ny * W + nx];
            if (o && o !== it.id) s.add(o);
          }
        }
        nbrs.set(it.id, s);
      }
      const anchorOf = new Map();
      for (const it of bag) {
        const c = cellsMap.get(it.id), my = Math.min(...c.map((q) => q[1]));
        anchorOf.set(it.id, my * 100 + Math.min(...c.filter((q) => q[1] === my).map((q) => q[0])));
      }
      const byAnchor = (a, b) => anchorOf.get(a.id) - anchorOf.get(b.id) || a.id - b.id;
      const soldiers = bag.filter((i) => cfg.items[i.kind].role === 'soldier').sort(byAnchor);
      const weapons = bag.filter((i) => cfg.items[i.kind].role === 'weapon').sort(byAnchor);
      const capS = cfg.soldier.linksPerSoldier, capW = cfg.soldier.linksPerWeapon;
      const links = Game.maxLinks(soldiers.map((s) => s.id), weapons.map((w) => w.id), (s, w) => nbrs.get(s).has(w), capS, capW);
      const linksOfW = new Map();     // weaponId -> [soldierId,...] in reading order
      for (const l of links) { if (!linksOfW.has(l.weapon)) linksOfW.set(l.weapon, []); linksOfW.get(l.weapon).push(l.soldier); }
      const lm = (it) => cfg.levelMult[it.level - 1];
      const wstats = [];
      const fires = [];
      for (const w of weapons) {
        const def = cfg.items[w.kind];
        const sIds = linksOfW.get(w.id) || [];
        let flat = 0, mult = 1;
        for (const nid of nbrs.get(w.id)) {
          const n = this._item(nid), nd = cfg.items[n.kind];
          if (nd.role === 'buff' && def.tags.indexOf(nd.boosts) >= 0) {
            if (nd.flat) flat += nd.flat * lm(n);
            if (nd.mult) mult += nd.mult * lm(n);
          }
        }
        const base = (def.dmg * lm(w) + flat) * mult;
        // one entry per fire; each fire uses the level bonus of its own soldier
        const perFire = sIds.map((sid) => Math.max(1, Math.round(base * (1 + cfg.soldier.levelBonus * (this._item(sid).level - 1)))));
        const common = { id: w.id, kind: w.kind, powered: sIds.length > 0, soldier: sIds[0] || 0, soldiers: sIds, links: sIds.length, firesPerAttack: sIds.length,
          fireDamage: perFire, hits: def.hits, cd: def.cd, cleave: def.cleave };
        const unpoweredDmg = Math.max(1, Math.round(base));
        fires.push({ id: w.id, perFire, common, unpoweredDmg });
      }
      // `weapons` has one entry per FIRE (a weapon with 2 links is listed twice, next to each other), so any
      // loop that fires every powered entry once per tick (simulate(), ui/battle-trace.js) fires it twice.
      // Unpowered weapons are listed once with powered:false.
      for (const f of fires) {
        if (!f.perFire.length) wstats.push(Object.assign({}, f.common, { dmg: f.unpoweredDmg, fire: 0 }));
        else f.perFire.forEach((d, k) => wstats.push(Object.assign({}, f.common, { dmg: d, soldier: f.common.soldiers[k], fire: k + 1 })));
      }
      let shield = 0, heal = 0;
      for (const it of bag) {
        const d = cfg.items[it.kind];
        if (d.role === 'defense') shield += d.reduce * lm(it);
        if (d.role === 'heal') heal += d.heal * lm(it);
      }
      return { weapons: wstats, shield: Math.round(shield), heal: Math.round(heal), links };
    }

    // ---- enemies / battle ----
    waveInfo(w) {
      const type = this.waveTypes[w - 1];
      const e = this.cfg.enemies[type];
      const f = (p) => Math.floor(p[0] + p[1] * (w - 1));
      return { type, name: e.name, count: f(e.count), hp: f(e.hp), dmg: f(e.dmg), armor: f(e.armor) };
    }

    // Pure simulation of the current bag against wave `w` (default: current wave). Does not change the game.
    simulate(w, withLog, startHp) {
      const info = this.waveInfo(w === undefined ? this.wave : w);
      const an = this.analyze();
      const weapons = an.weapons.filter((x) => x.powered);
      const enemies = [];
      for (let i = 0; i < info.count; i++) enemies.push(info.hp);
      let alive = enemies.length, hp = startHp === undefined ? this.hp : startHp;
      const log = withLog ? [] : null;
      const bt = this.cfg.battle;
      let tick = 0, taken = 0;
      if (log) log.push(`Wave ${w === undefined ? this.wave : w}: ${info.count} x ${info.name} (hp ${info.hp}, dmg ${info.dmg}, armor ${info.armor}). Powered weapons: ${new Set(weapons.map((x) => x.id)).size}, fires per attack: ${weapons.length}.`);
      // enemies[] holds hp of each enemy in order; dead ones are 0. "front" = first alive.
      let front = 0;
      while (tick < bt.maxTicks && alive > 0 && hp > 0) {
        tick++;
        let dealt = 0, killed = 0;
        for (const wp of weapons) {
          if ((tick - 1) % wp.cd !== 0) continue;
          for (let h = 0; h < wp.hits; h++) {
            let n = 0, i = front;
            while (n < wp.cleave && i < enemies.length) {
              if (enemies[i] > 0) {
                const d = Math.max(1, wp.dmg - info.armor);
                dealt += Math.min(d, enemies[i]);
                enemies[i] -= d;
                if (enemies[i] <= 0) { enemies[i] = 0; alive--; killed++; }
                n++;
              }
              i++;
            }
            while (front < enemies.length && enemies[front] <= 0) front++;
          }
        }
        let hit = 0;
        if (alive > 0) {
          const att = Math.min(bt.maxAttackers, alive);
          hit = Math.max(0, att * info.dmg - an.shield);
          hp -= hit; taken += hit;
        }
        if (log) log.push(`t${tick}: you dealt ${dealt}, killed ${killed} (${alive} left); you took ${hit} (hp ${Math.max(0, hp)}).`);
      }
      const won = alive === 0 && hp > 0;
      let remaining = 0; for (const e of enemies) remaining += e;
      if (log) log.push(won ? `Victory in ${tick} ticks.` : (hp <= 0 ? 'You were defeated.' : 'Time ran out. You were defeated.'));
      return { won, hpAfter: Math.max(0, hp), taken, ticks: tick, enemiesLeft: alive, enemyHpLeft: remaining, log, heal: an.heal };
    }

    // ---- actions ----
    act(a) {
      if (this.over) return { ok: false, error: 'game is over' };
      if (!a || typeof a !== 'object') return { ok: false, error: 'action must be an object' };
      const fn = this['_a_' + a.type];
      if (!fn || a.type[0] === '_') return { ok: false, error: 'unknown action type: ' + a.type };
      return fn.call(this, a);
    }

    _a_buy(a) {
      const s = this.shop[a.slot];
      if (!s) return { ok: false, error: 'no item in that shop slot' };
      if (this.gold < s.cost) return { ok: false, error: 'not enough gold' };
      if (this.items.filter((i) => i.loc === 'stash').length >= this.cfg.stashSize) return { ok: false, error: 'stash is full' };
      this.gold -= s.cost;
      const id = this.nextId++;
      this.items.push({ id, kind: s.kind, level: 1, value: s.cost, loc: 'stash', x: 0, y: 0, rot: 0 });
      this.shop[a.slot] = null;
      return { ok: true, id };
    }
    _a_place(a) {
      const it = this._item(a.id);
      if (!it) return { ok: false, error: 'no such item' };
      if (it.loc !== 'stash') return { ok: false, error: 'item is already in the bag (use move)' };
      const rot = (a.rot | 0) & 3;
      if (!this._fits(it, a.x, a.y, rot)) return { ok: false, error: 'does not fit there' };
      it.loc = 'bag'; it.x = a.x; it.y = a.y; it.rot = rot;
      return { ok: true };
    }
    _a_move(a) {
      const it = this._item(a.id);
      if (!it || it.loc !== 'bag') return { ok: false, error: 'item is not in the bag' };
      const rot = a.rot === undefined ? it.rot : (a.rot | 0) & 3;
      if (!this._fits(it, a.x, a.y, rot)) return { ok: false, error: 'does not fit there' };
      it.x = a.x; it.y = a.y; it.rot = rot;
      return { ok: true };
    }
    _a_rotate(a) {
      const it = this._item(a.id);
      if (!it) return { ok: false, error: 'no such item' };
      const rot = (it.rot + 1) & 3;
      if (it.loc === 'stash') { it.rot = rot; return { ok: true }; }
      if (!this._fits(it, it.x, it.y, rot)) return { ok: false, error: 'rotated item does not fit' };
      it.rot = rot;
      return { ok: true };
    }
    _a_unplace(a) {
      const it = this._item(a.id);
      if (!it || it.loc !== 'bag') return { ok: false, error: 'item is not in the bag' };
      if (this.items.filter((i) => i.loc === 'stash').length >= this.cfg.stashSize) return { ok: false, error: 'stash is full' };
      it.loc = 'stash';
      return { ok: true };
    }
    _a_sell(a) {
      const it = this._item(a.id);
      if (!it) return { ok: false, error: 'no such item' };
      const refund = Math.max(1, Math.floor(it.value * this.cfg.sellRefund));
      this.gold += refund;
      this.items = this.items.filter((i) => i.id !== it.id);
      return { ok: true, refund };
    }
    _a_merge(a) {
      const x = this._item(a.a), y = this._item(a.b);
      if (!x || !y || x.id === y.id) return { ok: false, error: 'need two different items' };
      if (x.kind !== y.kind) return { ok: false, error: 'items are different kinds' };
      if (x.level !== y.level) return { ok: false, error: 'items are different levels' };
      if (x.level >= this.cfg.maxLevel) return { ok: false, error: 'already max level' };
      // keep the one that sits in the bag (a first); shape never changes, so it always fits.
      const keep = x.loc === 'bag' ? x : (y.loc === 'bag' ? y : x), drop = keep === x ? y : x;
      keep.level++; keep.value += drop.value;
      this.items = this.items.filter((i) => i.id !== drop.id);
      return { ok: true, id: keep.id, level: keep.level };
    }
    _a_reroll() {
      if (this.gold < this.cfg.rerollCost) return { ok: false, error: 'not enough gold' };
      this.gold -= this.cfg.rerollCost;
      this._rollShop();
      return { ok: true };
    }
    _a_fight() {
      const w = this.wave;
      const res = this.simulate(w, true);
      this.battles++;
      this.hp = res.hpAfter;
      const info = this.waveInfo(w);
      this.lastBattle = { wave: w, type: info.type, won: res.won, ticks: res.ticks, hpAfter: res.hpAfter, log: res.log };
      if (!res.won) { this.over = true; this.won = false; return { ok: true, won: false, over: true }; }
      this.hp = Math.min(this.cfg.maxHp, this.hp + res.heal);
      if (w >= this.cfg.waves) { this.over = true; this.won = true; return { ok: true, won: true, over: true }; }
      const ic = this.cfg.interest;
      const interest = Math.min(ic.cap, Math.floor(this.gold / ic.per) * ic.rate);
      this.wave = w + 1;
      const income = Math.floor(this.cfg.income.base + this.cfg.income.perWave * (this.wave - 1));
      this.gold += interest + income;
      this._rollShop();
      return { ok: true, won: true, over: false, interest, income };
    }

    // ---- queries ----
    mergePairs() {
      const out = [];
      for (let i = 0; i < this.items.length; i++) for (let j = i + 1; j < this.items.length; j++) {
        const a = this.items[i], b = this.items[j];
        if (a.kind === b.kind && a.level === b.level && a.level < this.cfg.maxLevel) out.push([a.id, b.id]);
      }
      return out;
    }

    getState() {
      const cfg = this.cfg;
      const an = this.analyze();
      const effOf = new Map();
      for (const w of an.weapons) if (!effOf.has(w.id)) effOf.set(w.id, w);
      const soldierLinks = new Map();
      for (const l of an.links) soldierLinks.set(l.soldier, (soldierLinks.get(l.soldier) || 0) + 1);
      const describe = (it) => {
        const def = cfg.items[it.kind];
        const o = { id: it.id, kind: it.kind, level: it.level, value: it.value, role: def.role, sellPrice: Math.max(1, Math.floor(it.value * cfg.sellRefund)), rot: it.rot };
        if (it.loc === 'bag') { o.x = it.x; o.y = it.y; o.cells = this.cellsOf(it); }
        else o.cells = rotShape(def.shape, it.rot);
        const e = effOf.get(it.id);
        if (e) {
          o.powered = e.powered; o.poweredBy = e.soldier || null; o.linkedSoldiers = e.soldiers.slice(); o.links = e.links; o.firesPerAttack = e.firesPerAttack;
          o.damage = e.dmg; o.fireDamage = e.fireDamage.slice(); o.hits = e.hits; o.cooldown = e.cd; o.cleave = e.cleave;
        }
        if (def.role === 'soldier' && it.loc === 'bag') o.links = soldierLinks.get(it.id) || 0;
        return o;
      };
      const bagItems = this.items.filter((i) => i.loc === 'bag').map(describe);
      const stash = this.items.filter((i) => i.loc === 'stash').map(describe);
      const grid = [];
      for (let y = 0; y < cfg.gridH; y++) grid.push(new Array(cfg.gridW).fill(0));
      for (const it of bagItems) for (const [x, y] of it.cells) grid[y][x] = it.id;
      const shop = this.shop.map((s, slot) => (s ? { slot, kind: s.kind, cost: s.cost, affordable: this.gold >= s.cost } : null));
      const stashFull = stash.length >= cfg.stashSize;
      const legal = {
        buy: this.over ? [] : shop.filter((s) => s && s.affordable && !stashFull).map((s) => s.slot),
        reroll: !this.over && this.gold >= cfg.rerollCost,
        fight: !this.over,
        place: {},
        merge: this.mergePairs(),
        sell: this.items.map((i) => i.id),
        unplace: stashFull ? [] : bagItems.map((i) => i.id),
      };
      for (const it of stash) legal.place[it.id] = this.placementsFor(it.id);
      const nextWave = this.over ? null : this.waveInfo(this.wave);
      return {
        over: this.over, won: this.won,
        wave: this.wave, totalWaves: cfg.waves,
        hp: this.hp, maxHp: cfg.maxHp, gold: this.gold,
        nextWave,
        income: { nextRoundBase: Math.floor(cfg.income.base + cfg.income.perWave * this.wave), interestPer: cfg.interest.per, interestCap: cfg.interest.cap },
        rerollCost: cfg.rerollCost,
        shop, stash,
        bag: { width: cfg.gridW, height: cfg.gridH, items: bagItems, grid },
        links: an.links,
        shield: an.shield, heal: an.heal,
        legal,
        lastBattle: this.lastBattle ? { wave: this.lastBattle.wave, type: this.lastBattle.type, won: this.lastBattle.won, hpAfter: this.lastBattle.hpAfter, log: this.lastBattle.log } : null,
        catalog: Game.catalog(cfg),
      };
    }

    static catalog(cfg) {
      cfg = cfg || CONFIG;
      const out = {};
      for (const k of Object.keys(cfg.items)) {
        const d = cfg.items[k];
        const o = { name: d.name, role: d.role, cost: d.cost, shape: d.shape };
        for (const f of ['dmg', 'hits', 'cd', 'cleave', 'tags', 'boosts', 'flat', 'mult', 'reduce', 'heal']) if (d[f] !== undefined) o[f] = d[f];
        out[k] = o;
      }
      return out;
    }

    // Short plain-text view for LLM prompts.
    toText() {
      const s = this.getState(), cfg = this.cfg;
      const L = [];
      L.push(`WAVE ${s.wave}/${s.totalWaves}  HP ${s.hp}/${s.maxHp}  GOLD ${s.gold}${s.over ? (s.won ? '  [YOU WON]' : '  [YOU LOST]') : ''}`);
      if (s.nextWave) L.push(`NEXT ENEMY: ${s.nextWave.count} x ${s.nextWave.type} (hp ${s.nextWave.hp}, dmg ${s.nextWave.dmg}, armor ${s.nextWave.armor})`);
      L.push('SHOP (reroll costs ' + s.rerollCost + '):');
      s.shop.forEach((x, i) => L.push(`  [${i}] ` + (x ? `${x.kind} cost ${x.cost}${x.affordable ? '' : ' (too expensive)'}` : '(bought)')));
      L.push('STASH: ' + (s.stash.length ? s.stash.map((i) => `#${i.id} ${i.kind} L${i.level}`).join(', ') : '(empty)'));
      L.push(`BAG (x across, y down; number = item id). LINKS ${s.links.length}: ` + (s.links.length ? s.links.map((l) => `#${l.soldier}-#${l.weapon}`).join(' ') : 'none'));
      for (let y = 0; y < s.bag.height; y++) L.push('  ' + s.bag.grid[y].map((v) => (v ? String(v).padStart(2, ' ') : ' .')).join(' '));
      for (const it of s.bag.items) {
        let d = `  #${it.id} ${it.kind} L${it.level} at (${it.x},${it.y}) rot ${it.rot}`;
        if (it.role === 'weapon') d += it.powered ? `  LINKS ${it.links}/${cfg.soldier.linksPerWeapon} (soldier ${it.linkedSoldiers.map((x) => '#' + x).join(', ')}), fires ${it.firesPerAttack}x per attack, dmg ${it.fireDamage.join('/')} x${it.hits} hits${it.cooldown > 1 ? ', every ' + it.cooldown + ' ticks' : ''}${it.cleave > 1 ? ', hits ' + it.cleave + ' enemies' : ''}` : '  NOT POWERED, 0 links (needs a touching soldier with a free link)';
        if (it.role === 'soldier') d += `  LINKS ${it.links}/${cfg.soldier.linksPerSoldier}`;
        L.push(d);
      }
      if (s.shield) L.push(`SHIELD: you take ${s.shield} less damage per tick`);
      if (s.heal) L.push(`HEAL after a won wave: ${s.heal}`);
      if (s.legal.merge.length) L.push('MERGES: ' + s.legal.merge.map((p) => `#${p[0]}+#${p[1]}`).join(', '));
      L.push('ACTIONS: buy{slot}, place{id,x,y,rot}, move{id,x,y,rot}, rotate{id}, unplace{id}, sell{id}, merge{a,b}, reroll, fight');
      if (s.lastBattle) L.push(`LAST BATTLE (wave ${s.lastBattle.wave}): ${s.lastBattle.won ? 'won' : 'lost'}, hp after ${s.lastBattle.hpAfter}`);
      return L.join('\n');
    }
  }

  // Maximum soldier-weapon link set with caps, reading-order-first among all maximum sets.
  // soldierIds / weaponIds must already be in reading order. touches(s, w) -> bool.
  Game.maxLinks = function (soldierIds, weaponIds, touches, capS, capW) {
    const edges = [];
    for (const s of soldierIds) for (const w of weaponIds) if (touches(s, w)) edges.push([s, w]);
    if (!edges.length) return [];
    const degS = new Map(), degW = new Map();
    for (const [s, w] of edges) { degS.set(s, (degS.get(s) || 0) + 1); degW.set(w, (degW.get(w) || 0) + 1); }
    let easy = true;
    for (const d of degS.values()) if (d > capS) easy = false;
    for (const d of degW.values()) if (d > capW) easy = false;
    if (easy) return edges.map(([s, w]) => ({ soldier: s, weapon: w }));   // no cap binds: every touch is a link
    // max flow (augmenting paths) on the undecided edges, with left capacities
    const flow = (cand, leftS, leftW) => {
      const usedS = new Map(), usedW = new Map(), match = new Map(); // weapon -> [edge idx]
      const on = new Array(cand.length).fill(false);
      let total = 0;
      const tryS = (s, seen) => {
        for (let k = 0; k < cand.length; k++) {
          if (on[k] || cand[k][0] !== s) continue;
          const w = cand[k][1];
          if (seen.has(w)) continue;
          seen.add(w);
          if ((usedW.get(w) || 0) < (leftW.get(w) || 0)) { on[k] = true; usedW.set(w, (usedW.get(w) || 0) + 1); return true; }
          for (let j = 0; j < cand.length; j++) {
            if (!on[j] || cand[j][1] !== w) continue;
            const s2 = cand[j][0];
            on[j] = false;
            if (s2 !== s && tryS(s2, seen)) { on[k] = true; return true; }
            if (s2 === s) { on[j] = true; continue; }
            on[j] = true;
          }
        }
        return false;
      };
      for (const s of soldierIds) {
        for (let c = (usedS.get(s) || 0); c < (leftS.get(s) || 0); c++) {
          if (tryS(s, new Set())) { usedS.set(s, (usedS.get(s) || 0) + 1); total++; } else break;
        }
      }
      return total;
    };
    const leftS = new Map(soldierIds.map((s) => [s, capS])), leftW = new Map(weaponIds.map((w) => [w, capW]));
    let undecided = edges.slice();
    const best = flow(undecided, leftS, leftW);
    const chosen = [];
    while (undecided.length) {
      const [s, w] = undecided.shift();
      if ((leftS.get(s) || 0) <= 0 || (leftW.get(w) || 0) <= 0) continue;
      leftS.set(s, leftS.get(s) - 1); leftW.set(w, leftW.get(w) - 1);
      if (chosen.length + 1 + flow(undecided, leftS, leftW) === best) chosen.push([s, w]);
      else { leftS.set(s, leftS.get(s) + 1); leftW.set(w, leftW.get(w) + 1); }
    }
    return chosen.map(([s, w]) => ({ soldier: s, weapon: w }));
  };

  Game.CONFIG = CONFIG;
  Game.rotShape = rotShape;
  return Game;
});
