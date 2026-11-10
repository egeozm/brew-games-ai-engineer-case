import pandas as pd, numpy as np
def load(path='cohorts.csv'):
    d=pd.read_csv(path)
    inst=d.drop_duplicates(['game_id','cohort']).groupby('game_id').installs.sum()
    agg=d.groupby(['game_id','day']).agg(au=('active_users','sum'),rev=('ad_revenue_usd','sum')).reset_index()
    agg['ret']=agg.au/agg.game_id.map(inst)
    agg['rpi']=agg.rev/agg.game_id.map(inst)
    pt=d.assign(w=d.avg_playtime_s*d.active_users).groupby(['game_id','day']).w.sum()/d.groupby(['game_id','day']).active_users.sum()
    agg['pt']=pt.values
    meta=d.drop_duplicates('game_id').set_index('game_id')[['genre','cpi_usd']]
    meta['installs']=inst
    R=agg.pivot(index='game_id',columns='day',values='ret')
    V=agg.pivot(index='game_id',columns='day',values='rpi')
    P=agg.pivot(index='game_id',columns='day',values='pt')
    return d,meta,R,V,P
