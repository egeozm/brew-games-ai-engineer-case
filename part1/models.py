"""Baseline and model for D7, D30, LTV30 from days 0-3 only.

All quantities are pooled over a game's 3 cohorts:
  retention(t) = sum active_users(t) / sum installs
  revenue per install (rpi)(t) = sum ad_revenue(t) / sum installs
  LTV30 = sum of rpi over days 0..30
"""
import numpy as np
import pandas as pd
from sklearn.linear_model import RidgeCV

OBS = [0, 1, 2, 3]
FUT = np.arange(4, 31)


def features(R, V, P, meta):
    """Features built only from days 0-3."""
    t = np.log([1, 2, 3])
    f = pd.DataFrame(index=R.index)
    ab = [np.polyfit(t, np.log(R.loc[g, [1, 2, 3]].values.astype(float)), 1) for g in R.index]
    f['b3'] = [b for b, a in ab]                 # early power-law slope
    f['a3'] = [a for b, a in ab]                 # early power-law intercept (log D1)
    f['log_d1'] = np.log(R[1])
    f['log_d3'] = np.log(R[3])
    f['log_pt'] = np.log(P[OBS].mean(1))         # mean playtime days 0-3
    f['log_arpdau'] = np.log(V[OBS].sum(1) / R[OBS].sum(1))
    f['rev03'] = V[OBS].sum(1)
    return f


def powerlaw_curve(a, b, days):
    return np.exp(a + b * np.log(days))


def baseline(f):
    """Power law fitted per game on days 1-3, extrapolated. ARPDAU held at its days 0-3 value."""
    out = pd.DataFrame(index=f.index)
    out['d7'] = powerlaw_curve(f.a3, f.b3, 7)
    out['d30'] = powerlaw_curve(f.a3, f.b3, 30)
    fut = np.exp(f.a3.values[:, None] + f.b3.values[:, None] * np.log(FUT)[None, :]).sum(1)
    out['ltv30'] = f.rev03 + np.exp(f.log_arpdau) * fut
    return out


class SlopeModel:
    """Learns the true day 1-30 power-law (a, b) from early features, then rebuilds the curve.

    Rationale: on the 45 complete games a power law fits days 1-30 with ~2% log error,
    so the only thing to learn is a better estimate of (a, b) than the noisy 3-point fit.
    """
    cols = ['a3', 'b3', 'log_d1', 'log_d3', 'log_pt', 'log_arpdau']

    def fit(self, f, R):
        t = np.log(np.arange(1, 31))
        ab = np.array([np.polyfit(t, np.log(R.loc[g, 1:30].values.astype(float)), 1) for g in f.index])
        X = f[self.cols].values
        self.mu, self.sd = X.mean(0), X.std(0)
        Z = (X - self.mu) / self.sd
        self.mb = RidgeCV(alphas=np.logspace(-3, 3, 25)).fit(Z, ab[:, 0])
        self.ma = RidgeCV(alphas=np.logspace(-3, 3, 25)).fit(Z, ab[:, 1])
        return self

    def predict(self, f):
        Z = (f[self.cols].values - self.mu) / self.sd
        b, a = self.mb.predict(Z), self.ma.predict(Z)
        out = pd.DataFrame(index=f.index)
        out['d7'] = powerlaw_curve(a, b, 7)
        out['d30'] = powerlaw_curve(a, b, 30)
        fut = np.exp(a[:, None] + b[:, None] * np.log(FUT)[None, :]).sum(1)
        out['ltv30'] = f.rev03.values + np.exp(f.log_arpdau.values) * fut
        return out


def truth(R, V):
    return pd.DataFrame({'d7': R[7], 'd30': R[30], 'ltv30': V.loc[:, 0:30].sum(1)})
