'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Game = require('../game.js');

// helper: put an item straight into the bag (tests only)
function put(g, kind, x, y, rot, level) {
  const id = g.nextId++;
  g.items.push({ id, kind, level: level || 1, value: g.cfg.items[kind].cost, loc: 'bag', x, y, rot: rot || 0 });
  return id;
}
const fresh = () => { const g = new Game(1); g.items = []; return g; };

test('link rule: weapon fires only next to a soldier', () => {
  const g = fresh();
  const s = put(g, 'soldier', 0, 0), w = put(g, 'sword', 1, 0), far = put(g, 'dagger', 4, 4);
  const st = g.getState();
  const by = (id) => st.bag.items.find((i) => i.id === id);
  assert.strictEqual(by(w).powered, true);
  assert.strictEqual(by(w).poweredBy, s);
  assert.strictEqual(by(far).powered, false);
});

test('link rule: diagonal is not adjacent', () => {
  const g = fresh();
  put(g, 'soldier', 0, 0); const w = put(g, 'dagger', 1, 1);
  assert.strictEqual(g.getState().bag.items.find((i) => i.id === w).powered, false);
});

test('link rule: soldier cap 2, the first 2 in reading order win', () => {
  const g = fresh();
  const s = put(g, 'soldier', 1, 1);
  const a = put(g, 'dagger', 1, 0), b = put(g, 'dagger', 0, 1), c = put(g, 'dagger', 2, 1), d = put(g, 'dagger', 1, 2);
  const st = g.getState();
  const p = (id) => st.bag.items.find((i) => i.id === id).powered;
  // reading order (row, then column): a(1,0) and b(0,1) win; c(2,1) and d(1,2) stay dark
  assert.deepStrictEqual([p(a), p(b), p(c), p(d)], [true, true, false, false]);
  assert.strictEqual(st.links.length, 2);
  assert.ok(st.links.every((l) => l.soldier === s));
});

test('link rule: the second soldier takes the weapon the first could not', () => {
  const g = fresh();
  put(g, 'soldier', 1, 1);
  const a = put(g, 'dagger', 1, 0), b = put(g, 'dagger', 0, 1), c = put(g, 'dagger', 2, 1);
  const s2 = put(g, 'soldier', 3, 1);
  const st = g.getState();
  assert.strictEqual(st.bag.items.find((i) => i.id === c).poweredBy, s2);
  assert.ok(st.bag.items.find((i) => i.id === a).powered && st.bag.items.find((i) => i.id === b).powered);
});

test('link rule: 2 soldiers on one weapon = 2 links, it fires twice per attack', () => {
  const g = fresh();
  const s1 = put(g, 'soldier', 0, 0), w = put(g, 'hammer', 1, 0), s2 = put(g, 'soldier', 3, 0);
  const st = g.getState();
  const it = st.bag.items.find((i) => i.id === w);
  assert.strictEqual(it.links, 2);
  assert.strictEqual(it.firesPerAttack, 2);
  assert.deepStrictEqual(it.linkedSoldiers, [s1, s2]);
  assert.strictEqual(it.poweredBy, s1);
  assert.deepStrictEqual(st.links, [{ soldier: s1, weapon: w }, { soldier: s2, weapon: w }]);
  assert.strictEqual(st.bag.items.find((i) => i.id === s1).links, 1);
  // the battle really fires it twice: same bag with one soldier deals half the damage in tick 1
  g.waveTypes[0] = 'boss';
  const two = g.simulate(1, true, 999);
  const h = fresh(); put(h, 'soldier', 0, 0); put(h, 'hammer', 1, 0); h.waveTypes[0] = 'boss';
  const one = h.simulate(1, true, 999);
  const dealt = (r) => +r.log[1].match(/you dealt (\d+)/)[1];
  assert.strictEqual(dealt(two), 2 * dealt(one));
  assert.ok(g.toText().includes('fires 2x per attack'));
});

test('link rule: weapon cap 2, a third touching soldier gets no link', () => {
  const g = fresh();
  const w = put(g, 'dagger', 1, 1);
  const a = put(g, 'soldier', 1, 0), b = put(g, 'soldier', 0, 1), c = put(g, 'soldier', 2, 1);
  const st = g.getState();
  assert.strictEqual(st.bag.items.find((i) => i.id === w).links, 2);
  assert.deepStrictEqual(st.links.map((l) => l.soldier), [a, b]); // reading order
  assert.strictEqual(st.bag.items.find((i) => i.id === c).links, 0);
});

test('link rule: the game picks the MOST links, not the reading-order-greedy set', () => {
  // soldier 1 touches weapons 10, 11, 12; soldiers 2 and 3 touch only weapon 10.
  // Reading-order greedy would give 1-10, 1-11, 2-10 (3 links). The maximum is 4.
  const E = new Set(['1-10', '1-11', '1-12', '2-10', '3-10']);
  const got = Game.maxLinks([1, 2, 3], [10, 11, 12], (s, w) => E.has(s + '-' + w), 2, 2);
  assert.deepStrictEqual(got, [{ soldier: 1, weapon: 11 }, { soldier: 1, weapon: 12 }, { soldier: 2, weapon: 10 }, { soldier: 3, weapon: 10 }]);
});

test('link rule: maxLinks equals brute force (size and reading-order tie break) on 400 random graphs', () => {
  let r = 7; const rnd = () => { r = (r * 1103515245 + 12345) >>> 0; return r / 4294967296; };
  let checked = 0;
  for (let t = 0; t < 600 && checked < 400; t++) {
    const S = [1, 2, 3, 4].slice(0, 1 + Math.floor(rnd() * 4)), W = [11, 12, 13, 14].slice(0, 1 + Math.floor(rnd() * 4));
    const E = new Set(); for (const s of S) for (const w of W) if (rnd() < 0.55) E.add(s + '-' + w);
    const edges = []; for (const s of S) for (const w of W) if (E.has(s + '-' + w)) edges.push([s, w]);
    if (edges.length > 12) continue;
    checked++;
    let best = -1, bestMask = 0;
    for (let m = 0; m < (1 << edges.length); m++) {
      const deg = new Map(); let ok = true, n = 0;
      for (let k = 0; k < edges.length; k++) if ((m >> k) & 1) { n++; for (const v of edges[k]) { deg.set(v, (deg.get(v) || 0) + 1); if (deg.get(v) > 2) ok = false; } }
      if (!ok) continue;
      let earlier = false;
      for (let k = 0; k < edges.length; k++) { const a = (m >> k) & 1, b = (bestMask >> k) & 1; if (a !== b) { earlier = a > b; break; } }
      if (n > best || (n === best && earlier)) { best = n; bestMask = m; }
    }
    const want = edges.filter((_, k) => (bestMask >> k) & 1).map((e) => ({ soldier: e[0], weapon: e[1] }));
    assert.deepStrictEqual(Game.maxLinks(S, W, (s, w) => E.has(s + '-' + w), 2, 2), want, JSON.stringify(edges));
  }
  assert.strictEqual(checked, 400);
});

test('determinism: links do not depend on the order items were added', () => {
  const build = (order) => {
    const g = fresh();
    const spec = [['soldier', 1, 1], ['dagger', 1, 0], ['dagger', 0, 1], ['dagger', 2, 1], ['soldier', 3, 1], ['soldier', 0, 0], ['sword', 2, 2]];
    const ids = {};
    for (const k of order) ids[k] = put(g, spec[k][0], spec[k][1], spec[k][2]);
    // report links as spec indexes so ids do not matter
    const back = new Map(Object.entries(ids).map(([k, v]) => [v, +k]));
    return JSON.stringify(g.getState().links.map((l) => [back.get(l.soldier), back.get(l.weapon)]));
  };
  const a = build([0, 1, 2, 3, 4, 5, 6]);
  assert.strictEqual(build([6, 5, 4, 3, 2, 1, 0]), a);
  assert.strictEqual(build([3, 0, 6, 1, 5, 2, 4]), a);
});

test('synergy: whetstone boosts an adjacent blade, anvil does not', () => {
  const g = fresh();
  put(g, 'soldier', 0, 0); const w = put(g, 'sword', 1, 0);
  const before = g.getState().bag.items.find((i) => i.id === w).damage;
  put(g, 'anvil', 2, 0);
  assert.strictEqual(g.getState().bag.items.find((i) => i.id === w).damage, before);
  put(g, 'whetstone', 2, 1);
  assert.strictEqual(g.getState().bag.items.find((i) => i.id === w).damage, before + 2);
});

test('merge: two same-level copies become one item one level higher', () => {
  const g = fresh();
  const a = put(g, 'sword', 0, 0), b = put(g, 'sword', 2, 0);
  const r = g.act({ type: 'merge', a, b });
  assert.ok(r.ok);
  const swords = g.items.filter((i) => i.kind === 'sword');
  assert.strictEqual(swords.length, 1);
  assert.strictEqual(swords[0].level, 2);
  assert.strictEqual(swords[0].value, 8);
});

test('merge: refuses different kinds and different levels', () => {
  const g = fresh();
  const a = put(g, 'sword', 0, 0), b = put(g, 'dagger', 2, 0), c = put(g, 'sword', 3, 0, 0, 2);
  assert.strictEqual(g.act({ type: 'merge', a, b }).ok, false);
  assert.strictEqual(g.act({ type: 'merge', a, b: c }).ok, false);
});

test('merged item is stronger', () => {
  const g = fresh();
  put(g, 'soldier', 0, 0);
  const a = put(g, 'sword', 1, 0), b = put(g, 'sword', 3, 0);
  const d1 = g.getState().bag.items.find((i) => i.id === a).damage;
  g.act({ type: 'merge', a, b });
  assert.ok(g.getState().bag.items.find((i) => i.id === a).damage > d1);
});

test('gold: bought slot is empty until the shop changes', () => {
  const g = new Game(7); g.act({ type: 'buy', slot: 0 });
  assert.strictEqual(g.act({ type: 'buy', slot: 0 }).ok, false);
});

test('gold: buy costs, reroll costs, sell refunds part', () => {
  const g = new Game(7);
  const g0 = g.gold, cost = g.shop[0].cost;
  assert.ok(g.act({ type: 'buy', slot: 0 }).ok);
  assert.strictEqual(g.gold, g0 - cost);
  assert.ok(g.act({ type: 'reroll' }).ok);
  assert.strictEqual(g.gold, g0 - cost - g.cfg.rerollCost);
  const id = g.items[0].id;
  assert.ok(g.act({ type: 'sell', id }).ok);
  assert.strictEqual(g.gold, g0 - cost - g.cfg.rerollCost + Math.max(1, Math.floor(cost * g.cfg.sellRefund)));
});

test('gold: cannot buy without enough gold', () => {
  const g = new Game(7); g.gold = 0;
  assert.strictEqual(g.act({ type: 'buy', slot: 0 }).ok, false);
});

test('gold rule: income plus capped interest after a won wave', () => {
  const g = fresh();
  put(g, 'soldier', 0, 0); put(g, 'sword', 1, 0); put(g, 'sword', 2, 0, 0); put(g, 'hammer', 3, 3);
  g.gold = 12; // 12 unspent: floor(12/5)=2 interest, cap 2
  const r = g.act({ type: 'fight' });
  assert.ok(r.ok && r.won, JSON.stringify(r));
  assert.strictEqual(r.interest, 2);
  assert.strictEqual(g.gold, 12 + 2 + Math.floor(g.cfg.income.base + g.cfg.income.perWave));
  const h = fresh(); put(h, 'soldier', 0, 0); put(h, 'sword', 1, 0);
  h.gold = 40; const r2 = h.act({ type: 'fight' });
  assert.strictEqual(r2.interest, h.cfg.interest.cap); // interest is capped
});

test('place / move / rotate respect the grid', () => {
  const g = new Game(3);
  g.act({ type: 'buy', slot: 1 }); // some item
  const id = g.items[0].id;
  assert.strictEqual(g.act({ type: 'place', id, x: 9, y: 9, rot: 0 }).ok, false);
  assert.ok(g.act({ type: 'place', id, x: 0, y: 0, rot: 0 }).ok);
  assert.ok(g.getState().bag.grid[0][0] === id);
});

test('rotate turns a 1x2 into a 2x1', () => {
  const g = fresh();
  const id = put(g, 'sword', 0, 0, 0);
  assert.deepStrictEqual(g.getState().bag.items[0].cells, [[0, 0], [0, 1]]);
  assert.ok(g.act({ type: 'rotate', id }).ok);
  assert.deepStrictEqual(g.getState().bag.items[0].cells, [[0, 0], [1, 0]]);
});

test('next wave type is visible and matches the wave that is fought', () => {
  const g = new Game(5);
  for (let i = 0; i < 3 && !g.over; i++) {
    const s = g.getState();
    g.act({ type: 'fight' });
    assert.strictEqual(g.lastBattle.type, s.nextWave.type);
  }
});

test('armored enemies shrug off weak hits', () => {
  const g = fresh();
  put(g, 'soldier', 0, 0); put(g, 'dagger', 1, 0);
  g.waveTypes[0] = 'armored'; g.waveTypes[1] = 'swarm'; // same wave number, different type
  const armored = g.simulate(1, false, 999);
  g.waveTypes[0] = 'normal';
  const normal = g.simulate(1, false, 999);
  assert.ok(armored.ticks > normal.ticks);
});

test('determinism: same seed + same actions = same result', () => {
  const bot = require('../bots/random.js');
  const play = (seed) => {
    const g = new Game(seed); const trace = [];
    for (let n = 0; n < 300 && !g.over; n++) {
      const o = bot.chooseAction(g.getState()); const a = o.action || o;
      trace.push(JSON.stringify([a, g.act(a)]));
    }
    return JSON.stringify([trace, g.getState()]);
  };
  assert.strictEqual(play(11), play(11));
  assert.notStrictEqual(play(11), play(12));
});

test('determinism: a clone plays the same as the original', () => {
  const g = new Game(9);
  g.act({ type: 'buy', slot: 0 });
  const c = g.clone();
  g.act({ type: 'reroll' }); c.act({ type: 'reroll' });
  assert.deepStrictEqual(g.getState().shop, c.getState().shop);
});

test('getState is plain JSON and fromState round-trips the bag', () => {
  const g = new Game(4);
  g.act({ type: 'buy', slot: 0 }); g.act({ type: 'place', id: 1, x: 2, y: 2, rot: 0 });
  const s = g.getState();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), s);
  const r = Game.fromState(s);
  assert.deepStrictEqual(r.getState().bag, s.bag);
  assert.ok(g.toText().includes('WAVE 1/10'));
});

test('log format: run.js --log writes one JSONL file per game with step/state/action/reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-log-'));
  try {
    execFileSync('node', [path.join(__dirname, '..', 'run.js'), '--bot', path.join(__dirname, '..', 'bots', 'random.js'), '--games', '2', '--seed', '3', '--log', dir]);
    const files = fs.readdirSync(dir).sort();
    assert.deepStrictEqual(files, ['game-3.jsonl', 'game-4.jsonl']);
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length > 3);
    lines.forEach((l, i) => { assert.strictEqual(l.step, i + 1); assert.ok('state' in l && 'action' in l && 'reason' in l); });
    assert.ok(lines[0].action.type);
    assert.strictEqual(lines[lines.length - 1].action, null);
    assert.strictEqual(lines[lines.length - 1].state.over, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('log replay: replaying the saved actions on the same seed reproduces every logged state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-log-'));
  try {
    execFileSync('node', [path.join(__dirname, '..', 'run.js'), '--bot', path.join(__dirname, '..', 'bots', 'random.js'), '--games', '1', '--seed', '21', '--log', dir]);
    const lines = fs.readFileSync(path.join(dir, 'game-21.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => typeof l.reason === 'string' && l.reason.length));
    const g = new Game(21);
    const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.catalog; return c; };
    for (const l of lines) {
      assert.deepStrictEqual(strip(g.getState()), l.state);
      if (l.action) g.act(l.action);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run.js --seeds reads a seed list from a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-seeds-'));
  try {
    const f = path.join(dir, 'seeds.txt'); fs.writeFileSync(f, '5\n6\n7\n');
    const out = execFileSync('node', [path.join(__dirname, '..', 'run.js'), '--bot', path.join(__dirname, '..', 'bots', 'random.js'), '--seeds', f]).toString();
    assert.strictEqual(JSON.parse(out.split('\n')[0]).games, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
