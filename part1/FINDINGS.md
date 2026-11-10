# Part 1: Working findings

A running log of what we found and decided, in order. This is not the final 2-page note. The note will be written from it.
Every number here can be reproduced. The script that produced it is named next to each section.

**Status:** This was the step-by-step working log for sections 1–3. The finished write-up is `part1/NOTE.md` (the 2-page note). Sections 4–6 below were completed there.

---

## 1. What the data is
*Source: `python3 part1/analysis/data_checks.py`, parts A and B.*

- 4365 rows, 60 games, 3 install cohorts per game. Each row is one cohort on one day: installs, CPI, active users, average playtime, ad revenue.
- **G01–G45** have days 0–30 and are used for training. **G46–G60** have days 0–3 only and are the games we predict.
- Genres: arcade 15, puzzle 14, merge 9, runner 9, match3 7, idle 6.
- CPI is the same for all 3 cohorts of a game, so each game has one CPI.

### Definitions (pooled over the 3 cohorts)
| Metric | Formula |
|---|---|
| Retention on day N | Σ active users on day N ÷ Σ installs |
| D7, D30 | retention on day 7, day 30 |
| LTV30 | Σ ad revenue, days 0–30 ÷ Σ installs |
| Decision ratio | LTV30 ÷ CPI |

**Worked example, G01:** 5250 installs. D7 = 550/5250 = 10.5%, D30 = 232/5250 = 4.4%, LTV30 = $0.0985, CPI = $0.225, so **LTV30/CPI = 0.44** (the game earns back 44% of the user cost in 30 days).

**Decision: pool the cohorts instead of modelling them separately.** We need one prediction per game, and pooling averages out noise (see section 2). Larger cohorts weigh more, which is right because they are more reliable.

---

## 2. Noise in the data
*Source: `python3 part1/analysis/data_checks.py` (parts C and D) and `python3 part1/analysis/cleaning_test.py`.*

### 2a. Some rows are impossible: retention above 100%
- 83 of 4365 rows have more active users than installs. **All 83 are on day 0.**
- Day-0 retention ranges from 86.9% to 108.3% and is spread evenly around 100% (95 cohorts below, 83 above).
- So the rows above 100% are not a special error. They are the visible half of symmetric random noise.

### 2b. Every day is noisy, not only day 0
We can't see the noise on one row, but we can see it by comparing things that should be equal:

| Check | What we saw |
|---|---|
| Same game, same day, 3 cohorts | They disagree. G01 day 1: 31.4% / 32.2% / 29.6% |
| Day-to-day movement | Active users *rise* vs the previous day in 809 of 3915 cohort-days (21%). G01 cohort 1, days 10–20: `105, 96, 103, 95, 86, 82, 87, 76, 72, 70, 76` |
| Distance from a smooth power-law curve | ~4% on every day (day 1: 3.2%, day 3: 3.9%, days 7/14/30: 4.0%) |

**Conclusion:** the data looks like *smooth curve × about ±4% random noise* on every row. In real games, daily actives can rise for real reasons (weekends, events). In this synthetic data the trend is smooth, so the zigzag is noise.

### 2c. Decision: keep the raw data
We tested three options with the same leave-one-game-out validation, all scored against the same true answers (mean absolute % error):

| Option | D7 | D30 | LTV30 |
|---|---|---|---|
| **Keep as is** (chosen) | 3.48% | 6.61% | **3.07%** |
| Cap at 100% | 3.47% | 6.59% | 3.05% |
| Drop the rows | 3.44% | 6.51% | **6.71%** |

- **Dropping doubles the LTV30 error.** The dropped rows also have higher day-0 revenue ($0.0316 vs $0.0302 per install). Removing only the high side of symmetric noise pulls revenue down. The general lesson: when noise goes both ways, cutting one side biases the data.
- **Capping is harmless but doesn't help** (differences ≤ 0.1 pp). We keep the raw data because it is simpler and needs no justification.
- The hidden true answers for G46–G60 also come from noisy data. Cleaning our inputs would not make those answers cleaner.

### 2d. What this means for the rest of the work
1. **Accuracy floor.** Pooling 3 cohorts leaves noise with a typical size (standard deviation) of about **2.2%** in each game's daily value, and the hidden true answers carry that noise too. Even a perfect model that knew the true curve would miss a single day's value by **~1.8% on average** (mean absolute error of noise with sd 2.2%; checked by simulation). So we compare our errors against this floor, not against zero.

   *Why we can't "subtract the 4%" to reach zero:* the noise is random in sign and size (e.g. +1.4%, +3.3%, −5.2%, …), and 4% is only its typical size. Subtracting a fixed 4% shifts every row down, which hurts the rows that were already low (in a 6-row simulation the mean error went from 2.8% to 3.0%). We can't remove noise from one row because we don't know its direction. We can only shrink it by averaging many rows (pooling cohorts, fitting a curve through many days). And no input processing can remove the noise in the hidden answers.
2. **Smooth curves, not point values.** Fitting a curve through several days averages the noise out, while reading a single day keeps it.
3. **Intervals, not single numbers.** A single number would pretend the noise is not there.

---

## 3. Baseline: power-law curve from days 1–3
*Source: `python3 part1/analysis/baseline_walkthrough.py` (also draws `part1/analysis/figs/baseline_G01.png`).*

### How it works
1. **Retention.** For each game separately, fit `retention(day) = c · day^b` through days 1, 2 and 3. This is a straight-line fit of log(retention) against log(day). Day 0 is left out because it is ~100% by definition and does not follow the curve. Then read the curve at day 7 and day 30.
2. **LTV30** = revenue already earned on days 0–3 + (revenue per active user on days 0–3) × (sum of predicted retention, days 4–30).
   This assumes revenue per active user stays flat after day 3. On the 45 complete games it does: days 4–30 average 1.01× the days 0–3 value, and the two correlate at 0.99.

**Worked example, G01:** days 1–3 = 0.308, 0.211, 0.172 → fit `0.307 · day^−0.533`.

| | predicted | actual | error |
|---|---|---|---|
| D7 | 0.1089 | 0.1048 | +3.9% |
| D30 | 0.0501 | 0.0442 | +13.5% |
| LTV30 | 0.1021 | 0.0985 | +3.6% |

### Why a power law
- On the 45 complete games, a power law fitted to days 1–30 misses by only **2.3%** on average, which is about the size of the noise (~2.2%). So **the shape is right**, and the only hard part is estimating its two numbers (c and b) from 3 noisy points.
- It is also the standard simple retention model in mobile games, and it is what the case brief suggests as a baseline.

### Why errors grow from D7 to D30
The fit sees days 1–3 only. A small noise-driven error in the slope `b` is multiplied by the distance we extrapolate: day 7 is close to the data, day 30 is ten times further out on the log scale. This is why G01 is +3.9% at D7 but +13.5% at D30.
LTV30 is the most accurate of the three because on average 46% of it (days 0–3 revenue; range 32–70% across the 45 games) is observed, not predicted.

### Baseline score on the 45 training games
The baseline has no training step, so scoring it on G01–G45 has no leakage risk.

| | mean abs error | avg bias | worst game |
|---|---|---|---|
| D7 | 4.5% | +1.5% | 12.8% |
| D30 | 8.0% | +2.9% | 23.9% |
| LTV30 | 3.8% | +0.4% | 11.4% |

**Bias** means the baseline *over*-predicts on average: the real curves bend down a little faster after day 3 than the first 3 days suggest (visible on the log-log chart). A model trained on the 45 complete games can learn to correct this. That is the idea behind step 4.

## 4. Model: not yet reviewed
## 5. Validation and intervals: not yet reviewed
## 6. Decision threshold: not yet decided
Open question: 0.4 with a retest band, or 0.5 with model intervals only. See `part1/run_part1.py`.

---

## Reproduce
```bash
python3 part1/analysis/data_checks.py
python3 part1/analysis/cleaning_test.py
python3 part1/run_part1.py
```
