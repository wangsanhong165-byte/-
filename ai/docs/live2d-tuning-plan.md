# Live2D 生动度微调 — 实施计划（Phase A/B/C）

> **状态：已全部实施并合入（2026-08-28，commit d0d0f79 / 9dda27c / 32dfbb4 + 验收脚本 ecb78ee + 人工反馈三连修 9ae40f8）。本文数值即当前代码行为，作为调参基线保留。** 验收脚本见 [acceptance-motion-curve.ps1](acceptance-motion-curve.ps1)。
>
> 分支：`feature/live2d-vividness-tuning`（基于 main @adbc86a）
> 依据：`.tmp_video/vividness-verification-report.md`（v3 方案）+ MinikoMew 视频观察笔记
> 范围裁定（用户 2026-08 确认）：皮套无手臂词表 → 无手势循环；唱歌未调试 → 无唱歌态；核心痛点 = 幅度过小 + 取消路径瞬断。

## Phase A：幅度修正（4 文件，全常数）

### A1 frontend/src/character/performance/BodySwayController.ts
- `:19-25` defaultRanges：headX ±0.8→±3.0、headY ±0.5→±1.9、headZ ±1.1→±3.5、bodyX ±1.7→±4.5、bodyY ±0.75→±1.8
- `:83` 重定目标间隔 2.4+rand×3.8 → 1.8+rand×2.7（换姿态更勤）
- 连带：output 经 bodyMotionGain(1.25)/parameterGain(1.45) 放大后，idle 头摆实际峰值约 4-6°，符合"陪伴型角色=主播能量一半"的定位

### A2 frontend/src/character/performance/IdleActionScheduler.ts
- 六个既有动作幅度 ×~2（nod 3.4→6.5、tilt 4.2→8.0、weight-shift 3.4→6.5、lean 2→3.8、sigh -2.6→-5.0、slow-blink 伴随头动加深）
- 新增第 7 个动作 `'reposition'`（重新落座，bodyX ±9.5° 的大动作，补长尾）：类型 union `:9-16`、labels `:58-61`、buildKeyframes、durationFor、isDirectional、isAvailable（bodyControl 门控）
- 连带：调用方仅 IdleBehaviorController（标签池自动纳入）

### A3 frontend/src/character/performance/SpeechPerformanceController.ts
- 说话姿态幅度 ×~2.5（headX 1.28→3.2、accent 2.35→4.6、headZ 0.74→1.8、body 各项同步）
- 去节拍器：固定 2.15Hz 正弦（`:57`）改为相位累加器 + 慢变频率（2.15±0.55，随 elapsed 漂移），消除固定周期机械感
- 连带：无（自包含）

### A4 frontend/src/character/IdleBehaviorController.ts
- `:111` 微正弦幅度 headX 0.48→1.0、headY 0.34→0.7、headZ 0.3→0.8、eyeX 0.24→0.34、eyeY 0.14→0.2
- `:112` 鼠标跟踪时 idle 阻尼 0.88→0.45（跟踪时身体保留过半摆动，消除"锁定定格"）

## Phase B：取消路径淡出（3 文件）

### B1 frontend/src/character/live2d/NativeMotionPlayer.ts
- 新增 `beginRelease(fadeOutMs)`：进入"冻结播放位置 + 权重按现有 fadeOut smoothstep 衰减至 0"模式；`update()` 期间持续产出衰减 contributions，完成后返回 done
- 连带：MotionArbiter 调用

### B2 frontend/src/character/MotionArbiter.ts
- `cancelOwner(owner, fadeMs=0)`：nativeName + fadeMs>0 时改走 `nativePlayer.beginRelease(fadeMs)` 并**保留活动条目**至 player done（update 循环驱动）；否则原逻辑
- `releaseOwner :266`：nativeName 分支由瞬时 cancelOwner 改为带 fadeMs 的软取消（修复 thinking=原生动作时的 releaseState 瞬斩）
- `cancelTurn :320-326`：逐 owner 先试 releaseOwner（逻辑淡出）再 cancelOwner(fade)（原生淡出）
- 连带调用点：controllers.ts `:428,537,543`（cancelTurn）、`:615`（cancelOwner('idle:native')）

### B3 frontend/src/character/controllers.ts
- `:615` cancelOwner('idle:native') → cancelOwner('idle:native', 320)（idle→listening 不再瞬斩待机动画）

## Phase C：情绪能量接通（1 文件）

### C1 frontend/src/character/performance/AmbientPerformanceEngine.ts
- `update()` 内取 `input.vad.arousal`（VADState 已由 character.intent 的 emotion/intensity/naturalVAD 连续驱动，controllers.ts:679,691），计算 `energyGain = 1 + arousal×0.45`（0.55-1.45x）
- 应用：`logicalIdlePose(idle, gain×energyGain)`、`logicalSpeechPose(speech, gain×energyGain)`
- 效果：兴奋时全身幅度放大、低落时收缩——LLM 情绪第一次调制身体
- 连带：无新调用方（vad 已在 input 内，:1068）

## 明确不改
- ParameterMixer 优先级/裁决逻辑（:277-302 正确）
- MotionArbiter 通道冲突/优先级模型
- LipSync/EmbodiedTracking/表情过渡（已验证平滑）
- 任何模型资产（.moc3/贴图/physics3.json）

## 验收
1. 单元测试：frontend vitest 全量跑（改前改后各一遍）
2. 参数轨迹断言：验收脚本逐帧检查 |Δ| 超阈值跳变（衔接场景清单见报告 §6）
3. 视频验收：录屏（自动 harness 或用户实录）→ ffmpeg tblend 运动量曲线 → 与改前基线及视频参考值（均值 5-6/峰值 15-20）对比；0.25x 逐帧检查 idle→listening、stop、跟踪进出三场景交接
4. 每 Phase 一个 commit，可独立回滚
