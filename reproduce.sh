#!/usr/bin/env bash
# Rebuilds every number, table and chart in the notes from the data and the saved game results.
# No API key needed (the LLM games are already played and saved in game/results and game/logs).
#   bash reproduce.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "== Part 1: data checks, cleaning test, model, validation, predictions"
python3 part1/analysis/data_checks.py > part1/out/data_checks.txt
python3 part1/analysis/data_plots.py
python3 part1/analysis/cleaning_test.py
python3 part1/analysis/baseline_walkthrough.py > /dev/null
python3 part1/run_part1.py

echo "== Part 2: game tests (fake model, no API), results table, paired tests, mistake counts"
(cd game && node --test test/ 2>&1 | grep -E "^ℹ (pass|fail)")
node part2/mistakes.js llm_v1 llm_v2 rule > part2/out/mistakes.txt
python3 part2/analyze.py > /dev/null
cat part2/out/comparisons.md

echo "== Done. Predictions: part1/out/predictions.csv   Part 2 table: part2/out/results_table.md"
