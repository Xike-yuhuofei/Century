import json,pathlib
r=pathlib.Path(__file__).resolve().parent
rows=[]
for arm in ['baseline','repaired','confirmation','final-comparison/baseline','final-comparison/repaired']:
 for p in (r/arm).glob('**/context.json'):
  if not (p.parent/'modules.json').exists():continue
  d=json.loads(p.read_text());c=d.get('context',{});s=json.loads((p.parent/'modules.json').read_text())
  modules={m['id']:m['functionSha256'] for m in s.get('modules',[])}
  expected=c.get('moduleIds');locked=c.get('lockedModuleHashes',{})
  rows.append({'arm':arm,'path':str(p.relative_to(r)),'stage':d.get('stage'),'seeds':d.get('seeds'),'actualModules':sorted(modules),'expectedModules':expected,'fullSetMatches':sorted(expected)==sorted(modules) if expected else None,'lockedHashesMatch':all(modules.get(k)==v for k,v in locked.items()) if locked else None,'parameters':c.get('parameters')})
assert all(x['fullSetMatches'] is not False and x['lockedHashesMatch'] is not False for x in rows)
(r/'LLM-CONTEXT-AUDIT.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
print(len(rows),'评估上下文已核对；无集合或锁定哈希不一致')
