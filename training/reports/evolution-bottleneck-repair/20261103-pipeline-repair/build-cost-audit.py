import json,pathlib
r=pathlib.Path(__file__).resolve().parent
load=lambda name:json.loads((r/name).read_text())
a=load('RESULTS-AUDIT.json');by={x['arm']:x for x in a}
seconds={
 'baseline':by['baseline']['elapsedMs']/1000,
 'repaired':by['repaired']['elapsedMs']/1000,
 'confirmation':load('confirmation-wall-budget.json')['elapsedSeconds'],
 'confirmation-final':load('confirmation-final-wall-budget.json')['elapsedSeconds'],
 **{f"final-comparison/{x['arm']}":x['elapsedSeconds'] for x in load('final-comparison/wall-budget.json')},
 'probe-score-check':load('probe-score-check/wall-budget.json')['elapsedSeconds'],
 'validation':load('validation-wall-budget.json')['elapsedSeconds'],
 'accidental-test-conservative':120,
}
rows=[{'run':k,'elapsedSeconds':v,'savedGames':by[k]['savedGameCount'] if k in by else (16 if k=='probe-score-check' else load('validation-summary.json')['games'] if k=='validation' else None)} for k,v in seconds.items()]
report={'rows':rows,'totalRealSecondsConservative':sum(seconds.values()),'totalRealMinutesConservative':sum(seconds.values())/60,'authorizedLimitSeconds':7200,'withinAuthorizedLimit':sum(seconds.values())<=7200,'savedGames':sum(x['savedGames'] or 0 for x in rows),'accidentalGamesUnknownUpperBound':32,'loggedLLMIterationAttempts':7,'loggedLLMSuccessfulCalls':sum(x['loggedSuccessfulLLMCalls'] for x in a),'loggedTokens':sum(x['loggedTokens'] for x in a),'failedLLMIterations':[e for x in a for e in x['llmErrors']],'billing':'仅日志token；订阅现金成本未知，未购买额度或服务','timeBasis':'runner实际墙钟，事故保守120秒；测试/构建/离线分析和无人运行间隔不计真实实验预算','concurrency':'各真实runner顺序完成后才启动下一个；无并行真实训练'}
(r/'COST-AUDIT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2))
