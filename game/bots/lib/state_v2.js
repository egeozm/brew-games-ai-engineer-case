// CANDIDATE fix, NOT used in the measured v2 (see part2/NOTE.md). v2 state representation: the v1 text PLUS explicit spatial facts the model kept getting wrong.
// Error analysis of v1 found spatial mistakes in about half of the lost games (weapons placed where no soldier
// touches them, diagonals taken as "touching", buffs next to the wrong weapon type), but they were not the most
// frequent class, so this change was kept as the next candidate.
// This adds facts only (what touches what, where an item would get links), no strategy advice.
'use strict';
const Game = require('../../game.js');
const { renderState } = require('./agent.js');

const BLADE = new Set(['sword', 'dagger']), HEAVY = new Set(['hammer', 'axe']);

function touching(g, it) {
  const occ = g._occupancy(it.id), W = g.cfg.gridW, H = g.cfg.gridH;
  const ids = new Set();
  for (const [x, y] of g.cellsOf(it)) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const o = occ[ny * W + nx];
    if (o && o !== it.id) ids.add(o);
  }
  return [...ids].map((id) => g._item(id));
}

const label = (it) => `#${it.id} ${it.kind}`;

// What placing item `id` at each legal spot would do: links gained (for weapons and soldiers),
// matching weapons touched (for buffs). Returns the best few spots.
function bestSpots(g, id, k) {
  const it = g._item(id), role = g.cfg.items[it.kind].role;
  const before = g.analyze().links.length;
  const out = [];
  for (const [x, y, rot] of g.placementsFor(id)) {
    const c = g.clone();
    if (!c.act({ type: 'place', id, x, y, rot }).ok) continue;
    const links = c.analyze().links.length - before;
    const placed = c._item(id);
    const nb = touching(c, placed);
    let value = links, what = '';
    if (role === 'weapon' || role === 'soldier') {
      const partners = c.analyze().links.filter((l) => l.soldier === id || l.weapon === id).map((l) => (l.soldier === id ? l.weapon : l.soldier));
      what = `+${links} link${links === 1 ? '' : 's'}${partners.length ? ' (with ' + partners.map((p) => label(c._item(p))).join(', ') + ')' : ''}`;
    } else if (it.kind === 'whetstone' || it.kind === 'anvil') {
      const want = it.kind === 'whetstone' ? BLADE : HEAVY;
      const hits = nb.filter((n) => want.has(n.kind));
      value = hits.length;
      what = hits.length ? `boosts ${hits.map(label).join(', ')}` : 'boosts nothing';
    } else {
      value = 0; what = 'works anywhere';
    }
    out.push({ x, y, rot, value, what, cells: c.cellsOf(placed) });
  }
  out.sort((a, b) => b.value - a.value || a.y - b.y || a.x - b.x || a.rot - b.rot);
  return out.slice(0, k);
}

function renderStateV2(s) {
  const base = renderState(s);
  const g = Game.fromState(s);
  const L = ['', 'SPATIAL FACTS (computed exactly; "touch" = share an edge, diagonals do not count):'];
  for (const it of g.items.filter((i) => i.loc === 'bag')) {
    const nb = touching(g, it);
    const def = g.cfg.items[it.kind];
    let note = '';
    if (def.role === 'weapon' && !nb.some((n) => n.kind === 'soldier')) note = '  <- no soldier touches it, it will NOT fire';
    if (it.kind === 'whetstone' && !nb.some((n) => BLADE.has(n.kind))) note = '  <- touches no blade weapon, does nothing';
    if (it.kind === 'anvil' && !nb.some((n) => HEAVY.has(n.kind))) note = '  <- touches no heavy weapon, does nothing';
    L.push(`  ${label(it)} touches: ${nb.length ? nb.map(label).join(', ') : 'nothing'}${note}`);
  }
  const empty = g._occupancy().filter((v) => !v).length;
  L.push(`  empty cells: ${empty}/25`);
  for (const it of g.items.filter((i) => i.loc === 'stash')) {
    const spots = bestSpots(g, it.id, 3);
    L.push(`  stash ${label(it)} best spots: ${spots.length ? spots.map((p) => `(x=${p.x},y=${p.y},rot=${p.rot}) ${p.what}`).join(' | ') : 'does not fit anywhere'}`);
  }
  return base + '\n' + L.join('\n');
}

module.exports = { renderStateV2, bestSpots, touching };
