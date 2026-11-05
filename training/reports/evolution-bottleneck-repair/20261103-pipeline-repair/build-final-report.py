import pathlib,json,re,datetime
r=pathlib.Path(__file__).resolve().parent
load=lambda name:json.loads((r/name).read_text())
tests=load('FINAL-TESTS.json')
assert len(tests)==7 and all(x['exitCode']==0 for x in tests),'最终测试尚未全部通过'
results=load('RESULTS-AUDIT.json');cost=load('COST-AUDIT.json');v=load('validation-summary.json');boundary=load('BOUNDARY-AUDIT.json');lineage=load('lineage-audit.json')
assert v['status']=='completed' and v['games']==96
assert cost['withinAuthorizedLimit'] and cost['savedGames']==496
assert boundary['championUnchanged'] and all(boundary['assetsUnchanged'].values()) and boundary['preexistingSeedEntriesUnchanged'] and not boundary['protectedTrackedChanges'] and not boundary['uncoveredSeeds']
assert all(not x['removed'] and x['parametersInherited'] and x['lineageChangedMatches'] for x in lineage if x['arm'] in ['confirmation','confirmation-final'])
by={x['arm']:x for x in results};rep=next(x for x in v['stages'] if x['stage']=='confirmation-replication')['metrics']
assert rep['totalGames']==64 and rep['anomalies']==0
assert all(s['independentSeeds']==8 for s in rep['byPlayerCount'].values())
for arm in ['baseline','repaired']:assert by[f'final-comparison/{arm}']['status'] in ['completed','budget-exhausted']
rows=[]
for label,key in [('原基线','baseline'),('原修复臂','repaired'),('最终基线','final-comparison/baseline'),('最终修复臂','final-comparison/repaired')]:
 x=by[key];generated=len(x['generatedPrograms']);compiled=sum(p['metrics'].get('compile_ok')==1 for p in x['generatedPrograms'])
 rows.append(f"|{label}|{2 if key=='repaired' else 1}|{x['loggedSuccessfulLLMCalls']}|{generated}|{compiled}|{x['controllerNoncontrols']}|{x['screenedNoncontrols']}|{x['deepNoncontrols']}|{x['savedGameCount']}|{x['loggedTokens']:,}|")
funnel='\n'.join(rows)
strata='\n'.join(f"|{n}人|{s['independentSeeds']}|{s['candidateFirst']}/8|{s['championFirst']}/8|{s['delta']*100:+.1f}|[{s['ci']['lower']*100:.2f}, {s['ci']['upper']*100:.2f}]|" for n,s in rep['byPlayerCount'].items())
testrows=[]
for t in tests:
 text=(r/t['log']).read_text();p=re.search(r'^# pass (\d+)',text,re.M);sk=re.search(r'^# skipped (\d+)',text,re.M);py=re.search(r'Ran (\d+) tests?',text)
 count=p.group(1) if p else py.group(1) if py else '检查通过'
 testrows.append(f"|{t['suite']}|{count}|{sk.group(1) if sk else '0'}|{t['elapsedSeconds']:.1f}s|{t['log']}|")
testtable='\n'.join(testrows)
costtable='\n'.join(f"|{x['run']}|{x['elapsedSeconds']/60:.2f}|{x['savedGames'] if x['savedGames'] is not None else '未知，最多32'}|" for x in cost['rows'])
text=f'''# Century 进化瓶颈修复与验证报告

交付时间：{datetime.datetime.now(datetime.timezone.utc).isoformat()}。工作树 `/Volumes/Extreme SSD/Projects/Century-ai13`，分支 `fix/evolution-bottleneck-20261103`，基线 `d0a6f8715df3b1a6d812d90436129d6a9927c70e`；改动未提交、未推送。

## 三类结论

1. **流程正确性：已完成修复及真实链路验收。** 父代累积、参数保留、锁定模块、消融/交叉语义、停滞退出、预算/深验调度、证据归因与行为签名均有针对性回归。真实 LLM 提案通过完整组装、原白名单、Seatbelt编译/探针、开发对局、筛选、反馈，再由默认生成器继承至第三代。
2. **候选产出变化：证据不足，未证明产出率提高。** 最终每臂仅一次LLM；两臂都没有选出新best。旧桥把原始输入误计为新候选，修复桥正确拒绝。减少虚假产出不等于增加有效算法产出。
3. **算法实力：未发现独立复现的收益。** 预指定第二代候选在独立32对/64局中，第一名率25%对25%，增量0；总体和四个人数层区间均跨零。没有Elo、显著增强或显著削弱结论。

## 基线、范围和身份

原cwd空目录；旧Century工作树有既有改动，未动。实际基线、本地origin/main和工作树身份在 BASELINE.json / BASELINE-RESUMED.json 记录。web-v1已重建，源码未变；baseline-build.log及构建manifest记录决策产物。最终代码身份见 FINAL-CODE-VERSION.json / FINAL-SOURCE-MANIFEST.json；历史 ai11-6h-v4 必须绑定其原始 `cd86eddc4831d904354f80b6f2a6a533d4588335`，不冒充当前复现。

冻结冠军hash仍为 `{boundary['championSha256']}`。8份既有PPO资产哈希不变；规则、正式对手池、晋级标准、静态白名单、Seatbelt模板、正式验证账本无修改。没有正式冠军挑战、alpha消费、冠军替换、部署、commit/push/PR或购买服务。BOUNDARY-AUDIT.json检查了已有登记条目和实际种子覆盖。

## A–E 修复及证据

|项|变更与理由|主要验收|
|---|---|---|
|A 完整继承|普通/LLM变异保留所有未修改父模块和参数；LLM输入、Python评估与最终编译使用完整集合；锁定块改动/非法丢失拒绝；交叉记录每模块捐赠者和官方回退，消融只移除无人依赖模块|before-reproduction.json；lineage-audit.json；LLM-CONTEXT-AUDIT.json；真实编译回归|
|B 探索恢复|用真实研究轮次限制诊断周期；无新增深验证据不能重置停滞；同模块不同实现可交叉；研究精英明确未验证；数字变异抽中舍入不变整数时继续找可变字面量|history-replay-resumed.json；stale-trend-reproduction.json；numeric-mutation-before.json；confirmation-final/state.json|
|C 证据纪律|机制身份按模块干预稳定生成；未测预测保持inconclusive；scope与实际变化相交；最新独立证据才能进入positiveModules，弱化/翻负撤销；历史追加更正|historical-evidence-corrections-v2.json；研究回归；INDEPENDENT-FEEDBACK.json|
|D 排序/预算/行为|保留与深验同用pooled竞技rankKey；对照单独记账；不重复乘已分层人数；配额耗尽先跳过深验；记录同公开局面的具体动作，缺失/异构签名不计新行为|历史41轮首深验对象改变、14轮旧首位control；预算/排序回归；validation-summary.json|
|E 模式适配|固定workUnits路径排除新M12干预并保留已继承M12；记录失活模块；调用路径覆盖M01–M12及续行结构边界|EVOLVABLE-MAP.md；M12-fixed/time.json及resolved-configs|

额外发现并修复：有限函数探针“相等”会覆盖真实竞技分数。最终基线提案 `cb913a63` 探针相等但真实delta=-0.125，旧分数0；去掉该覆盖后同一归档可复算0.3375，新窗口16局得真实分数0.4。所有安全检查保留。见 probe-score-regression.json；这只是评分纠错。另修复默认OpenEvolve未先登记种子的入口：桥接先分配现有治理窗口，Python真实对局缺少显式已登记文件即拒绝。

有限探针覆盖不充分、泛化不足及缺乏单机制因果辨识仍是研究边界。没有据此扩展未验证的续行接口，也没有改裁判或晋级门禁。

## 真实闭环与谱系

原修复臂第一轮产生唯一真实LLM提案，内部评估后未胜过input；按结果前固定的确认协议，选择该唯一提案而非择优补抽，重新编译、安全检查和对局。confirmation运行发现数字变异与配额检查顺序问题，原始失败保留；confirmation-final修复后以40局、1次深验完成三代。

最终三代策略为 `openevolve`（导入既有真实提案）→`single`→`pair-fallback`，调度为bootstrap→explore→switch-direction。新增LLM预算为0，后两代未冒充LLM。两组三代都保留父代模块和engineWeight=1.03，真实差分与谱系记录一致。原基线两次则丢M01/M03/M06并重置为1。

同公开状态的父子行为诊断：第一代112个共同状态中2处动作不同，第二代24个中5处不同。只是轨迹交集上的可观察行为变化，不证明正确性或泛化。独立复验结果已追加回研究记忆，实际干预仅M02、结论inconclusive、positiveModules为空。

## 受控产出漏斗

生成指checkpoint中的新LLM程序，不把input计入；编译指原静态/Seatbelt/tsc/探针通过；入库/快筛/深验按控制器非对照候选计数。新行为必须有同公开状态具体动作证据；源码差异、动作分布、有限探针均不等同于非重复行为。独立收益需冻结候选后的新种子验证。

|运行|LLM尝试|成功调用|生成程序|编译通过|非对照入库|非对照快筛|非对照深验|真实局数|日志token|
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
{funnel}

原基线候选有真实源码变化但继承非法，不能算有效累积产出；最终基线入库者实为原始input，也不是LLM新提案。两个修复臂均拒绝原样best；原修复臂第二次调用遇额度错误。最终比较两臂各1次迭代/15分钟上限/2候选/32控制器局/1次深验，分别实际212.94s和257.55s；各32内部局+8对照快筛局。基线因预算重复乘人数在快筛第二个候选前误停，修复臂completed。对照没有进入修复臂探索名额。

**最终两臂可确认的新增非重复、完整继承且进入独立复验的产出均为0。** 基线未进入非对照快筛，没有共同状态签名可比；修复臂没有导出新best。不能把这个极小样本写成产出率提升或算法强弱比较。

全部6份成功LLM提案含5套不同完整函数集合、1次重复出现；acquisitionValue/restMultiplier各有3种实现，锁定的三个父模块各仅1种，符合保留约束（GENERATION-DIVERSITY.json）。该源码重复率只是搜索材料诊断，不能换算行为重复率。原confirmation生成失败包括3次数字变异误报、1次缺少第二个交叉父代和2次best原样返回；最终三代修复后记录明确的预算fallback，失败理由保留在各round.rejectedAtGeneration。

两臂模型同为gpt-5.6-sol/medium，workUnits=32、可编辑M02/M05、同初始父代与预算上限，但使用不同且预登记的开发窗口，属于流程干预比较。完整源码输入和提示自然不同。原比较受额度与执行器修订影响；最终比较冻结快照见 final-comparison/source-snapshot。之后的探针评分覆盖和异构签名修复单独保留版本/回归，未回填两臂结果。

## 独立复验与精度

对象在看确认结果前指定为 `cand-ai9-single-r2c0-1c04a9`，不是选最终比较中最好的候选。冻结身份和种子见 confirmation-replication-frozen.json。原修复臂末代无非对照候选，按协议记unavailable，没有补抽。

|人数|独立种子|候选第一|冠军第一|增量/百分点|现有t门限诊断范围/百分点|
|---|---:|---:|---:|---:|---|
{strata}

总体32个独立seed cluster、64局均完成，异常0；增量0，范围[-17.02,+17.02]个百分点。沿用项目单侧95% t门限输出的对称诊断范围，**不冒称双侧95%区间**，不是正式多重比较晋级检验。每层8种子的保守近似80%功效可检测效应约96.74个百分点（配对delta标准差上界1），远不足以辨别小幅收益。名称“deep”不增加信息量；quick每层1种子没有层CI，短deep每层2种子也不足以作强结论。

## M12 分模式验证

固定32 workUnits与时间模式各用独立开发窗口、各8局（每层1对），不跨模式比较胜率。固定模式config四层budgetMs均null，164个共同状态0处动作差异，M12被标记inactive；这与源码分支一致，但不能把零样本方差解释为普遍等价。

时间模式四层候选预算150ms、官方100ms，35个共同状态中5处动作差异；点估计+25个百分点，范围[-33.83,+83.83]，证据不足。真实时间路径还受机器时序影响，不能把全部动作差异都归因于M12。该验证证明调用/模式接线，未证明时间预算策略更强。

## 成本、种子与协议偏差

|运行|实际分钟|已保存真实局数|
|---|---:|---:|
{costtable}

累计真实运行保守计 **{cost['totalRealMinutesConservative']:.2f}分钟**，低于120分钟；逐次串行，构建/测试/离线分析及无人运行时间间隔另计。已保存496局，另有事故初评实际完成局数未知、上界32；不把未知局用于任何实力结论。7次已记录LLM迭代尝试、6次成功，日志token合计 **{cost['loggedTokens']:,}**。现金成本未知，未购买额度、未换模型补成功。496局不等于248个独立比较：探索阶段对固定CRN窗口有重复使用，只有冻结复验的32个新seed用于独立复验结论。

所有预定窗口由 seed_policy 与既有治理分配；独立复验窗口不与探索重叠，未按结果选种子。38条本任务开发登记已收尾：已用completed、未用voided继续占用；既有记录和正式挑战计数不变。中央登记覆盖证明见 BOUNDARY-AUDIT.json / SEED-CLOSURE.json。

必须披露的偏差：

- 谱系回归意外触发初评，发现后终止。默认1650开发块缺少中央预登记；已**事后**补记voided隔离，不伪称事前合规。保守计120秒，实际局数未知；已隔离测试并修复默认入口。
- confirmation原计划只在第3轮新增1次LLM，数字变异误报导致第2轮提前触发，实际2次。全部成本列入，不并入受控两臂；数字变异修复后，以零新增LLM的confirmation-final验证三代流程。
- 原比较经历额度错误、父代选择执行器修订和后续边界修复，不能合并为同一可比算法实验。保留原始脚本、日志、代码快照及追加解释。额度后来真实恢复，不把旧错误当当前阻塞。
- Python早期`seed_block=1650`摘要标签已陈旧，实际归档context中的种子在1660/1670开发窗口；已修正标签，历史真实种子不更改。

## 最终验证

|测试|通过项数|跳过|耗时|日志|
|---|---:|---:|---:|---|
{testtable}

编译、安全、谱系等测试用临时隔离目录；真实Seatbelt用例不是Linux跳过。完整命令见 COMMANDS.md / FINAL-TESTS.json。失败的中间测试、夹具修正及隔离事故均保留，不以旧绿灯替代最终重跑。最终保护审计再核对了冠军、PPO资产、正式边界、开发种子与源码差分。

## 仍值得研究的算法问题

先研究M05状态覆盖与M02/M05交互：已有真实案例表明空手/已打出比例会改变对局、而有限探针漏检，但独立收益未复现。可冻结同一父代，比较单模块与组合干预，记录函数输出、合法候选排序、最终选择及机会成本，再用有足够功效的新窗口检验。无动作触达或独立区间跨零即保持未验证，不能靠更多LLM调用包装进展。

M10候选覆盖和己方续行接口只在获得当前可重放的错误排序案例后考虑扩展；低续行一致率和历史准确率不是理论上限。本次没有足以支持扩接口的因果案例，因此保留接口。M12继续只在独立时间预算协议研究，并同时报告耗时与竞技区间。

本次交付的是可审计的管线修复与有限真实验证，**不是“算法已经优化成功”**。原始证据、版本差异和未验证假设完整保留。
'''
(r/'FINAL-REPORT.md').write_text(text)
print('FINAL-REPORT.md 已按完成后的证据生成')
