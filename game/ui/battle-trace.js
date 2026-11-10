/*
 * Per-turn trace of a battle, for the UI animation. UMD, no DOM.
 * traceBattle(game) takes a game (pass a CLONE: it is not changed anyway) and repeats the loop of
 * Game.simulate() in game.js step by step, keeping every shot. It must always agree with simulate()
 * on won / hpAfter / ticks (test/battle-trace.test.js checks this on 100 games).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BattleTrace = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function traceBattle(game) {
    const info = game.waveInfo(game.wave);
    const an = game.analyze();
    const cfg = game.cfg, bt = cfg.battle;
    const weapons = an.weapons.filter((x) => x.powered);
    const enemies = [];
    for (let i = 0; i < info.count; i++) enemies.push(info.hp);
    let alive = enemies.length, hp = game.hp, tick = 0, front = 0;
    const turns = [];
    while (tick < bt.maxTicks && alive > 0 && hp > 0) {
      tick++;
      const shots = [];
      for (const wp of weapons) {
        if ((tick - 1) % wp.cd !== 0) continue;
        for (let h = 0; h < wp.hits; h++) {
          let n = 0, i = front;
          while (n < wp.cleave && i < enemies.length) {
            if (enemies[i] > 0) {
              const d = Math.max(1, wp.dmg - info.armor);
              const before = enemies[i];
              enemies[i] -= d;
              let killed = false;
              if (enemies[i] <= 0) { enemies[i] = 0; alive--; killed = true; }
              shots.push({ weaponId: wp.id, enemyIndex: i, dmg: Math.min(d, before), rawDmg: d, killed });
              n++;
            }
            i++;
          }
          while (front < enemies.length && enemies[front] <= 0) front++;
        }
      }
      let hit = 0, blocked = 0;
      if (alive > 0) {
        const att = Math.min(bt.maxAttackers, alive);
        const raw = att * info.dmg;
        hit = Math.max(0, raw - an.shield);
        blocked = raw - hit;
        hp -= hit;
      }
      turns.push({ tick, shots, enemyHp: enemies.slice(), alive, hit, blocked, hpAfter: Math.max(0, hp) });
    }
    const won = alive === 0 && hp > 0;
    return { turns, won, hpAfter: Math.max(0, hp), ticks: tick, enemyCount: info.count, enemyMaxHp: info.hp, info, heal: an.heal };
  }
  return { traceBattle };
});
