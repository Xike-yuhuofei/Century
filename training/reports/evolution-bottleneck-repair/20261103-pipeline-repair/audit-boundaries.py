import pathlib,json,hashlib,subprocess,datetime
r=pathlib.Path(__file__).resolve().parent;repo=r.parents[3]
def load(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
b=load(r/'BASELINE.json');prior=load(r/'BASELINE-RESUMED.json')
assets={p:sha(repo/p)==h for p,h in prior['preexistingAssetHashes'].items()}
old=json.loads(subprocess.check_output(['git','show','HEAD:training/governance/seed-consumption-registry.json'],cwd=repo));new=load(repo/'training/governance/seed-consumption-registry.json');ids={x['experimentId'] for x in old['entries']};byid={x['experimentId']:x for x in new['entries']}
old_unchanged=all(byid.get(x['experimentId'])==x for x in old['entries']);added=[x for x in new['entries'] if x['experimentId'] not in ids]
changed=subprocess.check_output(['git','diff','--name-only'],cwd=repo,text=True).splitlines()
# 正式账本、规则、白名单、沙箱、冠军及web源码都没有工作树修改。
protected=[p for p in changed if p.startswith(('web-v1/','training/champions/','training/tournament/')) or p in ['ai5/lib/seed_policy.mjs','ai5/lib/seed_policy.py','ai5/openevolve/node/static_check_modules.mjs','ai5/openevolve/sandbox/candidate.sb.tmpl'] or 'validation-ledger' in p]
actual_seeds=set();evidence=[]
for p in r.glob('**/*.json'):
 if any(x in p.parts for x in ['baseline-source','source-snapshot','artifacts']):continue
 try:d=load(p)
 except (ValueError,UnicodeError):continue
 if not isinstance(d,dict) or not isinstance(d.get('games'),list):continue
 seeds={g['seed'] for g in d['games'] if isinstance(g,dict) and isinstance(g.get('seed'),int)}
 if seeds:actual_seeds.update(seeds);evidence.append(str(p.relative_to(r)))
covered={s:next((x['experimentId'] for x in added if x['base']<=s<x['base']+x['size']),None) for s in actual_seeds}
used_ids=set(covered.values())
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'branch':subprocess.check_output(['git','branch','--show-current'],cwd=repo,text=True).strip(),'assetsUnchanged':assets,'championUnchanged':sha(repo/'training/champions/champion.json')==b['championSha256'],'championSha256':sha(repo/'training/champions/champion.json'),'preexistingSeedEntriesUnchanged':old_unchanged,'protectedTrackedChanges':protected,'addedSeedEntries':added,'allAddedAreDev':all(x['purposeClass']!='formal-challenge' and x['base']>=1650000000 and x['base']+x['size']<=1680000000 and not x['countsTowardChallengeIndex'] for x in added),'savedUniqueSeeds':len(actual_seeds),'uncoveredSeeds':[s for s,v in covered.items() if v is None],'allSavedSeedsDev':all(1650000000<=s<1680000000 for s in actual_seeds),'usedExperimentIds':sorted(x for x in used_ids if x),'unusedReservedExperimentIds':[x['experimentId'] for x in added if x['experimentId'] not in used_ids and x['status']=='reserved'],'seedEvidenceFiles':evidence}
(r/'BOUNDARY-AUDIT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
assert all(assets.values()) and report['championUnchanged'] and old_unchanged and not protected and report['allAddedAreDev'] and not report['uncoveredSeeds'] and report['allSavedSeedsDev']
print('既有8份PPO资产、冠军与原登记记录不变；实际已保存种子全部有开发登记覆盖；正式边界无修改。')
