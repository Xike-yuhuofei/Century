"""最终验证串行执行；不会触发真实 OpenEvolve，不修改正式治理状态。"""
import pathlib,subprocess,json,time,sys
r=pathlib.Path(__file__).resolve().parent;repo=r.parents[3]
for p in [pathlib.Path('/Users/xike/ai5-sandbox-home-read-probe.txt'),repo/'ai5-sandbox-escape-test.txt']:
 if p.exists():raise RuntimeError(f'已有安全测试探针文件，拒绝覆盖: {p}')
commands=[
 ('evolution-final-suite',['node','--test','--test-concurrency=1',*map(str,sorted((repo/'training/evolution/tests').glob('*.test.mjs')))],repo),
 ('training-final-suite',['npm','test'],repo/'training'),
 ('web-final-suite',['npm','run','test:unit'],repo/'web-v1'),
 ('openevolve-node-final',['node','--test','--test-concurrency=1',*map(str,sorted((repo/'ai5/openevolve/tests').glob('*.test.mjs')))],repo),
 ('python-stratified-final',[str(repo/'ai5/openevolve/.venv/bin/python'),'ai5/openevolve/tests/test_stratified_score.py','-v'],repo),
 ('seatbelt-final',[str(repo/'ai5/openevolve/.venv/bin/python'),'ai5/openevolve/tests/test_security_sandbox.py','-v'],repo),
 ('diff-check-final',['git','diff','--check'],repo),
]
summary=[]
for name,cmd,cwd in commands:
 print('START',name,flush=True);start=time.monotonic()
 with (r/f'{name}.log').open('w') as log:
  result=subprocess.run(cmd,cwd=cwd,stdout=log,stderr=subprocess.STDOUT)
 summary.append({'suite':name,'command':cmd,'cwd':str(cwd),'exitCode':result.returncode,'elapsedSeconds':time.monotonic()-start,'log':f'{name}.log'})
 (r/'FINAL-TESTS.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
 print('END',name,result.returncode,flush=True)
 if result.returncode:sys.exit(result.returncode)
