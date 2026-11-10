"""Part 2: results table, significance tests and charts from game/results/*.json (written by game/bench.js).

Usage (from repo root):  python3 part2/analyze.py
Writes: part2/out/results_table.csv, part2/out/results_table.md, part2/out/comparisons.md, part2/out/figs/*.png
"""
import glob
import json
import math
import os
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, '..', 'game', 'results')
OUT = os.path.join(HERE, 'out')
FIGS = os.path.join(OUT, 'figs')
RNG = np.random.default_rng(0)
ORDER = ['random', 'rule', 'llm_v1', 'llm_v2']
COL = {'random': '#9aa5b1', 'rule': '#2ca02c', 'llm_v1': '#1f77b4', 'llm_v2': '#9467bd'}


def wilson(k, n, z=1.96):
    """95% confidence interval for a win rate (Wilson score interval: works well for small n and rates near 0 or 1)."""
    if n == 0:
        return (np.nan, np.nan)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0, c - h), min(1, c + h))


def mcnemar_exact(b, c):
    """Exact two-sided McNemar test on discordant pairs (b = only A won, c = only B won), same seeds for both bots."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(0, k + 1)) / 2 ** n
    return min(1.0, 2 * p)


def boot_mean_diff(a, b, n=10000):
    """Paired bootstrap 95% CI of mean(a - b) over seeds."""
    d = np.asarray(a, float) - np.asarray(b, float)
    idx = RNG.integers(0, len(d), (n, len(d)))
    m = d[idx].mean(1)
    return d.mean(), np.quantile(m, 0.025), np.quantile(m, 0.975)


def load():
    frames = []
    for f in sorted(glob.glob(os.path.join(RES, '*.json'))):
        name = os.path.basename(f).split('.')[0]
        if name.startswith('smoke'):
            continue
        df = pd.DataFrame(json.load(open(f)))
        df['bot'] = name
        frames.append(df)
    d = pd.concat(frames, ignore_index=True).drop_duplicates(['bot', 'seed'], keep='last')
    return d


def summarize(d, seeds=None):
    rows = []
    for bot in [b for b in ORDER if b in d.bot.unique()]:
        x = d[d.bot == bot]
        if seeds is not None:
            x = x[x.seed.isin(seeds)]
        n, k = len(x), int(x.won.sum())
        lo, hi = wilson(k, n)
        r = {'bot': bot, 'games': n, 'wins': k, 'win_rate': k / n, 'win_95CI_lo': lo, 'win_95CI_hi': hi,
             'avg_wave_reached': x.wave.mean(), 'avg_moves_per_game': x.steps.mean(), 'avg_sec_per_game': x.ms.mean() / 1000}
        if 'llmCalls' in x and x.llmCalls.notna().any():
            r.update({'llm_calls_per_game': x.llmCalls.mean(), 'input_tokens_per_game': x.inputTokens.mean(),
                      'output_tokens_per_game': x.outputTokens.mean(), 'illegal_actions_per_game': x.illegal.mean(),
                      'forced_fights_per_game': x.forcedFights.mean(), 'api_errors_total': int(x.apiErrors.sum()),
                      'paid_equiv_usd_per_game': x.costUsd.mean() if x.costUsd.notna().any() else np.nan,
                      'model': x.model.iloc[0]})
        rows.append(r)
    return pd.DataFrame(rows)


def paired(d, a, b):
    A = d[d.bot == a].set_index('seed')
    B = d[d.bot == b].set_index('seed')
    s = A.index.intersection(B.index)
    if not len(s):
        return None
    wa, wb = A.loc[s, 'won'].astype(int), B.loc[s, 'won'].astype(int)
    only_a, only_b = int(((wa == 1) & (wb == 0)).sum()), int(((wa == 0) & (wb == 1)).sum())
    md, lo, hi = boot_mean_diff(wa, wb)
    wd, wlo, whi = boot_mean_diff(A.loc[s, 'wave'], B.loc[s, 'wave'])
    return {'A': a, 'B': b, 'seeds': len(s), 'A_wins': int(wa.sum()), 'B_wins': int(wb.sum()),
            'only_A_won': only_a, 'only_B_won': only_b, 'mcnemar_p': mcnemar_exact(only_a, only_b),
            'win_rate_diff': md, 'win_diff_95CI': (lo, hi), 'wave_diff': wd, 'wave_diff_95CI': (wlo, whi)}


def main():
    os.makedirs(FIGS, exist_ok=True)
    d = load()
    llm_seeds = sorted(set(d[d.bot.str.startswith('llm')].seed)) if d.bot.str.startswith('llm').any() else list(range(1, 31))

    full = summarize(d)
    same = summarize(d, llm_seeds)
    full.to_csv(os.path.join(OUT, 'results_table_all_seeds.csv'), index=False)
    same.to_csv(os.path.join(OUT, 'results_table.csv'), index=False)

    def md_table(t):
        cols = [c for c in ['bot', 'model', 'games', 'wins', 'win_rate', 'win_95CI_lo', 'win_95CI_hi', 'avg_wave_reached',
                            'avg_moves_per_game', 'llm_calls_per_game', 'input_tokens_per_game', 'output_tokens_per_game',
                            'illegal_actions_per_game', 'avg_sec_per_game', 'paid_equiv_usd_per_game'] if c in t]
        return t[cols].round(3).to_markdown(index=False)

    comps = [p for p in [paired(d, 'llm_v1', 'rule'), paired(d, 'llm_v2', 'rule'), paired(d, 'llm_v2', 'llm_v1'),
                         paired(d, 'llm_v1', 'random'), paired(d, 'rule', 'random')] if p]
    with open(os.path.join(OUT, 'results_table.md'), 'w') as f:
        f.write(f'## Same seeds as the LLM runs ({len(llm_seeds)} seeds: {min(llm_seeds)}-{max(llm_seeds)})\n\n' + md_table(same) + '\n\n')
        f.write('## All seeds each bot played\n\n' + md_table(full) + '\n')
    with open(os.path.join(OUT, 'comparisons.md'), 'w') as f:
        f.write('| A vs B | seeds | A wins | B wins | only A won | only B won | McNemar p | win-rate diff [95% CI] | wave diff [95% CI] |\n|---|---|---|---|---|---|---|---|---|\n')
        for c in comps:
            f.write(f"| {c['A']} vs {c['B']} | {c['seeds']} | {c['A_wins']} | {c['B_wins']} | {c['only_A_won']} | {c['only_B_won']} | "
                    f"{c['mcnemar_p']:.3f} | {c['win_rate_diff']:+.3f} [{c['win_diff_95CI'][0]:+.3f}, {c['win_diff_95CI'][1]:+.3f}] | "
                    f"{c['wave_diff']:+.2f} [{c['wave_diff_95CI'][0]:+.2f}, {c['wave_diff_95CI'][1]:+.2f}] |\n")

    print(open(os.path.join(OUT, 'results_table.md')).read())
    print(open(os.path.join(OUT, 'comparisons.md')).read())
    figures(d, same, llm_seeds)


def figures(d, same, llm_seeds):
    plt.rcParams.update({'font.size': 9, 'axes.spines.top': False, 'axes.spines.right': False})
    bots = list(same.bot)

    # 1. win rate with 95% CI, same seeds
    fig, ax = plt.subplots(figsize=(6, 3.4))
    x = np.arange(len(bots))
    ax.bar(x, same.win_rate, color=[COL[b] for b in bots])
    ax.errorbar(x, same.win_rate, yerr=[same.win_rate - same.win_95CI_lo, same.win_95CI_hi - same.win_rate], fmt='none', ecolor='#333', capsize=4)
    for i, r in same.iterrows():
        ax.text(i, r.win_95CI_hi + 0.03, f'{r.wins}/{r.games}', ha='center', fontsize=8)
    ax.set_xticks(x); ax.set_xticklabels(bots); ax.set_ylim(0, 1.12); ax.set_ylabel('win rate (95% CI)')
    ax.set_title(f'Win rate on the same {len(llm_seeds)} seeds', fontsize=10)
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p2_winrate.png'), dpi=140); plt.close(fig)

    # 2. where games end: wave reached
    fig, ax = plt.subplots(figsize=(7, 3.4))
    w = 0.8 / len(bots)
    for i, b in enumerate(bots):
        x_ = d[(d.bot == b) & d.seed.isin(llm_seeds)]
        ended = x_.apply(lambda r: 11 if r.won else r.wave, axis=1)
        counts = ended.value_counts().reindex(range(1, 12), fill_value=0)
        ax.bar(np.arange(1, 12) + (i - (len(bots) - 1) / 2) * w, counts.values, w, color=COL[b], label=b)
    ax.set_xticks(range(1, 12)); ax.set_xticklabels([str(i) for i in range(1, 11)] + ['won'])
    ax.set_xlabel('wave where the game ended'); ax.set_ylabel('games'); ax.legend(frameon=False, fontsize=8)
    ax.set_title('Where each bot loses', fontsize=10)
    fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p2_wave_reached.png'), dpi=140); plt.close(fig)

    # 3. paired outcome per seed for the LLM versions and the rule bot
    show = [b for b in ['rule', 'llm_v1', 'llm_v2'] if b in bots]
    if len(show) >= 2:
        fig, ax = plt.subplots(figsize=(9, 0.5 + 0.45 * len(show)))
        for j, b in enumerate(show):
            x_ = d[(d.bot == b) & d.seed.isin(llm_seeds)].set_index('seed').reindex(llm_seeds)
            for i, s in enumerate(llm_seeds):
                r = x_.loc[s]
                if r.isna().all():
                    continue
                ax.add_patch(plt.Rectangle((i, j), 0.9, 0.8, color='#2ca02c' if r.won else '#d62728', alpha=0.35 + 0.065 * (10 if r.won else r.wave)))
                ax.text(i + 0.45, j + 0.4, 'W' if r.won else str(int(r.wave)), ha='center', va='center', fontsize=7)
        ax.set_xlim(0, len(llm_seeds)); ax.set_ylim(0, len(show))
        ax.set_yticks(np.arange(len(show)) + 0.4); ax.set_yticklabels(show)
        ax.set_xticks(np.arange(len(llm_seeds)) + 0.45); ax.set_xticklabels(llm_seeds, fontsize=7)
        ax.set_xlabel('seed (W = won, number = wave lost)'); ax.set_title('Same seeds, game by game', fontsize=10)
        for sp in ax.spines.values():
            sp.set_visible(False)
        fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p2_paired.png'), dpi=140); plt.close(fig)

    # 3b. error classes in the losing wave (from part2/mistakes.js), v1 vs v2
    ms = {b: json.load(open(os.path.join(OUT, f'mistakes_{b}.json'))) for b in ['llm_v1', 'llm_v2']
          if os.path.exists(os.path.join(OUT, f'mistakes_{b}.json'))}
    if ms:
        keys = ['blind_fight_into_loss', 'illegal_action_in_losing_wave', 'gold_5plus_unspent', 'no_working_weapon', 'forced_by_call_cap']
        labels = ['fought blind\ninto a loss', 'illegal action\nin that wave', '≥5 gold\nunspent', 'no working\nweapon', 'forced by\ncall cap']
        fig, ax = plt.subplots(figsize=(8, 3.4))
        w = 0.8 / len(ms)
        for i, (b, m) in enumerate(ms.items()):
            vals = [m['losingSummary'][k] for k in keys]
            xs = np.arange(len(keys)) + (i - (len(ms) - 1) / 2) * w
            ax.bar(xs, vals, w, color=COL[b], label=f"{b} ({m['lost']} lost games)")
            for x_, v in zip(xs, vals):
                ax.text(x_, v + 0.3, str(v), ha='center', fontsize=8)
        ax.set_xticks(np.arange(len(keys))); ax.set_xticklabels(labels, fontsize=8)
        ax.set_ylabel('lost games with this'); ax.legend(frameon=False, fontsize=8)
        ax.set_title('What the losing build phase looked like', fontsize=10)
        fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p2_error_classes.png'), dpi=140); plt.close(fig)

    # 4. cost / speed of the LLM bots
    llm = same[same.bot.str.startswith('llm')]
    if len(llm):
        fig, ax = plt.subplots(1, 3, figsize=(10, 3))
        for A, col, lab in [(ax[0], 'llm_calls_per_game', 'LLM calls / game'), (ax[1], 'avg_sec_per_game', 'seconds / game'),
                            (ax[2], 'illegal_actions_per_game', 'illegal actions / game')]:
            A.bar(llm.bot, llm[col], color=[COL[b] for b in llm.bot]); A.set_title(lab, fontsize=9)
        fig.tight_layout(); fig.savefig(os.path.join(FIGS, 'p2_cost.png'), dpi=140); plt.close(fig)


if __name__ == '__main__':
    main()
