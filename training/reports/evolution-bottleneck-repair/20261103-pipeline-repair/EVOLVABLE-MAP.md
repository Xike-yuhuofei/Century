# 可进化维度与评测路径

本表据当前注册表及 adapter/joint-rollout 源码核验。可达性不等于当前干预有效；M01–M11 的实际动作变化需逐候选测量。

|维度|函数与调用路径|行为影响|适用模式|
|---|---|---|---|
|M01 魔像目标选择|`goalPriority`；chooseAIAction -> chooseJointAction(joint-js5) -> choosePlan -> goalPriority|planner.choosePlan：每个目标路线期望乘以 goalPriority（缺省 1）|固定工作量及时间预算（受具体策略路径限制）|
|M02 商人卡获取|`acquisitionValue`；chooseAIAction/chooseJointAction -> choosePlan -> acquisitionValue|planner: searchGrade/prospectiveFormula 的新卡价值 + champion-guided 冠军基座|固定工作量及时间预算（受具体策略路径限制）|
|M03 生产引擎评估|`cardEngineValue`；choosePlan -> engineValueFor -> engineValue -> cardEngineValue|knowledge.engineValue -> planner/engine-model/acquisitionValue|固定工作量及时间预算（受具体策略路径限制）|
|M04 水晶资源管理/保留价值|`keepValue`；choosePlan -> payments/step -> keepValue；overflow -> trimStock -> keepValue|evaluator.trimStock（支付方案/溢出弃置）+ planner.payments|固定工作量及时间预算（受具体策略路径限制）|
|M05 打出与休息调度|`restMultiplier`；choosePlan -> searchGrade -> restMultiplier|planner.searchGrade：休息路线惩罚乘子（缺省 1）|固定工作量及时间预算（受具体策略路径限制）|
|M06 终局与胜率决策|`endgameBonus`；choosePlan -> routeGrade(terminal) -> endgameBonus|planner.routeGrade：终局路线价值增量（缺省 0；state.standings/baseScore/claimThreshold 提供公开名次与分数）|固定工作量及时间预算（受具体策略路径限制）|
|M07 对手行为预测|`opponentPressureDelta`；choosePlan -> evolvePressure -> opponentPressureDelta -> acquisitionValue/contest|planner.evolvePressure：市场卡 mean/peak 压力增量（缺省 0）|固定工作量及时间预算（受具体策略路径限制）|
|M08 多人竞争与时序|`seatContestFactor`；chooseJointAction -> competitionRisk / choosePlan -> seatContestFactor|planner.survivalOf + champion-guided.competitionRisk（缺省 1）|固定工作量及时间预算（受具体策略路径限制）|
|M09 未知牌概率模型|`unknownSupportFactor`；choosePlan -> futureDeckSupport -> unknownSupportFactor|planner: futureDeckSupport 乘子（缺省 1，只使用公开未翻开卡全集）|固定工作量及时间预算（受具体策略路径限制）|
|M10 行动候选生成/排序|`rankRootActions`；chooseJointAction -> ChampionGuidedPlanner.decide -> rankRootActions|champion-guided: 根筛选与认领候选重排/剪枝（只允许合法行动子集）|固定工作量及时间预算（受具体策略路径限制）|
|M11 多人联合搜索结构|`searchPolicyOverrides`；chooseJointAction -> searchPolicyOverrides -> ChampionGuidedPlanner.decide|adapter.chooseJointAction：白名单/边界内的联合搜索选项覆盖（缺省空）|固定工作量及时间预算（受具体策略路径限制）|
|M12 自适应计算预算|`budgetForDecision`；chooseJointAction -> budgetForDecision -> ChampionGuidedPlanner.decide|adapter.chooseJointAction：决策预算（0–1000ms 硬裁剪，缺省原值；固定 workUnits 时不生效）|仅时间预算；固定量失活|

M12：adapter 的 `resolvedOptions.workUnits === undefined` 条件控制调用，默认开发评测为32 workUnits，因此排除新 M12 干预并保留继承代码。两种模式的真实验证单独记录。

续行：joint-rollout 静态导入 rollout-policy 的 heuristicContext/myRankedActions/discardDecision。现有模块接口不能替换整个续行结构。当前未找到足以证实扩接口能改善候选排序的因果案例，本次不扩接口。

行为签名 v2：只存 buildObservation 的哈希及具体动作哈希；比较自然轨迹公共局面，同局面不同获取卡可被识别。轨迹无交集属不可比较；该签名不能证明分布外泛化或决策正确。
