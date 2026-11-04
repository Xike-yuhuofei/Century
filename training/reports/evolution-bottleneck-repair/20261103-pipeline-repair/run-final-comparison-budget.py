import subprocess,os,signal,time,json,pathlib
root=pathlib.Path(__file__).resolve().parent
summary=[]
for arm in ['baseline','repaired']:
 started=time.monotonic()
 with (root/'final-comparison'/f'{arm}.log').open('w') as log:
  p=subprocess.Popen(['node',str(root/'run-final-comparison.mjs'),arm],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=p.wait(timeout=900)
  except subprocess.TimeoutExpired:
   os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
   code=124
 summary.append({'arm':arm,'exitCode':code,'elapsedSeconds':time.monotonic()-started,'limitSeconds':900})
 (root/'final-comparison'/'wall-budget.json').write_text(json.dumps(summary,indent=2))
 if code==124:break
