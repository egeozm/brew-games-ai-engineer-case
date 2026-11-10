# Bag Battler: bot challenge

You build a bot that plays a small bag-battler game. Your bot gets the game state as JSON and returns one action at a time.
We judge the win rate of your bot, and how you got there.

## The game in one minute

- You have a **5x5 bag**. Items have shapes (1x1, 1x2, 2x2, L) and can be rotated.
- The game has **10 waves**. Each wave is a build phase (you shop and arrange the bag), then an automatic battle.
- **HP carries over** between waves. Lose all HP, or fail to win a battle, and the game ends. Win wave 10 (a boss) to win the game.
- The **next enemy type is shown** in the state, so you can plan for it.

### Items

| Item | Shape | What it does |
|---|---|---|
| soldier | 1x1 | Links to the weapons it touches (up to 2). A level-2 or 3 soldier makes its links hit harder. |
| sword | 1x2 | Weapon, blade. Medium damage, one target. |
| dagger | 1x1 | Weapon, blade. Low damage, 2 hits per tick. Weak against armor. |
| hammer | 2x2 | Weapon, heavy. Big damage, fires every 2 ticks. Good against armor. |
| axe | L | Weapon, heavy. Hits up to 3 enemies at once. Good against swarms. |
| whetstone | 1x1 | Gives adjacent blade weapons extra flat damage per hit. |
| anvil | 1x1 | Gives adjacent heavy weapons +50% damage. |
| shield | 1x2 | You take less damage every tick. |
| herb | 1x1 | Heals you after each won wave. |

The exact numbers are in `state.catalog` and in `CONFIG` at the top of `game.js`.

### Rules

- **Links.** Every soldier that shares an edge with a weapon (diagonal does not count) makes a **link** with it.
  Each link makes the weapon **fire once per attack**: a weapon with 2 links fires twice. A weapon with 0 links does nothing.
  - A soldier makes at most **2 links**. A weapon takes at most **2 links** (from 2 different soldiers).
  - When these caps leave a choice, the game picks the **largest** possible set of links, so you never lose a link to bad luck in the order.
    If several largest sets exist, the tie is broken in reading order: soldier-weapon pairs are sorted by the soldier's top-left cell
    (top row first, then left to right, ties by id), then by the weapon's top-left cell in the same order, and each pair is kept
    if a largest set that keeps it still exists.
  - Each fire uses the level bonus of its own soldier.
  - `state.links` lists every link as `{soldier, weapon}` (a weapon with 2 links is listed twice).
    Each bag item also has `links`; weapons have `firesPerAttack`, `linkedSoldiers` and `fireDamage` (damage per hit of each fire).
  - The bag is small, so the skill is getting the most links from few cells: a weapon between two soldiers fires twice.
- **Shop.** 3 random items each round. The first slot always holds a soldier. Buying puts the item in your **stash** (max 3 items).
  Then you `place` it in the bag. Reroll costs gold and replaces all 3 items.
- **Gold.** You get income at the start of every wave. Unspent gold is **not lost**: it earns interest (1 gold per 5 unspent, max 2 per round).
  Gold you hold is not worth much, gold you spend well wins games.
- **Merge.** Two copies of the same item at the same level merge into one item with level+1 (max level 3). It is stronger and keeps its shape.
  The merged item stays where the bag copy was.
- **Sell.** Selling returns half of the gold you paid (including merged copies).
- **Enemies.** Types: `normal`, `armored` (armor takes a flat amount off every hit, minimum 1), `swarm` (many weak enemies), and the `boss` on wave 10.
  Weapons hit the front enemy first. Each tick, up to 6 enemies hit you.
  A battle that does not end within 60 ticks counts as a loss.

## Files

- `game.js`: the game logic. Pure and deterministic. Do not change it; we run your bot on our own copy.
- `run.js`: runs your bot on many games.
- `bots/random.js`: an example bot.
- `index.html`: open it in a browser to play by hand, and to replay your bot's logs.

## API

```js
const Game = require('./game.js');
const g = new Game(seed);
g.getState();        // plain JSON, enough to play (see below)
g.act(action);       // -> { ok: true } or { ok: false, error: '...' }
g.toText();          // short text view, handy for LLM prompts
Game.fromState(state)  // rebuild a game from a state (use it to simulate ideas)
g.clone(); g.simulate(); g.placementsFor(id); g.mergePairs();
```

Actions (JSON objects):

| Action | Meaning |
|---|---|
| `{type:'buy', slot}` | Buy shop slot `slot` (0-2). Item goes to the stash. |
| `{type:'place', id, x, y, rot}` | Put a stash item in the bag. `x,y` is the top-left of the rotated shape, `rot` is 0-3. |
| `{type:'move', id, x, y, rot}` | Move a bag item. |
| `{type:'rotate', id}` | Rotate an item by 90 degrees. |
| `{type:'unplace', id}` | Move a bag item back to the stash. |
| `{type:'sell', id}` | Sell an item. |
| `{type:'merge', a, b}` | Merge two items of the same kind and level. |
| `{type:'reroll'}` | New shop. |
| `{type:'fight'}` | End the build phase and fight. |

`getState()` has: `wave`, `hp`, `gold`, `nextWave` (type, count, hp, dmg, armor), `shop`, `stash`, `bag` (items with cells, `grid` of ids),
`links`, `legal` (what you may do: buy slots, every legal `place` spot per stash item, merge pairs, ...), `lastBattle` (with a log), and `catalog`.

## Run your bot

```
node run.js --bot bots/random.js --games 200 --seed 1
```

It prints a JSON summary and a table: win rate, average wave reached, average final HP.
Add `--seeds file.txt` to use seeds from a file (one per line), and `--log logs/` to save one log file per game.

## Write a bot

A bot is a JS module that exports `chooseAction(state)`. Return an action, or `{ action, reason }` where `reason` is a short sentence about why.
`run.js` calls it again and again until the game ends. If your bot returns an illegal action, nothing happens; after 25 in a row, `run.js` fights.

```js
exports.chooseAction = function (state) {
  if (state.legal.buy.length) return { action: { type: 'buy', slot: state.legal.buy[0] }, reason: 'buy the first thing I can afford' };
  return { type: 'fight' };
};
```

The bot may use any approach: rules, search, an LLM, or a mix. If you call a model, keep it fast and deterministic enough for 200 games.
Write down your choices and what you tried. We read the logs and the reasons.

## What to send us

1. Your bot as a **module that `run.js` can load** (`node run.js --bot yourbot.js ...` must work with plain Node, no extra install).
2. **Logs of at least 30 of your games**, made with `--log` (one `.jsonl` file per game).
3. A short note: what you tried, what worked, what did not.

We will **rerun your bot on our own seeds**, so tuning to seeds 1..200 will not help. Open `index.html`, choose "Replay a log", and load one of your logs to check that it reads well.

## Tests

```
node --test test/*.js
```
