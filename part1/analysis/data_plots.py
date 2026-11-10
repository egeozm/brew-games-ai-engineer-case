"""Data-quality charts for Part 1 (outliers and noise). Numbers match data_checks.py.

Usage (from repo root):  python3 part1/analysis/data_plots.py
Writes part1/analysis/figs/outliers_day0.png and noise.png.
"""
import os
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
FIGS = os.path.join(HERE, 'figs')
os.makedirs(FIGS, exist_ok=True)
plt.rcParams.update({'font.size': 9, 'axes.spines.top': False, 'axes.spines.right': False})

d = pd.read_csv(os.path.join(HERE, '..', '..', 'cohorts.csv'))
d['ret'] = d.active_users / d.installs

# 1. Outliers: retention above 100% (impossible). Where are they?
fig, ax = plt.subplots(1, 2, figsize=(11, 3.8))
bad = d[d.ret > 1]
cnt = bad.day.value_counts().reindex(range(31), fill_value=0)
ax[0].bar(cnt.index, cnt.values, color='#d62728')
ax[0].set_xlabel('day'); ax[0].set_ylabel('rows with active users > installs')
ax[0].set_title(f'{len(bad)} impossible rows of {len(d)}: all on day 0')
r0 = d[d.day == 0].ret
bins = np.linspace(r0.min(), r0.max(), 30)
ax[1].hist(r0[r0 <= 1], bins=bins, color='#1f77b4', label=f'≤ 100% ({(r0 <= 1).sum()} cohorts)')
ax[1].hist(r0[r0 > 1], bins=bins, color='#d62728', label=f'> 100% ({(r0 > 1).sum()} cohorts)')
ax[1].axvline(1, color='#444', ls='--', lw=1)
ax[1].set_xlabel('day-0 retention (active users / installs)'); ax[1].set_ylabel('cohorts')
ax[1].set_title('Day-0 retention is one smooth cloud around 100%:\nthe ones above are noise, not a separate group')
ax[1].legend(frameon=False, fontsize=8)
fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'outliers_day0.png'), dpi=140); plt.close(fig)

# 2. Noise on every day: same game, 3 cohorts should match but don't; distance from a smooth curve
s = d.sort_values(['game_id', 'cohort', 'day'])
res = []
for _, x in s[(s.game_id <= 'G45') & (s.day >= 1)].groupby(['game_id', 'cohort']):
    b, a = np.polyfit(np.log(x.day), np.log(x.ret), 1)
    res += list(zip(x.day, np.log(x.ret) - (a + b * np.log(x.day))))
res = pd.DataFrame(res, columns=['day', 'r'])
sd = res.r.std()

fig, ax = plt.subplots(1, 2, figsize=(11, 3.8))
g = d[(d.game_id == 'G01') & (d.day >= 1)]
for c, col in zip(sorted(g.cohort.unique()), ['#1f77b4', '#ff7f0e', '#2ca02c']):
    x = g[g.cohort == c]
    ax[0].plot(x.day, x.ret, 'o-', ms=3, lw=0.8, color=col, label=f'cohort {c}')
ax[0].set_xlabel('day'); ax[0].set_ylabel('retention'); ax[0].set_yscale('log')
ax[0].set_title('G01: three cohorts of the same game zig-zag\n(active users even rise on some days)')
ax[0].legend(frameon=False, fontsize=8)
ax[1].hist(100 * res.r, bins=60, color='#7f7f7f')
ax[1].axvline(-100 * sd, color='#d62728', ls='--', lw=1); ax[1].axvline(100 * sd, color='#d62728', ls='--', lw=1)
ax[1].set_xlabel('distance from smooth power-law curve (%, log scale)'); ax[1].set_ylabel('rows (G01–G45, days 1–30)')
ax[1].set_title(f'Every day is noisy: typical distance ±{100 * sd:.1f}% per row,\n≈ ±{100 * sd / np.sqrt(3):.1f}% after pooling 3 cohorts')
fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'noise.png'), dpi=140); plt.close(fig)
print('wrote', os.listdir(FIGS))
