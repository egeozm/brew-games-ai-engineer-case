"""Part 1: forecast D7, D30, LTV30 for G46-G60 and label continue / stop / retest.

Usage (from repo root):  python3 part1/run_part1.py
Writes to part1/out/:
  predictions.csv            the deliverable: game_id, d7, d30, ltv30, alt, üst, karar (+ extra interval columns)
  predictions_detail.csv     same, with LTV30/CPI and English labels
  validation.csv             baseline vs model, measured with leave-one-game-out on G01-G45
  validation_per_game.csv    every held-out prediction, for checking by hand
  decision_backtest.csv      the decision rule replayed on G01-G45
  thresholds.json            the two decision thresholds and where they come from
  figs/*.png                 charts used in the note
"""
import json
import os
import sys
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from load import load
from models import features, baseline, SlopeModel, truth

COVERAGE = 0.90          # nominal coverage of every interval
TARGETS = ['d7', 'd30', 'ltv30']
LABEL_TR = {'continue': 'devam', 'stop': 'dur', 'retest': 'tekrar test'}
RNG = np.random.default_rng(0)
OUT = os.path.join(HERE, 'out')
FIGS = os.path.join(OUT, 'figs')


# ---------------------------------------------------------------- validation helpers
def logo_predictions(f, R, train):
    """Leave-one-game-out: for each training game, fit on the other 44 and predict it from its days 0-3."""
    rows = []
    for g in train:
        rest = [x for x in train if x != g]
        rows.append(SlopeModel().fit(f.loc[rest], R.loc[rest]).predict(f.loc[[g]]))
    return pd.concat(rows)


def conformal_quantiles(res, cov):
    """Quantiles of held-out log residuals log(truth/pred), with the usual (n+1) finite-sample correction."""
    n = len(res)
    lo_q = max(0.0, np.floor((n + 1) * (1 - cov) / 2) / n)
    hi_q = min(1.0, np.ceil((n + 1) * (1 - (1 - cov) / 2)) / n)
    return np.quantile(res, lo_q), np.quantile(res, hi_q)


def nested_coverage(res, cov):
    """Honest coverage estimate: each game's interval is built only from the OTHER games' residuals."""
    hit = []
    for i in range(len(res)):
        lo, hi = conformal_quantiles(np.delete(res, i), cov)
        hit.append(lo <= res[i] <= hi)
    return float(np.mean(hit))


def boot_ci(x, n=5000):
    """95% bootstrap interval of the mean of x (resampling games)."""
    idx = RNG.integers(0, len(x), (n, len(x)))
    return np.quantile(x[idx].mean(1), [0.025, 0.975])


# ---------------------------------------------------------------- decision helpers
def lifetime_multipliers(R, V, train):
    """How much more than LTV30 a game earns by day 180 / 365 IF its days 1-30 power law keeps going.

    This is an extrapolation beyond the data (no game has days > 30), so it is an assumption, not a measurement.
    """
    out = {180: [], 365: []}
    for g in train:
        t = np.arange(1, 31)
        b, a = np.polyfit(np.log(t), np.log(R.loc[g, 1:30].values.astype(float)), 1)
        arpdau = V.loc[g, 0:30].sum() / R.loc[g, 0:30].sum()
        l30 = V.loc[g, 0:30].sum()
        for H in out:
            out[H].append((l30 + arpdau * np.exp(a) * (np.arange(31, H + 1) ** b).sum()) / l30)
    return {H: float(np.median(v)) for H, v in out.items()}


def decide(lo, hi, t_go, t_stop):
    """continue: even the low end pays back in ~6 months. stop: even the high end cannot pay back in a year."""
    if lo >= t_go:
        return 'continue'
    if hi < t_stop:
        return 'stop'
    return 'retest'


# ---------------------------------------------------------------- main
def main():
    os.makedirs(FIGS, exist_ok=True)
    d, meta, R, V, P = load(os.path.join(HERE, '..', 'cohorts.csv'))
    f = features(R, V, P, meta)
    train = [g for g in R.index if R.loc[g, 30] == R.loc[g, 30]]   # day 30 observed
    test = [g for g in R.index if g not in train]

    T = truth(R.loc[train], V.loc[train])
    B = baseline(f.loc[train])
    M = logo_predictions(f, R, train)

    # ---- 1. validation: baseline vs model on held-out games ----
    rows, per_game, resid, resid_b = [], pd.DataFrame(index=pd.Index(train, name='game_id')), {}, {}
    for k in TARGETS:
        eb, em = np.log(B[k] / T[k]).values, np.log(M[k] / T[k]).values
        ape_b, ape_m = np.abs(np.exp(eb) - 1), np.abs(np.exp(em) - 1)
        ci = boot_ci(ape_b - ape_m)
        resid[k], resid_b[k] = -em, -eb           # log(truth / pred)
        rows.append({
            'target': k,
            'baseline_MAPE_%': 100 * ape_b.mean(), 'model_MAPE_%': 100 * ape_m.mean(),
            'gain_pp': 100 * (ape_b - ape_m).mean(), 'gain_95CI_lo_pp': 100 * ci[0], 'gain_95CI_hi_pp': 100 * ci[1],
            'model_better_games': int((ape_m < ape_b).sum()),
            'baseline_bias_%': 100 * (np.exp(eb.mean()) - 1), 'model_bias_%': 100 * (np.exp(em.mean()) - 1),
            'model_90PI_coverage': nested_coverage(resid[k], COVERAGE),
            'baseline_90PI_coverage': nested_coverage(resid_b[k], COVERAGE),
            'model_90PI_halfwidth_%': 100 * (np.exp(np.diff(conformal_quantiles(resid[k], COVERAGE))[0] / 2) - 1),
        })
        per_game[k + '_true'], per_game[k + '_baseline'], per_game[k + '_model'] = T[k], B[k], M[k]
    val = pd.DataFrame(rows)
    val.round(3).to_csv(os.path.join(OUT, 'validation.csv'), index=False)
    per_game.round(5).to_csv(os.path.join(OUT, 'validation_per_game.csv'))

    # ---- 2. thresholds ----
    k = lifetime_multipliers(R, V, train)
    t_go, t_stop = 1 / k[180], 1 / k[365]
    test_cost = float((meta.installs * meta.cpi_usd).loc[train].median())
    thr = {'t_continue': round(t_go, 3), 't_stop': round(t_stop, 3),
           'ltv180_over_ltv30_median': round(k[180], 3), 'ltv365_over_ltv30_median': round(k[365], 3),
           'median_ad_test_cost_usd': round(test_cost, 0),
           'note': 'continue if LTV30/CPI lower bound >= 1/k180 (pays back in ~6 months if the power law holds); '
                   'stop if upper bound < 1/k365 (cannot pay back within a year); otherwise retest.'}
    json.dump(thr, open(os.path.join(OUT, 'thresholds.json'), 'w'), indent=2)

    # ---- 3. decision rule replayed on the training games (with their held-out predictions) ----
    ql = conformal_quantiles(resid['ltv30'], COVERAGE)
    cpi_tr = meta.cpi_usd[train]
    bt = pd.DataFrame({'pred_ratio': M.ltv30 / cpi_tr, 'lo': M.ltv30 * np.exp(ql[0]) / cpi_tr,
                       'hi': M.ltv30 * np.exp(ql[1]) / cpi_tr, 'true_ratio': T.ltv30 / cpi_tr})
    bt['decision'] = [decide(lo, hi, t_go, t_stop) for lo, hi in zip(bt.lo, bt.hi)]
    bt['true_class'] = np.where(bt.true_ratio >= t_go, 'good', np.where(bt.true_ratio < t_stop, 'bad', 'middle'))
    bt.round(4).to_csv(os.path.join(OUT, 'decision_backtest.csv'), index_label='game_id')

    # ---- 4. final model on all 45 games, predict the 15 new games ----
    model = SlopeModel().fit(f.loc[train], R.loc[train])
    Pt = model.predict(f.loc[test])
    q = {kk: conformal_quantiles(resid[kk], COVERAGE) for kk in TARGETS}
    det = pd.DataFrame(index=pd.Index(test, name='game_id'))
    det['genre'] = meta.genre[test]
    for kk in TARGETS:
        det[kk] = Pt[kk]
        det[kk + '_lo'] = Pt[kk] * np.exp(q[kk][0])
        det[kk + '_hi'] = Pt[kk] * np.exp(q[kk][1])
    det['cpi'] = meta.cpi_usd[test]
    det['ratio'] = det.ltv30 / det.cpi
    det['ratio_lo'] = det.ltv30_lo / det.cpi
    det['ratio_hi'] = det.ltv30_hi / det.cpi
    det['decision'] = [decide(lo, hi, t_go, t_stop) for lo, hi in zip(det.ratio_lo, det.ratio_hi)]
    det.round(5).to_csv(os.path.join(OUT, 'predictions_detail.csv'))

    deliver = pd.DataFrame({
        'game_id': test, 'd7': det.d7.values, 'd30': det.d30.values, 'ltv30': det.ltv30.values,
        'alt': det.ltv30_lo.values, 'üst': det.ltv30_hi.values,
        'karar': [LABEL_TR[x] for x in det.decision],
        'd7_alt': det.d7_lo.values, 'd7_üst': det.d7_hi.values, 'd30_alt': det.d30_lo.values, 'd30_üst': det.d30_hi.values,
    })
    deliver.round(5).to_csv(os.path.join(OUT, 'predictions.csv'), index=False)

    make_figures(R, V, f, train, test, T, B, M, val, bt, det, t_go, t_stop, resid)

    # ---- console summary ----
    pd.set_option('display.width', 220)
    print(f'train games: {len(train)}  test games: {len(test)}  interval coverage target: {COVERAGE:.0%}')
    print('\nVALIDATION (leave-one-game-out on G01-G45)')
    print(val.round(2).to_string(index=False))
    print('\nTHRESHOLDS', json.dumps({k_: v for k_, v in thr.items() if k_ != 'note'}))
    print('\nDECISION RULE ON TRAINING GAMES (rows = decision, cols = true class)')
    print(pd.crosstab(bt.decision, bt.true_class))
    print('\nPREDICTIONS')
    print(det[['genre', 'd7', 'd30', 'ltv30', 'ltv30_lo', 'ltv30_hi', 'cpi', 'ratio', 'ratio_lo', 'ratio_hi', 'decision']].round(3).to_string())


# ---------------------------------------------------------------- figures
def make_figures(R, V, f, train, test, T, B, M, val, bt, det, t_go, t_stop, resid):
    plt.rcParams.update({'font.size': 9, 'axes.spines.top': False, 'axes.spines.right': False})
    C_B, C_M, C_T = '#9aa5b1', '#1f77b4', '#d62728'

    # 1. predicted vs actual, baseline vs model, three targets
    fig, ax = plt.subplots(1, 3, figsize=(12, 3.8))
    for i, k in enumerate(TARGETS):
        A = ax[i]
        lo, hi = T[k].min() * 0.85, T[k].max() * 1.15
        A.plot([lo, hi], [lo, hi], color='#444', lw=0.8, ls='--')
        A.scatter(T[k], B[k], s=16, color=C_B, label=f"baseline ({val.set_index('target').loc[k, 'baseline_MAPE_%']:.1f}% err)")
        A.scatter(T[k], M[k], s=16, color=C_M, label=f"model ({val.set_index('target').loc[k, 'model_MAPE_%']:.1f}% err)")
        A.set_xscale('log'); A.set_yscale('log')
        A.set_xlabel(f'actual {k.upper()}'); A.set_ylabel('predicted (held out)')
        A.set_title(k.upper()); A.legend(fontsize=8, frameon=False)
    fig.suptitle('Held-out predictions on G01-G45 (each game predicted by a model that never saw it)', fontsize=10)
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p1_pred_vs_actual.png'), dpi=140); plt.close(fig)

    # 2. error comparison with bootstrap CI of the gain
    fig, ax = plt.subplots(figsize=(6.5, 3.4))
    x = np.arange(3)
    v = val.set_index('target')
    ax.bar(x - 0.18, v['baseline_MAPE_%'], 0.36, color=C_B, label='baseline (power law, days 1-3)')
    ax.bar(x + 0.18, v['model_MAPE_%'], 0.36, color=C_M, label='model (learned curve)')
    for i, k in enumerate(TARGETS):
        ax.text(i, max(v.loc[k, 'baseline_MAPE_%'], v.loc[k, 'model_MAPE_%']) + 0.3,
                f"gain {v.loc[k, 'gain_pp']:.1f}pp\n95% CI [{v.loc[k, 'gain_95CI_lo_pp']:.1f}, {v.loc[k, 'gain_95CI_hi_pp']:.1f}]",
                ha='center', fontsize=8)
    ax.axhline(1.8, color='#888', ls=':', lw=1)
    ax.text(2.45, 1.95, 'noise floor ~1.8%', fontsize=7, color='#666', ha='right')
    ax.set_xticks(x); ax.set_xticklabels([k.upper() for k in TARGETS])
    ax.set_ylabel('mean abs % error (held out)'); ax.set_ylim(0, v['baseline_MAPE_%'].max() + 2.5)
    ax.legend(fontsize=8, frameon=False, loc='upper left')
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p1_error_bars.png'), dpi=140); plt.close(fig)

    # 3. interval check: held-out residuals and the 90% band
    fig, ax = plt.subplots(1, 3, figsize=(12, 3.2))
    for i, k in enumerate(TARGETS):
        r = 100 * (np.exp(resid[k]) - 1)
        lo, hi = [100 * (np.exp(qq) - 1) for qq in conformal_quantiles(resid[k], COVERAGE)]
        order = np.argsort(r)
        inside = (r >= lo) & (r <= hi)
        ax[i].scatter(np.arange(len(r)), r[order], s=12, c=np.where(inside[order], C_M, C_T))
        ax[i].axhspan(lo, hi, color=C_M, alpha=0.08)
        ax[i].axhline(0, color='#444', lw=0.6)
        ax[i].set_title(f'{k.upper()}: 90% band [{lo:+.1f}%, {hi:+.1f}%]', fontsize=9)
        ax[i].set_xlabel('training games, sorted by error'); ax[i].set_ylabel('actual vs predicted, %')
    fig.suptitle('How far reality landed from the held-out prediction (red = outside the 90% band)', fontsize=10)
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p1_intervals.png'), dpi=140); plt.close(fig)

    # 4. decision chart for the 15 new games
    d = det.sort_values('ratio')
    fig, ax = plt.subplots(figsize=(8, 4.6))
    col = {'continue': '#2ca02c', 'retest': '#ff7f0e', 'stop': '#d62728'}
    y = np.arange(len(d))
    ax.hlines(y, d.ratio_lo, d.ratio_hi, color=[col[c] for c in d.decision], lw=4, alpha=0.6)
    ax.scatter(d.ratio, y, color=[col[c] for c in d.decision], zorder=3, s=22)
    ax.axvline(t_go, color='#2ca02c', ls='--', lw=1); ax.text(t_go, len(d) - 0.3, f' continue ≥ {t_go:.2f}', color='#2ca02c', fontsize=8)
    ax.axvline(t_stop, color='#d62728', ls='--', lw=1); ax.text(t_stop, -1.0, f'stop < {t_stop:.2f} ', color='#d62728', fontsize=8, ha='right')
    ax.set_yticks(y); ax.set_yticklabels([f'{g} ({d.loc[g, "genre"]})' for g in d.index], fontsize=8)
    ax.set_xlabel('predicted LTV30 / CPI with 90% interval'); ax.set_xscale('log')
    for c in col:
        ax.scatter([], [], color=col[c], label=c)
    ax.legend(frameon=False, fontsize=8, loc='lower right')
    ax.set_title('Decisions for G46-G60', fontsize=10)
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p1_decisions.png'), dpi=140); plt.close(fig)

    # 5. backtest of the rule on training games
    fig, ax = plt.subplots(figsize=(6.5, 4))
    for c in col:
        s = bt[bt.decision == c]
        ax.scatter(s.true_ratio, s.pred_ratio, color=col[c], s=20, label=f'{c} ({len(s)})')
    lim = [bt[['true_ratio', 'pred_ratio']].min().min() * 0.8, bt[['true_ratio', 'pred_ratio']].max().max() * 1.2]
    ax.plot(lim, lim, color='#444', lw=0.6, ls='--')
    for t_, c_ in [(t_go, '#2ca02c'), (t_stop, '#d62728')]:
        ax.axvline(t_, color=c_, lw=0.8, ls=':'); ax.axhline(t_, color=c_, lw=0.8, ls=':')
    ax.set_xscale('log'); ax.set_yscale('log')
    ax.set_xlabel('TRUE LTV30 / CPI'); ax.set_ylabel('predicted (held out)')
    ax.set_title('Decision rule replayed on G01-G45', fontsize=10); ax.legend(frameon=False, fontsize=8)
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p1_backtest.png'), dpi=140); plt.close(fig)

    # 6. example curves: 3 test games, observed days 0-3 + forecast
    fig, ax = plt.subplots(figsize=(7, 3.8))
    t = np.arange(1, 31)
    for g, c in zip([det.ratio.idxmax(), det.ratio.idxmin(), det.index[len(det) // 2]], ['#2ca02c', '#d62728', '#1f77b4']):
        ax.plot([1, 2, 3], R.loc[g, [1, 2, 3]], 'o', color=c)
        b_, a_ = SlopeModel_curve(det, g)
        ax.plot(t, np.exp(a_) * t ** b_, color=c, label=f'{g}: D7 {det.loc[g, "d7"]:.3f}, D30 {det.loc[g, "d30"]:.3f}')
    ax.set_xlabel('day'); ax.set_ylabel('retention'); ax.set_yscale('log')
    ax.set_title('Three new games: observed days 1-3 (dots) and forecast curve', fontsize=10)
    ax.legend(frameon=False, fontsize=8)
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p1_test_curves.png'), dpi=140); plt.close(fig)


def SlopeModel_curve(det, g):
    """Recover the forecast power law (a, b) for game g from its predicted D7 and D30."""
    b = np.log(det.loc[g, 'd30'] / det.loc[g, 'd7']) / np.log(30 / 7)
    a = np.log(det.loc[g, 'd7']) - b * np.log(7)
    return b, a


if __name__ == '__main__':
    main()
