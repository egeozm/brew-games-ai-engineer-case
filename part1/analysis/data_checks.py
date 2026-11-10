"""Data understanding checks for Part 1. Every number in part1/FINDINGS.md sections 1-2 comes from here.

Usage (from repo root):  python3 part1/analysis/data_checks.py
"""
import os
import numpy as np
import pandas as pd

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
d = pd.read_csv(os.path.join(ROOT, 'cohorts.csv'))
d['ret'] = d.active_users / d.installs


def section(title):
    print('\n' + '=' * 70 + '\n' + title + '\n' + '=' * 70)


section('A. Shape of the data')
print('rows:', len(d), '| games:', d.game_id.nunique(), '| cohorts per game:', d.groupby('game_id').cohort.nunique().unique())
print('last observed day per game:', d.groupby('game_id').day.max().value_counts().to_dict())
print('genres:', d.drop_duplicates('game_id').genre.value_counts().to_dict())
print('CPI differs between cohorts of a game:', int((d.groupby('game_id').cpi_usd.nunique() > 1).sum()), 'games')

section('B. Worked example: G01 (3 cohorts pooled)')
g = d[d.game_id == 'G01']
inst = g.drop_duplicates('cohort').installs.sum()
p = g.groupby('day').agg(active=('active_users', 'sum'), rev=('ad_revenue_usd', 'sum'))
print('total installs:', inst)
for day in [0, 1, 7, 30]:
    print(f'day {day:2d}: active {p.active[day]:5d} -> retention {p.active[day] / inst:.3f}')
ltv = p.rev.sum() / inst
print(f'LTV30 = {ltv:.4f} $/user | CPI = {g.cpi_usd.iloc[0]} | LTV30/CPI = {ltv / g.cpi_usd.iloc[0]:.2f}')

section('C. Rows with active users > installs (retention > 100%)')
bad = d[d.active_users > d.installs]
print('count:', len(bad), 'of', len(d), '| by day:', bad.day.value_counts().to_dict())
r0 = d[d.day == 0].ret
print(f'day-0 retention over all cohorts: min {r0.min():.3f}, median {r0.median():.3f}, max {r0.max():.3f}')
print('cohorts below 100%:', int((r0 < 1).sum()), '| above 100%:', int((r0 > 1).sum()))
d0 = d[d.day == 0].assign(rev_per_install=lambda x: x.ad_revenue_usd / x.installs, above=lambda x: x.ret > 1)
print('day-0 revenue per install, rows <=100% vs >100%:', d0.groupby('above').rev_per_install.mean().round(4).to_dict())

section('D. Noise on all days')
print('D1. G01 retention by cohort (same game, same day, should match):')
print(g[g.day.isin([1, 3, 7, 14, 30])].pivot(index='day', columns='cohort', values='ret').round(3))
s = d.sort_values(['game_id', 'cohort', 'day']).copy()
s['up'] = s.groupby(['game_id', 'cohort']).active_users.diff() > 0
later = s[(s.game_id <= 'G45') & (s.day >= 2)]          # day>=2 so there is a previous day >=1
print(f'\nD2. day-to-day increases in active users (G01-G45, days 2-30): {later.up.sum()} of {len(later)} ({100 * later.up.mean():.0f}%)')
print('    G01 cohort 1, days 10-20:', s[(s.game_id == 'G01') & (s.cohort == 1) & s.day.between(10, 20)].active_users.tolist())
res = []
for _, x in s[(s.game_id <= 'G45') & (s.day >= 1)].groupby(['game_id', 'cohort']):
    b, a = np.polyfit(np.log(x.day), np.log(x.ret), 1)
    res += list(zip(x.day, np.log(x.ret) - (a + b * np.log(x.day))))
res = pd.DataFrame(res, columns=['day', 'r'])
print('\nD3. typical distance from a smooth power-law curve, per cohort (log sd, %):')
print('   ', {int(k): round(100 * v, 1) for k, v in res.groupby('day').r.std().loc[[1, 3, 7, 14, 30]].items()})
print(f'    all days 1-30: {100 * res.r.std():.1f}%  -> after pooling 3 cohorts ~{100 * res.r.std() / np.sqrt(3):.1f}%')
