# Aurora Architecture — Runtime V3

> 本文描述当前代码树的架构边界。代码、配置和测试是最终事实来源；本文不绑定某个 Git 分支或某个日期。

## 1. 总体分层

```text
soulctl.cmd
  -> scripts/soulctl.cjs
  -> app.lifecycle / Lifecycle Supervisor
  -> config/services.json
  -> ASR / LLM / TTS / GSVI / Bridge / frontend

用户文本或语音
  -> Bridge / CLI
  -> CharacterRuntime.handle_turn(TurnInput)
  -> Runtime V3 事件
  -> /client-ws
  -> React/Electron 表现层
  -> Live2DModelAdapter -> Cubism SDK
```

系统分为五个需要保持清晰边界的部分：

1. **生命周期层**：负责进程、依赖、端口选择、就绪和关闭，不负责角色决策。
2. **Runtime 层**：负责一次回合的语义流程、记忆、工具、语音和表现意图，不负责 Cubism 参数。
3. **Transport 层**：负责 V3 envelope、序列、会话和 WebSocket 事件，不负责业务状态拼装。
4. **Frontend/Live2D 层**：负责模型能力、参数混合、动作仲裁和渲染，不让各个输入源直接写模型。
5. **Stage/壁纸层**：负责壁纸渲染（静态图/视频/着色器场景）与主题化界面皮肤，是视觉外壳，不参与角色决策与表现仲裁。

## 2. 生命周期与服务

`soulctl.cmd` 只是 Windows 入口，实际命令分发在 `scripts/soulctl.cjs`。启动器把命令转换为 Lifecycle Supervisor 的 profile，并通过 `app.lifecycle.client` 与 Supervisor 通信。

`config/services.json` 是已提交的生命周期来源，包含服务命令、健康检查、依赖、首选端口、备用端口和 profile。当前服务关系如下：

```text
GSVI (optional/isolate)
  -> TTS warmup
  -> ASR preload
  -> Bridge
  -> frontend (full profile)

LLM -> Bridge
```

首选端口为：

| 服务 | 端口 |
| --- | ---: |
| ASR | 19201 |
| LLM | 19202 |
| TTS | 19203 |
| GSVI | 19205 |
| Bridge | 19206 |
| Vite frontend | 5173 |

端口被占用时，Supervisor 按清单选择备用端口或系统动态端口，并把实际端点注入后续服务。任何新增服务或端口都应先进入 `config/services.json`，而不是散落在 Python、前端或启动脚本中。

完整启动的就绪条件不是“进程存在”或“HTTP 200”，而是依赖服务已经完成对应的模型加载/预热，并由生命周期事件确认可用。关闭时应由 Supervisor 负责停止注册服务和清理运行状态。

## 3. Runtime V3 回合链

所有文本、语音和主动对话都归一为类型化的 `TurnInput`，唯一公开的回合入口是：

```text
CharacterRuntime.handle_turn(TurnInput)
```

回合生命周期可概括为：

```text
TurnInput
  -> CharacterTurn (created -> processing)
  -> ASR
  -> character/context
  -> memory retrieval
  -> decision/tool calls
  -> emotion and performance plan
  -> memory commit
  -> TTS
  -> TransportEmitter
  -> completed | failed
```

`CharacterSelf` 持有角色的持久状态。回合只能读取快照并暂存 `CharacterSelfChange`，持久变化必须通过 `CharacterSelf.commit()` 生效。`PromptCompiler` 只生成脱离运行时的模型请求，不做 I/O，也不修改回合。

`ResponseInterpreter` 将规范化的 `LLMResponse` 转换成回复文本、分段、工具调用和 `PerformancePlan`。表现计划只允许语义字段，例如：

- `emotion`
- `behavior`
- `attention`
- `energy`
- `speaking`
- `duration_ms`
- `context_tags`

后端不得把 Cubism 参数、表达式文件名、动作文件名或模型专属参数塞进 Runtime 表现更新。这样同一套 LLM/Runtime 可以服务不同 Live2D 模型，模型差异留在前端能力配置。

## 3.1 Stage/壁纸层

界面壁纸与主题是独立于 Live2D 表现链的视觉外壳：

- **壁纸三种形态**：静态图、视频（含转码/倍速/遮挡暂停等播放控制）、着色器场景（vendored we-scene 引擎在 `frontend/electron/vendor/we-scene/`，由 `wallpaper-scene-render.cjs` 离屏渲染出帧）。壁纸库与选择器在 `frontend/src/ui/StageBackground.tsx`、`WallpaperLibraryPicker.tsx`，素材在 `backgrounds/`。
- **主题系统**：`frontend/src/core/theme.ts` / `ui-theme.ts` 输出 CSS 变量与 `data-theme`，深色/浅色与强调色可调；壁纸之上的液态玻璃面板按主题令牌取色。
- **边界**：壁纸层只消费主题令牌与自身播放状态，不向 Live2D 控制链、Runtime 或 Transport 写任何状态。

## 4. Transport 与协议边界

`contracts/v3/envelope.py`、`contracts/v3/events.py` 和 `contracts/v3/registry.py` 是服务端 V3 协议来源。`app/bridge/server.py` 的 `/client-ws` 是客户端 WebSocket 主入口。

`WebSocketSession` 负责校验：

- V3 envelope 和协议版本
- session identity
- `eventId`
- 连续的 inbound sequence

通过校验的事件由 `RuntimeEventHandler` 映射到 `CharacterRuntime.handle_turn()`。`TransportEmitter` 是回合到领域事件的唯一正常发射器；连接级 writer 才能创建出站 `eventId`、`sessionId`、sequence、时间戳并执行序列化。

典型事件顺序：

```text
user.text | user.audio.* | user.visual (inbound)
  -> turn.started
  -> asr.started / asr.result (optional)
  -> tool.started / tool.result | tool.failed (optional)
  -> assistant.text.started / assistant.text.completed
  -> tts.started / tts.audio / tts.completed | tts.failed (optional)
  -> character.intent
  -> turn.completed
  -> runtime.status(idle)
```

失败回合以 `turn.failed` 结束并恢复 `runtime.status(idle)`。`character.intent` 是渲染器无关的语义事件；明确的用户 Avatar 管理消息属于另一条受权限控制的通道，不应伪装成 Runtime 决策。入站视觉回合 `user.visual` 携带图片附件（摄像头采样帧、截图或用户手动发送的图片），与文本/语音回合走同一条 `handle_turn` 链路。

## 5. Live2D 表现控制链

前端将 Runtime 的语义意图与鼠标跟踪、口型、眨眼、呼吸、自然动作和模型专属动作协调起来：

```text
character.intent / user input / audio
  -> CharacterBehaviorResolver
  -> CharacterPerformancePolicy
  -> PerformanceCoordinator
  -> MotionArbiter
  -> ParameterMixer
  -> Live2DModelAdapter
  -> Cubism SDK
```

控制原则：

- 模型参数只有一个最终写入路径，禁止自然动作、鼠标跟踪、LLM、口型等模块绕过 `ParameterMixer` 直接写 Cubism。
- 每个模型先通过能力配置筛选实际支持的参数和动作，再生成表现计划。
- 表情、动作、口型和身体微动是不同通道，需在仲裁和参数级混合处协调，不能简单地让后到事件覆盖前一个事件。
- 追踪输入要经过统一的时间采样和响应策略，避免自然动作与鼠标目标互相拉扯产生抽动。
- `runtime snapshot`、实时表现监控和模型参数目录用于验证控制链是否真的生效；构建通过不代表动作自然。

Live2D 资源和角色引用关系：

```text
config/characters/<id>/character.json
  -> models/live2d-models/<model_id>/
  -> config/avatar_profiles/<model_id>.json (if present)
  -> frontend Live2D adapter / Cubism model
```

角色卡只引用系统资源。模型注册会维护模型侧注册表和能力配置；不同模型的参数名、动作和表情不能假定完全相同。

## 6. 记忆、历史与主动对话

SQLite 是当前对话记忆的持久存储。V3 的记忆提交使用 `turn_id`、`write_token` 和 `history_uid` 等唯一信息，重复提交应幂等，不得重复插入对话。

旧历史 JSON 目录只作为读取/回退来源，Runtime 不再把新对话追加到 JSON；轻量索引只服务于历史列表元数据。

主动对话生产者只产生 `InitiativeCandidate`，由 `CharacterRuntime` 统一排队、去重、过期清理和选择。主动回合最终仍转换成普通 `TurnInput(origin=initiative)`，沿用同一套决策、记忆、TTS、传输和表现路径；主动对话不得中断正在进行的用户回合或语音回合。

## 7. 前端与开发入口

- `frontend/src/`：React 页面、Bridge 客户端、Live2D 控制器、壁纸/主题与运行时监控。
- `frontend/electron/`：Electron 主进程入口（窗口、桌宠、壁纸离屏渲染）。
- `electron/`：Electron 进程管理器与托盘（被 `frontend/electron/` 引用）。
- `frontend/vite.config.ts`：从服务清单读取端口并设置 API、WebSocket 和模型资源代理。
- `frontend/package.json`：开发、Electron、测试、类型检查、构建和性能检查命令。

常用命令：

```powershell
.\soulctl.cmd doctor
.\soulctl.cmd electron
.\soulctl.cmd electron --hot
python -m pytest -p no:cacheprovider -q
cd frontend
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

实时 Live2D 变更需要在实际模型上做视觉和运行时验收，至少覆盖：自然状态、鼠标追踪、口型、表情切换、LLM 表现意图、动作/身体微动和控制链监控。单元测试、构建和静态截图不能单独证明这些行为已经完成。

## 8. 当前事实来源

| 问题 | 首要来源 |
| --- | --- |
| 服务、端口、依赖、profile | `config/services.json` |
| 启动/停止/诊断 | `scripts/soulctl.cjs`, `app/lifecycle/` |
| 回合语义与状态 | `app/runtime/`, `contracts/v3/` |
| WebSocket 事件 | `app/bridge/server.py`, `contracts/v3/` |
| 前端和 Live2D | `frontend/src/`, `frontend/vite.config.ts` |
| 壁纸/主题 | `frontend/src/ui/StageBackground.tsx`, `frontend/src/core/theme.ts`, `frontend/electron/vendor/we-scene/` |
| 角色/模型能力 | `config/characters/`, `config/avatar_profiles/`, `config/avatar.yaml`, `config/live2d_models.json`, `models/` |
| 可回归行为 | `tests/`, `frontend/src/**/*.test.*` |

带日期的审计、交接和方案文档是历史证据或设计记录，不替代上述来源。文档分类见 [docs/README.md](docs/README.md)。
