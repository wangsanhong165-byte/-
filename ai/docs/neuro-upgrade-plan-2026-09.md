# Neuro 参照系升级方案 —— 表演层从"正确骨架"到"可感知生命感"

> 日期：2026-09-02 ｜ 前置文档：[neuro-reference-review-2026-09.md](neuro-reference-review-2026-09.md)（审查报告：18 条规律 + 8 条 Gap + 代码级证据）
> 本文档回答：**具体怎么改**。每个工作包给出：目标规律 → 改哪个文件哪个函数 → 新值与依据 → 验收方式 → 风险。
> 分级：P0=直接决定"导演层有没有存在感"，P1=显著提质，P2=锦上添花，P3=记录暂缓。
> 约束：不改协议格式（segments/motionPlan 不动）、不动眨眼 4.7 基准、全部走现有通道仲裁与能力开关。

> **⚠️ 2026-09-03 勘误（d82ddc3）**：本计划实施后经用户真机反馈与项目基线复核，以下条目已撤回或调整，以代码现状为准：
> - §P1"动作振幅 +30%"已撤回——超出 Phase-A 校准基线（live2d-tuning-plan.md），实测读感"作"；现恢复基线值并改用非对称节拍形状（快起-慢收-轻微回落）与逐拍强度 ±15% 变化。
> - §P0"表情过渡 360→220ms"已回退 360ms——vividness-report §2 判定原值已匹配视频带（300-600ms）。
> - 保留项：motionProbability 改革、speaking 期视线节律（strengthCurrent 平滑版）、fractions 抖动、idle 间隔 4.5-9s、眨眼联动、formal/somber 调制、contextTags 受控词表（b33d580）。
> - 新增（计划外）：活动切换 handoff 窗口——approachPose 回落速率 3.8→1.7/s 持续 1.2s，修复"发送→思考态瞬间回正"（提交 d82ddc3，基线见 live2d-tuning-plan.md）。

---

## 0. 量化依据（本方案数值的来源）

对两个视频全部 6548 帧（1fps）做的背景扣除运动能量分析（脚本 `.tmp_neuro/quant2/3/4.py`，结果 `quant*.json`）：

| 指标 | Evil | Neuro | 含义 |
|---|---|---|---|
| 头部显著节拍（>2.2×中位能量，≥3s 不应期） | **7.9 次/分** | **11.0 次/分** | 语义节拍的真实密度 |
| 运动覆盖秒数占比（头/身） | 84% / 90% | 54% / 84% | 几乎从不完全静止 |
| 完全静止秒占比 | 7.4% | 13.9% | "死住"时间极少且短暂 |
| 逐分钟能量曲线动态范围 | 15→46（3 倍） | 1.5→39（26 倍） | 情绪段落间起伏巨大 |
| 头:身能量比 | 0.69 | 0.49 | 身体是主要运动载体 |

外部参照（行为学常识，置信度中——检索通道受限未能拿到一手文献数值，方案按保守值设计）：交谈中伴随手势非常普遍（McNeill 传统估计约每分钟数次到十余次 beat）；思考时视线游离占比 30-50%；自发表情到峰约 300-500ms 但**可辨变化**在前 150-250ms。

**推论（方案的设计目标线）**：
- 说话期语义节拍应达 **6-10 次/分**（我们当前实测远低于此，motionProbability 0.45 命中 + 部分被 arbiter 拒）；
- 任何连续 3 秒内应有可测运动（消灭"死住 3 秒+"）；
- idle 与 speaking 之间的能量差应保持 2-3 倍动态范围，且**低能量段靠"变慢变小"而非"冻结"**。

---

## 1. P0 工作包：让导演层"被看见"

### 1.1 语义动作必达（motionProbability 改革）
- **目标规律**：R1 说话期身体从不静止；量化目标 6-10 beats/min。
- **改法**：`frontend/src/character/CharacterPerformancePolicy.ts:79-86`
  - speak/speak 类行为（behavior 无专属 motion 时）：`baseMotionProbability = min(1, 0.55 + intensity * 0.35)`；
  - 保留现有折减：close-up/whisper ×0.55、excited ×1.2；
  - **带 LLM motionPlan 的意图不走概率**（`controllers.ts:783` 处 `policy.motion` 为空但 `intent.motionPlan` 存在的路径已是必达，维持）——本条只治"LLM 没给 plan、policy 兜底动作"被丢弃的情况。
- **为什么安全**：动作仍走 MotionArbiter 通道仲裁+手势去重（PerformanceDirector 6s 窗口），不会抖动成高频抽搐；每个 cue 至多 1 个动作。
- **验收**：telemetry `character:performance` 事件里 motion 决策 accepted 率从当前（估计 <40%）升到 ≥70%；连续 10 轮对话肉眼可见"每句话都有身体语言"。
- **工作量**：~5 行 + 测试锚点 `performance-policy.test.ts` 相应断言更新。

### 1.2 speaking 期视线节律（第二生命线）
- **目标规律**：R5 视线节律贯穿说话期；尾段 R13 回忆前视线先漂移。
- **改法**（推荐 a，b 为备选）：
  - a. `frontend/src/character/performance/PerformanceCoordinator.ts:85-95`——AutonomousAttention 的 enabled 条件从 `activity === 'idle'` 放宽为 `['idle','speaking'].includes(activity)`，但 speaking 期强制 `strengthScale = 0.35`、`hold` 时长减半（说话时视线游离是"瞥"不是"看"）。实现方式：给 `AutonomousAttentionController.update` 增加 `strengthScale` 上下文字段（`AutonomousAttentionController.ts:66`），sample() 输出值乘系数；`interactionEngaged`（用户鼠标接管）优先级不变。
  - b. 备选：`SpeechPerformanceController.update` 增加 `eye.x` 缓慢正弦漂移项（±0.3，周期 4-7s 随机相位）——实现更小但失去"瞥向-停留-收回"的 episode 结构。
- **为什么选 a**：保留已有 episode 状态机（acquire/hold/release 的生物节奏），只是降权重；且 AutonomousAttention 已有与 tracking 的 cross-fade（blendAttentionWithTracking），说话期用户移动鼠标仍能平滑接管。
- **验收**：speaking 态连续 30s 内 `autonomous` debug state 至少进入 1-2 个 episode；视觉上说话时有明显"瞥别处又回来"。
- **风险与对策**： эпisode 的 head.x ±5.2° 在说话期可能与语义 head 动作叠加过大 → strengthScale 0.35 后 head 分量 ≤1.8°，安全。
- **工作量**：~15 行 + `autonomous-attention.test.ts` 新增 speaking 期用例。

### 1.3 表情切换提速
- **目标规律**：R2 表情切换 150-250ms 干脆到位。
- **改法**：`CharacterPerformancePolicy.ts:78` `transitionMs` 三档改两档：`surprised/excited → 140`（不变），**其余 360 → 220**；whisper/reassuring 保持 520（轻语放慢是性格不是缺陷）。
- **连带**：`controllers.ts:826-831` idle 期回 neutral 的 `Math.max(420, transitionMs)` → `Math.max(300, transitionMs)`。
- **验收**：`avatar-controller.test.ts`/`performance-policy.test.ts` 断言更新后全绿；肉眼确认多段情绪流转（如 pout→happy）第二段"跟得上台词"。
- **工作量**：2 行。

---

## 2. P1 工作包：幅度与节奏（把"有"变成"看得出来"）

### 2.1 动作振幅全局上调
- **目标规律**：R4 情绪幅度大；量化：Neuro 逐分钟能量动态范围 26 倍。
- **改法**：`frontend/src/character/MotionAction.ts:337-370` primitiveFrames：
  - nod：峰 -9° → **-12°**（回弹 +5°→+6°）
  - tilt_left/right：12° → **15°**
  - lean_forward：body.y 6 → **8**（head.y 3 → 4）
  - lean_back：-5 → **-6.5**
  - sway：body.x ±7 → **±9**
  - shrug / breathe / look_*：不变（低幅度原语保持克制）
- **依据**：Live2D 参数资产上限内安全（`project_live2d_fundamentals`：参数网格变形无骨骼限制，±15° 在 shirone 头部参数范围内）；叠加模型耦合系数后 body 分量自动跟随。
- **连带调小 risk**：`speech-performance-controller.test.ts:28` headPeak≥2.1 是 SpeechPerformanceController 的（不经过 primitiveFrames），不受影响；`motion-action.test.ts` 若有峰值断言需同步。
- **验收**：quick-perf 回放（已有表演回放导出功能）对比改前后 nod 视频帧位移；实测 head.y 峰值从 ~7° 升到 ~10°。
- **工作量**：6 行数值 + 测试核对。

### 2.2 语义节拍密度：本地编排 fractions 抖动 + 时长分档细化
- **目标规律**：量化 7.9-11 beats/min；R7 固定 fractions 显机械。
- **改法**：`frontend/src/character/performance/PerformanceDirector.ts:313-316`
  - 现三档 [0.06,0.42,0.72] → 按已有序的 turn hash 抖动：`fraction + (hash bit ? +0.07 : -0.07)`，clamp [0.04, 0.85]；
  - 5.5s+ 长句从 3 beat 提到 **4 beat**（fractions 加 0.9 档，供收尾拍）；`MotionAction.ts` MAX_LLM_STEPS=3 不动（本地编排上限独立于 LLM 校验，`withLocalSemanticChoreography` 输出走 compileMotionPlanForModel 的 authored 路径前需确认 slice(0,3) 上限——若受限则维持 3 拍、只加抖动）。
- **验收**：`performance-director.test.ts` 既有 9000*0.55 断言不破坏（尾部拍仍在 0.55 之后）；目测节拍不再"数得出来"。
- **工作量**：~10 行。

### 2.3 idle 节奏对齐
- **目标规律**：R9 idle 小动作 4-8s 一次。
- **改法**：`IdleActionScheduler.ts:151-156` `(6 + random*5)` → **`(4.5 + random*4.5)`**；focusLevel 加成保留。
- **验收**：`idle-action-scheduler.test.ts` 断言区间更新；10 分钟观察 idle 不再"长时间木头人"。
- **工作量**：1 行。

### 2.4 眨眼情绪联动（消费死数据）
- **目标规律**：R9 + 现有死数据清理。
- **改法**：`controllers.ts` applyIntent 内（channels.has('expression') 分支）把 `policy.modifiers.blinkRate` 传给 IdleController：新增 `setBlinkRateOverride(rate, durationMs)`——情绪表情持续期内 blinkRate 乘子生效（surprised 0.75=惊讶时睁眼凝视、happy 1.2=略快），超时回落 style 基准。
- **验收**：新单测 + 肉眼：惊讶台词后 2-3s 内不眨眼。
- **工作量**：~20 行（含 controller 方法与定时回落）。

---

## 3. P2 工作包：质变项（一条一讨论再做）

### 3.1 符号化表情门槛利用（shirone 专属）
- **目标规律**：R3 符号化外化是 Neuro 表情的主体。
- **现状**：星星眼/心心眼等映射已配平，但提示词层 `prompt_emotions`(shirone 11 词) 里 joyful/playful 可达符号眼，LLM 却倾向选 happy（报告 Gap）。
- **改法**：`app/runtime/prompt_compiler.py` 规则 7 的锚点措辞增加一句模型特性指引（由 presentation_capabilities 注入 per-model）："`joyful` 触发 star-eyes（真正的欢庆/狂喜时用，不要省）；`playful` 触发独特眼型（主动逗弄时用）"。**不加新词，只加引导**。
- **验收**：`test_presentation_capabilities.py` 相关断言 + 实测 10 轮对话符号眼出现率从偶发→常见。
- **工作量**：~6 行提示词 + 测试。

### 3.2 内容类型调制（formal/somber 标签）
- **目标规律**：R12 tech 段降表现力；R14 负面深思做减法。
- **改法**：两层：
  - 提示词规则 7 补一句："正式讲解/技术内容给 contextTags 加 `formal` 并把 energy 降到 0.3-0.4；沉重话题给 `somber`，energy 0.2-0.3 且**不要**提高 intensity"；
  - `CharacterPerformancePolicy.ts:70-72` tagEnergyScale 增加 `formal: 0.62`、`somber: 0.5`。
- **验收**：实测问技术问题时动作幅度肉眼变小但不冻结（energyGain 联动）。
- **工作量**：~8 行。

### 3.3 思考态可视化增强
- **目标规律**：R7 思考三段式边界清晰。
- **现状**：thinking 态只有 head/gaze channels priority 55 的微动作。
- **改法**：thinking 进入时（`controllers.ts:620-631`）给 Arbiter 请求附带视线向上偏移（'eye.y' -0.3 via attention 'away' 档）；若未来加 UI 层则可做"..."气泡——**UI 层暂不做，先做视线**。
- **验收**：目测 thinking 时视线明显上飘。
- **工作量**：~5 行。

### 3.4 低能量防冻结（quiet-floor）
- **量化依据**：Neuro 完全静止仅 13.9% 且短暂；我们 vadPosture 在 arousal≈-0.8（blank/sleepy）时 output 接近 0。
- **改法**：`AmbientPerformanceEngine.ts` vadPosture 之后加 floor：`if (activity==='speaking' && |target| 全通道 < ε) 注入 breathe 残量`——更简单的等价实现：speaking 态 energyGain 下限 clamp `Math.max(0.75, 1+arousal*0.45)`。
- **验收**：blank 情绪说话时头仍有微动。
- **工作量**：2 行。

## 4. P3 记录暂缓（明确不做，防 scope 蔓延）
- 双人轮替节拍（R6）：单人格，无第二模型驱动。
- 场景硬切/机长镜头语言（R17）：无场景系统。
- 手臂/手部动作（量化显示身体是主载体，但模型无手臂参数资产——`project_live2d_fundamentals` 硬约束）。
- 内核级 fine-tune 人格（Neuro 路线）：当前 DeepSeek API 无权重访问，prompt-only 是现实边界；记录 kimjammer 结论（aligned model 抵抗）作为预期管理。
- 长程 callback（R16）：属记忆系统路线图（已有 inner_state 双通道规划），不在表演层。

## 5. 实施顺序与批次（建议 3 个提交）

| 批次 | 内容 | 文件 | 测试面 |
|---|---|---|---|
| 批1 P0 | 1.1+1.2+1.3 | CharacterPerformancePolicy / PerformanceCoordinator+AutonomousAttention / controllers | performance-policy, autonomous-attention, avatar-controller |
| 批2 P1 | 2.1-2.4 | MotionAction / PerformanceDirector / IdleActionScheduler / controllers | motion-action, performance-director, idle-action-scheduler |
| 批3 P2 | 3.1-3.4 | prompt_compiler+presentation_capabilities / policy / AmbientPerformanceEngine | test_presentation_capabilities(py), speech-performance-controller |
- 每批：`node --test --experimental-strip-types <files>` 全绿 → `npm run build`（dist 同步，用户规则）→ 真机 GSVI 全链路一轮 → 提交。
- 回归锚点：报告 §测试基线（44 pass 基线、`--basetemp` pytest）。

## 6. 验收总清单（全部完成才算"升级方案落地"）
1. telemetry 统计：accepted motion 率 ≥70%（原 <40%）。
2. 10 分钟真机对话：连续 3 秒完全静止的片段 = 0（对齐量化 quiet_frac ≤14%）。
3. 多段情绪流转（傲娇 pout→happy 脚本）表情切换观感"跟嘴"。
4. speaking 期至少每 20s 一次可辨视线游离。
5. 符号眼（星星/心心）在对应情绪下出现率明显提升（shirone）。
6. 惊讶台词后眨眼抑制可复现。
7. 全量前端测试 + 后端 pytest 绿；dist 已重建。
