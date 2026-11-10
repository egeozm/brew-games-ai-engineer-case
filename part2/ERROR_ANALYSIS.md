# Part 2: Error analysis of the LLM agent (v1)

**Agent:** `game/bots/llm_v1.js`, Gemini 3.5 Flash-Lite, seeds 1–30. **Result:** 0/30 wins, average wave reached 3.53.
**Sources:** `node part2/story.js llm_v1 <seed>` (one game as a story), `node part2/mistakes.js llm_v1` (counts over all games).

## 1. Five lost games, read by hand

Picked to cover different stages of the game: two wave-1 losses, two mid-game losses and one late loss.

| seed | lost in | what the agent saw or thought wrong | classes |
|---|---|---|---|
| 3 | wave 1 (normal, the easiest fight) | Put soldiers at (1,0),(2,0) and the sword at (0,1)–(0,2), and believed they were linked. They only touch diagonally, so the sword never fired. Used `then_fight` and never saw the preview, which said LOSS. | spatial, **blind fight** |
| 4 | wave 1 | Planned "buy slot 0, buy slot 0" as if the shop refilled after a buy. Four act() calls failed with "no item in that shop slot". It merged its two soldiers and ended with no weapon at all, then fought (`then_fight`) with 0 weapons. | state misreading (shop), **blind fight** |
| 1 | wave 4 (armored) | Merged two placed soldiers (losing links), left a bought axe unpowered, and put an anvil next to nothing. HP fell 40 → 14 in wave 3 and nothing was done about defence. Fought wave 4 at 14 HP with `then_fight`; the preview would have shown LOSS in 2 ticks. | spatial, bad merge, **blind fight** |
| 6 | wave 5 (swarm) | Placed two daggers where no soldier touches them. HP fell 31 → 4 in wave 4, yet it kept 12–14 gold and bought no shield or herb. Repeated "buy slot 0" errors. Fought at 4 HP with `then_fight`. | spatial, economy/HP, **blind fight** |
| 8 | wave 8 (normal) | Spent 14 calls in wave 8 rearranging items, losing track of ids ("no such item", items it thought were in the bag were in the stash). Hit the call cap and was **forced** to fight with **56 gold unspent**. | id bookkeeping, economy, call cap |

## 2. What the classes mean

- **Blind fight into a loss.** The agent ends the build phase with `then_fight=true` in the same call as its last actions, so it never sees the exact battle preview that comes back with every act() result. The game is deterministic, so the preview *is* the result.
- **Spatial.** Wrong belief about which cells touch (diagonals, 2-cell shapes), so weapons stay unpowered and buffs touch the wrong weapon type.
- **State misreading.** Treats a bought shop slot as still full, merges items of different levels, uses ids that don't exist.
- **Economy/HP.** Keeps gold while losing HP, buys no defence.

## 3. Counts over all 30 games (automatic, `part2/mistakes.js`)

In the build phase that lost each game:

| class (in the losing wave) | lost games (of 30) |
|---|---|
| illegal action at some point in that wave (caught, reported, model retried) | 23 |
| **fought blind into a predicted loss** (`then_fight`, never looked at the preview) | **22** |
| ≥5 gold unspent when it lost | 17 |
| no working weapon (9: none in the bag; 2: only unpowered) | 11 (all the wave-1 losses) |
| forced to fight by the call cap | 4 |

Across all 106 build phases (not just losing ones): a weapon left unpowered in 32, a useless buff in 48, two placed soldiers merged in 46, and 163 illegal actions in total (top kinds: re-buying an empty shop slot 42, unknown id 30, merge with itself or missing id 25, does not fit 25, not enough gold 20).

## 4. Which class to fix, and why

**Chosen: the blind fight (22/30 lost games).**
- It is the step that actually **ended** the game: an irreversible decision taken without looking at information the agent already had for free (the exact simulator).
- Fixing it gives the agent a chance to repair the other mistakes too. A blocked fight shows "you would lose", and then it can buy a weapon, spend its gold, or move an unpowered weapon.
- **Illegal actions** are slightly more frequent (23), but they are *recoverable*: each one is caught, reported, and the model retries. They are also a mix of 8 different kinds, so no single change addresses them.
- **Spatial mistakes** are real (present in about half the lost games), but they directly decided only a few. A prepared fix (exact "what touches what" facts in the state text, `game/bots/lib/state_v2.js`) is kept as the next candidate, unmeasured.

**The change (tool):** `then_fight` now only starts the battle if the simulator predicts a win. Otherwise the act() result says *"then_fight was NOT executed: the preview below says you would LOSE…"* and the model must change the bag, or call `fight()` deliberately. Nothing else changed: same model, prompt, state text and seeds.

## 5. After the fix (v2, seeds 1–30, paired with v1)

`node part2/mistakes.js llm_v1 llm_v2` and the traces in `game/traces/llm_v2/`.

| class (in the losing wave) | v1 (30 lost) | v2 (30 lost) |
|---|---|---|
| fought blind into a predicted loss | 22 | **0** |
| illegal action in that wave | 23 | 30 |
| ≥5 gold unspent | 17 | 10 |
| no working weapon | 11 | 10 |
| forced by the call cap | 4 | 16 |

How each v2 loss started: **14 called `fight()` deliberately** after seeing the predicted loss (seeds 1, 2, 5, 9, 11, 12, 14–19, 21, 26), and **16 were forced by the call cap** (seeds 3, 4, 6, 7, 8, 10, 13, 20, 22–25, 27–30). Outcome: average wave 3.53 → 3.77, +0.23 [−0.43, +0.90] (paired bootstrap), wins 0 → 0. The fix removed the targeted class but didn't change results beyond noise. The next class to work on is bag planning (spatial/id/shop mistakes).
