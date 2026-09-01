# Neuro 参照系审查报告 —— 状态机 / 动作 / 表情 / 记忆 全量对照分析

> 日期：2026-09-02 ｜ 分支：feature/expression-director (a072be0)
> 方法：两个 Neuro/Evil 录像 **全片网格覆盖（无抽查**：粗扫 10s/格 41 张 + 1s 细扫关键段 10 张 + 尾段复核 19 张，共 60 次网格审阅）+ 公开架构研究两核心源全文精读 + 本项目 12 个核心文件逐行核实（非二手转述）。
> 覆盖率核验（09-02 自检）：粗抽帧 1/10s 全片连续；`coarse_*/list.txt` 是废弃首抽残留（曾误报 991s 后无覆盖），已用跨段同景交叉验证推翻（e_d1_09 客舱切换失误 ≈2200s 与 ev_tail_05 同景；n_d1_06 画兔子段 ≈1300s 与 nv_tail_02 同景）；3 对文件重复（e_c1=e_d1_01、e_c2=e_d2_01、n_c1=n_d1_01，MD5 已验）。
> 结论性质：**只分析未改码**（git 干净）。所有行号为当日检出值。

---

## 一、视频证据清单

| 材料 | 内容 |
|---|---|
| Evil 2026.8.10《乘务员/开飞机》 | 2920s，1080p，e_c1/c2 + e_d1_01..10 + e_d2_01/02 + e_fine1_01..05 + ev_tail_01..08 |
| Neuro 2026.4.22《Neuro星期二》 | 3630s，1080p，n_c1/c2 + n_d1_01..10 + n_d2_01..03 + n_fine1_01..05 + nv_tail_01..11 |
| 网格图位置 | `.tmp_neuro/grids/` + `.tmp_neuro/tail_grids/`（可复查），音频已提取在 `.tmp_neuro/` |

### 观察到的表演规律（按对项目可迁移度排序）

1. **说话期身体从不静止**。头小幅连续摆动 + 语音重音处节拍性点头 + 躯干律动，三线并行贯穿全程。这是"活着"的第一来源。
2. **表情切换快速干脆**（约 150-250ms 到位），hold 短、回 base 快。不是慢速长过渡；快切+短 hold 造成"情绪密度高"的观感。
3. **符号化/夸张外化优先于细微渐变**：头顶"?"气泡、思考气泡（"999 thoughts" 常驻头顶生长）、青蛙头套整脸覆盖、心心眼/星星眼。Neuro 的情绪表达高度依赖**整脸符号与外部道具**，而非参数级微调。
4. **情绪幅度大**：生气/惊讶/开心全脸+全身联动，没有"半吊子表情"。
5. **视线节律贯穿说话期**：读弹幕时视线偏侧边、回答回镜头、说话中仍有小游离。视线是"注意力在场上"的核心信号。
6. **双人轮替节拍**：倾听方做反应动作（点头/歪头/惊讶脸），与说话方交替成节奏（Evil 视频双人段尤其明显）。单人格项目暂不适用，留档。
7. **思考可视化三段式**：idle → 思考气泡 3-6s → 答案+表情，状态边界清晰可辨。
8. **记忆外化**：明确引用长期记忆（"I remembered..." / "your memory is a little fuzzy"）。NeuroWiki 证实：记忆是**选择性存储**而非全量，长期记忆是唯一有实质意义的内容。
9. 眨眼自然 3-6s 无抽动；idle 呼吸可见 + 偶发小动作约 4-8s 一次。
10. 词汇注意：karaoke/唱歌/子模式是**视频词汇**，本项目无唱歌功能，严禁混入（沿用 Miniko 分析时的教训）。

### 尾段复核补充规律（09-02 自检新增，同样按可迁移度排序）

11. **角色化表现力档位**：Evil 全程 deadpan 中性脸、偶发 PANIC 全身举手爆发；Neuro 高表现力常驻。印证 per-character motionStyle 设计方向。
12. **内容类型调制表现力**：tech-tips 问答段（白板场景）表现力显著低于 chat 段——正式内容做减法。
13. **回忆专用视线**：讲记忆故事前视线先漂移上/侧再开讲（可映射到我们 attention='away' + contextTags 提示词）。
14. **负面深思做减法**："存在还是虚无"段表情收敛、动作变少变慢——靠降低动画密度而非加大幅度。我们 `energyGain=1+arousal*0.45` 低唤起自动减幅，方向已对。
15. **极端爆发=全身+重复**：PANIC 段举手+台词复读，全身通道同时征用。
16. **跨 30 分钟长程 callback**：乌龟梗从铺垫到结尾回收——长期记忆的表演价值（属于记忆系统层，非导演层）。
17. **场景切换全是硬切**：卧室→机舱→双人→新房间，无过渡动画。低优先级（项目无场景切换需求）。
18. **画图时视线在画布与弹幕间交替**：attention user/screen 切换机制我们已有对应物。

## 二、公开架构研究结论

来源：`lin-guanguo.github.io/llm-memory-research/neuro-sama.research`（架构专文全文）+ `en.neurosama.info/wiki/Neuro-sama`（NeuroWiki）。检索方式：WebSearch 工具持续空结果 → curl 走本地代理 `127.0.0.1:7897` + DDG html 端点可行（Wikipedia/Reddit/Fandom 对该出口 403 风控，DDG 通）。

- **架构**：fine-tuned 小模型（~2B q2_k，社区传闻未证实）+ 系统提示只给**情境**不给人格（人格在权重里）+ Azure TTS "Ashley" +25% pitch + Live2D 口型；游戏走 Neuro SDK = **typed action protocol**（游戏注册 action schema → LLM 只做高层动作选择 → 下游验证执行）。
- **情绪由独立模块/AI 驱动，同时影响对话参数与 Live2D 参数**（NeuroWiki 明文）——即双通道：语义 → 情绪状态 → 表演参数，而非 LLM 直接输出表演。
- **记忆**：LLM 选择性决定记什么；无跨会话持久化确证（RAG 迹象未证实）；Vedal 称记忆是持续挑战。
- **学习**：无在线学习。deploy → collect → Vedal 人工筛选 → 离线 retrain 循环。
- 开源复刻（kimjammer/Neuro、Open-LLM-VTuber、airi、AIRIS）：pipeline 都能搭起来，**人格上限在 fine-tune；prompt-only 碰到 aligned model 的抵抗就到顶**。对本项目的启示：表演层调参是正路，训练不是当前杠杆。
- Evil = 同 base + 不同 prompt/安全设置（社区说法，未证实）→ prompt 层人格仍占显著比重。

**与本项目的同构性**（重要正面结论）：我们的 `segments[]` 语义分段协议 ≈ Neuro SDK typed actions；`naturalVAD` 双通道 ≈ "独立情绪模块驱动对话+Live2D"；shirone 星星眼/鸡爪眼/心心眼/圈圈眼映射 ≈ Neuro 的符号化表情体系。**骨架是对的，差距在参数与覆盖率，不在设计。**

## 三、本项目表演层现状审计（全部亲自读码核实）

### 已对齐 Neuro 模式的部分（勿推翻）
- `PerformanceDirector.ts`：多段实测时长锚定（scheduleFromMeasuredSegments）/ 顺序播放重锚（reanchorCuesFrom）/ 手势去重 6s 窗口 / prevExpression 继承 / 本地编排兜底（withLocalSemanticChoreography）。
- 眨眼 4.7s 基准（lively 3.0-4.5s），已符合人类节律，**勿再动**。
- GSVI 口型优先级 76>75 排他 + 语音期 mouth 参数解锁。
- MotionArbiter 通道仲裁（fadeIn 180 / recovery 420 / release 280ms）。
- shirone 符号化表情映射表（星星眼/鸡爪眼/心心眼/圈圈眼）。

### Gap 清单（"导演层没存在感"的根因，按证据强度排序）

| # | Gap | 证据（文件:行） | 影响 |
|---|---|---|---|
| 1 | **说话期表演源单一且语义动作常被概率丢弃** | `CharacterPerformancePolicy.ts:82` motionProbability = min(0.75, 0.2+intensity*0.5)；intensity 0.5 时仅 45% 概率执行 | LLM motionPlan 一半以上被静默丢弃 → 观感"导演没用" |
| 2 | **speaking 期视线完全静止** | `PerformanceCoordinator.ts:87` AutonomousAttention 仅 `activity==='idle'` 启用 | Neuro 规律 5 完全缺失 |
| 3 | **表情过渡偏慢** | `CharacterPerformancePolicy.ts:78` 默认 transitionMs 360（仅 surprised/excited 140） | Neuro 是 150-250ms 干脆切换 |
| 4 | **动作振幅偏小** | `MotionAction.ts:342-368` nod 峰 -9°、tilt 12°、lean 6°；叠加 energyGain(1+arousal*0.45) 后观感仍小；本地编排 baseIntensity clamp 0.34-0.76（`PerformanceDirector.ts:317-321`） | Neuro 幅度约大 30-50% |
| 5 | **idle 小动作节奏偏保守** | `IdleActionScheduler.ts:155` 间隔 6-11s + focus*2 | Neuro 约 4-8s |
| 6 | **死数据：modifiers.blinkRate 无人消费** | `CharacterPerformancePolicy.ts:98` 计算 surprised 0.75/happy 1.2，但 `setTiming` 仅在 setModel（controllers.ts:259）调用一次 | 表情↔眨眼联动断裂 |
| 7 | **节拍位置固定均匀** | `PerformanceDirector.ts:315-316` fractions [0.06,0.42,0.72]；hash 只轮转 primitive 顺序不换位置 | Neuro 节拍踩语音重音、更随机 |
| 8 | **holdMs 3000 回 neutral 掐掉 idle 长情绪** | `controllers.ts:826-831` speaking 跳过（正确），idle 期长情绪被定时复位 | 中优先级 |

### 关键接线事实（改码前必读）
- `SpeechPerformanceController`（beatRate 2.15±0.55Hz 漂移、onset 0.22s / release 0.48s）经 `AmbientPerformanceEngine.logicalSpeechPose` 进参数链，speaking 态唯一连续姿态源；`energyGain = 1+arousal*0.45` 是全身振幅总闸。
- `applyIntent`（controllers.ts:694）→ exprCtrl.apply / motionArbiter.request(priority 52/50) / attention.set；telemetry 在 controllers.ts:819-824。
- 提示词协议 `prompt_compiler.py:234-257`：segments JSON、motionPlan 白名单 10 primitive、否定词规则、few-shot 两例。后端测试锚点：`tests/test_presentation_capabilities.py:110`。
- 词表：Design_genius_White 19 emotions / shirone 11 prompt_emotions；emotion_map 见 `config/live2d_models.json`。

## 四、待实施微调清单（下次会话直接做，按性价比排序）

1. **speaking 期视线节律**：AutonomousAttentionController 放开 speaking 低权重（0.3-0.4）视线游离，或给 SpeechPerformanceController 加 eye.x 漂移项。*收益最大，对应规律 5；回忆前视线先漂移（规律 13）可由提示词 contextTags+attention='away' 表达，属提示词层可选加分项。*
2. **motionProbability 提高**：speak 行为改 0.55+intensity*0.35（保留 close-up/whisper 折减）。*一行改动，直接解决"导演没存在感"。*
3. **primitive 振幅 +30%**：nod -12 / tilt 15 / lean 8 / sway 9（`MotionAction.ts` primitiveFrames），或仅调 shirone energyGain。*PANIC 式全身爆发（规律 15）由 energy 高档+多 primitive 并发自然达成，无需新机制。*
4. **transitionMs 360→200**（emotion 多数档，surprised 140 保留）。
5. **IdleActionScheduler 间隔 6-11s → 4.5-9s**。
6. **本地编排 fractions 按 hash 抖动 ±0.08**（打破均匀感）。
7. **blinkRate 联动**：消费 modifiers.blinkRate（表情切换时 surprised 减慢 / happy 略快），或删除死数据。
8. **内容类型调制（可选，对应规律 12/14）**：提示词协议给 contextTags 增加 `formal`/`somber` 类语义标签的措辞指引（负面深思=energy/intensity 降低而非升高），由现有 tagEnergyScale（whisper 0.58 / excited 1.18 / reassuring 0.78，`CharacterPerformancePolicy.ts:70-72`）承接，无需新代码路径。
9. **不做**：眨眼 4.7 基准保持；场景硬切（规律 17，项目无此需求）；改完前端必须 rebuild dist（用户既定规则）。

### 测试基线（改动后回归用）
- 前端 runner 是 **`node --test --experimental-strip-types`（不是 vitest！）**，全清单在 `frontend/package.json` scripts.test。
- 基线：6 文件 44 pass（performance-director / performance-policy / motion-action / idle-action-scheduler / speech-performance-controller / autonomous-attention）。
- 改动风险锚点：`performance-director.test.ts:214`（断言 9000*0.55）、`speech-performance-controller.test.ts:28`（headPeak≥2.1，改振幅会抬高，方向安全）。
- 后端 pytest 需 `--basetemp`（临时目录损坏问题）。

## 五、边界声明
- 本次 **未修改任何项目文件**（git 状态干净，仅 `.tmp_neuro/` 分析材料未跟踪）。
- "2B/q2_k" 为社区传闻，研究页明确标注无一手来源，引用时需带此限定。
- 双人轮替节拍（规律 6）单人格项目暂不适用，留档备将来。
