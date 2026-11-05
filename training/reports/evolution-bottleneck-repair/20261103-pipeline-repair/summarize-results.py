"""只读归档复算，不发起训练；保留原始文件并复制全局评估证据到本报告。"""
import json,pathlib,re,shutil,hashlib
r=pathlib.Path(__file__).resolve().parent
repo=r.parents[3]
def load(p):return json.loads(p.read_text())
def write(name,d):(r/name).write_text(json.dumps(d,ensure_ascii=False,indent=2))
# 旧桥未指定 evidenceDir，按预登记种子定位既有真实评估，绝不按胜负挑选。
for arm,manifest in [('baseline',load(r/'seed-manifest.json')),('final-comparison/baseline',load(r/'final-comparison/seed-manifest.json'))]:
 seeds=set(s for v in manifest['arms']['baseline'].values() for s in v['seeds'])
 for f in (repo/'ai5/openevolve/results/ai9-evaluations').glob('**/stage*.json'):
  d=load(f);actual={g['seed'] for g in d.get('games',[])}
  if actual and actual.issubset(seeds):
   dest=r/arm/'external-evaluations'/f.parent.relative_to(repo/'ai5/openevolve/results/ai9-evaluations')
   dest.mkdir(parents=True,exist_ok=True)
   for src in f.parent.glob('*.json'):shutil.copy2(src,dest/src.name)
summary=[]
for arm in ['baseline','repaired','confirmation','confirmation-final','final-comparison/baseline','final-comparison/repaired']:
 root=r/arm
 if not (root/'state.json').exists():continue
 s=load(root/'state.json');logs=list(root.glob('**/logs/*.log'));calls=0;tokens=0;errors=[]
 for f in logs:
  t=f.read_text();matches=re.findall(r'Total LLM Token Usage \((\d+) calls?\): total_tokens=(\d+)',t)
  # 单会话日志最终累计，避免日志重复总结双计
  if matches:calls+=int(matches[-1][0]);tokens+=int(matches[-1][1])
  errors.extend(line for line in t.splitlines() if 'Iteration 1 error:' in line)
 programs={}
 for f in root.glob('**/checkpoints/**/programs/*.json'):
  d=load(f)
  if d.get('iteration_found',0)>0:programs[d['id']]={k:d.get(k) for k in ['id','parent_id','generation','iteration_found','metrics','changes_description']}
 stage_files=[f for f in root.glob('**/stage*.json') if 'evaluations' in str(f)]
 internal=sum(len(load(f).get('games',[])) for f in stage_files)
 noncontrols=[c for rd in s['rounds'] for c in rd['candidates'] if c.get('strategy')!='control']
 row={'arm':arm,'status':s['status'],'budgetUsed':s['budgetUsed'],'loggedSuccessfulLLMCalls':calls,'loggedTokens':tokens,'llmErrors':errors,'generatedPrograms':list(programs.values()),'controllerNoncontrols':len(noncontrols),'screenedNoncontrols':sum(bool(c.get('quick')) for c in noncontrols),'deepNoncontrols':sum(bool(c.get('deep')) for c in noncontrols),'controlGames':sum((c.get('quick') or {}).get('games',0) for rd in s['rounds'] for c in rd['candidates'] if c.get('strategy')=='control'),'internalGames':internal,'internalEvidenceFiles':[str(f.relative_to(r)) for f in stage_files],'generationRejections':[{'round':rd['round'],'rejections':rd.get('generationRejected',rd.get('rejectedAtGeneration'))} for rd in s['rounds']]}
 result=root/'experiment-result.json'
 if result.exists():row['elapsedMs']=load(result).get('elapsedMs')
 row['savedGameCount']=internal+s['budgetUsed']['games']
 summary.append(row)
write('RESULTS-AUDIT.json',summary)
print(json.dumps([{k:v for k,v in x.items() if k not in ['generatedPrograms','internalEvidenceFiles','generationRejections']} for x in summary],ensure_ascii=False,indent=2))
