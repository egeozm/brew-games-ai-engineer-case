# Brew Games: AI Engineer Case

Two parts: (1) forecast D7 / D30 / LTV30 for 15 new games from 4 days of data and decide continue / stop / retest; (2) an LLM agent that plays the bag-battler game, measured against baselines.

| | deliverable | note |
|---|---|---|
| Part 1 | `part1/out/predictions.csv` (`game_id, d7, d30, ltv30, alt, üst, karar`) | `part1/NOTE.md` (`.pdf`) |
| Part 2 | `game/bots/llm.js` (final agent), `game/logs/` (every game), `part2/out/results_table.md` | `part2/NOTE.md` (`.pdf`) |

## Reproduce everything (one command, no API key)

```bash
bash reproduce.sh
```

It reruns the Part 1 pipeline (data checks, cleaning test, model, validation, predictions, charts), the game tests, and the Part 2 analysis from the saved game results (`game/results/`, `game/logs/`). Takes about a minute.

## Requirements
- Python 3.10+ with `pandas numpy scikit-learn matplotlib tabulate markdown` (Part 1 and the analysis; `markdown` and Google Chrome only for the note PDFs)
- Node.js 18+ (the game and the bots; **no npm packages**)
- For the LLM agent: an API key in `game/.env` or the environment, one of
  `GEMINI_API_KEY` (used for our runs, model `gemini-3.5-flash-lite`), `ANTHROPIC_API_KEY` (Claude), or a local Ollama server.
  Override with `LLM_PROVIDER=gemini|anthropic|ollama` and `LLM_MODEL=...`.

## Run

```bash
# Part 1 (≈10 s): validation, intervals, thresholds, predictions, charts
python3 part1/run_part1.py
python3 part1/analysis/data_plots.py     # outlier and noise charts
python3 part1/analysis/cleaning_test.py  # keep / cap / drop the >100% rows, with chart

# Part 2: tests (no API needed), then the bots
cd game
node --test test/
node run.js --bot bots/llm.js --games 30 --seed 1 --log logs/llm      # the command from the case brief
node bench.js --bot bots/rule.js --seeds 1-200 --out results/rule.json --log logs/rule
node bench.js --bot bots/llm.js  --seeds 1-30  --out results/llm_v2.json --log logs/llm_v2 --trace traces/llm_v2
cd ..
python3 part2/analyze.py                 # results table, paired tests, charts
node part2/mistakes.js llm_v1 llm_v2 rule  # mistake counts
node part2/story.js llm_v1 7             # one game as a readable story

# Notes as PDF
python3 make_note_pdfs.py                # part1/NOTE.md, part2/NOTE.md -> NOTE.pdf
```

`bench.js` uses run.js's own `playGame()` (same loop, same log format) and adds wall time, LLM calls and tokens per game. It resumes where it stopped, and a game cut short by an API quota or authentication error is discarded, never counted as a loss.

**Note on v2:** seeds 1–23 ran on the free Gemini tier; when its daily quota ran out, seeds 24–30 ran on a paid key with the same model and settings.

## Running the agent on your own seeds

```bash
cd game
GEMINI_API_KEY=... LLM_MODEL=gemini-3.5-flash-lite node run.js --bot bots/llm.js --games 30 --seed 1001 --log logs/hidden
```

- Our reported numbers use `gemini-3.5-flash-lite` at temperature 0. With `ANTHROPIC_API_KEY` the default model is `claude-opus-5-5`, which is a different (much stronger) model, so results are not comparable to ours.
- If the key is missing or invalid, billing is off, or the quota is used up, the agent **stops the run with a clear message** instead of playing fake games (run.js would otherwise turn every failed call into a fight).
- Expect about 20 LLM calls and 2 minutes per game.

