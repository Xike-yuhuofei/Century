import json,pathlib,hashlib,datetime
r=pathlib.Path(__file__).resolve().parent;repo=r.parents[3]
load=lambda name:json.loads((r/name).read_text())
tests=load('FINAL-TESTS.json');assert len(tests)==7 and all(t['exitCode']==0 for t in tests)
assert load('validation-summary.json')['status']=='completed'
assert load('confirmation-final/state.json')['status']=='completed'
assert all(x['exitCode']==0 for x in load('final-comparison/wall-budget.json'))
assert load('COST-AUDIT.json')['withinAuthorizedLimit']
b=load('BOUNDARY-AUDIT.json');assert b['championUnchanged'] and all(b['assetsUnchanged'].values()) and b['preexistingSeedEntriesUnchanged'] and not b['protectedTrackedChanges'] and b['allAddedAreDev'] and not b['uncoveredSeeds']
manifest=load('FINAL-SOURCE-MANIFEST.json');assert all(hashlib.sha256((repo/p).read_bytes()).hexdigest()==h for p,h in manifest.items())
items=[
 ('一/二','Goal复用、工作树/分支/基线/已有改动保护','已核验空cwd、旧dirty工作树；在ai13独立分支修改；已有资产保留','BASELINE.json,BASELINE-RESUMED.json,BOUNDARY-AUDIT.json'),
 ('二/五','代码/冠军/构建/配置身份','基线与最终源码摘要、实际构建manifest、各run解析配置均留存','BASELINE.json,FINAL-CODE-VERSION.json,FINAL-SOURCE-MANIFEST.json,experiment-config-hash.json'),
 ('A-1','普通/LLM完整继承与参数','非法丢失与参数重置旧行为已复现；修复后两组三代参数/模块差分均一致','before-reproduction.json,lineage-audit.json,regression-seed-entry.log'),
 ('A-2','变异/交叉/消融语义、依赖与安全','同模块不同实现交叉、捐赠者/官方回退、被依赖模块不可消融；原白名单/沙箱保留','evolution-final-suite.log,seatbelt-final.log,BOUNDARY-AUDIT.json'),
 ('A-3','最终完整子代评估与谱系','14份LLM评估上下文集合/锁定哈希一致；最终候选重新编译和真实对局，没有借用局部分数','LLM-CONTEXT-AUDIT.json,lineage-audit.json,confirmation-final/proposal-origin.json'),
 ('B-1','重复诊断复现及退出','旧历史44/58 ablate；新静态调度与固定trend边界回归；实际第三轮恢复探索','history-replay-resumed.json,stale-trend-reproduction.json,confirmation-final/state.json'),
 ('B-2','精英区分、重复率与失败','研究精英未验证；6提案5套函数集合；失败按算子/原样best/额度分类；未以调用量认成功','GENERATION-DIVERSITY.json,RESULTS-AUDIT.json,FINAL-REPORT.md'),
 ('C-1','机制身份/预测/实际干预','按模块干预稳定身份；实际变化scope交集；综合胜负不证明机制，真实反馈保持inconclusive','evolution-final-suite.log,confirmation-final/research-memory.jsonl,INDEPENDENT-FEEDBACK.json'),
 ('C-2','跨零/部分修改/后续翻负','针对性回归覆盖；最新独立证据门禁，后续削弱撤销；无单次负读数永久封模块','evolution-final-suite.log,regression-final-complete.log'),
 ('C-3','历史追加解释、不覆盖','58轮原始历史及原code-version保留，旧裁决另存v2更正','historical-evidence-corrections-v2.json,history-replay.json'),
 ('D-1','竞技排序/对照/预算','统一pooled rankKey；对照单独记账；已分层种子不再重复乘人数；quota先检查','history-replay.json,evolution-final-suite.log,confirmation-final/state.json'),
 ('D-2','分层样本/区间/功效','独立每层8种子；所有层报告区间与保守MDE，明确弱功效和单侧t门限','confirmation-independent-replication.json,FINAL-REPORT.md'),
 ('D-3','行为可辨识与评分证据','同状态具体动作哈希；无交集/异构不算新行为；有限探针不得覆盖真实竞技分数','validation-summary.json,probe-score-regression.json,evolution-final-suite.log'),
 ('E-1','进化维度调用/行为/模式映射','M01–M12与续行静态接口地图完成；可达性不当效果保证','EVOLVABLE-MAP.md'),
 ('E-2','M12失活隔离与双模式真实验证','固定32工作量排除新M12且保留父模块；fixed/time独立种子、真实config及对局均完成','M12-fixed.json,M12-time.json,M12-fixed-resolved-configs.json,M12-time-resolved-configs.json'),
 ('E-3','接口扩展是否必要','无当前错误排序因果案例；不据低一致率/旧准确率扩接口或克隆扫描','FINDINGS.md,EVOLVABLE-MAP.md'),
 ('四-1/2','旧复现、新回归、历史重放','真实编译复现与最终测试通过；历史调度重排不推断新胜负','before-reproduction.json,FINAL-TESTS.json,history-replay-resumed.json'),
 ('四-3','真实LLM到后代闭环','原LLM唯一提案按预注册确认协议导入、完整编译安全、游戏、筛选、反馈和默认后代继承；常规best没有改善如实披露','repaired/llm-r1/checkpoints/checkpoint_1/programs,confirmation-final/state.json,lineage-audit.json'),
 ('四-4','预注册受控产出与停止条件','最终两臂同模型/预算上限、新开发窗口，均达到停止条件；失败/实际消耗保留；没产出有效候选不补抽','EXPERIMENT-PLAN.md,final-comparison/wall-budget.json,RESULTS-AUDIT.json'),
 ('四/五','种子隔离、并发、时长与正式边界','实际已保存种子均开发登记覆盖，探索与独立复验分离；累计48.67分钟串行；事故事后补记偏差公开','COST-AUDIT.json,BOUNDARY-AUDIT.json,SEED-CLOSURE.json,TEST-ISOLATION-NOTE.md'),
 ('六-产物','全部指定报告和命令日志','基线、发现、预注册、最终报告、命令、测试、种子、谱系、成本、原始结果均有文件','BASELINE.json,FINDINGS.md,EXPERIMENT-PLAN.md,FINAL-REPORT.md,COMMANDS.md,FINAL-TESTS.json'),
 ('六-结论','流程/产出/实力分开','流程完成；产出变化证据不足；独立收益未复现。无算法优化成功宣称','FINAL-REPORT.md'),
]
records=[]
for key,requirement,conclusion,evidence in items:
 files=evidence.split(',')
 for f in files:assert (r/f).exists(),f
 records.append({'requirement':key,'scope':requirement,'status':'proved','conclusion':conclusion,'evidence':files})
result={'auditedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'allRequiredWorkComplete':True,'algorithmStrengthImprovementProven':False,'effectiveCandidateYieldImprovementProven':False,'protocolDeviationsDisclosed':True,'requirements':records,'remainingResearch':'小幅竞技收益、分布外泛化、单机制因果与续行接口价值均未证明；不作为本次流程修复完成的伪成果。'}
(r/'COMPLETION-AUDIT.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
lines=['# 完成条件逐项审计','','本审计对应原目标的完整范围；科学结论未证明的部分明确保留为未验证，不伪造阳性结果。','','|原目标|要求范围|当前证据化结论|证据|','|---|---|---|---|']
for x in records:lines.append(f"|{x['requirement']}|{x['scope']}|{x['conclusion']}|{'、'.join(x['evidence'])}|")
lines += ['','所有必需实施、预定真实实验、验证及交付项已完成。候选产出率提升、竞技实力提升和具体机制因果仍未证明；这与目标允许的“未发现有效新候选”结果一致。','']
(r/'COMPLETION-AUDIT.md').write_text('\n'.join(lines));print('逐项完成审计通过')
