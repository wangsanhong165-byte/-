# 表演层打磨 SOP(新表情 / 调参标准流程)

> 适用范围:Live2D 表现层的情绪肢体语言、待机/说话/思考编排、连续性阈值。
> 原则:**身体语言的定义只有一个入口;每次打磨必须留下回归锁。**

> **当前生产模型:shirone。** 真值来源:`app/bridge/server.py:47`(`_live2d_model` 默认)
> 与 `data/settings.json`(`live2dModel`)。场景库与 harness 已固定 shirone profile
> (`performance-pipeline-harness.ts` 的 `PROFILE_NAME`);换模型时改这一处并重新校准阈值。

## 1. 身体语言定义在哪

只有一个表:`frontend/src/character/performance/performance-recipes.ts`。
**posture 分两套**(shirone 的 expressionMap 把一族情绪折叠到同一张脸——
joyful/cheerful/laughing→星星眼,love/shy/embarrassed→心心眼,
angry/pout→生气表情,calm/neutral→重置——身体语言是族内唯一的区分维度):

```ts
POSTURE_SETS = {
  lively:  { joyful: { head.z: 1.8, body.x: 1.3, head.y: 0.9 }, ... },  // 主套(shirone 默认)
  natural: { /* lively × ~0.72,同语法软声线 */ },
}
POSTURE_SCRIPTS = { love: { phases: [...] }, shy: {...}, joyful: {...}, ... }  // 分拍表演脚本(见 §1.5)
EMOTION_BEATS = { pout: ['lean_back', 'tilt_right', 'breathe'], ... }   // 补拍,不分套
BEHAVIOR_BEATS = { greet: [...], agree: [...] }                          // 行为(非情绪)的拍点
IDLE_TINTS = { playful: { 'ear-flick': 2.6, ... }, sad: { 'sigh-sink': 2.4, ... } }  // 待机染色
```

套的选择:motionStyle.preset = lively → lively 套;其余(natural/calm/shy)
→ natural 套(`emotionPosture(emotion, preset)` 内映射)。改套值只动
`LIVELY_POSTURES`,natural 由它派生(scalePostures ×0.72);脚本同样按 preset
缩放(`emotionPostureAt` 内 0.72)。

族内区分要求(锁在场景库):joyful 前倾打开 / cheerful 挺直明亮 /
laughing 前摇滚头;love 前倾贴近 / shy 后转低头 / embarrassed 低头;
**calm 必须有姿态**,否则与 neutral 视觉零区分。

消费方自动生效:

| 消费方 | 取用 | 机制 |
|---|---|---|
| `AmbientPerformanceEngine`(环境层) | `posture` / **脚本** | 情绪激活期间缓入的姿态底座;**有脚本的族沿时间线采样**(接近拍→落定→活保持) |
| `PerformanceDirector`(导演层) | `beats` | LLM 动作计划单薄时,按行为/情绪回退的本地补拍 |
| `IdleActionScheduler`(待机层) | `IDLE_TINTS` | 情绪给待机选词池乘权重——待机也在演情绪 |

不要再往别处加情绪→肢体映射;`config/live2d_models.json` 的 `behavior_map` 只负责
模型级的语义别名(如 greet→tilt),不属于身体语言定义。

### §1.5 分拍表演脚本(POSTURE_SCRIPTS,2026-09-04)

每个情绪族一条**分拍时间线**:`phases: [{atMs, values, loop?, holdLoopMs?}]`。
语义:接近拍(快速 commit,180-420ms)→ 落定拍(过冲回稳)→ 活保持拍(末拍,
带 `loop` 微幅呼吸循环)。**ear./tail. 通道合法**——shirone 没有手,耳/尾是她的
"手"(害羞耳贴、愤怒耳压、开心耳立、尾巴卷/甩)。规则:

- 第 0 拍从空值起步(引擎从当前体位缓入,不写"跳变");
- 末拍值 ≈ 旧 flat posture 的数值(保持族间区分度,能力锁不失效);
- `holdLoopMs` 3-5s,是"呼吸"不是"摇摆";
- 镜像只翻**侧向轴**(head/body 的 x/z);ear 压/立、尾升降是强调轴,不翻
  (`AmbientPerformanceEngine.lateralAxis`);
- 情绪姿态脚本写 `tail.*` 时,尾巴物理链让位(意图优先,惯性只补空白轴);
- 没有脚本的族自动回退 flat posture,无需删旧表。

### §1.6 待机短语库(2026-09-04)

待机动作池从 8 个本地节拍扩到 12:`ear-flick`/`tail-sweep`(shirone 的
`logicalMotionPresets` 里的预制动画)通过 **phraseRequest 桥**走 MotionArbiter
播放(所有权/淡入/释放物理免费获得),controller shell 在
`controllers.ts` configure 时安装桥;`micro-stretch`(小伸展)/`look-back`
(低头回看)是新的本地长尾节拍。无桥路径(测试/harness)短语标签自动出池。
配饰短语需要 `capabilities.secondaryMotion !== false`(新字段,默认 true)。

`IDLE_TINTS` 情绪染色是**乘法不覆盖**:人格/VAD 权重保留投票权。
锁在 `idle-action-scheduler.test.ts`(分布差分锁 + 桥锁 + 无桥出池锁)。

### 导演层情绪节奏

`PerformanceDirector` 有 **emotionHoldMs 滞回**(生产 900ms):分段 LLM 情绪
标签切换过快时沿用旧情绪,只延后表情/姿态,**节拍照发**;换 turn 重置。
标尺:Live2D 官方表情淡变默认 500ms(docs.live2d.com),900ms ≈ 2 倍淡变——
足以拦住 A/B/A 抖动,又不会吃掉一句一个的短情绪(一句 ≈1-1.5s)。
**neutral 永不滞回**:静默尾巴被旧怒脸钉住 = "卡在生气",live 踩过的坑。
初版 1800ms 就是这么翻车的——滞回是"取消短情绪"不是"延迟",窗口必须贴着
淡变量级走,调参前先问:这个窗口吃掉的最短情绪,观众该不该看到?

## 2. 新增一个表情的肢体语言

1. 在 `performance-recipes.ts` 给一行定义:flat `posture`(兜底)和/或
   `POSTURE_SCRIPTS` 分拍脚本(推荐,含 ear/tail 联动,见 §1.5)/`beats`。
   幅度参考现有条目:头部姿态 1.2–3.0°,ear 压/立 2–5,尾 2–4;新族记得在
   `SCRIPT_FAMILY` 登记继承关系(如 embarrassed → shy)。
2. 待机若要随该情绪变色,在 `IDLE_TINTS` 加一行(乘法权重,0.2–2.6)。
3. 若该表情会作为一段回复的情绪出现,给场景库补能力锁:
   `frontend/src/character/performance-scenarios.test.ts` 加一个 test,断言
   "姿态真的发生了"(参照 pout 场景的 `maxAbs(...,'head.z',...) >= 门槛`);
   有脚本的族加**分拍锁**(参照 shy 场景:回瞟拍必须浅于躲避保持)。
4. 跑验证(见 §4),全绿后提交,commit 里说明动了哪个值、为什么。

## 3. 调既有表情 / 调编排参数

- 只改 `performance-recipes.ts` 或对应控制器里的数值。
- 改完先跑场景库;若峰值变化导致能力锁或连续性阈值不匹配,**同一次提交里**
  更新场景基准并在 commit 说明(阈值注释里写明了校准依据)。
- 连续性红线:活动驱动层单帧跳变 ≤ 0.8°/帧(2026-09-04 调参包后正常包线
  ~0.63°/帧,病理闪现是 5.9°/帧;场景库阈值 FLASH_STEP_DEG=1.3 同步)。
  指针获取路径例外,它被设计为即时响应,阈值见场景文件。

## 4. 怎么跑验证

```bash
cd frontend
npm test                 # 全量单元 + 场景库
npx tsc --noEmit         # 类型
```

- 沙箱/受限终端里 `node --test` 的子进程可能被拒(EPERM)。**注意:
  `--test-isolation=none` 传多个文件只会执行第一个文件**(2026-09 实测),
  别用它跑全量。受限环境全量验证用逐文件循环(每个文件一个独立进程,
  等价于 `npm test` 的隔离语义):

  ```powershell
  $list = ((Get-Content package.json -Raw | ConvertFrom-Json).scripts.test `
    -replace '^node --test --experimental-strip-types ','').Split(' ')
  $fail = @()
  foreach ($f in $list) { node --experimental-strip-types $f *> $null
    if ($LASTEXITCODE -ne 0) { $fail += $f } }
  "total=$($list.Count) fail=$($fail.Count)"; $fail
  ```
- 场景库阈值重新校准的工具:`node --experimental-strip-types scripts/scenario-metrics.mjs`
  (打印各场景的正常峰值,阈值应保持在"正常包线 ~2 倍、可感知闪现 ~1/7"附近)

## 5. 场景库怎么扩展

`performance-pipeline-harness.ts` 是逐帧驱动的真实管线(注意力/环境层/仲裁器/
混合器按 controllers.ts 的每帧顺序接线),场景 = 事件脚本 + 不变量:

- 新场景:优先用现有事件原语(`transition/setEmotion/setAttention/requestMotion/
  trackPointer`),不要为单个场景往 harness 加特判;
- 断言分两类:**连续性**(不许闪)与**能力**(必须发生)。新能力两条都要有。
- 原生 motion3(独占通道、冻结衰减)尚未入场景——现有 native-motion-fade 等
  单元测试覆盖;若打磨涉及原生动作路径,先扩 harness 再扩场景。

## 6. 动效预算(Neuro 参考实测,2026-09 粗扫+细读)

粗查:对 3630 帧做逐帧差分运动能量扫描(`.tmp/motion-sweep.py`,ROI=角色区,
排除道具遮罩干扰)——全场都有运动(中位 19.7),前三分之一最活跃(27-29)。
细读:游戏段手臂教鞭+猫耳配饰+泛红;温情段头微动+眯眼笑;各段头位几乎
每个样本都在变(±10-15°),偶发 30-40° 刻意大倾。

落地参数(改前先读):
- 头微动:每 2.2-4.5s 一个新头位(±3.2° ×2.6 增益,弹簧 0.55Hz、阻尼 0.72 带
  ~10% 过冲回稳)——头高频;头位重选**只在重音门控触发**(语音能量上升
  >0.03,或静默超 1.6s 的宽限重选),不是定时器
- 躯干:能量驱动(swayScale 随语音能量 0.62-1.0 浮动),幅度小、不匀速游走
- 待机动作:6.5-13s 一动 + 稀有 big-tilt(16°,权重 0.3)
- 表情状态保持数秒(导演 emotionHoldMs=900,neutral 豁免)
- **幽默主要走道具/配饰/眼神,不走肢体幅度**——shirone 无手臂,等效通道是
  耳弹/尾扫/配饰件(config accessories + avatar components),值得后续把
  配饰事件接到笑话/情绪节点上(需 bridge 侧支持,单独立项)

### 2026-09-04 灵巧度调参包(动画表演原则落地)

参照 Williams《动画师生存工具包》时值表与迪士尼十二法则做的一轮"灵巧度"
重塑(动机:小模型调出的动作起手慢、缺因果、神态不分):

1. **快速起手**:全部 9 个预设 JSON 的起手段压缩 30-40%(预备 60-120ms、
   主峰 150-380ms;一个 beat 的 commitment ≈ 8-10 帧 ≈ 130-170ms 的行业时值)
2. **神态分离(眼睛先行)**:react 的 eye.y 70ms 到位、head.y 150ms 才到峰;
   greet 的 wave 步 380ms 对齐头位到位时刻(因果链,不再同时发生)
3. **MotionAction 原语峰值点 .3 → .22**(LLM 补拍 beats 同样快速起手;
   连带 motion-action.test.ts 峰值断言 300ms → 220ms)
4. **说话层弹簧 0.42→0.55Hz、阻尼 0.85→0.72**(头位变更 ~0.9s 到位并带
   ~10% 过冲回稳——"commit"而非"漂移");重音门控阈值 0.05→0.03(真音节
   起振即触发)
5. **左右镜像交替**:逻辑动作每次播放 x/z 取反、y 保留(MotionArbiter
   mirrorToggle);情绪姿态每次换情绪翻转(AmbientPerformanceEngine
   postureMirror)——锁在 motion-arbiter.test.ts 镜像交替符号锁
6. **连续性包线抬升**:上述改动把 24s 待机最坏单帧从 ~0.46 抬到 0.63°/帧,
   FLASH_STEP_DEG 1.0→1.3(仍为包线 ~2 倍、病理 5.9° 的 ~1/4.5),
   SOP §3 红线 0.6→0.8 同步

新增回归锁:镜像交替符号锁(motion-arbiter.test.ts)、重音门控差分锁
(speech-performance-controller.test.ts)、情感否定守卫锁(tests/test_emotion_step.py)。

## 7. 防镜像漂移(硬规则)

harness 的每帧接线和活动转换是**手工镜像** `controllers.ts` 的,不同步就会
"测试一套、真实一套":

- **改 `controllers.ts` 的动画帧循环(≈1090-1303)或 `onActivityChange`,
  同一次 commit 必须对照 `performance-pipeline-harness.ts` 的接线**,行为参数
  (优先级/通道/时长源/释放顺序)变了就同步改 harness 并跑场景库;
- 共享逻辑一律抽成生产模块让两边 import(如
  `performance/activity-entries.ts` 的 `enterThinking`),**禁止复制**;
- 已知真实案例:`releaseState` 只收裸 turnId(MotionArbiter 自己加 `state:`
  前缀),harness 曾传带前缀的 owner 导致"转换释放状态动作"静默空转——
  场景照绿,模拟行为已偏离生产。审查接线时重点核对前缀/单位/索引这类
  约定边界。
