#!/usr/bin/env python3
"""Build deterministic derived benchmark tables and extend the v2 qualification corpus to 32 cases."""
from __future__ import annotations
import json, math
from pathlib import Path
import pandas as pd

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'fixtures/benchmarks/v2/data'
MANIFEST=ROOT/'fixtures/benchmarks/v2/manifest.json'
DATA.mkdir(parents=True,exist_ok=True)

def write(df: pd.DataFrame, name: str):
    p=DATA/name
    df.to_csv(p,index=False,lineterminator='\n')
    return str(p.relative_to(ROOT))

def common_recipe(story_family, job, rows, claim, temporal=False):
    return {
        'schema_version':'2.0.0','analytical_job':job,'artifact_mode':'static_editorial','story_family':story_family,
        'data_profile':{'mark_count':int(rows),'node_count':0,'edge_count':0,'temporal':bool(temporal)},
        'geography':{'enabled':False,'scale':'global','projection_policy':'editorial_auto','terrain':False,'bathymetry':False,'context_layers':[]},
        'network':{'enabled':False,'spatial':False,'directed':False,'weighted':False,'community_structure':False,'comparison_dense':False},
        'annotation':{'label_count':int(min(rows,12)),'direct_labels':True,'callouts':False,'locator':False,'scale_bar':False},
        'delivery':{'print':True,'interactive':False,'mobile':True,'vector_required':True,'animation':False},
        'backend_hints':{'qualification_mode':True,'challenger_mode':False},'claim_ids':[claim],'generated_imagery':False
    }

def chart_case(*,cid,family,job,raw,derived,claim,title,subtitle,source_note,chart_type,options,semantics,rows,temporal=False):
    base={'chart_type':chart_type,'title':title,'subtitle':subtitle,'source_note':source_note,**options}
    py={'inputs':{'table':derived},'options':{'renderer':'editorial_chart',**base}}
    rr={'inputs':{'table':derived},'options':{'renderer':'editorial_chart','filename':'figure.svg',**base}}
    ec={'inputs':{'table':derived},'options':base}
    return {
      'id':cid,'story_family':family,'candidate_backends':['python_publication','r_editorial','echarts_editorial'],
      'source_ref':raw,'human_evidence':'PENDING','qualification_stage':'MULTI_BACKEND_WIRED',
      'recipe':common_recipe(family,job,rows,claim,temporal),
      'semantic_contract':{
        'evidence_paths':[raw,derived],'claim_ids':[claim],
        'semantics':{'geometry':'statistical_marks','transformation':'deterministic_derived_snapshot',**semantics},
        'source_ledger':{'source':source_note}
      },
      'render_requests':{'python_publication':py,'r_editorial':rr,'echarts_editorial':ec}
    }

# NASA annual + monthly
nasa_raw='fixtures/realdata/nasa-gistemp-1980-2025.csv'
nasa=pd.read_csv(ROOT/nasa_raw)
nasa_hot=nasa.nlargest(10,'anomaly_c').sort_values('anomaly_c')
p_hot=write(nasa_hot,'nasa-hottest-10.csv')
nasa_dec=nasa.assign(decade=(nasa.year//10)*10).groupby('decade',as_index=False).agg(anomaly_c=('anomaly_c','mean')).round({'anomaly_c':3})
p_dec=write(nasa_dec,'nasa-decade-means.csv')
nasa_recent=nasa[nasa.year>=2000].copy(); p_recent=write(nasa_recent,'nasa-2000-2025.csv')
monthly_raw='fixtures/realdata/nasa-gistemp-monthly-2023-2025.csv'; monthly=pd.read_csv(ROOT/monthly_raw)
months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; order={m:i+1 for i,m in enumerate(months)}
m25=monthly[monthly.year==2025].copy(); m25['month_order']=m25.month.map(order); m25=m25.sort_values('month_order'); p_m25=write(m25[['month','anomaly_c']],'nasa-monthly-2025.csv')
seq=monthly.copy(); seq['month_order']=seq.month.map(order); seq=seq.sort_values(['year','month_order']); seq['month_index']=range(1,len(seq)+1); seq['period']=seq.year.astype(str)+'-'+seq.month; p_seq=write(seq[['month_index','period','anomaly_c']],'nasa-monthly-sequence-2023-2025.csv')

# OWID
owid_raw='fixtures/realdata/owid-renewables-2021-2025.csv'; owid=pd.read_csv(ROOT/owid_raw)
p_ow21=write(owid[['country','renewables_2021']].sort_values('renewables_2021'),'owid-renewables-2021.csv')
p_ow_scatter=write(owid[['country','renewables_2021','renewables_2025']].copy(),'owid-renewables-2021-vs-2025.csv')
p_gain=write(owid[owid.change_pp>0][['country','change_pp']].sort_values('change_pp'),'owid-renewable-gains.csv')
solar_raw='fixtures/realdata/owid-solar-renewables-2025.csv'; solar=pd.read_csv(ROOT/solar_raw)
p_solar=write(solar[['country','solar_share']].sort_values('solar_share'),'owid-solar-rank-2025.csv')
p_mix=write(solar[['country','renewables_share']].sort_values('renewables_share'),'owid-renewables-mix-rank-2025.csv')

# Titanic counts/rates from the R datasets contingency-table snapshot.
titanic_raw='fixtures/v09-realdata/titanic-r-datasets.csv'; titanic=pd.read_csv(ROOT/titanic_raw)
def survival_group(field):
    g=titanic.groupby([field,'Survived'],as_index=False).Freq.sum().pivot(index=field,columns='Survived',values='Freq').fillna(0)
    total=g.sum(axis=1); yes=g['Yes'] if 'Yes' in g else 0
    out=pd.DataFrame({field:g.index,'survival_pct':(yes/total*100).round(1)}).reset_index(drop=True)
    return out
p_t_class=write(survival_group('Class'),'titanic-survival-by-class.csv')
p_t_sex=write(survival_group('Sex'),'titanic-survival-by-sex.csv')
p_t_age=write(survival_group('Age'),'titanic-survival-by-age.csv')
counts=titanic.groupby('Class',as_index=False).Freq.sum().rename(columns={'Freq':'passengers'}); p_t_count=write(counts,'titanic-passengers-by-class.csv')
surv=titanic[titanic.Survived=='Yes'].groupby('Class',as_index=False).Freq.sum().rename(columns={'Freq':'survivors'}); p_t_surv=write(surv,'titanic-survivors-by-class.csv')

# EIA crude imports + World Bank remittances.
crude_raw='fixtures/v09-realdata/eia-us-crude-imports-2024.csv'; crude=pd.read_csv(ROOT/crude_raw)
p_crude_bpd=write(crude[['country','thousand_bpd']].sort_values('thousand_bpd'),'eia-crude-imports-rank-bpd.csv')

def haversine_km(lat1,lon1,lat2,lon2):
    r=6371.0088; a1,a2=math.radians(lat1),math.radians(lat2); dlat=math.radians(lat2-lat1); dlon=math.radians(lon2-lon1)
    a=math.sin(dlat/2)**2+math.cos(a1)*math.cos(a2)*math.sin(dlon/2)**2
    return 2*r*math.asin(math.sqrt(a))
crude_dist=crude[['country','source_lat','source_lon','target_lat','target_lon','thousand_bpd']].copy(); crude_dist['distance_km']=[round(haversine_km(r.source_lat,r.source_lon,r.target_lat,r.target_lon),1) for r in crude_dist.itertuples()]
p_crude_dist=write(crude_dist[['country','distance_km','thousand_bpd']],'eia-crude-distance-vs-volume.csv')
remit_raw='fixtures/v15-cartographic-flow/world-bank-remittance-corridors-2021.csv'; remit=pd.read_csv(ROOT/remit_raw); remit['corridor']=remit['source']+' → '+remit['target']; p_remit=write(remit[['corridor','usd_billion']].sort_values('usd_billion'),'worldbank-remittance-corridor-rank.csv')

cases=[]
def add(**kw): cases.append(chart_case(**kw))
add(cid='nasa_hottest_years',family='statistical_editorial',job='comparison',raw=nasa_raw,derived=p_hot,claim='claim:nasa:hottest-years',title='The warmest years in the series cluster near the present',subtitle='Top 10 annual global temperature anomalies in the benchmark snapshot',source_note='Source: NASA GISTEMP fixture',chart_type='bar',options={'category_field':'year','value_field':'anomaly_c','x_label':'Temperature anomaly (°C)'},semantics={'measure':'annual_temperature_anomaly','selection':'top_10_by_anomaly'},rows=len(nasa_hot))
add(cid='nasa_decade_means',family='statistical_editorial',job='time_change',raw=nasa_raw,derived=p_dec,claim='claim:nasa:decade-means',title='Average temperature anomaly rises across successive decades',subtitle='Decadal means derived from the annual NASA benchmark snapshot',source_note='Source: NASA GISTEMP fixture; ADN deterministic decade aggregation',chart_type='bar',options={'category_field':'decade','value_field':'anomaly_c','x_label':'Mean temperature anomaly (°C)'},semantics={'measure':'decadal_mean_temperature_anomaly','aggregation':'mean_by_decade'},rows=len(nasa_dec),temporal=True)
add(cid='nasa_recent_trend',family='statistical_editorial',job='time_change',raw=nasa_raw,derived=p_recent,claim='claim:nasa:recent-trend',title='The recent warming trend is visible across the 21st century',subtitle='Annual global temperature anomaly, 2000 to 2025',source_note='Source: NASA GISTEMP fixture',chart_type='line',options={'x_field':'year','y_field':'anomaly_c','x_label':'Year','y_label':'Temperature anomaly (°C)'},semantics={'measure':'annual_temperature_anomaly','window':'2000-2025'},rows=len(nasa_recent),temporal=True)
add(cid='nasa_monthly_2025',family='statistical_editorial',job='comparison',raw=monthly_raw,derived=p_m25,claim='claim:nasa:monthly-2025',title='Monthly temperature anomalies remained elevated through 2025',subtitle='Monthly anomaly values in the benchmark snapshot',source_note='Source: NASA GISTEMP monthly fixture',chart_type='bar',options={'category_field':'month','value_field':'anomaly_c','x_label':'Temperature anomaly (°C)'},semantics={'measure':'monthly_temperature_anomaly','year':2025},rows=len(m25),temporal=True)
add(cid='nasa_monthly_sequence',family='statistical_editorial',job='time_change',raw=monthly_raw,derived=p_seq,claim='claim:nasa:monthly-sequence',title='Monthly anomalies stay elevated across the latest three-year window',subtitle='January 2023 through December 2025, indexed by month',source_note='Source: NASA GISTEMP monthly fixture',chart_type='line',options={'x_field':'month_index','y_field':'anomaly_c','x_label':'Month index from Jan 2023','y_label':'Temperature anomaly (°C)'},semantics={'measure':'monthly_temperature_anomaly','window':'2023-2025'},rows=len(seq),temporal=True)
add(cid='owid_renewable_2021',family='statistical_editorial',job='comparison',raw=owid_raw,derived=p_ow21,claim='claim:owid:renewables-2021',title='Renewable electricity shares already differed widely in 2021',subtitle='Selected economies in the benchmark snapshot',source_note='Source: Our World in Data fixture',chart_type='bar',options={'category_field':'country','value_field':'renewables_2021','x_label':'Renewable electricity share (%)'},semantics={'measure':'renewable_electricity_share','year':2021},rows=len(owid))
add(cid='owid_renewable_2021_vs_2025',family='statistical_editorial',job='comparison',raw=owid_raw,derived=p_ow_scatter,claim='claim:owid:renewables-2021-vs-2025',title='Countries started from very different renewable shares before the latest gains',subtitle='Renewable electricity share in 2021 versus 2025',source_note='Source: Our World in Data fixture',chart_type='scatter',options={'x_field':'renewables_2021','y_field':'renewables_2025','label_field':'country','x_label':'Renewable electricity share, 2021 (%)','y_label':'Renewable electricity share, 2025 (%)'},semantics={'measure':'renewable_electricity_share','comparison':'2021_vs_2025'},rows=len(owid))
add(cid='owid_renewable_gains',family='statistical_editorial',job='comparison',raw=owid_raw,derived=p_gain,claim='claim:owid:renewable-gains',title='Renewable-electricity gains are uneven across selected economies',subtitle='Positive percentage-point change from 2021 to 2025',source_note='Source: Our World in Data fixture',chart_type='bar',options={'category_field':'country','value_field':'change_pp','x_label':'Change in renewable electricity share (pp)'},semantics={'measure':'renewable_share_change','selection':'positive_change'},rows=len(pd.read_csv(ROOT/p_gain)))
add(cid='owid_solar_rank_2025',family='statistical_editorial',job='comparison',raw=solar_raw,derived=p_solar,claim='claim:owid:solar-rank-2025',title='Solar supplies very different shares of electricity across the sample',subtitle='Selected economies, 2025',source_note='Source: Our World in Data fixture',chart_type='bar',options={'category_field':'country','value_field':'solar_share','x_label':'Solar electricity share (%)'},semantics={'measure':'solar_electricity_share','year':2025},rows=len(solar))
add(cid='owid_renewable_mix_rank_2025',family='statistical_editorial',job='comparison',raw=solar_raw,derived=p_mix,claim='claim:owid:renewable-mix-rank-2025',title='Total renewable share varies even among solar-heavy economies',subtitle='Selected economies, 2025',source_note='Source: Our World in Data fixture',chart_type='bar',options={'category_field':'country','value_field':'renewables_share','x_label':'Renewable electricity share (%)'},semantics={'measure':'renewable_electricity_share','year':2025},rows=len(solar))
add(cid='titanic_survival_class',family='statistical_editorial',job='comparison',raw=titanic_raw,derived=p_t_class,claim='claim:titanic:survival-class',title='Titanic survival rates differed sharply by passenger class',subtitle='Weighted from the classic R datasets contingency table',source_note='Source: R datasets Titanic fixture; ADN deterministic aggregation',chart_type='bar',options={'category_field':'Class','value_field':'survival_pct','x_label':'Survival rate (%)'},semantics={'measure':'survival_rate','group':'Class','weight':'Freq'},rows=len(pd.read_csv(ROOT/p_t_class)))
add(cid='titanic_survival_sex',family='statistical_editorial',job='comparison',raw=titanic_raw,derived=p_t_sex,claim='claim:titanic:survival-sex',title='Titanic survival rates differed dramatically by sex',subtitle='Weighted from the classic R datasets contingency table',source_note='Source: R datasets Titanic fixture; ADN deterministic aggregation',chart_type='bar',options={'category_field':'Sex','value_field':'survival_pct','x_label':'Survival rate (%)'},semantics={'measure':'survival_rate','group':'Sex','weight':'Freq'},rows=len(pd.read_csv(ROOT/p_t_sex)))
add(cid='titanic_survival_age',family='statistical_editorial',job='comparison',raw=titanic_raw,derived=p_t_age,claim='claim:titanic:survival-age',title='Children had a higher survival rate in the Titanic table',subtitle='Child and adult groups, weighted by frequency',source_note='Source: R datasets Titanic fixture; ADN deterministic aggregation',chart_type='bar',options={'category_field':'Age','value_field':'survival_pct','x_label':'Survival rate (%)'},semantics={'measure':'survival_rate','group':'Age','weight':'Freq'},rows=len(pd.read_csv(ROOT/p_t_age)))
add(cid='titanic_passengers_class',family='statistical_editorial',job='comparison',raw=titanic_raw,derived=p_t_count,claim='claim:titanic:passengers-class',title='Third class and crew dominate the Titanic contingency table',subtitle='People represented by class or crew status',source_note='Source: R datasets Titanic fixture; ADN deterministic aggregation',chart_type='bar',options={'category_field':'Class','value_field':'passengers','x_label':'People'},semantics={'measure':'population_count','group':'Class','aggregation':'sum_Freq'},rows=len(counts))
add(cid='titanic_survivors_class',family='statistical_editorial',job='comparison',raw=titanic_raw,derived=p_t_surv,claim='claim:titanic:survivors-class',title='Survivor counts reflect both class size and survival probability',subtitle='Survivors represented in the Titanic contingency table',source_note='Source: R datasets Titanic fixture; ADN deterministic aggregation',chart_type='bar',options={'category_field':'Class','value_field':'survivors','x_label':'Survivors'},semantics={'measure':'survivor_count','group':'Class','aggregation':'sum_Freq_where_survived_yes'},rows=len(surv))
add(cid='eia_crude_import_rank',family='statistical_editorial',job='comparison',raw=crude_raw,derived=p_crude_bpd,claim='claim:eia:crude-import-rank',title='Canada dominates U.S. crude-oil imports',subtitle='Average crude imports by source country, 2024',source_note='Source: U.S. Energy Information Administration fixture',chart_type='bar',options={'category_field':'country','value_field':'thousand_bpd','x_label':'Thousand barrels per day'},semantics={'measure':'average_crude_imports','unit':'thousand_bpd'},rows=len(crude))
add(cid='eia_crude_distance_vs_volume',family='statistical_editorial',job='distribution',raw=crude_raw,derived=p_crude_dist,claim='claim:eia:crude-distance-vs-volume',title='Import volume is concentrated in a nearby supplier despite a global source network',subtitle='Great-circle source distance versus average U.S. crude imports, 2024',source_note='Source: U.S. Energy Information Administration fixture; distance derived with a spherical great-circle calculation',chart_type='scatter',options={'x_field':'distance_km','y_field':'thousand_bpd','label_field':'country','x_label':'Great-circle distance to U.S. reference point (km)','y_label':'Thousand barrels per day'},semantics={'measure':'average_crude_imports','derived_metric':'great_circle_distance_km'},rows=len(crude))
add(cid='worldbank_remittance_corridor_rank',family='statistical_editorial',job='comparison',raw=remit_raw,derived=p_remit,claim='claim:worldbank:remittance-corridor-rank',title='The largest selected remittance corridor is U.S. to Mexico',subtitle='Selected bilateral corridors, 2021',source_note='Source: World Bank bilateral remittance fixture',chart_type='bar',options={'category_field':'corridor','value_field':'usd_billion','x_label':'Remittances (USD billions)'},semantics={'measure':'bilateral_remittance_flow','unit':'usd_billion'},rows=len(remit))

m=json.loads(MANIFEST.read_text())
obsolete={'owid_renewable_declines','eia_crude_annual_rank'}
new_ids={c['id'] for c in cases}
m['cases']=[c for c in m['cases'] if c['id'] not in (new_ids|obsolete)]+cases
m['target_case_count']=32
m['corpus_version']='1.0.0'
m['coverage_note']='32 cases from repository evidence snapshots; terrain, local urban cartography, and true multi-runtime output remain qualification gaps.'
MANIFEST.write_text(json.dumps(m,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({'status':'PASS','cases':len(m['cases']),'derived_tables':len(list(DATA.glob('*.csv')))},indent=2))
