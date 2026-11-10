/* Bag Battler UI. Pure presentation: every rule and number comes from BagGame (game.js). */
(function () {
  'use strict';
  var G = BagGame, CFG = G.CONFIG, CAT = G.catalog();
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var game = null, mode = 'play', sel = null, rotPending = 0, busy = false;
  var drag = null, pend = null, shown = null, fx = null, lastState = null, msgTimer = null;
  var battleCtl = null, battleInfo = null;
  var rep = { lines: [], i: 0, timer: null, playing: false };

  // ---------------------------------------------------------------- helpers
  function h(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function mix(hex, to, t) { var a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16); var c = [16, 8, 0].map(function (k) { var x = (a >> k) & 255, y = (b >> k) & 255; return Math.round(x + (y - x) * t); }); return 'rgb(' + c.join(',') + ')'; }
  function rgba(hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
  var WORDS = { 1: 'once', 2: 'twice', 3: 'three times' };
  function times(n) { return WORDS[n] || n + ' times'; }
  var LEAF = '<svg class="spr its-svg" viewBox="0 0 64 64"><path d="M10 54 C8 28 28 8 56 8 C56 38 38 56 12 54 Z" fill="#6fcf7a" stroke="#1d4a2a" stroke-width="3.5" stroke-linejoin="round"/><path d="M13 51 L42 22" stroke="#1d4a2a" stroke-width="3.5" stroke-linecap="round"/></svg>';
  function spriteEl(kind, cls) {
    if (kind === 'herb') { var w = h('div', cls || '', LEAF); w.firstChild.style.cssText = 'width:100%;height:100%'; return w; }
    var i = new Image(); i.src = 'assets/' + kind + '.png'; i.alt = ''; i.draggable = false; i.className = cls || ''; return i;
  }
  function name(k) { return CFG.items[k].name; }
  function lm(level) { return CFG.levelMult[level - 1]; }
  function rotUnsorted(shape, rot) {
    var c = shape.map(function (q) { return [q[0], q[1]]; });
    for (var r = 0; r < ((rot % 4) + 4) % 4; r++) c = c.map(function (q) { return [-q[1], q[0]]; });
    var mx = Math.min.apply(null, c.map(function (q) { return q[0]; })), my = Math.min.apply(null, c.map(function (q) { return q[1]; }));
    return c.map(function (q) { return [q[0] - mx, q[1] - my]; });
  }
  function norm(cells, ox, oy) { return cells.map(function (q) { return [q[0] - ox, q[1] - oy]; }); }

  // ---------------------------------------------------------------- explain: cause and effect of the bag
  // Read-only. Rebuilds the damage breakdown from the state with the formula in game.js analyze(),
  // and keeps it only if it matches the damage the game reports (it.damage).
  var DIRS = [[1, 0, 'to its right'], [-1, 0, 'to its left'], [0, 1, 'below it'], [0, -1, 'above it']];
  function fmt(n) { return Math.round(n * 10) / 10; }
  // link caps: read from config so the UI follows the rule in game.js
  function capSoldier() { return CFG.soldier.linksPerSoldier || 2; }
  function capWeapon() {
    var sc = CFG.soldier, k = Object.keys(sc).filter(function (q) { return /weapon/i.test(q) && typeof sc[q] === 'number'; })[0];
    return k ? sc[k] : (CFG.weaponMaxLinks || CFG.linksPerWeapon || 2);
  }
  function linksOfWeapon(s, id) { return (s.links || []).filter(function (l) { return l.weapon === id; }); }
  function blades(tag) { return Object.keys(CAT).filter(function (k) { return (CAT[k].tags || []).indexOf(tag) >= 0; }).map(function (k) { return CAT[k].name.toLowerCase(); }); }
  function explain(s) {
    var items = s.bag.items, byId = {}, W = s.bag.width, H = s.bag.height, grid = s.bag.grid;
    items.forEach(function (it) { byId[it.id] = it; });
    var nb = {}, dirOf = {};
    items.forEach(function (it) {
      var set = {};
      it.cells.forEach(function (c) {
        DIRS.forEach(function (d) {
          var nx = c[0] + d[0], ny = c[1] + d[1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
          var o = grid[ny][nx];
          if (o && o !== it.id) { set[o] = 1; if (!dirOf[it.id + '>' + o]) dirOf[it.id + '>' + o] = d[2]; }
        });
      });
      nb[it.id] = Object.keys(set).map(Number);
    });
    var ex = { byId: byId, nb: nb, weapons: {}, power: [], boosts: [], taken: [], soldiers: {}, buffs: {}, notes: [] };
    var load = {};
    (s.links || []).forEach(function (l) { load[l.soldier] = (load[l.soldier] || 0) + 1; ex.power.push({ a: l.soldier, b: l.weapon }); });
    items.forEach(function (w) {
      if (w.role !== 'weapon') return;
      var d = CAT[w.kind], m = lm(w.level), base = d.dmg * m, flat = 0, mult = 1, parts = [], buffs = [];
      nb[w.id].forEach(function (nid) {
        var n = byId[nid], nd = CAT[n.kind];
        if (nd.role !== 'buff' || (d.tags || []).indexOf(nd.boosts) < 0) return;
        var nm = lm(n.level), lab;
        if (nd.flat) { flat += nd.flat * nm; lab = '+' + fmt(nd.flat * nm); parts.push('+ ' + fmt(nd.flat * nm) + ' ' + nd.name); }
        if (nd.mult) { mult += nd.mult * nm; lab = '+' + Math.round(nd.mult * nm * 100) + '%'; parts.push('+ ' + Math.round(nd.mult * nm * 100) + '% ' + nd.name); }
        buffs.push(nid);
        ex.boosts.push({ a: nid, b: w.id, label: lab, kind: n.kind });
      });
      var wl = linksOfWeapon(s, w.id), sols = wl.map(function (l) { return byId[l.soldier]; }).filter(Boolean);
      var sb = 1, so = sols.length === 1 ? sols[0] : null;
      if (so && so.level > 1) { sb = 1 + CFG.soldier.levelBonus * (so.level - 1); parts.push('+ ' + Math.round((sb - 1) * 100) + '% Soldier Lv' + so.level); }
      var calc = Math.max(1, Math.round((base + flat) * mult * sb));
      var text = parts.length ? w.damage + ' = ' + fmt(base) + ' base ' + parts.join(' ') : w.damage + ' base';
      if (calc !== w.damage) text = String(w.damage);   // never show a sum that does not match the game
      var touching = nb[w.id].filter(function (nid) { return byId[nid].role === 'soldier'; });
      ex.weapons[w.id] = { buffs: buffs, breakdown: text, links: wl.length, powered: wl.length > 0 || !!w.powered,
        dirs: sols.map(function (q) { return dirOf[w.id + '>' + q.id] || 'next to it'; }), touchingSoldiers: touching };
    });
    items.forEach(function (it) {
      if (it.role === 'soldier') {
        var mine = (s.links || []).filter(function (l) { return l.soldier === it.id; }).map(function (l) { return l.weapon; });
        // a soldier touches a weapon but no link was made: one side has no free link
        var taken = nb[it.id].filter(function (nid) { return byId[nid].role === 'weapon' && mine.indexOf(nid) < 0; });
        taken.forEach(function (wid) { ex.taken.push({ a: it.id, b: wid }); });
        ex.soldiers[it.id] = { powers: mine, taken: taken };
      } else if (it.role === 'buff') {
        ex.buffs[it.id] = ex.boosts.filter(function (b) { return b.a === it.id; }).map(function (b) { return b.b; });
      }
    });
    // plain-language notes about things that do not work yet
    items.forEach(function (it) {
      var nm = name(it.kind);
      if (it.role === 'weapon' && !it.powered) {
        var full = ex.weapons[it.id].touchingSoldiers.length;
        ex.notes.push({ id: it.id, bad: true, t: nm + ' has no soldier, so it does not fight.' + (full ? ' The soldier next to it already powers ' + capSoldier() + ' weapons.' : ' Put a soldier next to it.') });
      }
      if (it.role === 'soldier' && ex.soldiers[it.id].taken.length) {
        ex.notes.push({ id: it.id, t: fullWhy(ex, it.id, ex.soldiers[it.id].taken[0]).replace(/^This soldier/, 'A soldier') });
      }
      if (it.role === 'buff' && !ex.buffs[it.id].length) {
        ex.notes.push({ id: it.id, bad: true, t: nm + ' touches no ' + blades(CAT[it.kind].boosts).join(' or ') + ', so it boosts nothing.' });
      }
      if (it.role === 'buff' && ex.buffs[it.id].length && ex.buffs[it.id].every(function (wid) { return !byId[wid].powered; })) {
        ex.notes.push({ id: it.id, bad: true, t: nm + ' boosts ' + name(byId[ex.buffs[it.id][0]].kind) + ', but that weapon has no soldier.' });
      }
    });
    // totals
    var per = 0, perArmor = 0, armor = s.nextWave ? s.nextWave.armor : 0;
    items.forEach(function (w) {
      if (w.role !== 'weapon') return;
      var n = ex.weapons[w.id].links || (w.powered ? 1 : 0); if (!n) return;
      // one entry per fire (each soldier link fires once); older states have a single damage value
      var fires = w.fireDamage && w.fireDamage.length ? w.fireDamage : Array(n + 1).join('x').split('').map(function () { return w.damage; });
      fires.forEach(function (d) { per += d * w.hits / w.cooldown; perArmor += Math.max(1, d - armor) * w.hits / w.cooldown; });
    });
    ex.perTurn = Math.round(per); ex.perTurnArmor = Math.round(perArmor);
    return ex;
  }
  function fullWhy(ex, sid, wid) {
    var wn = name(ex.byId[wid].kind);
    if (ex.soldiers[sid].powers.length >= capSoldier()) return 'This soldier touches ' + wn + ', but it already powers ' + capSoldier() + ' weapons.';
    return 'This soldier touches ' + wn + ', but ' + wn + ' already has ' + capWeapon() + ' soldiers.';
  }
  function related(ex, id) {
    var r = {}; r[id] = 1;
    ex.power.concat(ex.boosts, ex.taken).forEach(function (l) { if (l.a === id) r[l.b] = 1; if (l.b === id) r[l.a] = 1; });
    return r;
  }

  var LEVEL_COL = { 2: '#ff8a00', 3: '#b33dff' };
  var HIT_IC = '<svg class="ic hit" viewBox="0 0 24 24"><path d="M12 1l2.6 6.3L21 5l-2.3 6.4L24 14l-6.6 1.3L19 22l-7-3.6L5 22l1.6-6.7L0 14l5.3-2.6L3 5l6.4 2.3z"/></svg>';
  var LINK_IC = '<svg class=\"ic\" viewBox=\"0 0 24 24\"><path d=\"M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM8 20a4 4 0 0 1-2.8-6.8l2.5-2.5a1 1 0 1 1 1.4 1.4l-2.5 2.5A2 2 0 1 0 9.4 17.4l2.5-2.5a1 1 0 1 1 1.4 1.4l-2.5 2.5A4 4 0 0 1 8 20zm7.3-6.3a1 1 0 0 1-.7-1.7l2.5-2.5A2 2 0 1 0 14.3 6.6l-2.5 2.5A1 1 0 1 1 10.4 7.7l2.5-2.5a4 4 0 1 1 5.7 5.7l-2.5 2.5a1 1 0 0 1-.8.3z\"/></svg>';
  // corner of cell q: tl / tr / bl / br, 3px inside the cell
  function placeChip(b, q, corner) {
    var X = 'calc(' + q[0] + ' * (var(--c) + var(--g))', Y = 'calc(' + q[1] + ' * (var(--c) + var(--g))';
    var right = corner.charAt(1) === 'r', bottom = corner.charAt(0) === 'b';
    b.style.left = X + (right ? ' + var(--c) - 3px)' : ' + 3px)'); b.style.top = Y + (bottom ? ' + var(--c) - 3px)' : ' + 3px)');
    b.style.transform = 'translate(' + (right ? '-100%' : '0') + ',' + (bottom ? '-100%' : '0') + ')';
    b.dataset.corner = corner;
  }
  // ---------------------------------------------------------------- item component
  // o: {kind, level, cells (normalized), c (css size), nolink, badge, id, src, drag, selected}
  function itemEl(o) {
    var def = CFG.items[o.kind], cells = o.cells;
    var w = 1 + Math.max.apply(null, cells.map(function (q) { return q[0]; }));
    var hh = 1 + Math.max.apply(null, cells.map(function (q) { return q[1]; }));
    var el = h('div', 'it' + (o.nolink ? ' nolink' : '') + (o.powered ? ' pow' : ''));
    if (o.c) el.style.setProperty('--c', o.c);
    el.style.setProperty('--w', w); el.style.setProperty('--h', hh);
    var has = {}; cells.forEach(function (q) { has[q[0] + ',' + q[1]] = 1; });
    var col = def.color;
    cells.forEach(function (q) {
      var x = q[0], y = q[1];
      var up = has[x + ',' + (y - 1)], dn = has[x + ',' + (y + 1)], lf = has[(x - 1) + ',' + y], rt = has[(x + 1) + ',' + y];
      var d = h('div', 'itc');
      d.style.setProperty('--x', x); d.style.setProperty('--y', y);
      d.style.setProperty('--ex', rt ? 1 : 0); d.style.setProperty('--ey', dn ? 1 : 0);
      d.style.background = mix(col, '#ffffff', 0.3);
      var R = 'var(--r)';
      d.style.borderRadius = [(!up && !lf) ? R : '0', (!up && !rt) ? R : '0', (!dn && !rt) ? R : '0', (!dn && !lf) ? R : '0'].join(' ');
      var lc = LEVEL_COL[o.level], e = lc || mix(col, '#1c1408', 0.55), bw0 = lc ? '4px' : '2.5px', sh = [];
      if (!up) sh.push('inset 0 ' + bw0 + ' 0 ' + e, 'inset 0 ' + (lc ? '6.5px' : '5px') + ' 0 ' + mix(col, '#ffffff', 0.6)); if (!dn) sh.push('inset 0 -' + bw0 + ' 0 ' + e, 'inset 0 -' + (lc ? '6.5px' : '5px') + ' 0 ' + mix(col, '#ffffff', 0.1));
      if (!lf) sh.push('inset ' + bw0 + ' 0 0 ' + e); if (!rt) sh.push('inset -' + bw0 + ' 0 0 ' + e);
      d.style.boxShadow = sh.join(',');
      el.appendChild(d);
    });
    // sprite box: bbox shrunk, centred on the centroid of the real cells
    var cx = 0, cy = 0; cells.forEach(function (q) { cx += q[0] + 0.5; cy += q[1] + 0.5; }); cx /= cells.length; cy /= cells.length;
    var bw = w * 0.82, bh = hh * 0.82;
    var l = Math.min(Math.max(cx - bw / 2, 0), w - bw), t = Math.min(Math.max(cy - bh / 2, 0), hh - bh);
    var sp = spriteEl(o.kind, 'its');
    sp.style.left = (l / w * 100) + '%'; sp.style.top = (t / hh * 100) + '%'; sp.style.width = (bw / w * 100) + '%'; sp.style.height = (bh / hh * 100) + '%';
    el.appendChild(sp);
    var first = cells.slice().sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; })[0];
    var last = cells.slice().sort(function (a, b) { return b[1] - a[1] || b[0] - a[0]; })[0];
    // labels: at most ONE per cell. A 1-cell item shows one chip (damage for a weapon, links for a soldier).
    // A bigger weapon shows links in its first cell and damage in its last cell.
    var labs = [];
    if (cells.length === 1) { var one = o.dmgChip || o.linkChip; if (one) labs.push({ q: first, c: one, pref: 'br' }); }
    else {
      if (o.linkChip) labs.push({ q: first, c: o.linkChip, pref: 'tr' });
      if (o.dmgChip) labs.push({ q: last, c: o.dmgChip, pref: 'br' });
    }
    labs.forEach(function (L) {
      var b = h('div', 'chipc ' + L.c.cls, L.c.html); b._full = L.c.html; b._compact = L.c.compact || null;
      b.dataset.qx = L.q[0]; b.dataset.qy = L.q[1]; b.dataset.pref = L.pref;
      placeChip(b, L.q, L.pref);
      el.appendChild(b);
    });
    if (o.nolink) {
      var p = h('div', 'nopill', w === 1 ? 'NO<br>SOLDIER' : 'NO SOLDIER');
      p.style.left = (cx / w * 100) + '%'; p.style.top = (cy / hh * 100) + '%';
      el.appendChild(p);
    }
    if (o.src) { el.dataset.src = o.src; el.dataset.tip = 'item'; }
    if (o.id) el.dataset.id = o.id;
    if (o.drag) el.dataset.drag = '1';
    return el;
  }
  function stateItemOpts(it, s, interactive) {
    var o = { kind: it.kind, level: it.level, id: it.id, src: 'bag', drag: interactive };
    o.cells = norm(it.cells, it.x === undefined ? 0 : it.x, it.y === undefined ? 0 : it.y);
    if (it.role === 'weapon') {
      var wn = linksOfWeapon(s, it.id).length, wmx = capWeapon(), pw = wn > 0 || !!it.powered;
      o.powered = pw; o.nolink = !pw;
      if (pw) {
        // one number: damage per attack = every fire of every linked soldier x hits
        var fd = it.fireDamage && it.fireDamage.length ? it.fireDamage : Array(Math.max(1, wn) + 1).join('x').split('').map(function () { return it.damage; });
        var tot = fd.reduce(function (a, b) { return a + b; }, 0) * (it.hits || 1);
        o.dmgChip = { cls: 'dmgpill', html: tot + '<small>dmg</small>', compact: HIT_IC + tot };
        o.linkChip = { cls: 'sb' + (wn >= wmx ? ' full' : ''), html: LINK_IC + wn + '/' + wmx };
      }
    }
    if (it.role === 'soldier') {
      var n = s.links.filter(function (l) { return l.soldier === it.id; }).length, mx = capSoldier();
      o.linkChip = { cls: 'sb' + (n >= mx ? ' full' : ''), html: LINK_IC + n + '/' + mx };
    }
    return o;
  }

  // ---------------------------------------------------------------- bag
  function makeBag(s, c, interactive) {
    var wrap = h('div', 'bagwrap');
    if (c) wrap.style.setProperty('--c', c);
    var cells = h('div', 'cells');
    for (var y = 0; y < s.bag.height; y++) for (var x = 0; x < s.bag.width; x++) {
      var d = h('div', 'cell'); d.dataset.x = x; d.dataset.y = y; cells.appendChild(d);
    }
    wrap.appendChild(cells);
    var layer = h('div', 'items'), labs = h('div', 'labs');
    s.bag.items.forEach(function (it) {
      var o = stateItemOpts(it, s, interactive);
      var el = itemEl(o);
      el.style.left = 'calc(' + it.x + ' * (var(--c) + var(--g)))'; el.style.top = 'calc(' + it.y + ' * (var(--c) + var(--g)))';
      if (sel && sel.src === 'bag' && sel.id === it.id) el.classList.add('sel');
      if (!interactive) el.style.cursor = 'default';
      layer.appendChild(el);
      // chips and pills live in a layer above every item, so a big sprite next door never paints over them
      var lb = h('div', 'lab-it'); lb.dataset.id = it.id; lb.style.cssText = el.style.cssText; lb.style.setProperty('--w', el.style.getPropertyValue('--w')); lb.style.setProperty('--h', el.style.getPropertyValue('--h'));
      el.querySelectorAll('.chipc,.nopill').forEach(function (b) { lb.appendChild(b); });
      labs.appendChild(lb);
    });
    wrap.appendChild(layer); wrap.appendChild(labs);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'links');
    wrap.appendChild(svg);
    wrap.appendChild(h('div', 'ghost'));
    wrap._links = s.links; wrap._svg = svg; wrap._ex = explain(s);
    return wrap;
  }
  function centerOfItem(wrap, id) {
    var el = wrap.querySelector('.it[data-id="' + id + '"]'); if (!el) return null;
    var wr = wrap.getBoundingClientRect(), sx = 0, sy = 0, n = 0;
    el.querySelectorAll('.itc').forEach(function (c) { var r = c.getBoundingClientRect(); sx += r.left + r.width / 2; sy += r.top + r.height / 2; n++; });
    return [sx / n - wr.left, sy / n - wr.top];
  }
  var BOOST_COL = '#45d3e6', TAKEN_COL = '#6b5a45';
  // the two touching cells of a link, as pixel centres: the line crosses the shared side
  function touchPair(wrap, ida, idb) {
    var ex = wrap._ex, A = ex.byId[ida], B = ex.byId[idb]; if (!A || !B) return null;
    var cellC = function (q) { var c = wrap.querySelector('.cell[data-x="' + q[0] + '"][data-y="' + q[1] + '"]'); if (!c) return null; var wr = wrap.getBoundingClientRect(), r = c.getBoundingClientRect(); return [r.left + r.width / 2 - wr.left, r.top + r.height / 2 - wr.top]; };
    for (var i = 0; i < A.cells.length; i++) for (var j = 0; j < B.cells.length; j++) {
      var p = A.cells[i], q = B.cells[j];
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) === 1) { var a = cellC(p), b = cellC(q); return a && b ? [a, b] : null; }
    }
    return null;
  }
  function drawLinks(wrap) {
    var svg = wrap._svg; svg.innerHTML = '';
    var wr = wrap.getBoundingClientRect(); svg.setAttribute('viewBox', '0 0 ' + wr.width + ' ' + wr.height);
    var NS = 'http://www.w3.org/2000/svg', ex = wrap._ex;
    function mk(tag, at) { var e = document.createElementNS(NS, tag); for (var k in at) e.setAttribute(k, at[k]); return e; }
    function line(l, col, kind, label) {
      var pr = touchPair(wrap, l.a, l.b); if (!pr) return;
      // a short bridge across the shared side, so two links into one weapon stay two separate marks
      var mx0 = (pr[0][0] + pr[1][0]) / 2, my0 = (pr[0][1] + pr[1][1]) / 2, dx = pr[1][0] - pr[0][0], dy = pr[1][1] - pr[0][1], dl = Math.sqrt(dx * dx + dy * dy) || 1, k = 0.19 * dl;
      var a = [mx0 - dx / dl * k, my0 - dy / dl * k], b = [mx0 + dx / dl * k, my0 + dy / dl * k];
      var g = mk('g', { 'class': 'lk ' + kind, 'data-a': l.a, 'data-b': l.b });
      var at = { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: col, 'stroke-width': kind === 'taken' ? 4 : 6, 'stroke-linecap': 'round' };
      if (kind === 'taken') at['stroke-dasharray'] = '6 6';
      if (kind !== 'taken') g.appendChild(mk('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: '#2b1a0e', 'stroke-width': 9.5, 'stroke-linecap': 'round' }));
      g.appendChild(mk('line', at));
      svg.appendChild(g);
      if (label) {
        var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        var t = mk('text', { x: mx, y: my + 4.5, 'text-anchor': 'middle', 'class': 'lklab' }); t.textContent = label;
        g.appendChild(t);
        var bb = t.getBBox(), padx = 4;
        var r = mk('rect', { x: bb.x - padx, y: bb.y - 1, width: bb.width + padx * 2, height: bb.height + 2, rx: 7, fill: '#24324a', stroke: col, 'stroke-width': 2 });
        g.insertBefore(r, t);
      }
    }
    ex.taken.forEach(function (l) { line(l, TAKEN_COL, 'taken', 'full'); });
    ex.power.forEach(function (l) { line(l, '#ffd02a', 'power'); });
    ex.boosts.forEach(function (l) { line(l, BOOST_COL, 'boost', l.label); });
    placeLabels(wrap);
  }
  // No label may cover another label, a link bar or a NO SOLDIER pill.
  // 1) each chip takes the first corner of its cell that touches no link bar and no other chip;
  // 2) each boost / "full" label slides along its shared edge (bar and label move together) to the first free spot.
  function placeLabels(wrap) {
    var W = wrap.getBoundingClientRect(), c = parseFloat(getComputedStyle(wrap).getPropertyValue('--c')) || 60;
    function rel(el, pad) { var r = el.getBoundingClientRect(); pad = pad || 0; return { l: r.left - W.left - pad, t: r.top - W.top - pad, r: r.right - W.left + pad, b: r.bottom - W.top + pad }; }
    function grp(g) { var rs = [].map.call(g.querySelectorAll('line,rect'), function (e) { return rel(e, e.tagName === 'line' ? (+e.getAttribute('stroke-width') || 0) / 2 : 0); }); return rs.reduce(function (a, b) { return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) }; }); }
    function area(a, b) { var x = Math.min(a.r, b.r) - Math.max(a.l, b.l), y = Math.min(a.b, b.b) - Math.max(a.t, b.t); return x > 0.5 && y > 0.5 ? x * y : 0; }
    function cost(r, list) { var s = 0; list.forEach(function (o) { s += area(r, o); }); return s; }
    var groups = [].slice.call(wrap.querySelectorAll('svg.links g.lk'));
    var pills = [].map.call(wrap.querySelectorAll('.labs .nopill'), function (e) { return rel(e); });
    var chips = [].slice.call(wrap.querySelectorAll('.labs .chipc'));
    var ORDER = { br: ['br', 'tr', 'bl', 'tl'], tr: ['tr', 'br', 'tl', 'bl'] };
    // labelled groups first (they are wider), then the plain gold bars
    groups.sort(function (a, b) { return (b.querySelector('rect') ? 1 : 0) - (a.querySelector('rect') ? 1 : 0); });
    var gRect = groups.map(grp);   // where each link sits now (at first: in the middle of its edge)
    var SLIDE = [0, -0.15, 0.15, -0.25, 0.25, -0.33, 0.33, -0.41, 0.41];
    for (var pass = 0; pass < 4; pass++) {
      var cr = [];
      chips.forEach(function (b) {
        var q = [+b.dataset.qx, +b.dataset.qy], best = null;
        ORDER[b.dataset.pref].forEach(function (k) {
          placeChip(b, q, k);
          var r = rel(b), sc = (cost(r, cr) + cost(r, pills)) * 4 + cost(r, gRect);
          if (!best || sc < best.sc - 0.01) best = { k: k, sc: sc, r: r };
        });
        placeChip(b, q, best.k); cr.push(best.r);
      });
      var placed = cr.concat(pills), total = 0, gr = [];
      groups.forEach(function (g, i) {
        var ln = g.querySelector('line'), dx = +ln.getAttribute('x2') - +ln.getAttribute('x1'), dy = +ln.getAttribute('y2') - +ln.getAttribute('y1'), d = Math.sqrt(dx * dx + dy * dy) || 1;
        var px = -dy / d, py = dx / d, best = null, lab = g.querySelector('rect');
        var bb = lab ? lab.getBBox() : null, half = bb ? (Math.abs(px) > 0.5 ? bb.width : bb.height) / 2 : (+ln.getAttribute('stroke-width') || 0) / 2, fmax = (c / 2 - half) / c + 0.001;
        // a bar may also get shorter (it only has to bridge the gap between the two cells)
        var lines = [].slice.call(g.querySelectorAll('line'));
        if (!g._ends) g._ends = lines.map(function (e) { return ['x1', 'y1', 'x2', 'y2'].map(function (k) { return +e.getAttribute(k); }); });
        var setLen = function (m) { lines.forEach(function (e, j) { var q = g._ends[j], cx = (q[0] + q[2]) / 2, cy = (q[1] + q[3]) / 2; e.setAttribute('x1', cx + (q[0] - cx) * m); e.setAttribute('y1', cy + (q[1] - cy) * m); e.setAttribute('x2', cx + (q[2] - cx) * m); e.setAttribute('y2', cy + (q[3] - cy) * m); }); };
        var opts = []; [1, 0.55].forEach(function (m) { SLIDE.forEach(function (f) { if (Math.abs(f) <= fmax) opts.push([f, m]); }); });
        opts.some(function (o) {
          setLen(o[1]); g.setAttribute('transform', 'translate(' + px * o[0] * c + ',' + py * o[0] * c + ')');
          var r = grp(g), sc = cost(r, placed);
          if (!best || sc < best.sc - 0.01) best = { f: o[0], m: o[1], sc: sc, r: r };
          return sc === 0;
        });
        setLen(best.m); g.setAttribute('transform', 'translate(' + px * best.f * c + ',' + py * best.f * c + ')');
        gRect[i] = best.r; placed.push(best.r); total += best.sc;
      });
      if (total === 0) break;
      // still crowded: chips that touch a link switch to their short form (icon + number) for the next pass
      chips.forEach(function (b) { if (b._compact && b.innerHTML !== b._compact && cost(rel(b), gRect) > 0) b.innerHTML = b._compact; });
    }
  }
  // hover: light up what an item affects and what affects it
  function setFocus(wrap, id) {
    if (!wrap || !wrap._ex) return;
    var r = id ? related(wrap._ex, id) : null;
    wrap.classList.toggle('focus', !!r);
    wrap.querySelectorAll('.items .it,.labs .lab-it').forEach(function (e) { e.classList.toggle('rel', !!r && !!r[+e.dataset.id]); });
    wrap.querySelectorAll('g.lk').forEach(function (g) { g.classList.toggle('hot', !!r && (+g.dataset.a === id || +g.dataset.b === id)); });
  }

  // ---------------------------------------------------------------- tooltips
  var tipTimer = null, tipFor = null;
  function boostNames(tag) {
    return Object.keys(CAT).filter(function (k) { return (CAT[k].tags || []).indexOf(tag) >= 0; }).map(function (k) { return CAT[k].name.toLowerCase() + 's'; }).join(' and ');
  }
  function boosterFor(tags) {
    var b = Object.keys(CAT).filter(function (k) { return CAT[k].role === 'buff' && (tags || []).indexOf(CAT[k].boosts) >= 0; })[0];
    if (!b) return 'no booster.';
    var bd = CAT[b]; return 'a touching ' + bd.name.toLowerCase() + ' adds ' + (bd.flat ? '+' + bd.flat + ' damage per hit.' : '+' + Math.round(bd.mult * 100) + '% damage.');
  }
  function itemDesc(kind, level) {
    var d = CAT[kind], m = lm(level), L = [];
    if (d.role === 'soldier') L.push('Powers up to ' + capSoldier() + ' weapons that touch its sides. Each soldier on a weapon makes it fire once more.' + (level > 1 ? ' Its weapons hit ' + Math.round(CFG.soldier.levelBonus * (level - 1) * 100) + '% harder.' : ''));
    else if (d.role === 'weapon') L.push('Damage ' + Math.round(d.dmg * m) + ' per hit' + (d.hits > 1 ? ' x' + d.hits : '') + ', ' + (d.cd === 1 ? 'every turn' : 'every ' + d.cd + ' turns') + (d.cleave > 1 ? ', hits up to ' + d.cleave + ' enemies' : '') + '. Needs one soldier on its side to fight.');
    else if (d.role === 'buff') L.push('Touching ' + boostNames(d.boosts) + ' get ' + (d.flat ? '+' + Math.round(d.flat * m) + ' damage per hit' : '+' + Math.round(d.mult * m * 100) + '% damage') + '.');
    else if (d.role === 'defense') L.push('Blocks ' + Math.round(d.reduce * m) + ' damage from enemies every turn.');
    else if (d.role === 'heal') L.push('Heals ' + Math.round(d.heal * m) + ' HP after you win a wave.');
    return L;
  }
  function tipHTML(t) {
    if (t.dataset.tip === 'text') return t.id === 'goldBox' ? goldTip() : (t.dataset.tiptext || '');
    var src = t.dataset.src, s = lastState, it = null, kind, level = 1, price = null;
    if (src === 'shop') { var sl = s.shop[+t.dataset.slot]; if (!sl) return ''; kind = sl.kind; price = 'Cost ' + sl.cost + ' gold'; }
    else {
      it = (src === 'bag' ? s.bag.items : s.stash).filter(function (q) { return q.id === +t.dataset.id; })[0]; if (!it) return '';
      kind = it.kind; level = it.level; price = 'Sells for ' + it.sellPrice + ' gold';
    }
    var out = '<b class="ttl">' + name(kind) + (level > 1 ? ' (level ' + level + ')' : '') + '</b>';
    var ex = src === 'bag' ? explain(s) : null, d = CAT[kind];
    if (src === 'bag' && it.role === 'weapon') {
      var we = ex.weapons[it.id];
      out += '<div>Damage per hit: <b>' + we.breakdown + '</b></div>';
      out += '<div class="muted">' + cap((it.hits > 1 ? 'hits ' + times(it.hits) + ' each time it fires, ' : '') + (it.cooldown === 1 ? 'fires every turn' : 'fires every ' + it.cooldown + ' turns') + (it.cleave > 1 ? ', up to ' + it.cleave + ' enemies at once' : '')) + '.</div>';
      if (we.powered) {
        out += '<div class="pw">Links ' + we.links + '/' + capWeapon() + ': powered by the soldier ' + we.dirs.join(' and the soldier ') + '.</div>';
        out += '<div>' + (we.links > 1 ? 'It fires ' + times(we.links) + ' per turn, once for each soldier.' : 'It fires once per turn. A second soldier on its side makes it fire twice.') + '</div>';
      } else out += '<div class="np">NOT powered: it does not fight. ' + (we.touchingSoldiers.length ? 'The soldier next to it already powers ' + capSoldier() + ' weapons.' : 'Put a soldier on one of its sides.') + '</div>';
      out += '<div class="muted">' + cap((d.tags || []).join(', ')) + ' weapon: ' + boosterFor(d.tags) + '</div>';
    } else if (src === 'bag' && it.role === 'soldier') {
      var se = ex.soldiers[it.id], mx = capSoldier();
      out += '<div>Badge <b>links ' + se.powers.length + '/' + mx + '</b>: this soldier powers ' + se.powers.length + ' of the ' + mx + ' weapons it can power.</div>';
      out += '<div class="muted">Each soldier that touches a weapon makes it fire once more.' + (level > 1 ? ' Its weapons hit ' + Math.round(CFG.soldier.levelBonus * (level - 1) * 100) + '% harder.' : '') + '</div>';
      if (se.powers.length) out += '<div class="pw">Powers: ' + se.powers.map(function (wid) { return name(ex.byId[wid].kind); }).join(', ') + '</div>';
      se.taken.forEach(function (wid) { out += '<div class="tk">' + fullWhy(ex, it.id, wid) + '</div>'; });
    } else if (src === 'bag' && it.role === 'buff') {
      itemDesc(kind, level).forEach(function (l) { out += '<div>' + l + '</div>'; });
      var bl = ex.buffs[it.id];
      if (bl.length) out += '<div class="bo">Boosts: ' + bl.map(function (wid) { var b = ex.boosts.filter(function (q) { return q.a === it.id && q.b === wid; })[0]; return name(ex.byId[wid].kind) + ' ' + b.label; }).join(', ') + '</div>';
      else out += '<div class="np">Boosts nothing: it must touch a ' + blades(d.boosts).join(' or ') + '.</div>';
    } else {
      itemDesc(kind, level).forEach(function (l) { out += '<div>' + l + '</div>'; });
      if (d.role === 'defense' || d.role === 'heal') out += '<div class="muted">Works anywhere in the bag. It needs no soldier.</div>';
      if (d.role === 'weapon') out += '<div class="muted">' + cap((d.tags || []).join(', ')) + ' weapon: ' + boosterFor(d.tags) + '</div>';
    }
    out += '<div class="pr">' + price + '</div>';
    if (level < CFG.maxLevel && src !== 'shop') out += '<div class="muted">Drop it on the same item at the same level to level it up.</div>';
    return out;
  }
  function goldTip() {
    var ic = CFG.interest;
    return 'Gold buys items. You also earn income every wave. Unspent gold earns interest: +' + ic.rate + ' per ' + ic.per + ' saved (max +' + ic.cap + ').';
  }
  function showTip(t) {
    var tip = $('tip'), html = tipHTML(t); if (!html) return;
    tip.innerHTML = html; tip.style.left = '0px'; tip.style.top = '0px';
    var r = t.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight, vw = innerWidth, vh = innerHeight;
    var x = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), vw - tw - 8);
    var y = r.bottom + 10; if (y + th > vh - 8) y = r.top - th - 10;
    if (y < 8) { y = Math.min(vh - th - 8, Math.max(8, r.top)); x = r.right + 10 + tw < vw ? r.right + 10 : Math.max(8, r.left - tw - 10); }
    tip.style.left = x + 'px'; tip.style.top = y + 'px'; tip.classList.add('show');
  }
  function hideTip() { clearTimeout(tipTimer); tipFor = null; $('tip').classList.remove('show'); }
  document.addEventListener('pointerover', function (e) {
    if (drag || pend || (e.pointerType && e.pointerType !== 'mouse')) return;
    var t = e.target.closest && e.target.closest('[data-tip]');
    var bi = e.target.closest && e.target.closest('#bagHost .it');
    setFocus(document.querySelector('#bagHost .bagwrap'), bi ? +bi.dataset.id : null);
    if (t === tipFor) return;
    hideTip(); tipFor = t;
    if (t) tipTimer = setTimeout(function () { if (!drag) showTip(t); }, 250);
  });
  document.addEventListener('pointerdown', function () { hideTip(); setFocus(document.querySelector('#bagHost .bagwrap'), null); }, true);

  // ---------------------------------------------------------------- floating feedback
  function floatText(text, cls, x, y, dy) {
    var f = h('div', 'flt ' + cls, text); f.style.left = x + 'px'; f.style.top = y + 'px'; $('fxlayer').appendChild(f);
    var a = f.animate([{ opacity: 0, transform: 'translate(-50%,-50%) translateY(6px)' }, { opacity: 1, transform: 'translate(-50%,-50%) translateY(-6px)', offset: 0.15 }, { opacity: 0, transform: 'translate(-50%,-50%) translateY(' + (dy || -38) + 'px)' }], { duration: 800, easing: 'ease-out', fill: 'forwards' });
    a.onfinish = function () { f.remove(); };
  }
  function floatAtEl(el, text, cls, slot) {
    var r = el.getBoundingClientRect(); floatText(text, cls, r.left + r.width / 2 + (slot || 0) * 0, r.top + r.height / 2 + (slot || 0) * 24, -28);
  }
  function floatHp(text, cls, slot) {
    var us = $('army').querySelectorAll('.unit'), r;
    if (us.length) { var L = 1e9, R = -1e9, T = 1e9; us.forEach(function (u) { var b = u.getBoundingClientRect(); L = Math.min(L, b.left); R = Math.max(R, b.right); T = Math.min(T, b.top); }); r = { left: L, width: R - L, top: T }; }
    else r = document.querySelector('#armyTag .hpBox .bar').getBoundingClientRect();
    // pops over the soldiers' heads and rises a little: never up into the HP pill
    floatText(text, cls, r.left + r.width / 2, r.top + 22 + slot * 22, -12);
  }
  function fly(el, toRect, opts) {
    opts = opts || {};
    var from = el.getBoundingClientRect(); var clone = el.cloneNode(true);
    clone.style.cssText += ';position:fixed;left:' + from.left + 'px;top:' + from.top + 'px;margin:0;pointer-events:none;z-index:250;opacity:.85';
    $('fxlayer').appendChild(clone);
    var dx = toRect.left + toRect.width / 2 - (from.left + from.width / 2), dy = toRect.top + toRect.height / 2 - (from.top + from.height / 2);
    var a = clone.animate([{ transform: 'translate(0,0) scale(1)', opacity: 0.85 }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + (opts.scale === undefined ? 1 : opts.scale) + ')', opacity: opts.fade ? 0 : 0.85 }], { duration: opts.ms || 220, easing: 'ease-in-out', fill: 'forwards' });
    return new Promise(function (res) { a.onfinish = function () { clone.remove(); res(); }; });
  }
  function bounce(el) { if (el) el.animate([{ transform: 'scale(.88)' }, { transform: 'scale(1.08)', offset: 0.55 }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' }); }
  function pulse(el) { if (el) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 380, easing: 'ease-out' }); }

  // ---------------------------------------------------------------- rendering
  function renderTop(s) {
    $('waveTxt').textContent = 'Wave ' + Math.min(s.wave, s.totalWaves) + '/' + s.totalWaves;
    var p = $('pips'); p.innerHTML = '';
    for (var i = 1; i <= s.totalWaves; i++) {
      var d = h('i', 'pip' + (i < s.wave || (s.over && s.won) ? ' done' : '') + (i === s.wave && !(s.over && s.won) ? ' cur' : '') + (i === s.totalWaves && CFG.bossWave ? ' boss' : ''));
      if (i === s.totalWaves && CFG.bossWave) d.title = 'Boss wave';
      p.appendChild(d);
    }
    $('hpFill').style.width = Math.max(0, s.hp / s.maxHp * 100) + '%';
    $('hpTxt').textContent = s.hp + '/' + s.maxHp;
    $('goldVal').textContent = s.gold;
    $('goldBox').dataset.tip = 'text';
  }
  function renderBag(s, interactive) {
    var host = $('bagHost'); host.innerHTML = '';
    var wrap = makeBag(s, null, interactive); host.appendChild(wrap);
    var empty = s.bag.items.length === 0 && s.wave === 1 && interactive && !s.over;
    var hint = h('div', 'bagHint', 'Drag a soldier<br>into your bag'); hint.style.opacity = empty ? 1 : 0; wrap.appendChild(hint);
    drawLinks(wrap);
  }
  function shapePreview(kind) {
    var o = itemEl({ kind: kind, level: 1, cells: norm(CAT[kind].shape, 0, 0) });
    o.classList.add('inline'); o.querySelector('.its').remove(); return o;
  }
  var REROLL_SVG = '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 0 1 7.4 5H22l-3.5 4.5L15 9h2.2A5.6 5.6 0 0 0 12 6.4 5.6 5.6 0 0 0 6.4 12H4a8 8 0 0 1 8-8zm0 16a8 8 0 0 1-7.4-5H2l3.5-4.5L9 15H6.8a5.6 5.6 0 0 0 5.2 2.6 5.6 5.6 0 0 0 5.6-5.6H20a8 8 0 0 1-8 8z"/></svg>';
  function renderShop(s, interactive) {
    var box = $('shop'); box.innerHTML = '';
    s.shop.forEach(function (x, i) {
      var c;
      if (!x) { c = h('div', 'shopcard sold', 'Sold'); box.appendChild(c); return; }
      c = h('div', 'shopcard' + (x.affordable ? '' : ' poor') + (sel && sel.src === 'shop' && sel.slot === i ? ' sel' : ''));
      c.dataset.src = 'shop'; c.dataset.slot = i; c.dataset.tip = 'item'; if (interactive) c.dataset.drag = '1';
      var art = h('div', 'art'); var ie = itemEl({ kind: x.kind, level: 1, cells: [[0, 0]] }); ie.classList.add('inline'); art.appendChild(ie);
      c.appendChild(art);
      c.appendChild(h('div', 'nm', name(x.kind)));
      if (CAT[x.kind].shape.length > 1) { var shp = h('div', 'shp'); shp.appendChild(shapePreview(x.kind)); c.appendChild(shp); }
      var cost = h('div', 'cost'); cost.innerHTML = '<img src="assets/ui/coin.png" alt="">' + x.cost; c.appendChild(cost);
      box.appendChild(c);
    });
    var rb = $('rerollBtn'); rb.innerHTML = REROLL_SVG + '<span class="rc"><img src="assets/ui/coin.png" alt="">' + s.rerollCost + '</span>';
    rb.title = 'Reroll the shop'; rb.setAttribute('aria-label', 'Reroll for ' + s.rerollCost + ' gold');
    rb.disabled = !interactive || !s.legal.reroll;
  }
  function renderStash(s, interactive) {
    $('stashTitle').textContent = 'Stash';
    var box = $('stash'); box.innerHTML = '';
    for (var i = 0; i < CFG.stashSize; i++) {
      var slot = h('div', 'slot'), it = s.stash[i];
      if (it) {
        var o = itemEl({ kind: it.kind, level: it.level, cells: it.cells, id: it.id, src: 'stash', drag: interactive });
        o.classList.add('inline'); o.style.cursor = interactive ? 'grab' : 'default';
        if (it.cells.length === 1) o.classList.add('h1w1');
        if (sel && sel.src === 'stash' && sel.id === it.id) o.classList.add('sel');
        slot.appendChild(o);
      }
      box.appendChild(slot);
    }
  }
  function nextHint(w) {
    if (w.type === 'normal') return w.name + ': ' + (w.armor ? 'armor ' + w.armor : 'no armor') + '. Any powered weapon works.';
    if (w.type === 'armored') return w.name + ': every hit loses ' + w.armor + ' damage (min 1). Daggers do almost nothing; use hammers or swords.';
    if (w.type === 'swarm') return w.name + ': many weak enemies. Axes hit ' + CAT.axe.cleave + ' at once, daggers hit ' + times(CAT.dagger.hits) + '.';
    return w.name + ': one huge enemy, armor ' + w.armor + '. Big hits win: hammer + anvil.';
  }
  // ---------------------------------------------------------------- battlefield: army (left) and the next wave (right)
  function unitPx() { return parseFloat(getComputedStyle($('app')).getPropertyValue('--unit')) || 46; }
  // place n units of size sz in a box w wide, in rows; front row at the bottom, back rows higher and behind
  function formation(n, w, sz, maxRows, alignRight) {
    var rows = Math.min(maxRows, Math.max(1, Math.ceil(n * sz * 0.92 / Math.max(1, w - sz * 0.2)))), per = Math.ceil(n / rows), out = [];
    for (var i = 0; i < n; i++) {
      var r = Math.floor(i / per), k = i % per, cnt = Math.min(per, n - r * per), sh = rows > 1 ? sz * 0.3 : 0;
      var step = cnt > 1 ? Math.min(sz * 1.08, (w - sh - sz) / (cnt - 1)) : 0, span = step * (cnt - 1) + sz;
      var x0 = alignRight ? w - span - (r % 2) * sh : (r % 2) * sh;
      out.push({ x: x0 + k * step, b: r * sz * 0.42, z: 10 - r, row: r });
    }
    return out;
  }
  function unitEl(cls, src, size, pos) {
    var u = h('div', 'unit ' + cls);
    u.style.setProperty('--us', size + 'px'); u.style.left = pos.x + 'px'; u.style.bottom = pos.b + 'px'; u.style.zIndex = pos.z;
    var b = h('div', 'body'); var im = new Image(); im.src = src; im.alt = ''; im.draggable = false; im.className = 'me'; b.appendChild(im); u.appendChild(b);
    return u;
  }
  function renderArmy(s) {
    var box = $('army'); box.innerHTML = '';
    var sols = s.bag.items.filter(function (q) { return q.role === 'soldier'; }).sort(function (a, b) { return a.id - b.id; });
    var U = unitPx(), w = box.clientWidth || 170, sz = sols.length > 6 ? U * 0.8 : U;
    var pos = formation(sols.length, w, sz, 2, true);
    sols.forEach(function (so, i) {
      var mine = (s.links || []).filter(function (l) { return l.soldier === so.id; }).map(function (l) { return l.weapon; });
      var u = unitEl('sol idle' + (i % 4) + (mine.length ? '' : ' nolinks'), 'assets/soldier.png', sz, pos[i]);
      u.dataset.id = so.id;
      mine.slice(0, 2).forEach(function (wid, k) {
        var wi = s.bag.items.filter(function (q) { return q.id === wid; })[0]; if (!wi) return;
        var wimg = spriteEl(wi.kind, 'wpn w' + k); u.querySelector('.body').appendChild(wimg);
      });
      if (so.level > 1) u.classList.add('lv' + so.level);
      box.appendChild(u);
    });
  }
  function foeSize(n, U) { return n === 1 ? U * 1.35 : n <= 2 ? U * 1.2 : n <= 4 ? U * 1.05 : n <= 6 ? U * 0.92 : n <= 9 ? U * 0.8 : U * 0.7; }
  function renderFoes(info) {
    var box = $('bFoes'); box.innerHTML = '';
    if (!info) return;
    var U = unitPx(), w = box.clientWidth || 170, sz = info.type === 'boss' ? U * 1.45 : foeSize(info.count, U);
    var pos = formation(info.count, w, sz, info.count > 8 ? 3 : 2, false), multi = pos.some(function (q) { return q.row > 0; });
    foeHp = []; foeMax = info.hp * info.count;
    for (var i = 0; i < info.count; i++) {
      var f = unitEl('foe idle' + (i % 4) + (sz < U * 0.85 ? ' small' : ''), 'assets/enemy-' + info.type + '.png', sz, pos[i]);
      f.dataset.i = i; foeHp.push(info.hp);
      if (!multi) f.appendChild(h('div', 'fbar', '<i style="width:100%"></i>'));

      box.appendChild(f);
    }
    if (multi) { var gb = h('div', 'fbar group', '<i style="width:100%"></i>'); var maxX = Math.max.apply(null, pos.map(function (q) { return q.x; })) + sz; gb.style.left = '4px'; gb.style.width = (maxX - 8) + 'px'; box.appendChild(gb); }
  }
  var foeHp = [], foeMax = 1;
  function renderNext(s) {
    var c = $('nextCard'); c.innerHTML = '';
    var w = s.nextWave;
    if (!w) { c.dataset.tiptext = ''; renderFoes(null); return; }
    var boss = w.type === 'boss';
    c.appendChild(h('span', 'nm', (boss ? 'Boss: ' : 'Next: ') + (w.count === 1 ? '' : w.count + '× ') + w.name));
    var ch = h('span', 'chips'); ch.appendChild(h('span', 'chip', '<small>HP</small>' + w.hp)); if (w.armor) ch.appendChild(h('span', 'chip', '<small>armor</small>' + w.armor)); ch.appendChild(h('span', 'chip', '<small>hits</small>' + w.dmg));
    c.appendChild(ch);
    c.dataset.tip = 'text';
    c.dataset.tiptext = '<b class="ttl">Next: ' + (w.count === 1 ? w.name : w.count + ' x ' + w.name) + '</b><div>HP <b>' + w.hp + '</b> each, hits you for <b>' + w.dmg + '</b>, armor <b>' + w.armor + '</b>.</div><div>' + nextHint(w) + '</div><div class="muted">Up to ' + CFG.battle.maxAttackers + ' enemies hit you each turn; shields cut that damage.</div>';
    renderFoes(w);
  }
  function renderStats(s) {
    var ex = explain(s), w = s.nextWave, chip = $('dmgChip');
    chip.innerHTML = '<img src="assets/ui/hit.png" alt="">' + (w && w.armor ? ex.perTurnArmor : ex.perTurn) + '<small>dmg / turn</small>';
    chip.dataset.tiptext = '<b class="ttl">Your damage per turn</b><div>Your bag: <b>' + ex.perTurn + '</b> damage per turn, <b>' + (s.shield || 0) + '</b> shield, <b>' + (s.heal || 0) + '</b> heal.</div>' +
      (w ? '<div>Next wave: <b>' + (w.count * w.hp) + '</b> HP in total.' + (w.armor ? ' After its armor you deal <b>' + ex.perTurnArmor + '</b> per turn.' : '') + '</div>' : '');
    lastNote = ex.notes.filter(function (n) { return n.bad; })[0] || null;
  }
  var lastNote = null;
  function selectedInfo(s) {
    if (!sel) return null;
    if (sel.src === 'shop') { var x = s.shop[sel.slot]; return x ? { kind: x.kind, src: 'shop' } : null; }
    var arr = sel.src === 'bag' ? s.bag.items : s.stash;
    var it = arr.filter(function (q) { return q.id === sel.id; })[0];
    return it ? { kind: it.kind, src: sel.src, it: it } : null;
  }
  function defaultMsg() { return mode === 'play' && lastNote && !busy ? lastNote.t : ''; }
  function renderDock(s, interactive) {
    var d = $('dock'); d.innerHTML = ''; d.hidden = !interactive;
    var info = interactive ? selectedInfo(s) : null;
    if (sel && !info) sel = null;
    if (!info) {
      var m = h('div', 'msg', defaultMsg()); m.id = 'msg'; d.appendChild(m); return;
    }
    var row = h('div', 'selrow'); row.appendChild(h('b', '', name(info.kind)));
    function btn(label, fn, dis, cls) { var b = h('button', 'sbtn' + (cls ? ' ' + cls : ''), label); b.disabled = !!dis; b.onclick = fn; row.appendChild(b); return b; }
    if (info.src === 'shop') {
      btn('Rotate', function () { rotPending = (rotPending + 1) & 3; msgSoon('Rotation set. Now tap a cell in your bag.'); });
      btn('Buy', function () { doPlan([{ type: 'buy', slot: sel.slot }], {}); });
      row.appendChild(h('span', 'hint', ''));
    } else {
      btn('Rotate', function () { doPlan([{ type: 'rotate', id: sel.id }], { keepSel: true }); });
      btn('Sell ' + info.it.sellPrice, function () { doPlan([{ type: 'sell', id: sel.id }], { sell: true }); }, false, 'sell');
      if (info.src === 'bag') btn('Stash', function () { doPlan([{ type: 'unplace', id: sel.id }], {}); });
      var pair = game.mergePairs().filter(function (p) { return p.indexOf(sel.id) >= 0; })[0];
      if (pair) btn('Merge', function () { var p = game.mergePairs().filter(function (q) { return q.indexOf(sel.id) >= 0; })[0]; if (!p) return msg('No matching copy at the same level.', true); var other = p[0] === sel.id ? p[1] : p[0]; var tgt = s.bag.items.some(function (q) { return q.id === other; }) ? other : sel.id; var oth = tgt === other ? sel.id : other; doPlan([{ type: 'merge', a: tgt, b: oth }], { merge: tgt }); });
    }
    var x = h('button', 'sbtn x', '×'); x.title = 'Cancel'; x.onclick = function () { sel = null; hideTip(); refresh(); }; row.appendChild(x);
    d.appendChild(row);
  }
  // a message while a selection row is shown: swap the row for the message for a moment
  function msgSoon(t) { var d = $('dock'); d.innerHTML = ''; var m = h('div', 'msg', t); m.id = 'msg'; d.appendChild(m); clearTimeout(msgTimer); msgTimer = setTimeout(function () { if (lastState && !busy) renderDock(lastState, mode === 'play'); }, 1800); }
  function msg(t, err) {
    var m = $('msg'); if (!m) { if (t) msgSoon(t); return; }
    m.textContent = t || defaultMsg(); m.className = 'msg' + (err ? ' err' : '');
    clearTimeout(msgTimer); if (t) msgTimer = setTimeout(function () { var q = $('msg'); if (q) { q.className = 'msg'; q.textContent = defaultMsg(); } }, 3500);
  }
  // what changed in the bag after one action, in plain words
  function changeLines(before, after) {
    var A = explain(before), B = explain(after), out = [];
    var inA = {}; before.bag.items.forEach(function (i) { inA[i.id] = i; });
    var key = function (l) { return l.a + '>' + l.b; };
    var pa = {}; A.power.forEach(function (l) { pa[key(l)] = 1; });
    var ba = {}; A.boosts.forEach(function (l) { ba[key(l)] = 1; });
    var ta = {}; A.taken.forEach(function (l) { ta[key(l)] = 1; });
    var nm = function (id) { return name(B.byId[id] ? B.byId[id].kind : A.byId[id].kind); };
    after.bag.items.forEach(function (it) {
      if (it.role !== 'weapon') return;
      var was = inA[it.id] ? { powered: A.weapons[it.id].powered } : null; it = { id: it.id, powered: B.weapons[it.id].powered };
      if (it.powered && !(was && was.powered)) out.push({ p: 1, t: nm(it.id) + ' is now powered by a soldier' });
      else if (!it.powered && (!was || was.powered)) out.push({ p: 0, bad: 1, t: nm(it.id) + ' has no soldier, so it will not fight' });
    });
    B.boosts.forEach(function (l) { if (!ba[key(l)]) out.push({ p: 1, t: nm(l.a) + ' boosts ' + nm(l.b) + ' ' + l.label }); });
    A.boosts.forEach(function (l) { if (B.byId[l.a] && B.byId[l.b] && !B.boosts.some(function (q) { return key(q) === key(l); })) out.push({ p: 2, bad: 1, t: nm(l.a) + ' no longer boosts ' + nm(l.b) }); });
    B.taken.forEach(function (l) { if (!ta[key(l)]) out.push({ p: 2, t: fullWhy(B, l.a, l.b).replace(/\.$/, '').replace(/^This soldier/, 'A soldier') }); });
    after.bag.items.forEach(function (it) {
      if (it.role !== 'weapon') return;
      var na = A.weapons[it.id] ? A.weapons[it.id].links : 0, nb2 = B.weapons[it.id].links;
      if (na && nb2 > na) out.push({ p: 1, t: nm(it.id) + ' now fires ' + times(nb2) + ' per turn (' + nb2 + ' soldiers)' });
      if (nb2 && na > nb2) out.push({ p: 1, bad: 1, t: nm(it.id) + ' now fires ' + times(nb2) + ' per turn' });
    });
    after.bag.items.forEach(function (it) {
      if (inA[it.id] && inA[it.id].level === it.level) return;
      var d = CAT[it.kind];
      if (d.role === 'buff' && !B.buffs[it.id].length) out.push({ p: 1, bad: 1, t: d.name + ' touches no ' + blades(d.boosts).join(' or ') + ', so it boosts nothing yet' });
      if (d.role === 'defense') out.push({ p: 1, t: d.name + ' blocks ' + Math.round(d.reduce * lm(it.level)) + ' damage per turn. It works anywhere in the bag' });
      if (d.role === 'heal') out.push({ p: 1, t: d.name + ' heals ' + Math.round(d.heal * lm(it.level)) + ' HP after a won wave. It works anywhere in the bag' });
      if (d.role === 'soldier' && !B.soldiers[it.id].powers.length && !B.soldiers[it.id].taken.length) out.push({ p: 2, t: 'Soldier placed. Put a weapon on one of its sides' });
    });
    if (A.perTurn !== B.perTurn) out.push({ p: 4, t: 'Damage per turn ' + A.perTurn + ' \u2192 ' + B.perTurn });
    out.sort(function (x, y) { return x.p - y.p; });
    return out.slice(0, 2);
  }
  function toast(lines) {
    if (!lines.length) return;
    var m = $('msg'); if (!m) { var d = $('dock'); d.innerHTML = ''; m = h('div', 'msg'); m.id = 'msg'; d.appendChild(m); }
    m.innerHTML = ''; m.className = 'msg toast' + (lines.every(function (l) { return l.bad; }) ? ' warn' : '');
    lines.forEach(function (l, i) { if (i) m.appendChild(h('span', 'sep', ' \u00b7 ')); m.appendChild(h('span', l.bad ? 'tw' : 'tg', l.t)); });
    m.title = m.textContent;
    m.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 160, easing: 'ease-out' });
    clearTimeout(msgTimer); msgTimer = setTimeout(function () { if (lastState && !busy) renderDock(lastState, mode === 'play'); }, 3000);
  }
  function render(s, o) {
    o = o || {};
    var interactive = o.interactive !== false;
    lastState = s;
    renderTop(s); renderBag(s, interactive); renderShop(s, interactive); renderStash(s, interactive); renderStats(s); renderNext(s); renderArmy(s); renderDock(s, interactive);
    var fb = $('fight'), boss = s.nextWave && s.nextWave.type === 'boss';
    fb.disabled = !interactive || s.over || busy;
    fb.innerHTML = s.over ? 'GAME OVER' : 'FIGHT!<small>Wave ' + s.wave + '</small>' + (boss ? '<span class="bossTag">Boss Wave</span>' : '');
    fb.classList.toggle('red', !!boss); fb.classList.toggle('green', !boss);
    fb.classList.toggle('pulse', interactive && !s.over && !busy && s.bag.items.some(function (q) { return q.role === 'weapon' && q.powered; }));
    // floats for gold / hp changes
    if (shown && !o.noFloat && interactive) {
      if (s.gold !== shown.gold) floatAtEl($('goldVal'), (s.gold > shown.gold ? '+' : '') + (s.gold - shown.gold), s.gold > shown.gold ? 'g' : 'r');
      if (s.hp !== shown.hp) floatHp((s.hp > shown.hp ? '+' : '') + (s.hp - shown.hp) + ' HP', s.hp > shown.hp ? 'g' : 'r', 0);
    }
    shown = { gold: s.gold, hp: s.hp };
    applyFx();
  }
  function applyFx() {
    var f = fx; fx = null; if (!f) return;
    var q = function (src, id) { return document.querySelector('[data-src="' + src + '"][data-id="' + id + '"]'); };
    if (f.settle) { var e = q('bag', f.settle) || q('stash', f.settle); bounce(e); }
    if (f.merge) {
      var m = q('bag', f.merge) || q('stash', f.merge); pulse(m);
      if (m) { var r = m.getBoundingClientRect(); floatText('Lv' + f.level + '!', 'y', r.left + r.width / 2, r.top + 6, -34); }
    }
  }
  function refresh(o) { render(game.getState(), o); }

  // ---------------------------------------------------------------- actions / plans
  function subst(a, nid) { var c = {}; for (var k in a) c[k] = a[k] === '$new' ? nid : a[k]; return c; }
  function checkPlan(actions) {
    var c = game.clone(), nid = null;
    for (var i = 0; i < actions.length; i++) {
      var r = c.act(subst(actions[i], nid));
      if (!r.ok) return { ok: false, reason: r.error };
      if (actions[i].type === 'buy') nid = r.id;
    }
    return { ok: true };
  }
  function runPlan(actions) {
    var nid = null, last = null;
    for (var i = 0; i < actions.length; i++) {
      var r = game.act(subst(actions[i], nid));
      if (!r.ok) return { ok: false, reason: r.error };
      if (actions[i].type === 'buy') nid = r.id; last = r;
    }
    return { ok: true, nid: nid, last: last };
  }
  function cap(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
  // Run a plan from a click / button (no drag).
  function doPlan(actions, o) {
    o = o || {};
    if (busy) return;
    var chk = checkPlan(actions);
    if (!chk.ok) { msg(cap(chk.reason), true); return; }
    var before = game.getState();
    var res = runPlan(actions); if (!res.ok) { msg(cap(res.reason), true); return; }
    var placed = actions[actions.length - 1];
    var id = placed.type === 'merge' ? placed.a : (placed.id === '$new' ? res.nid : placed.id);
    fx = {};
    if (placed.type === 'merge') { fx.merge = id; fx.level = res.last.level; }
    else if (placed.type === 'buy') fx.settle = res.nid;
    else if (placed.type === 'place' || placed.type === 'move' || placed.type === 'unplace' || placed.type === 'rotate') fx.settle = id;
    if (!o.keepSel) sel = null;
    refresh();
    toast(changeLines(before, lastState));
  }

  // ---------------------------------------------------------------- drag and drop
  function pitch() {
    var c = document.querySelectorAll('#bagHost .cell'); return c[1].offsetLeft - c[0].offsetLeft;
  }
  function startDrag(p, e) {
    var s = lastState, src = p.src, kind, rot = 0, level = 1, base, srcEl = p.el;
    if (src === 'shop') { var sl = s.shop[p.slot]; if (!sl) return false; kind = sl.kind; rot = rotPending; }
    else { var it = (src === 'bag' ? s.bag.items : s.stash).filter(function (q) { return q.id === p.id; })[0]; if (!it) return false; kind = it.kind; rot = it.rot; level = it.level; }
    base = CAT[kind].shape;
    var pt = pitch(), cells = rotUnsorted(base, rot), ai = 0, offX = pt / 2, offY = pt / 2;
    if (src === 'bag') {
      var it2 = s.bag.items.filter(function (q) { return q.id === p.id; })[0], er = srcEl.getBoundingClientRect();
      var rx = e.clientX - er.left, ry = e.clientY - er.top, gx = Math.floor(rx / pt), gy = Math.floor(ry / pt), best = 1e9;
      cells.forEach(function (q, i) { var dd = Math.abs(q[0] - gx) + Math.abs(q[1] - gy); if (dd < best) { best = dd; ai = i; } });
      offX = Math.min(Math.max(rx - cells[ai][0] * pt, 4), pt - 4); offY = Math.min(Math.max(ry - cells[ai][1] * pt, 4), pt - 4);
    } else {
      var cx = 0, cy = 0; cells.forEach(function (q) { cx += q[0]; cy += q[1]; }); cx /= cells.length; cy /= cells.length;
      var bd = 1e9; cells.forEach(function (q, i) { var dd = Math.abs(q[0] - cx) + Math.abs(q[1] - cy); if (dd < bd) { bd = dd; ai = i; } });
    }
    drag = { src: src, id: p.id, slot: p.slot, kind: kind, level: level, rot: rot, ai: ai, offX: offX, offY: offY, srcEl: srcEl, plan: null, x: e.clientX, y: e.clientY };
    srcEl.classList.add('dragging');
    if (src === 'bag') { var lbe = document.querySelector('#bagHost .labs .lab-it[data-id="' + p.id + '"]'); if (lbe) lbe.classList.add('dragging'); }
    hideTip(); document.body.classList.add('dragging');
    buildFloater();
    if (src !== 'shop') {
      var sit = (src === 'bag' ? s.bag.items : s.stash).filter(function (q) { return q.id === p.id; })[0];
      drag.sellTxt = sit ? 'Sell for ' + sit.sellPrice : 'Sell'; $('sellTxt').textContent = drag.sellTxt;
      $('sell').classList.add('armed');
    }
    return true;
  }
  function dragCells() { return rotUnsorted(CAT[drag.kind].shape, drag.rot); }
  function buildFloater() {
    var fl = $('floater'); fl.innerHTML = '';
    var cells = dragCells();
    var el = itemEl({ kind: drag.kind, level: drag.level, cells: cells }); el.classList.add('inline'); el.style.setProperty('--c', 'var(--cell)');
    fl.appendChild(el); fl.style.display = 'block';
    var host = $('bagHost'); fl.style.setProperty('--cell', getComputedStyle(document.documentElement).getPropertyValue('--cell'));
    fl.style.setProperty('--g', '4px'); fl.style.setProperty('--r', '10px');
    positionFloater();
  }
  function positionFloater() {
    var pt = pitch(), a = dragCells()[drag.ai];
    var fl = $('floater');
    fl.style.transform = 'translate(' + (drag.x - a[0] * pt - drag.offX) + 'px,' + (drag.y - a[1] * pt - drag.offY) + 'px)';
  }
  function evalDrop() {
    var s = lastState, x = drag.x, y = drag.y;
    var under = document.elementFromPoint(x, y), plan = { type: 'none', ok: false };
    var sellEl = under && under.closest('#sell'), stashEl = under && under.closest('#stashPanel');
    var cellsEl = document.querySelector('#bagHost .cells'), cr = cellsEl.getBoundingClientRect();
    var inBag = x >= cr.left && x < cr.right && y >= cr.top && y < cr.bottom;
    if (sellEl) {
      plan.type = 'sell';
      if (drag.src === 'shop') { plan.reason = 'Shop items cannot be sold'; return plan; }
      var it = (drag.src === 'bag' ? s.bag.items : s.stash).filter(function (q) { return q.id === drag.id; })[0];
      plan.actions = [{ type: 'sell', id: drag.id }]; plan.label = 'Sell for ' + it.sellPrice;
      plan.ok = checkPlan(plan.actions).ok; return plan;
    }
    if (stashEl && !inBag) {
      plan.type = 'stash';
      if (drag.src === 'stash') { plan.reason = ''; return plan; }
      plan.actions = drag.src === 'shop' ? [{ type: 'buy', slot: drag.slot }] : [{ type: 'unplace', id: drag.id }];
      var ck = checkPlan(plan.actions); plan.ok = ck.ok; plan.reason = ck.reason ? cap(ck.reason) : ''; plan.label = drag.src === 'shop' ? 'Buy to stash' : 'Move to stash';
      return plan;
    }
    if (!inBag) return plan;
    var pt = pitch(), hx = Math.floor((x - cr.left) / pt), hy = Math.floor((y - cr.top) / pt);
    hx = Math.min(hx, s.bag.width - 1); hy = Math.min(hy, s.bag.height - 1);
    var tid = s.bag.grid[hy][hx];
    var tgt = tid && tid !== drag.id ? s.bag.items.filter(function (q) { return q.id === tid; })[0] : null;
    if (tgt && tgt.kind === drag.kind) {
      plan.type = 'merge'; plan.target = tgt.id;
      var b = drag.src === 'shop' ? '$new' : drag.id;
      plan.actions = (drag.src === 'shop' ? [{ type: 'buy', slot: drag.slot }] : []).concat([{ type: 'merge', a: tgt.id, b: b }]);
      var ck2 = checkPlan(plan.actions); plan.ok = ck2.ok; plan.reason = ck2.reason ? cap(ck2.reason) : ''; plan.label = 'Level up to Lv' + (tgt.level + 1);
      return plan;
    }
    var a = dragCells()[drag.ai], ox = hx - a[0], oy = hy - a[1];
    plan.type = 'place'; plan.x = ox; plan.y = oy;
    plan.ghost = dragCells().map(function (q) { return [q[0] + ox, q[1] + oy]; });
    if (drag.src === 'shop') plan.actions = [{ type: 'buy', slot: drag.slot }, { type: 'place', id: '$new', x: ox, y: oy, rot: drag.rot }];
    else if (drag.src === 'stash') plan.actions = [{ type: 'place', id: drag.id, x: ox, y: oy, rot: drag.rot }];
    else plan.actions = [{ type: 'move', id: drag.id, x: ox, y: oy, rot: drag.rot }];
    var ck3 = checkPlan(plan.actions); plan.ok = ck3.ok; plan.reason = ck3.reason ? cap(ck3.reason) : '';
    return plan;
  }
  function paintDrop(plan) {
    var ghost = document.querySelector('#bagHost .ghost'); ghost.innerHTML = '';
    document.querySelectorAll('.mergeHot').forEach(function (e) { e.classList.remove('mergeHot'); });
    var pt = pitch(), has = {};
    if (plan.type === 'place' && plan.ghost) {
      plan.ghost.forEach(function (q) { has[q[0] + ',' + q[1]] = 1; });
      plan.ghost.forEach(function (q) {
        if (q[0] < 0 || q[1] < 0 || q[0] >= lastState.bag.width || q[1] >= lastState.bag.height) return;
        var g = h('div', 'gc ' + (plan.ok ? 'ok' : 'bad')), c = pt - 4;
        g.style.left = 'calc(' + q[0] + ' * (var(--c) + var(--g)))'; g.style.top = 'calc(' + q[1] + ' * (var(--c) + var(--g)))';
        g.style.width = 'calc(var(--c) + ' + (has[(q[0] + 1) + ',' + q[1]] ? 'var(--g)' : '0px') + ')'; g.style.height = 'calc(var(--c) + ' + (has[q[0] + ',' + (q[1] + 1)] ? 'var(--g)' : '0px') + ')';
        ghost.appendChild(g);
      });
    }
    if (plan.type === 'merge') { var te = document.querySelector('#bagHost .it[data-id="' + plan.target + '"]'); if (te) te.classList.add('mergeHot'); }
    $('sell').classList.toggle('hot', plan.type === 'sell' && plan.ok); $('sell').classList.toggle('hotbad', plan.type === 'sell' && !plan.ok);
    $('stashPanel').classList.toggle('hot', plan.type === 'stash' && plan.ok); $('stashPanel').classList.toggle('hotbad', plan.type === 'stash' && !plan.ok && !!plan.reason);
    if (plan.type === 'sell') $('sellTxt').textContent = plan.ok ? plan.label : plan.reason || 'Cannot sell';
    else if (drag.sellTxt) $('sellTxt').textContent = drag.sellTxt;
    var tipEl = $('dragTip'), txt = plan.ok ? (plan.type === 'place' ? '' : plan.label) : (plan.reason || '');
    if (txt && plan.type !== 'sell') {
      tipEl.textContent = txt; tipEl.className = plan.ok ? 'ok' : 'bad'; tipEl.style.display = 'block';
      tipEl.style.left = Math.min(drag.x + 16, innerWidth - 220) + 'px'; tipEl.style.top = (drag.y + 22) + 'px';
    } else tipEl.style.display = 'none';
  }
  function cleanupDrag() {
    $('floater').style.display = 'none'; $('floater').innerHTML = ''; $('dragTip').style.display = 'none';
    document.body.classList.remove('dragging');
    var g = document.querySelector('#bagHost .ghost'); if (g) g.innerHTML = '';
    document.querySelectorAll('.mergeHot,.dragging').forEach(function (e) { e.classList.remove('mergeHot'); e.classList.remove('dragging'); });
    ['sell', 'stashPanel'].forEach(function (i) { $(i).classList.remove('hot'); $(i).classList.remove('hotbad'); });
    $('sellTxt').textContent = 'Drop here to sell';
    $('sell').classList.remove('armed');
  }
  // touch: the dragged item floats a little above the finger, so the finger does not hide it.
  // The drop is judged where the item is drawn, not under the finger.
  function liftOf(p) { return p && p.touch ? Math.round(pitch() * 0.55) : 0; }
  function onDown(e) {
    var touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    var t = e.target.closest && e.target.closest('[data-drag]');
    if (!t || busy || mode !== 'play' || e.button !== 0 || drag) {
      // touch has no hover: a tap on a stat (gold, HP, next wave) shows its info
      if (touch && !drag) { var ti = e.target.closest && e.target.closest('[data-tip="text"]'); if (ti) showTip(ti); }
      if (!t || busy || mode !== 'play' || drag) return;
      if (e.button !== 0) return;
    }
    e.preventDefault();
    pend = { el: t, x0: e.clientX, y0: e.clientY, src: t.dataset.src, id: +t.dataset.id, slot: +t.dataset.slot, touch: touch };
    // long-press on touch = show the item info (the hover tooltip of the mouse)
    if (touch) { var pp = pend; pp.lp = setTimeout(function () { if (pend === pp && !drag) { pp.lpShown = true; showTip(pp.el); } }, 420); }
  }
  function onMove(e) {
    if (pend && !drag) {
      if (Math.abs(e.clientX - pend.x0) + Math.abs(e.clientY - pend.y0) < (pend.touch ? 9 : 6)) return;
      clearTimeout(pend.lp); hideTip();
      var ok = startDrag(pend, { clientX: pend.x0, clientY: pend.y0 }); pend.started = ok; if (!ok) { pend = null; return; }
      drag.lift = liftOf(pend);
    }
    if (!drag) return;
    if (e.cancelable) e.preventDefault();
    drag.x = e.clientX; drag.y = e.clientY - drag.lift; positionFloater();
    drag.plan = evalDrop(); paintDrop(drag.plan);
  }
  function onUp(e) {
    if (!pend) return;
    var p = pend; pend = null; clearTimeout(p.lp);
    if (!drag) { if (!p.lpShown) clickItem(p); return; }
    drag.x = e.clientX; drag.y = e.clientY - drag.lift;
    var plan = evalDrop(), d = drag; drag = null;
    var fl = $('floater'), flRect = fl.firstChild ? fl.firstChild.getBoundingClientRect() : null;
    var clone = fl.firstChild ? fl.firstChild.cloneNode(true) : null;
    cleanupDrag();
    if (plan.ok && plan.actions) { commitDrop(d, plan, clone, flRect); }
    else {
      if (plan.reason) msg(plan.reason, true); else if (plan.type === 'none') msg('');
      if (clone && flRect) {
        clone.style.cssText += ';position:fixed;left:' + flRect.left + 'px;top:' + flRect.top + 'px;margin:0;opacity:.8;z-index:250;--c:' + getComputedStyle(document.documentElement).getPropertyValue('--cell') + ';--g:4px;--r:10px';
        $('fxlayer').appendChild(clone);
        var back = d.srcEl.getBoundingClientRect();
        var a = clone.animate([{ transform: 'translate(0,0)' }, { transform: 'translate(' + (back.left - flRect.left + (back.width - flRect.width) / 2) + 'px,' + (back.top - flRect.top + (back.height - flRect.height) / 2) + 'px) scale(' + Math.min(1, back.width / flRect.width) + ')' }], { duration: 200, easing: 'ease-in-out', fill: 'forwards' });
        a.onfinish = function () { clone.remove(); };
      }
    }
  }
  function commitDrop(d, plan, clone, flRect) {
    var before = game.getState();
    var res = runPlan(plan.actions);
    if (!res.ok) { msg(cap(res.reason), true); refresh(); return; }
    var lastA = plan.actions[plan.actions.length - 1];
    fx = {};
    if (plan.type === 'merge') { fx.merge = lastA.a; fx.level = res.last.level; }
    else if (plan.type === 'place') fx.settle = lastA.id === '$new' ? res.nid : lastA.id;
    else if (plan.type === 'stash') fx.settle = d.src === 'shop' ? res.nid : d.id;
    var sellFlyRect = null;
    if (plan.type === 'sell') {
      var sr = $('sell').getBoundingClientRect(); sellFlyRect = sr;
      if (clone && flRect) {
        clone.style.cssText += ';position:fixed;left:' + flRect.left + 'px;top:' + flRect.top + 'px;margin:0;z-index:250;--c:' + getComputedStyle(document.documentElement).getPropertyValue('--cell') + ';--g:4px;--r:10px';
        $('fxlayer').appendChild(clone);
        var dx = sr.left + sr.width / 2 - (flRect.left + flRect.width / 2), dy = sr.top + sr.height / 2 - (flRect.top + flRect.height / 2);
        var a = clone.animate([{ transform: 'translate(0,0) scale(1)', opacity: .8 }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.15)', opacity: 0 }], { duration: 260, easing: 'ease-in', fill: 'forwards' });
        a.onfinish = function () { clone.remove(); };
        var coin = new Image(); coin.src = 'assets/ui/coin.png'; coin.style.cssText = 'position:fixed;width:30px;height:30px;left:' + (sr.left + sr.width / 2 - 15) + 'px;top:' + (sr.top + sr.height / 2 - 15) + 'px';
        $('fxlayer').appendChild(coin);
        var ca = coin.animate([{ transform: 'scale(.2)', opacity: 0 }, { transform: 'scale(1.5)', opacity: 1, offset: .5 }, { transform: 'scale(1) translateY(-26px)', opacity: 0 }], { duration: 700, delay: 200, easing: 'ease-out', fill: 'backwards' });
        ca.onfinish = function () { coin.remove(); };
      }
    }
    sel = null;
    refresh();
    toast(changeLines(before, lastState));
  }
  function clickItem(p) {
    // a click (no movement) on a draggable thing = select / merge target
    var s = lastState;
    if (sel && (sel.src !== p.src || sel.id !== p.id || sel.slot !== p.slot) && p.src === 'bag') {
      // clicking another bag item with something selected: merge if possible, else select that one
      var other = p.id, selId = sel.src === 'shop' ? null : sel.id;
      var si = selectedInfo(s), oi = s.bag.items.filter(function (q) { return q.id === other; })[0];
      if (si && oi && si.kind === oi.kind && (sel.src === 'shop' || si.it.level === oi.level) && si.it !== oi) {
        var acts = sel.src === 'shop' ? [{ type: 'buy', slot: sel.slot }, { type: 'merge', a: other, b: '$new' }] : [{ type: 'merge', a: other, b: selId }];
        if (checkPlan(acts).ok) { var ss = sel; sel = null; doPlan(acts, { merge: other }); return; }
      }
    }
    if (sel && sel.src === p.src && sel.id === p.id && sel.slot === p.slot) sel = null;
    else sel = p.src === 'shop' ? { src: 'shop', slot: p.slot } : { src: p.src, id: p.id };
    refresh();
    // touch: a tap shows the item info as well (there is no hover)
    if (p.touch && sel) {
      var el = sel.src === 'shop' ? document.querySelector('.shopcard[data-slot="' + sel.slot + '"]') : document.querySelector('[data-src="' + sel.src + '"][data-id="' + sel.id + '"]');
      if (el) showTip(el);
    }
  }
  // click-to-place fallback: click an empty cell with something selected
  document.addEventListener('click', function (e) {
    if (busy || mode !== 'play' || !sel) return;
    var cellE = e.target.closest && e.target.closest('#bagHost .cell');
    var stashE = e.target.closest && e.target.closest('#stashPanel');
    var s = lastState;
    if (cellE) {
      var x = +cellE.dataset.x, y = +cellE.dataset.y, rot = 0, acts;
      if (sel.src === 'shop') { rot = rotPending; acts = [{ type: 'buy', slot: sel.slot }, { type: 'place', id: '$new', x: x, y: y, rot: rot }]; }
      else if (sel.src === 'stash') { var it = s.stash.filter(function (q) { return q.id === sel.id; })[0]; acts = [{ type: 'place', id: sel.id, x: x, y: y, rot: it ? it.rot : 0 }]; }
      else acts = [{ type: 'move', id: sel.id, x: x, y: y }];
      var wasShop = sel.src === 'shop'; var ck = checkPlan(acts);
      if (!ck.ok) { msg(cap(ck.reason), true); return; }
      doPlan(acts, {});
    } else if (stashE && !e.target.closest('.it,.slot .it')) {
      if (sel.src === 'shop') doPlan([{ type: 'buy', slot: sel.slot }], {});
      else if (sel.src === 'bag') doPlan([{ type: 'unplace', id: sel.id }], {});
    }
  });
  document.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('touchmove', function (e) { if (drag || pend) e.preventDefault(); }, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', function () { if (drag) { cleanupDrag(); drag = null; } pend = null; });
  function rotateKey() {
    if (drag) { drag.rot = (drag.rot + 1) & 3; buildFloater(); drag.plan = evalDrop(); paintDrop(drag.plan); return; }
    if (!sel || busy || mode !== 'play') return;
    if (sel.src === 'shop') { rotPending = (rotPending + 1) & 3; msg('Rotation set. Now click a spot in your bag.'); }
    else doPlan([{ type: 'rotate', id: sel.id }], { keepSel: true });
  }
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && mode === 'play') { rotateKey(); e.preventDefault(); }
    if (e.key === 'Escape' && sel) { sel = null; refresh(); }
  });
  document.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('#app,#floater') || drag) { e.preventDefault(); if (drag) rotateKey(); } });
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('button'); if (b && e.detail > 0) b.blur(); });
  document.addEventListener('dragstart', function (e) { e.preventDefault(); });
  document.addEventListener('selectstart', function (e) { e.preventDefault(); });

  // ---------------------------------------------------------------- overlays
  function showOv(el) { el.classList.add('show'); }
  function hideOv(el) { el.classList.remove('show'); }

  // ---------------------------------------------------------------- how to play
  function buildHelp() {
    var el = $('help'), card = h('div', 'card');
    var w = capSoldier(), boss = CFG.enemies.boss.name;
    var mk = function (k, c, lv) { var e = itemEl({ kind: k, level: lv || 1, cells: [[0, 0]] }); e.classList.add('inline'); e.style.setProperty('--c', c + 'px'); return e; };
    var steps = [
      { t: '<b>Drag</b> items from the shop into your bag. Tap or hover an item to see what it does.', pic: function () {
        var p = h('div', 'pic');
        var mc = h('div', 'mcard'); mc.appendChild(mk('soldier', 28)); mc.appendChild(h('span', '', CAT.soldier.cost));
        p.appendChild(mc); p.appendChild(h('span', 'arrow', '&rarr;'));
        var mini = h('div', 'mini'); for (var i = 0; i < 9; i++) { var c = h('i'); if (i === 4) { c.appendChild(spriteEl('soldier')); c.style.background = mix(CFG.items.soldier.color, '#ffffff', 0.5); } mini.appendChild(c); }
        p.appendChild(mini); return p; } },
      { t: 'A <b>soldier</b> next to a weapon makes it fire. Two soldiers = it fires <b>twice</b>. A soldier powers ' + w + ' weapons. Sides touch, corners do not.', pic: function () {
        var p = h('div', 'pic'); p.style.gap = '2px';
        var col = h('div', ''); col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px';
        col.appendChild(mk('sword', 28)); col.appendChild(h('div', 'firepill', 'x2'));
        p.appendChild(mk('soldier', 28)); p.appendChild(h('i', 'ln')); p.appendChild(col); p.appendChild(h('i', 'ln')); p.appendChild(mk('soldier', 28)); return p; } },
      { t: 'Drop an item on the <b>same item</b> to level it up. Level 2 has an <b style="color:#e07800">orange</b> frame, level 3 a <b style="color:#9b2ee0">purple</b> one.', pic: function () {
        var p = h('div', 'pic');
        p.style.gap = '2px'; p.appendChild(mk('sword', 26)); p.appendChild(h('span', 'arrow', '+')); p.appendChild(mk('sword', 26)); p.appendChild(h('span', 'arrow', '&rarr;')); p.appendChild(mk('sword', 26, 2)); return p; } },
      { t: '<b>Whetstone</b>: swords and daggers +' + CAT.whetstone.flat + ' damage. <b>Anvil</b>: hammers and axes +' + Math.round(CAT.anvil.mult * 100) + '%. Both must touch the weapon. Shields and herbs work anywhere.', pic: function () {
        var p = h('div', 'pic'); p.style.gap = '3px';
        p.appendChild(mk('whetstone', 28)); p.appendChild(h('div', 'hlink', '+' + CAT.whetstone.flat)); p.appendChild(mk('sword', 28));
        var sp = h('span', ''); sp.style.width = '4px'; p.appendChild(sp); p.appendChild(mk('shield', 28)); return p; } },
      { t: 'Check the next wave, then press <b>FIGHT!</b> Survive ' + CFG.waves + ' waves. Wave ' + CFG.waves + ' is the ' + boss + '.', pic: function () {
        var p = h('div', 'pic'); var im = new Image(); im.src = 'assets/enemy-boss.png'; im.alt = ''; im.style.cssText = 'height:50px;width:44px;object-fit:contain'; p.appendChild(im); p.appendChild(h('span', 'fakebtn', 'FIGHT!')); return p; } }
    ];
    card.appendChild(h('div', 'head', '<h1>How to play</h1>'));
    var list = h('div', 'steps');
    steps.forEach(function (st, i) {
      var row = h('div', 'step'); var pic = st.pic(); pic.appendChild(h('div', 'n', i + 1)); row.appendChild(pic); row.appendChild(h('div', 't', st.t)); list.appendChild(row);
    });
    card.appendChild(list);
    var act = h('div', 'help-actions'); var b = h('button', 'chunky green', 'Play!'); b.id = 'helpStart'; act.appendChild(b); card.appendChild(act);
    el.innerHTML = ''; el.appendChild(card);
    b.onclick = function () { try { localStorage.setItem('bagbattler.help.seen', '1'); } catch (e) { } hideOv(el); };
  }
  function maybeHelp() {
    var hp = params.get('help'), seen = false; try { seen = localStorage.getItem('bagbattler.help.seen'); } catch (e) { }
    buildHelp();
    if (hp === '1' || (hp !== '0' && !seen)) showOv($('help'));
  }
  $('helpBtn').onclick = function () { hideTip(); showOv($('help')); };

  // ---------------------------------------------------------------- battle (plays on the battlefield at the top)
  function waitB(ms) {
    return new Promise(function (res) {
      if (battleCtl.skip) return res();
      var t = setTimeout(function () { battleCtl.waiters = battleCtl.waiters.filter(function (w) { return w !== fn; }); res(); }, ms);
      var fn = function () { clearTimeout(t); res(); }; battleCtl.waiters.push(fn);
    });
  }
  var shotCount = {};
  function buildBattle(info, s) {
    hideTip(); shotCount = {};
    $('app').classList.add('battling');
    $('dock').innerHTML = '';
    $('turnBar').hidden = false; $('turnTxt').textContent = 'Wave ' + s.wave;
    renderFoes(info);
    var box = $('bFoes'), wdt = box.clientWidth + 40;
    box.querySelectorAll('.foe').forEach(function (f, k) {
      f.animate([{ transform: 'translateX(' + wdt + 'px)' }, { transform: 'translateX(0)' }], { duration: 650, delay: k * 35, easing: 'cubic-bezier(.25,.8,.35,1)', fill: 'backwards' });
    });
    $('army').querySelectorAll('.unit').forEach(function (u, k) {
      u.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-10px)', offset: .4 }, { transform: 'translateY(0)' }], { duration: 360, delay: 300 + k * 50 });
    });
    setBattleHp(s.hp, s.maxHp);
  }
  function setBattleHp(hp, max) {
    $('hpFill').style.width = Math.max(0, hp / max * 100) + '%'; $('hpTxt').textContent = Math.max(0, hp) + '/' + max;
  }
  function foeEl(i) { return document.querySelector('#bFoes .foe[data-i="' + i + '"]'); }
  function setFoe(i, hp, max) {
    var f = foeEl(i); if (!f) return;
    var fb = f.querySelector('.fbar i'); if (fb) fb.style.width = Math.max(0, hp / max * 100) + '%';
    foeHp[i] = Math.max(0, hp); var gb = document.querySelector('#bFoes .fbar.group i');
    if (gb) gb.style.width = Math.max(0, foeHp.reduce(function (a, b) { return a + b; }, 0) / foeMax * 100) + '%';
  }
  function killFoe(i) {
    var f = foeEl(i); if (!f || f.classList.contains('dead')) return;
    var c = centerOf(f); var p = h('div', 'poof'); p.style.left = c[0] + 'px'; p.style.top = c[1] + 'px'; $('fxlayer').appendChild(p);
    var a = p.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(1.8)', opacity: 0 }], { duration: 380, easing: 'ease-out' });
    a.onfinish = function () { p.remove(); };
    f.classList.add('dead');
  }
  function centerOf(el) { var r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
  function fireShot(sh, T, hpState, max) {
    var st = lastState, f = foeEl(sh.enemyIndex); if (!f) return;
    var wEl = document.querySelector('#bagHost .it[data-id="' + sh.weaponId + '"]');
    var wi = st.bag.items.filter(function (q) { return q.id === sh.weaponId; })[0];
    var ln = (st.links || []).filter(function (l) { return l.weapon === sh.weaponId; });
    var n = shotCount[sh.weaponId] = (shotCount[sh.weaponId] || 0) + 1;
    var u = ln.length ? document.querySelector('#army .unit[data-id="' + ln[n % ln.length].soldier + '"]') : null;
    if (wEl) { wEl.classList.remove('fire'); void wEl.offsetWidth; wEl.classList.add('fire'); }
    if (u) u.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(9px) rotate(7deg)', offset: .35 }, { transform: 'translateX(0)' }], { duration: Math.min(260, T * 0.5) });
    var a = u ? centerOf(u) : centerOf($('army')), b = centerOf(f.querySelector('img.me'));
    var hit = function () {
      if (!document.body.contains(f)) return;
      hpState[sh.enemyIndex] -= sh.rawDmg; setFoe(sh.enemyIndex, hpState[sh.enemyIndex], max);
      var ir = f.querySelector('img.me').getBoundingClientRect();
      floatText('-' + sh.rawDmg, 'dmg', ir.left + ir.width / 2 + (Math.random() * 24 - 12), ir.top - 4, -26);
      f.classList.add('hurt'); setTimeout(function () { f.classList.remove('hurt'); }, 110);
      f.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(5px)', offset: .3 }, { transform: 'translateX(-3px)', offset: .65 }, { transform: 'translateX(0)' }], { duration: 160 });
      if (sh.killed) setTimeout(function () { killFoe(sh.enemyIndex); }, 120);
    };
    if (!wi) { setTimeout(hit, 80); return; }
    var pr = spriteEl(wi.kind, 'proj'); pr.style.left = (a[0] - 13) + 'px'; pr.style.top = (a[1] - 13) + 'px'; $('fxlayer').appendChild(pr);
    var dx = b[0] - a[0], dy = b[1] - a[1], dur = Math.max(110, Math.min(260, T * 0.45));
    var an = pr.animate([{ transform: 'translate(0,0) rotate(0deg) scale(.8)' }, { transform: 'translate(' + dx / 2 + 'px,' + (dy / 2 - 26) + 'px) rotate(220deg) scale(1)' }, { transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(420deg) scale(.9)' }], { duration: dur, easing: 'linear', fill: 'forwards' });
    an.onfinish = function () { pr.remove(); hit(); };
  }
  async function playTrace(tr, s) {
    var n = tr.turns.length, T = Math.max(60, Math.min(600, 3200 / Math.max(1, n)));
    var lead = Math.max(700, 3000 - n * T - 300);
    var hpState = []; for (var i = 0; i < tr.enemyCount; i++) hpState.push(tr.enemyMaxHp);
    battleInfo = { turn: 0, total: n };
    await waitB(lead);
    var myHp = s.hp;
    for (var t = 0; t < n && !battleCtl.skip; t++) {
      var turn = tr.turns[t]; battleInfo.turn = t + 1; $('turnTxt').textContent = 'Turn ' + (t + 1) + '/' + n;
      var shots = turn.shots, gap = shots.length ? Math.min(T * 0.5 / shots.length, 90) : 0;
      shots.forEach(function (sh, k) { setTimeout(function () { if (!battleCtl.skip) fireShot(sh, T, hpState, tr.enemyMaxHp); }, k * gap); });
      await waitB(T * 0.6);
      if (battleCtl.skip) break;
      if (turn.alive > 0) {
        document.querySelectorAll('#bFoes .foe:not(.dead)').forEach(function (f, k) { if (k < CFG.battle.maxAttackers) f.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-16px)', offset: .4 }, { transform: 'translateX(0)' }], { duration: Math.min(240, T * .4) }); });
        if (turn.hit > 0) document.querySelectorAll('#army .unit').forEach(function (u) { u.classList.add('hurtR'); setTimeout(function () { u.classList.remove('hurtR'); }, 120); });
        myHp = turn.hpAfter; setBattleHp(myHp, s.maxHp);
        if (turn.hit > 0) floatHp('-' + turn.hit, 'r', 0);
        if (turn.blocked > 0) floatHp('⛨ ' + turn.blocked + ' blocked', 'y sm', 1);
      }
      await waitB(T * 0.4);
    }
    if (battleCtl.skip) {
      for (var q = 0; q < tr.enemyCount; q++) { var left = tr.turns.length ? tr.turns[n - 1].enemyHp[q] : tr.enemyMaxHp; setFoe(q, left, tr.enemyMaxHp); if (left <= 0) killFoe(q); }
      setBattleHp(tr.hpAfter, s.maxHp);
      await sleep(250);
    } else await waitB(300);
  }
  async function playLogOnly(lines) {
    for (var i = 0; i < lines.length && !battleCtl.skip; i++) { $('turnTxt').textContent = lines[i].slice(0, 40); await waitB(Math.max(60, Math.min(600, 3500 / lines.length))); }
  }
  function heroArt(won) {
    var d = h('div', 'hero'); var g = new Image(); g.src = 'assets/ui/glow.png'; g.alt = ''; g.className = 'glow'; d.appendChild(g);
    var m = new Image(); m.src = 'assets/ui/hero-' + (won ? 'win' : 'lose') + '.png'; m.alt = ''; m.className = 'me'; d.appendChild(m); return d;
  }
  function showBanner(o) {
    var b = $('banner'); b.innerHTML = ''; var card = h('div', 'card');
    card.appendChild(h('div', 'head ' + (o.won ? 'green' : 'red'), '<h1>WAVE ' + o.wave + (o.won ? ' WON' : ' LOST') + '</h1>'));
    card.appendChild(heroArt(o.won));
    var res = h('div', 'res');
    res.appendChild(h('span', 'chip', '<img src="assets/ui/heart.png" alt="">' + o.hp + '/' + o.max));
    if (o.won && o.gold) res.appendChild(h('span', 'chip', '<img src="assets/ui/coin.png" alt="">+' + o.gold));
    card.appendChild(res);
    if (o.sub) card.appendChild(h('div', 'sub', o.sub));
    var btn = h('button', 'chunky green go', o.btn); btn.id = 'bannerBtn'; card.appendChild(btn);
    b.appendChild(card); showOv(b);
    return new Promise(function (res2) { btn.onclick = function () { hideOv(b); res2(); }; });
  }
  function closeBattle() { $('app').classList.remove('battling'); $('turnBar').hidden = true; battleCtl = null; battleInfo = null; }
  function flyCoins(n, from) {
    var gi = $('goldBox').querySelector('img'), to = gi.getBoundingClientRect(), tx = to.left + to.width / 2, ty = to.top + to.height / 2, all = [];
    for (var k = 0; k < n; k++) (function (k) {
      var c = new Image(); c.src = 'assets/ui/coin.png'; c.alt = ''; c.className = 'flycoin';
      var x = from[0] + (Math.random() * 60 - 30), y = from[1] + (Math.random() * 30 - 15);
      c.style.left = (x - 14) + 'px'; c.style.top = (y - 14) + 'px'; $('fxlayer').appendChild(c);
      var a = c.animate([{ transform: 'translate(0,0) scale(.3)', opacity: 0 }, { transform: 'translate(0,-18px) scale(1.15)', opacity: 1, offset: .25 }, { transform: 'translate(' + (tx - x) + 'px,' + (ty - y) + 'px) scale(.75)', opacity: 1 }], { duration: 700, delay: k * 70, easing: 'cubic-bezier(.45,0,.6,1)', fill: 'backwards' });
      all.push(new Promise(function (res) { a.onfinish = function () { c.remove(); bounce($('goldBox')); res(); }; }));
    })(k);
    return Promise.all(all);
  }

  async function startFight() {
    if (busy || mode !== 'play' || game.over) return;
    busy = true; sel = null; refresh({ noFloat: true });
    var s = lastState, pre = { hp: s.hp, gold: s.gold, wave: s.wave };
    var tr = null, sim = game.simulate(), ok = false;
    try { tr = BattleTrace.traceBattle(game.clone()); ok = tr.won === sim.won && tr.hpAfter === sim.hpAfter && tr.ticks === sim.ticks; } catch (e) { console.warn('trace failed', e); }
    if (!ok) console.warn('battle trace differs from simulate(); showing the log only');
    battleCtl = { skip: false, waiters: [] };
    buildBattle(tr ? tr.info : game.waveInfo(s.wave), s);
    if (ok) await playTrace(tr, s); else await playLogOnly(sim.log);
    var r = game.act({ type: 'fight' });
    var st = game.getState();
    var gain = (r.income || 0) + (r.interest || 0);
    var healed = r.won && !r.over ? st.hp - sim.hpAfter : (r.won ? Math.min(CFG.maxHp, sim.hpAfter + sim.heal) - sim.hpAfter : 0);
    var foesC = centerOf($('bFoes'));
    await showBanner({ won: r.won, wave: pre.wave, hp: st.hp, max: st.maxHp, gold: gain, btn: r.over ? 'See result' : 'Continue',
      sub: r.won ? (r.over ? '' : (healed > 0 ? 'Healed +' + healed + ' HP. ' : '') + 'The shop is open.') : 'The enemy was too strong.' });
    closeBattle(); busy = false;
    shown = { gold: pre.gold, hp: pre.hp };
    render(st, { noFloat: true });
    var gEl = $('goldVal'), k = 0;
    if (r.won && gain > 0 && !r.over) {
      gEl.textContent = pre.gold;
      await flyCoins(Math.max(3, Math.min(9, gain)), foesC);
      gEl.textContent = st.gold;
    }
    if (r.income) floatAtEl(gEl, '+' + r.income + ' income', 'g', k++);
    if (r.interest) floatAtEl(gEl, '+' + r.interest + ' interest', 'g', k++);
    if (healed > 0) floatHp('+' + healed + ' HP', 'g', 0);
    shown = { gold: st.gold, hp: st.hp };
    if (r.over) showEnd(st);
  }
  $('fight').onclick = startFight;
  $('rerollBtn').onclick = function () { doPlan([{ type: 'reroll' }], {}); };
  $('skipBtn').onclick = function () { if (battleCtl) { battleCtl.skip = true; battleCtl.waiters.slice().forEach(function (f) { f(); }); } };

  // ---------------------------------------------------------------- end screens
  function showEnd(s) {
    var el = $('end'); el.innerHTML = ''; var card = h('div', 'card');
    if (s.won) {
      card.appendChild(h('div', 'head green', '<h1>Victory!</h1>')); card.appendChild(heroArt(true));
      card.appendChild(h('div', 'sub', 'The ' + CFG.enemies.boss.name + ' falls. You cleared all ' + s.totalWaves + ' waves with ' + s.hp + '/' + s.maxHp + ' HP left.'));
    } else {
      card.appendChild(h('div', 'head red', '<h1>Defeated</h1>')); card.appendChild(heroArt(false));
      var res = h('div', 'res'); res.appendChild(h('span', 'chip', 'Wave ' + (s.lastBattle ? s.lastBattle.wave : s.wave) + '/' + s.totalWaves)); card.appendChild(res);
      card.appendChild(h('div', 'sub', 'Check the next wave before you fight, and keep every weapon next to a soldier.'));
    }
    var b = h('button', 'chunky green go', 'Play again'); b.id = 'againBtn'; b.onclick = function () { hideOv(el); newGame(); }; card.appendChild(b);
    el.appendChild(card); showOv(el);
  }

  // ---------------------------------------------------------------- game / modes
  function newGame(seed) {
    var sd = seed !== undefined ? seed : Math.floor(Math.random() * 1e6);
    game = new G(sd); sel = null; rotPending = 0; busy = false; shown = null;
    refresh({ noFloat: true });
  }
  function setMode(m) {
    mode = m; hideOv($('end'));
    $('tabPlay').hidden = m !== 'replay'; $('tabReplay').hidden = m === 'replay';
    $('replayBar').hidden = m !== 'replay'; $('shopArea').hidden = m === 'replay'; $('bottom').hidden = m === 'replay';
    $('app').classList.toggle('replay', m === 'replay');
    hideTip();
    stopAuto();
    if (m === 'play') { if (!game || game.over) newGame(); else refresh({ noFloat: true }); }
    else {
      sel = null; shown = null;
      if (rep.lines.length) showStep(); else { var st = new G(1).getState(); st.shop = [null, null, null]; render(st, { interactive: false, noFloat: true }); $('act').innerHTML = '<b>Action:</b> choose a .jsonl log file written by run.js --log'; $('reason').innerHTML = ''; $('pos').textContent = ''; }
    }
  }
  $('tabPlay').onclick = function () { setMode('play'); }; $('tabReplay').onclick = function () { setMode('replay'); };

  // ---------------------------------------------------------------- replay
  function showStep() {
    var l = rep.lines[rep.i]; if (!l) return;
    l.state.catalog = CAT;
    render(l.state, { interactive: false, noFloat: true });
    $('pos').textContent = 'step ' + l.step + ' (' + (rep.i + 1) + '/' + rep.lines.length + ')';
    $('act').innerHTML = '<b>Action:</b> <code>' + (l.action ? JSON.stringify(l.action) : '(game over)') + '</code>';
    $('reason').innerHTML = '<b>Reason:</b> ' + (l.reason ? String(l.reason).replace(/</g, '&lt;') : '(none given)');
    $('act').title = $('act').textContent; $('reason').title = $('reason').textContent;
  }
  function step(d) { rep.i = Math.max(0, Math.min(rep.lines.length - 1, rep.i + d)); showStep(); }
  function stopAuto() { rep.playing = false; clearTimeout(rep.timer); $('auto').textContent = 'play'; }
  async function replayFight(l, nx) {
    var s = l.state; s.catalog = CAT;
    var g = G.fromState(s), tr = null, ok = false;
    try {
      tr = BattleTrace.traceBattle(g.clone()); var sim = g.simulate();
      ok = tr.won === sim.won && tr.hpAfter === sim.hpAfter && tr.ticks === sim.ticks;
      if (ok && nx) { var exp = tr.won ? Math.min(s.maxHp, tr.hpAfter + tr.heal) : tr.hpAfter; if (nx.state.hp !== exp) ok = false; }
    } catch (e) { ok = false; }
    var lines = nx && nx.state.lastBattle ? nx.state.lastBattle.log : ['Fight.'];
    if (!ok) console.warn('replay: trace differs from the log; showing the log only');
    battleCtl = { skip: false, waiters: [] };
    buildBattle(ok ? tr.info : G.fromState(s).waveInfo(s.wave), s, tr);
    if (ok) await playTrace(tr, s); else await playLogOnly(lines);
    closeBattle();
  }
  function autoTick() {
    if (!rep.playing) return;
    if (rep.i >= rep.lines.length - 1) { stopAuto(); return; }
    var l = rep.lines[rep.i], nx = rep.lines[rep.i + 1];
    if (l.action && l.action.type === 'fight') {
      replayFight(l, nx).then(function () { if (!rep.playing) return; step(1); rep.timer = setTimeout(autoTick, 500); });
    } else { step(1); rep.timer = setTimeout(autoTick, 700); }
  }
  $('prev').onclick = function () { step(-1); }; $('next').onclick = function () { step(1); };
  $('auto').onclick = function () {
    if (rep.playing) { stopAuto(); return; }
    if (!rep.lines.length) return;
    rep.playing = true; $('auto').textContent = 'pause'; autoTick();
  };
  function loadLog(text) {
    rep.lines = text.split('\n').filter(function (x) { return x.trim(); }).map(function (x) { return JSON.parse(x); }); rep.i = 0;
    if (mode !== 'replay') setMode('replay'); else showStep();
  }
  $('file').onchange = function (e) { var f = e.target.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { loadLog(r.result); }; r.readAsText(f); };
  window.BagUI = { loadLog: loadLog, step: step };

  // read-only debug handle for tests
  window.__bag = { refresh: function () { refresh({ noFloat: true }); } };
  Object.defineProperty(window.__bag, 'game', { get: function () { return game; } });
  Object.defineProperty(window.__bag, 'battle', { get: function () { return battleInfo; } });
  Object.defineProperty(window.__bag, 'drag', { get: function () { return drag ? { ok: !!(drag.plan && drag.plan.ok), type: drag.plan && drag.plan.type } : null; } });

  // ---------------------------------------------------------------- start
  // ---------------------------------------------------------------- layout: one portrait phone screen
  // On a phone the game fills the screen. On a wide screen it sits in a phone-sized frame.
  // Cell and unit sizes follow the frame, so the bag, shop and FIGHT button always fit without scrolling.
  function px(v) { var d = h('div'); d.style.cssText = 'position:absolute;visibility:hidden;padding-top:' + v; $('app').appendChild(d); var n = parseFloat(getComputedStyle(d).paddingTop) || 0; d.remove(); return n; }
  function layout() {
    var vw = innerWidth, vh = innerHeight, app = $('app'), framed = vw > 560 && vw > vh * 0.75, FW, FH;
    document.body.classList.toggle('framed', framed);
    if (framed) {
      FH = Math.min(vh - 40, 900); FW = Math.round(FH * 390 / 844);
      if (FW > vw - 40) { FW = vw - 40; FH = Math.round(FW * 844 / 390); }
      app.style.width = FW + 'px'; app.style.height = FH + 'px';
    } else { app.style.width = ''; app.style.height = ''; FW = app.clientWidth; FH = app.clientHeight; }
    var sat = px('var(--sat)'), sab = px('var(--sab)'), g = 4, short = FH - sat - sab < 790, cardH = short ? 96 : 104, fightH = short ? 56 : 62;
    // the field needs: HUD (52) + two tag rows (60) + units (1.5 x 42) + the grass strip under their feet
    var shopH = 8 + 14 + 6 + cardH, bottomH = 8 + fightH + 5 + 10 + sab, bagChrome = 8 + 26 + 36, fieldMin = sat + 52 + 60 + 63 + FW * 0.102;
    var cellW = (FW - 20 - 26 - 4 * g) / 5, cellH = (FH - fieldMin - shopH - bottomH - bagChrome - 4 * g) / 5;
    var cell = Math.floor(Math.max(44, Math.min(cellW, cellH, 80)));
    document.documentElement.style.setProperty('--cell', cell + 'px');
    app.style.setProperty('--fw', FW + 'px'); app.style.setProperty('--cardH', cardH + 'px'); app.style.setProperty('--fightH', fightH + 'px');
    var fieldH = FH - (5 * cell + 4 * g + bagChrome) - shopH - bottomH, free = fieldH - sat - 52 - 60 - FW * 0.102;
    app.style.setProperty('--unit', Math.round(Math.max(32, Math.min(56, free / 1.5))) + 'px');
  }
  layout();
  var sp = params.get('seed');
  setMode('play');
  if (sp !== null && sp !== '') newGame(parseInt(sp, 10) >>> 0);
  maybeHelp();
  window.addEventListener('resize', function () { layout(); if (busy) return; if (lastState && mode === 'play' && game) refresh({ noFloat: true }); else if (lastState) render(lastState, { interactive: mode === 'play', noFloat: true }); });
})();
