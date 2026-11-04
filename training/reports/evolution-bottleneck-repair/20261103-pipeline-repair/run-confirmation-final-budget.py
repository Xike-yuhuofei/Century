import subprocess,os,signal,time,json,pathlib
root=pathlib.Path(__file__).resolve().parent
started=time.monotonic()
with (root/'confirmation-final.log').open('w') as log:
 p=subprocess.Popen(['node',str(root/'run-confirmation-final.mjs')],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 try:code=p.wait(timeout=300)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
  code=124
(root/'confirmation-final-wall-budget.json').write_text(json.dumps({'exitCode':code,'elapsedSeconds':time.monotonic()-started,'limitSeconds':300}))
raise SystemExit(code)
