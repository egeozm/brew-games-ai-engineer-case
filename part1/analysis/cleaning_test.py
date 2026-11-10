"""Does removing/capping the impossible day-0 rows (active users > installs) help?

Runs the same leave-one-game-out validation three ways: keep raw data, cap at installs, drop the rows.
Every option is scored against the same true answers (from the raw data).

Usage (from repo root):  python3 part1/analysis/cleaning_test.py
"""
import os
import sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from load import load
from models import features, baseline, SlopeModel, truth

CSV = os.path.join(HERE, '..', '..', 'cohorts.csv')


def load_mode(mode):
    d = pd.read_csv(CSV)
    bad = d.active_users > d.installs
    if mode == 'cap':
        d.loc[bad, 'active_users'] = d.loc[bad, 'installs']
    if mode == 'drop':
        d = d[~bad]
    # pool per day using only the cohorts present that day
    d = d.assign(w=d.avg_playtime_s * d.active_users)
    a = d.groupby(['game_id', 'day']).agg(au=('active_users', 'sum'), rev=('ad_revenue_usd', 'sum'),
                                          inst=('installs', 'sum'), w=('w', 'sum')).reset_index()
    a['ret'], a['rpi'], a['pt'] = a.au / a.inst, a.rev / a.inst, a.w / a.au
    meta = d.drop_duplicates('game_id').set_index('game_id')[['genre', 'cpi_usd']]
    piv = lambda c: a.pivot(index='game_id', columns='day', values=c)
    return meta, piv('ret'), piv('rpi'), piv('pt')


_, _, R0, V0, _ = load(CSV)
train = list(R0.index[:45])
T = truth(R0.loc[train], V0.loc[train])

print(f"{'option':6s} " + ' '.join(f'{k + " model":>11s} {k + " base":>10s}' for k in ['d7', 'd30', 'ltv30']) + '   (mean abs % error)')
rows = []
for mode in ['keep', 'cap', 'drop']:
    meta, R, V, P = load_mode(mode)
    f = features(R, V, P, meta)
    M = pd.concat([SlopeModel().fit(f.loc[[x for x in train if x != g]], R.loc[[x for x in train if x != g]]).predict(f.loc[[g]])
                   for g in train])
    B = baseline(f.loc[train])
    err = lambda X, k: 100 * np.mean(np.abs(X[k] / T[k] - 1))
    print(f'{mode:6s} ' + ' '.join(f'{err(M, k):10.2f}% {err(B, k):9.2f}%' for k in ['d7', 'd30', 'ltv30']))
    rows.append({'option': mode, **{k: err(M, k) for k in ['d7', 'd30', 'ltv30']}})

# Chart: model error per option (lower is better)
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams.update({'font.size': 9, 'axes.spines.top': False, 'axes.spines.right': False})
res = pd.DataFrame(rows).set_index('option')
fig, ax = plt.subplots(figsize=(7, 3.4))
x = np.arange(3)
cols = {'keep': '#1f77b4', 'cap': '#2ca02c', 'drop': '#d62728'}
for i, mode in enumerate(res.index):
    bars = ax.bar(x + (i - 1) * 0.26, res.loc[mode], 0.26, color=cols[mode], label=mode)
    ax.bar_label(bars, fmt='%.2f', fontsize=7, padding=1)
ax.set_xticks(x, ['D7', 'D30', 'LTV30'])
ax.set_ylabel('model error, leave-one-game-out (%)')
ax.set_title('What to do with the day-0 rows above 100%? Keep and cap tie; drop breaks LTV30')
ax.legend(frameon=False)
fig.tight_layout()
os.makedirs(os.path.join(HERE, 'figs'), exist_ok=True)
fig.savefig(os.path.join(HERE, 'figs', 'cleaning_options.png'), dpi=140)
