"""Step 2: the power-law baseline, shown on one game and then scored on all 45 training games.

Usage (from repo root):  python3 part1/analysis/baseline_walkthrough.py
Writes: part1/analysis/figs/baseline_G01.png
"""
import os
import sys
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from load import load
from models import features, baseline, truth

d, meta, R, V, P = load(os.path.join(HERE, '..', '..', 'cohorts.csv'))
G = 'G01'

# ---- 1. fit: retention(t) = exp(a) * t^b  <=>  log(retention) = a + b*log(t), on days 1,2,3 only ----
days = np.array([1, 2, 3])
y = R.loc[G, days].values
b, a = np.polyfit(np.log(days), np.log(y), 1)
print(f'{G} observed retention days 1-3: {np.round(y, 3)}')
print(f'fit: log(ret) = {a:.3f} + ({b:.3f}) * log(day)   ->   ret(day) = {np.exp(a):.3f} * day^{b:.3f}')
for t in [7, 30]:
    p = np.exp(a) * t ** b
    print(f'  day {t:2d}: predicted {p:.4f}  actual {R.loc[G, t]:.4f}  error {100 * (p / R.loc[G, t] - 1):+.1f}%')

# ---- 2. LTV30: revenue already earned days 0-3 + (revenue per active user) x predicted active share days 4-30 ----
rev03 = V.loc[G, 0:3].sum()
arpdau = V.loc[G, 0:3].sum() / R.loc[G, 0:3].sum()
fut = (np.exp(a) * np.arange(4, 31) ** b).sum()
ltv = rev03 + arpdau * fut
print(f'\nLTV30 = revenue days 0-3 ({rev03:.4f}) + revenue per active user ({arpdau:.4f}) x sum of predicted retention days 4-30 ({fut:.3f})')
print(f'      = {ltv:.4f}   actual {V.loc[G, 0:30].sum():.4f}   error {100 * (ltv / V.loc[G, 0:30].sum() - 1):+.1f}%')

# ---- 3. why a power law: on complete games it is a straight line on log-log axes ----
fits = []
for g in R.index[:45]:
    t = np.arange(1, 31)
    yy = np.log(R.loc[g, 1:30].values.astype(float))
    bb, aa = np.polyfit(np.log(t), yy, 1)
    fits.append(np.std(yy - (aa + bb * np.log(t))))
print(f'\nPower law fitted on days 1-30 of each of the 45 complete games: typical miss {100 * np.mean(fits):.1f}% '
      f'(close to the ~2.2% noise in the data) -> the shape is right; the hard part is estimating it from 3 days.')

# ---- 4. baseline scored on all 45 training games ----
f = features(R, V, P, meta)
tr = R.index[:45]
B, T = baseline(f.loc[tr]), truth(R.loc[tr], V.loc[tr])
print('\nBaseline on all 45 training games (no training involved, so no leakage):')
for k in ['d7', 'd30', 'ltv30']:
    e = B[k] / T[k] - 1
    print(f'  {k:5s}: mean abs error {100 * e.abs().mean():.1f}%   avg bias {100 * e.mean():+.1f}%   worst {100 * e.abs().max():.1f}%')

# ---- figure ----
os.makedirs(os.path.join(HERE, 'figs'), exist_ok=True)
fig, ax = plt.subplots(1, 2, figsize=(11, 4.2))
t = np.arange(1, 31)
for i, log in enumerate([False, True]):
    A = ax[i]
    A.plot(t, R.loc[G, 1:30], 'o', color='#999', ms=4, label='actual (days 4-30 hidden from the baseline)')
    A.plot(days, y, 'o', color='#d62728', ms=7, label='days 1-3 (all the baseline sees)')
    A.plot(t, np.exp(a) * t ** b, '-', color='#1f77b4', label=f'power law fit: {np.exp(a):.3f}·day^{b:.2f}')
    A.set_xlabel('day'); A.set_ylabel('retention')
    if log:
        A.set_xscale('log'); A.set_yscale('log'); A.set_title('Same data, log-log axes: a straight line')
    else:
        A.set_title(f'{G}: retention curve')
    A.legend(fontsize=8)
fig.tight_layout()
path = os.path.join(HERE, 'figs', 'baseline_G01.png')
fig.savefig(path, dpi=130)
print('\nfigure:', os.path.relpath(path, os.path.join(HERE, '..', '..')))
