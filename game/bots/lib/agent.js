// LLM agent core. The model is behind providers.js (Gemini, Claude or a local Ollama model), raw HTTP, no npm packages.
//
// How it plays one build phase (one "wave"):
//   1. A fresh conversation starts with the rules (system prompt) and the current state as text.
//   2. The model calls tools: act([...actions]) to buy/place/merge/..., preview_fight() to simulate the next
//      battle with the current bag, and fight() to end the build phase.
//   3. run.js wants ONE action per chooseAction() call, so actions from act() are queued and handed out
//      one by one; after the queue is empty the new real state goes back to the model as the tool result.
// Every action is checked on a copy of the game before it is returned, so illegal actions are reported
// back to the model as errors instead of being silently ignored by run.js.
'use strict';
const fs = require('fs');
const path = require('path');
const Game = require('../../game.js');
const { makeProvider } = require('./providers.js');

// $ per million tokens, paid list prices. Free-tier runs cost $0; we still report what the same tokens would cost.
const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cacheRead: 0.075 },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4, cacheRead: 0.025 },
  'gemini-2.5-pro': { in: 1.25, out: 10, cacheRead: 0.31 },
};

// ------------------------------------------------------------------ prompt pieces
function shapesText() {
  const C = Game.CONFIG;
  const L = [];
  for (const k of Object.keys(C.items)) {
    const seen = new Set(), rots = [];
    for (let r = 0; r < 4; r++) {
      const cells = Game.rotShape(C.items[k].shape, r), key = JSON.stringify(cells);
      if (seen.has(key)) continue;
      seen.add(key);
      rots.push(`rot ${r}: ${cells.map((c) => `(${c[0]},${c[1]})`).join(' ')}`);
    }
    L.push(`  ${k}: ${rots.join(' | ')}`);
  }
  return L.join('\n');
}

function itemsText() {
  const C = Game.CONFIG.items;
  return [
    `  soldier   cost ${C.soldier.cost}, 1x1. Powers touching weapons (max 2 links per soldier). Level L adds +25%*(L-1) to the damage of the fires it powers.`,
    `  sword     cost ${C.sword.cost}, 1x2, blade. ${C.sword.dmg} dmg, 1 hit per fire, every tick, 1 target.`,
    `  dagger    cost ${C.dagger.cost}, 1x1, blade. ${C.dagger.dmg} dmg, 2 hits per fire, every tick, 1 target. Weak vs armor.`,
    `  hammer    cost ${C.hammer.cost}, 2x2, heavy. ${C.hammer.dmg} dmg, 1 hit, fires every 2 ticks (ticks 1,3,5...), 1 target. Good vs armor.`,
    `  axe       cost ${C.axe.cost}, L-shape (3 cells), heavy. ${C.axe.dmg} dmg, 1 hit, every tick, hits up to 3 enemies.`,
    `  whetstone cost ${C.whetstone.cost}, 1x1. Adjacent blade weapons get +${C.whetstone.flat} flat dmg per hit (x level mult).`,
    `  anvil     cost ${C.anvil.cost}, 1x1. Adjacent heavy weapons get +${C.anvil.mult * 100}% dmg (x level mult).`,
    `  shield    cost ${C.shield.cost}, 1x2. You take ${C.shield.reduce} less damage per tick (x level mult).`,
    `  herb      cost ${C.herb.cost}, 1x1. Heals ${C.herb.heal} HP after each won wave (x level mult).`,
  ].join('\n');
}

function systemPrompt() {
  const C = Game.CONFIG;
  return `You are playing Bag Battler, a deterministic auto-battler. Your goal is to WIN: survive all ${C.waves} waves, the last one is a boss.

GAME RULES (exact)
- Bag: ${C.gridW}x${C.gridH} grid, x = column 0-4 (left to right), y = row 0-4 (top to bottom). Items have shapes and can be rotated.
- Each wave = a build phase (you act) then an automatic battle. HP carries over between waves (start ${C.startHp}, max ${C.maxHp}).
  Losing a battle (your HP hits 0, or enemies still alive after ${C.battle.maxTicks} ticks) ends the game.
- Gold: start ${C.startGold}. At the start of wave w (w>=2) you get floor(${C.income.base} + ${C.income.perWave}*(w-1)) gold, plus interest of
  1 gold per ${C.interest.per} unspent gold (max ${C.interest.cap}). Unspent gold is kept.
- Shop: ${C.shopSize} items, slot 0 is always a soldier. Buying puts the item in your stash (max ${C.stashSize} items; stash items do nothing in battle).
  Reroll costs ${C.rerollCost} gold and replaces all 3 items. Selling returns half of what you paid (rounded down, min 1).
- Merge: two items of the same kind AND level merge into one item of level+1 (max ${C.maxLevel}). It stays where the bag copy was.
  Level multiplies stats: L1 x${C.levelMult[0]}, L2 x${C.levelMult[1]}, L3 x${C.levelMult[2]}.

ITEMS
${itemsText()}

LINKS (the core mechanic)
- A soldier and a weapon that share an edge (not diagonal) form a LINK. Each link makes that weapon fire once per attack.
- A soldier makes at most 2 links; a weapon takes at most 2 links (from 2 different soldiers). A weapon with 0 links never fires.
  So a weapon between two soldiers fires twice. When caps leave a choice, the game picks the largest possible set of links.
- Buffs (whetstone/anvil) must touch the weapon. Shield/herb work anywhere in the bag.
- Damage of one fire = round((weapon dmg x level mult + whetstone flat) x (1 + anvil bonuses) x (1 + 0.25*(soldier level-1))).

BATTLE (each tick)
- Every link fires (hammer only on ticks 1,3,5,...). Each hit damages the FRONT enemies (axe: up to 3 enemies, others: 1).
  Damage dealt per hit = max(1, fire damage - enemy armor).
- Then, if enemies remain, min(6, enemies alive) x enemy dmg - your shield is subtracted from your HP.
- After a won wave, herbs heal you.

ENEMIES. Value at wave w = floor(base + perWave*(w-1)):
  normal  (Raiders):         count 2+0.5/w, hp 10+4/w,   dmg 1+0.35/w, armor 0
  armored (Armored knights): count 2+0.35/w, hp 15+6.5/w, dmg 2+0.4/w,  armor 2+0.6/w
  swarm:                     count 5+1/w,   hp 4+1.25/w, dmg 1+0.15/w, armor 0
  boss (always wave ${C.waves}): 1 Warlord, hp 200, dmg 9, armor 5
  Wave 1 is normal. Waves 2-9 are drawn from [normal, armored, swarm, armored, swarm]. Only the NEXT wave type is known.

SHAPES (cells relative to the top-left (x,y) you give in place/move; rot 0-3 rotates 90 degrees clockwise)
${shapesText()}

HOW TO ACT
- Use the tools. act() runs a list of actions in order and stops at the first illegal one; you get back what happened and the new state.
  Batch several actions into one act() call when you can. A buy reports the new item's id; to use an item you buy in the same act()
  call, refer to it as "last" (the most recently bought item), e.g. {"type":"place","id":"last","x":0,"y":0,"rot":0}.
- Every act() result ends with a battle preview (the next fight and a boss test, simulated exactly with your current bag).
  preview_fight() gives the same preview without doing anything.
- fight() ends the build phase and starts the battle. You can also set then_fight=true in your last act() call.
- Tool calls are rate-limited, so batch several actions into each act() call. Look at the preview in the act() result before
  you fight; use then_fight=true only when you already know the result is what you want.
- Keep each "reason" short (one sentence).`;
}

function itemLine(it) {
  let d = `#${it.id} ${it.kind} L${it.level}`;
  if (it.x !== undefined) d += ` at (${it.x},${it.y}) rot ${it.rot} cells ${it.cells.map((c) => `(${c[0]},${c[1]})`).join('')}`;
  if (it.role === 'weapon') {
    d += it.powered ? ` | LINKS ${it.links}/2 from soldier ${it.linkedSoldiers.map((x) => '#' + x).join(',')} | fires ${it.firesPerAttack}x, dmg per fire ${it.fireDamage.join('/')}`
      : ' | NOT POWERED (0 links)';
  }
  if (it.role === 'soldier' && it.x !== undefined) d += ` | LINKS ${it.links}/2`;
  d += ` | sells for ${it.sellPrice}`;
  return d;
}

// The state as text. Kept close to game.js toText(), with a few extra facts the JSON already has.
function renderState(s) {
  const L = [];
  L.push(`WAVE ${s.wave}/${s.totalWaves}   HP ${s.hp}/${s.maxHp}   GOLD ${s.gold}   (next wave income ${s.income.nextRoundBase} + interest)`);
  if (s.nextWave) L.push(`NEXT ENEMY: ${s.nextWave.count} x ${s.nextWave.type} (hp ${s.nextWave.hp} each, dmg ${s.nextWave.dmg}, armor ${s.nextWave.armor})`);
  L.push(`BOSS (wave 10): 1 x hp 200, dmg 9, armor 5`);
  L.push('SHOP: ' + s.shop.map((x, i) => `[${i}] ` + (x ? `${x.kind} ${x.cost}g${x.affordable ? '' : ' (too expensive)'}` : '(bought)')).join('   '));
  L.push('STASH: ' + (s.stash.length ? s.stash.map(itemLine).join('; ') : '(empty)') + `   (${s.stash.length}/3)`);
  L.push('BAG (number = item id, . = empty):');
  L.push('     x=0  1  2  3  4');
  for (let y = 0; y < s.bag.height; y++) L.push(`  y=${y} ` + s.bag.grid[y].map((v) => (v ? String(v).padStart(2, ' ') : ' .')).join(' '));
  for (const it of s.bag.items) L.push('  ' + itemLine(it));
  L.push(`LINKS: ${s.links.length ? s.links.map((l) => `#${l.soldier}->#${l.weapon}`).join(' ') : 'none'}   SHIELD ${s.shield}   HEAL ${s.heal}`);
  if (s.legal.merge.length) L.push('POSSIBLE MERGES: ' + s.legal.merge.map((p) => `#${p[0]}+#${p[1]}`).join(', '));
  return L.join('\n');
}

function previewText(state) {
  const g = Game.fromState(state);
  const r = g.simulate(g.wave, false);
  const b = g.simulate(10, false, state.maxHp);
  const an = g.analyze();
  const fires = an.weapons.filter((w) => w.powered).length;
  return [
    `NEXT FIGHT (wave ${state.wave}, ${state.nextWave.count} x ${state.nextWave.type}) with the current bag: ${r.won ? 'WIN' : 'LOSS'} after ${r.ticks} ticks, ` +
      `your HP ${state.hp} -> ${r.hpAfter}${r.won ? '' : `, enemies left ${r.enemiesLeft} with ${r.enemyHpLeft} total HP`}.`,
    `BOSS TEST (boss at full HP 50, current bag): ${b.won ? `WIN in ${b.ticks} ticks with ${b.hpAfter} HP left` : `LOSS, boss has ${b.enemyHpLeft}/200 HP left after ${b.ticks} ticks`}.`,
    `Bag: ${fires} fires per attack, shield ${an.shield}, heal ${an.heal}.`,
  ].join('\n');
}

// ------------------------------------------------------------------ tools
const ID = { type: 'string', description: 'item id as a string, e.g. "7", or "last" for the item bought most recently' };
const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['buy', 'place', 'move', 'rotate', 'unplace', 'sell', 'merge', 'reroll'] },
    slot: { type: 'integer', description: 'buy only: shop slot 0-2' },
    id: ID,
    x: { type: 'integer', description: 'place/move: column 0-4 of the top-left cell' },
    y: { type: 'integer', description: 'place/move: row 0-4 of the top-left cell' },
    rot: { type: 'integer', description: 'place/move: rotation 0-3' },
    a: Object.assign({}, ID, { description: 'merge only: first item id' }),
    b: Object.assign({}, ID, { description: 'merge only: second item id' }),
  },
  required: ['type'],
};

function baseTools() {
  return [
    {
      name: 'act',
      description: 'Run a list of build-phase actions in order (buy, place, move, rotate, unplace, sell, merge, reroll). Stops at the first illegal action. Returns each result, the new state and a battle preview. Set then_fight=true to fight right after (only if every action succeeded).',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'One short sentence: why these actions.' },
          actions: { type: 'array', items: ACTION_SCHEMA },
          then_fight: { type: 'boolean', description: 'true = start the battle right after these actions if all of them succeed' },
        },
        required: ['reason', 'actions'],
      },
    },
    {
      name: 'preview_fight',
      description: 'Simulate the next battle with the current bag (no cost), plus a test against the wave-10 boss at full HP.',
      input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: [] },
    },
    {
      name: 'fight',
      description: 'End the build phase and start the battle.',
      input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  ];
}

// ------------------------------------------------------------------ agent
function createAgent(opts) {
  opts = Object.assign({
    name: 'llm',
    maxCallsPerWave: 14,
    maxActionsPerWave: 60,
    extraTools: [],          // [{tool, handler(state, input) -> text}]
    extraSystem: '',         // appended to the system prompt
    renderState,             // state -> text
    mock: null,              // test hook: a fake provider
    guardThenFight: false,   // v2: then_fight only starts the battle if the simulator predicts a win
  }, opts || {});

  const SYSTEM = systemPrompt() + (opts.extraSystem ? '\n\n' + opts.extraSystem : '');
  const TOOLS = baseTools().concat(opts.extraTools.map((t) => t.tool));
  const EXTRA = Object.fromEntries(opts.extraTools.map((t) => [t.tool.name, t.handler]));
  const provider = opts.mock || makeProvider(SYSTEM, TOOLS, opts);

  let G = null;          // per-game memory
  let stats = null;      // per-game counters
  let traceFile = null;
  let lastError = '';

  function newGame() {
    G = { wave: 0, queue: [], pending: null, results: [], calls: 0, actions: 0, history: [], lastBuyId: null, prevIds: null, reason: '' };
    stats = { llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, apiMs: 0, apiErrors: 0,
      illegal: 0, illegalKinds: {}, forcedFights: 0, noToolReplies: 0, previews: 0, extraToolCalls: 0, autoFights: 0, blockedFights: 0, quotaExhausted: false };
  }
  function trace(obj) { if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(obj) + '\n'); }

  function callModel(sentNote) {
    const t0 = Date.now();
    let r;
    try { r = provider.call(G.lastState); } catch (e) { stats.apiErrors++; stats.apiMs += Date.now() - t0; throw e; }
    const ms = Date.now() - t0;
    stats.apiMs += ms; stats.llmCalls++; G.calls++;
    stats.inputTokens += r.usage ? r.usage.in : 0; stats.outputTokens += r.usage ? r.usage.out : 0; stats.cachedTokens += r.usage ? r.usage.cached : 0;
    trace({ t: 'call', wave: G.wave, call: G.calls, ms, sent: sentNote, model: r.model, stop: r.stop, usage: r.usage,
      thoughts: r.thoughts ? r.thoughts.slice(0, 4000) : '', text: r.text, calls: r.calls });
    return r;
  }

  function resolveIds(a) {
    const out = Object.assign({}, a);
    for (const k of ['id', 'a', 'b', 'slot', 'x', 'y', 'rot']) {
      if (out[k] === 'last') {
        if (G.lastBuyId == null) return { error: '"last" used but nothing was bought yet' };
        out[k] = G.lastBuyId;
      } else if (typeof out[k] === 'string' && /^#?\d+$/.test(out[k].trim())) out[k] = Number(out[k].trim().replace('#', ''));
    }
    return { action: out };
  }

  function validate(state, action) {   // same items, gold and shop as the real game
    const res = Game.fromState(state).act(action);
    return res.ok ? null : res.error;
  }

  function startWave(state) {
    G.wave = state.wave; G.calls = 0; G.actions = 0; G.queue = []; G.pending = null; G.results = []; G.lastBuyId = null;
    const lb = state.lastBattle;
    if (lb) G.history.push(`wave ${lb.wave} (${lb.type}): ${lb.won ? 'won' : 'lost'}, HP after battle ${lb.hpAfter}`);
    const hist = G.history.length ? 'PREVIOUS WAVES: ' + G.history.join('; ') + '\n\n' : '';
    const text = `${hist}New build phase.\n\n${opts.renderState(state)}\n\nPlan this build phase with the tools, then call fight().`;
    provider.start(text);
    trace({ t: 'wave_start', wave: state.wave, text });
  }

  // Ask the model until it gives something run.js can execute. Returns an action, or null after queueing act() actions.
  function think(state) {
    let note = 'state';
    for (;;) {
      if (G.calls >= opts.maxCallsPerWave || G.actions >= opts.maxActionsPerWave) {
        stats.forcedFights++;
        trace({ t: 'forced_fight', wave: G.wave, calls: G.calls, actions: G.actions });
        return { action: { type: 'fight' }, reason: `[cap] too many calls/actions in wave ${G.wave}, fight` };
      }
      let r;
      try { r = callModel(note); } catch (e) {
        if (e.dailyQuota) stats.quotaExhausted = true;
        lastError = String(e.message || e);
        trace({ t: 'api_error', wave: G.wave, error: String(e.message || e) });
        // A missing/invalid key, no billing, or a used-up quota will fail on every call. run.js would turn each
        // failure into a fight and record nonsense games, so stop the whole process with a clear message instead.
        const fatal = e.dailyQuota || /is not set|unknown LLM_PROVIDER|\b(401|402|403|404)\b|API[ _]key|API_KEY|UNAUTHENTICATED|PERMISSION_DENIED/i.test(lastError);
        if (fatal) {
          console.error(`\n[llm agent] Stopping: the LLM API cannot be used.\n  ${lastError.slice(0, 400)}\n` +
            '  No game was recorded for this seed. Fix the API key / billing / quota (see README) and rerun.');
          process.exit(2);
        }
        stats.forcedFights++;
        return { action: { type: 'fight' }, reason: `[api error] ${String(e.message || e).slice(0, 120)}` };
      }
      if (!r.calls.length) {
        stats.noToolReplies++;
        provider.userText('Please continue by calling a tool: act, preview_fight, or fight.');
        note = 'nudge';
        continue;
      }
      const tu = r.calls[0];
      const others = r.calls.slice(1).map((c) => ({ id: c.id, name: c.name, content: 'Ignored: call one tool at a time.', isError: true }));
      const answer = (content, isError) => { provider.toolResults([{ id: tu.id, name: tu.name, content, isError: !!isError }].concat(others)); };
      const input = tu.input || {};
      if (tu.name === 'fight') return { action: { type: 'fight' }, reason: `[llm w${G.wave}] ${input.reason || 'fight'}` };
      if (tu.name === 'preview_fight') { stats.previews++; answer(previewText(state)); note = 'preview'; continue; }
      if (EXTRA[tu.name]) {
        stats.extraToolCalls++;
        let text; try { text = EXTRA[tu.name](state, input); } catch (e) { text = 'Tool error: ' + e.message; }
        answer(text); note = tu.name; continue;
      }
      if (tu.name === 'act') {
        const acts = Array.isArray(input.actions) ? input.actions : [];
        if (!acts.length) { answer('No actions given.', true); note = 'empty act'; continue; }
        G.queue = acts.slice(); G.results = []; G.reason = input.reason || ''; G.thenFight = !!input.then_fight; G.hadError = false;
        G.pending = { id: tu.id, name: tu.name, others };
        return null;
      }
      answer(`Unknown tool ${tu.name}.`, true); note = 'unknown tool';
    }
  }

  function chooseAction(state) {
    const fresh = state.wave === 1 && !state.lastBattle && state.bag.items.length === 0 && state.stash.length === 0 &&
      state.gold === Game.CONFIG.startGold && state.shop.every((s) => s);
    if (!G || fresh) newGame();
    if (G.prevIds) {   // learn the id of the item bought by the previous action
      const added = state.bag.items.concat(state.stash).map((i) => i.id).filter((id) => !G.prevIds.has(id));
      if (added.length) {
        G.lastBuyId = Math.max(...added);
        const i = G.results.length - (G.results[G.results.length - 1] === '(all actions done)' ? 2 : 1);
        if (G.results[i]) G.results[i] += ` -> new item id #${G.lastBuyId}`;
      }
      G.prevIds = null;
    }
    G.lastState = state;
    if (state.wave !== G.wave) startWave(state);

    for (let guard = 0; guard < 200; guard++) {
      // 1. hand out queued actions one at a time, checking each one first
      while (G.queue.length) {
        const raw = G.queue.shift();
        const r = resolveIds(raw || {});
        let err = r.error || null;
        const a = r.action;
        if (!err && (!a || !a.type)) err = 'action has no type';
        if (!err && a.type === 'fight') { G.results.push('fight inside act() ignored: call the fight tool'); continue; }
        if (!err) err = validate(state, a);
        if (err) {
          G.results.push(`${JSON.stringify(raw)} -> ERROR: ${err}. Remaining actions in this call were skipped.`);
          stats.illegal++; stats.illegalKinds[err] = (stats.illegalKinds[err] || 0) + 1;
          trace({ t: 'illegal', wave: G.wave, action: raw, error: err });
          G.queue = []; G.hadError = true;
          break;
        }
        G.actions++;
        let note = 'ok';
        if (a.type === 'buy') { G.prevIds = new Set(state.bag.items.concat(state.stash).map((i) => i.id)); note = `ok (bought ${state.shop[a.slot].kind})`; }
        G.results.push(`${JSON.stringify(raw)} -> ${note}`);
        if (G.queue.length === 0) G.results.push('(all actions done)');
        return { action: a, reason: `[llm w${G.wave}] ${G.reason}` };
      }
      // 2. an act() call is waiting for its result
      let guardNote = '';
      if (G.pending && G.thenFight && !G.hadError) {     // all actions worked and the model asked to fight right after
        G.thenFight = false;
        const predictedWin = Game.fromState(state).simulate(state.wave, false).won;
        if (!opts.guardThenFight || predictedWin) {
          G.pending = null; stats.autoFights++;
          return { action: { type: 'fight' }, reason: `[llm w${G.wave}] ${G.reason} (then fight)` };
        }
        // v2 guard: do not walk into a battle the exact simulator says is lost; show the model why instead
        stats.blockedFights++;
        trace({ t: 'blocked_fight', wave: G.wave });
        guardNote = '\n\nthen_fight was NOT executed: the preview below says you would LOSE this battle. ' +
          'Change your bag (buy, place, move, sell, merge, reroll) and check the preview again. ' +
          'If you still want to fight anyway, call fight().';
      }
      if (G.pending) {
        const text = G.results.join('\n') + guardNote + '\n\nNEW STATE:\n' + opts.renderState(state) + '\n\nPREVIEW:\n' + previewText(state);
        provider.toolResults([{ id: G.pending.id, name: G.pending.name, content: text }].concat(G.pending.others));
        G.pending = null;
      }
      // 3. ask the model
      const out = think(state);
      if (out) return out;
    }
    return { action: { type: 'fight' }, reason: '[guard] loop limit' };
  }

  return {
    chooseAction,
    getStats: () => Object.assign({}, stats, { model: provider.model, provider: provider.name, name: opts.name,
      costUsd: cost(stats, provider.model) }),
    setTrace: (file) => { traceFile = file; if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); } },
    reset: () => { G = null; },
    lastError: () => lastError,
    systemPrompt: () => SYSTEM,
    tools: () => TOOLS,
    renderState: opts.renderState,
  };
}

// List-price cost if the same tokens were billed (free-tier runs cost $0; this shows what they would cost on a paid key).
function cost(s, model) {
  const p = PRICES[model];
  if (!p || !s) return null;
  return ((s.inputTokens - s.cachedTokens) * p.in + s.cachedTokens * p.cacheRead + s.outputTokens * p.out) / 1e6;
}

module.exports = { createAgent, renderState, previewText, systemPrompt };
