import pathlib,subprocess,os,time,signal,json
r=pathlib.Path(__file__).resolve().parent;repo=r.parents[3];out=r/'probe-score-check'
env={**os.environ,'CENTURY_OPENEVOLVE_STAGE2_SEED_FILE':str(out/'stage2-seeds.json'),'CENTURY_OPENEVOLVE_CONTEXT':str(out/'context.json'),'CENTURY_OPENEVOLVE_EVIDENCE_DIR':str(out/'evaluations')}
start=time.monotonic()
with (out/'evaluation.log').open('w') as log:
 p=subprocess.Popen([str(repo/'ai5/openevolve/.venv/bin/python'),str(repo/'ai5/openevolve/century_evaluator_ai9.py'),str(out/'program.ts'),'2'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,cwd=repo)
 try:code=p.wait(timeout=180)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
  code=124
(out/'wall-budget.json').write_text(json.dumps({'exitCode':code,'elapsedSeconds':time.monotonic()-start,'limitSeconds':180}))
if code:raise SystemExit(code)
metrics=json.loads((out/'evaluation.log').read_text());(out/'metrics.json').write_text(json.dumps(metrics,indent=2))
if metrics.get('stage_passed')!=1:raise RuntimeError(f'验收未通过 {metrics}')
print(json.dumps(metrics,ensure_ascii=False))
