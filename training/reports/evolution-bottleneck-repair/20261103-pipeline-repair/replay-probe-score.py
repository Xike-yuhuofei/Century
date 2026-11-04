"""有限探针误判的真实归档回归：只复算，不运行对局。"""
import json,pathlib,sys
r=pathlib.Path(__file__).resolve().parent;repo=r.parents[3]
sys.path.insert(0,str(repo/'ai5/openevolve'))
from century_evaluator_ai9 import compute_combined_score
rows=[]
for label,root in [('old',r/'final-comparison/baseline/external-evaluations'),('fixed',r/'probe-score-check/evaluations')]:
 for raw in root.glob('61cde1a84775/**/stage2.json'):
  data=json.loads(raw.read_text());stats=data['stats'];probe=json.loads((raw.parent/'probe.json').read_text())
  static=json.loads((raw.parent/'modules.json').read_text())
  size=sum(int(m.get('textLength',0)) for m in static['modules']);delta=stats['firstPlaceDelta']['ci']['mean']
  score=compute_combined_score(delta,stats['anomalyRate'],min(1,max(0,(stats['meanDecisionMs']-300)/300)),min(1,max(0,size/12000-1)),stats['firstPlaceDelta']['byPlayerCount'])
  assert probe['identicalToOfficial'] is True
  if label=='fixed':assert json.loads((r/'probe-score-check/metrics.json').read_text())['combined_score']==round(score,4)
  rows.append({'run':label,'evidence':str(raw.relative_to(r)),'finiteProbeIdentical':True,'oldRuleScore':0,'realGameScore':score,'firstPlaceDelta':delta,'games':len(data['games'])})
assert {x['run'] for x in rows}=={'old','fixed'}
(r/'probe-score-regression.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print(rows)
