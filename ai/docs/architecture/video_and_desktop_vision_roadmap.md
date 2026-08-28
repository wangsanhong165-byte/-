# Aurora 视觉能力拓宽：视频聊天 / 桌面投影调研与设计路线

> 状态：设计草案（research + roadmap）；范围已收敛。
> 范围（已确认）：Aurora 从“单张图片视觉输入”拓宽到 **P1 摄像头实时帧** 与 **P2 桌面/屏幕持续感知**。
> 明确不做：**P3 低延迟实时会话**、**P4 桌面操作闭环**（本轮不立项，仅保留评估记录）。

## 0. 实施状态（P1 + P2）

已完成首版实现并验证（2026-08）。最终交互采用“Settings → Vision 持久化视觉源”方案（非逐轮手动选择）：

- **P1 摄像头帧（语音自动采样 + 手动小窗）**
  - 后端：`/api/visual-attachments` 接受可选 `source`（allowlist：`user_upload/camera/screen_capture/screen_watcher/screen_chat`），`/api/visual-policy` 返回 `cameraSampleIntervalMs`、`cameraMaxFrames`、`screenChatMaxAgeSeconds`（`app/bridge/server.py`、`app/runtime/visual_attachments.py`）。
  - 前端：`cameraSession` 单例共享 MediaStream（隐藏采集 `<video>` + 预览槽），`CameraWindow.tsx` 为固定尺寸、可拖拽、位置记忆（`localStorage`）的悬浮小窗；采样循环在 `DesktopSessionProvider.tsx` 的录音生命周期内运行。
  - 协议：`user.audio.completed` 载荷新增 `attachments: VisualAttachmentPayload[]`，语音回合自动携带摄像头采样帧（`contracts/v3/events.py`、`frontend/src/runtime/event-types.ts`、`client.ts`）。
- **P2 屏幕像素感知（持续截帧 + 问答当前帧）**
  - `ScreenWatcher` 在前台窗口变化时截帧（PIL ImageGrab），节流默认 30s（`SCREEN_CAPTURE_MIN_INTERVAL`），存 `VisualAttachmentStore(source="screen_watcher")`（`app/services/screen_watcher.py`）。
  - `TurnVisualContext.screen_frame()`：文本/语音回合优先复用 `ScreenWatcher.latest_frame`，仅当帧龄 ≤ `SCREEN_CHAT_MAX_AGE_SECONDS`（默认 8s）；否则即时截帧（`source="screen_chat"`）（`app/runtime/visual_context.py`）。
  - `screen_change` 事件携带 `visual_attachment` 描述符 → `runtime._on_initiative` 随 initiative 传递 → `_dispatch_initiative` 解析为 `TurnInput.visual_attachments` 注入主动回合（`app/runtime/runtime.py`）。
  - 记忆与诊断：initiative 视觉回合记录为“Aurora 注意到屏幕变化并附加了 N 帧画面”，飞行记录器增加 `sources`（`app/runtime/steps/memory_save_step.py`、`app/runtime/turn_recorder.py`）。
- **Vision 设置统一收编（持久化，自动生效）**
  - 总开关 `cameraEnabled`、`screenVisionEnabled`；语音源 `voiceCameraEnabled`（默认开）、`voiceScreenEnabled`（默认开）；文本源 `textCameraEnabled`（默认关）、`textScreenEnabled`（默认关）。
  - 管理动作：`set_screen_vision` 与 `set_vision_source(voice_camera|voice_screen|text_camera|text_screen, enabled)`（`app/runtime/management.py`、`app/transport/management.py`），前端连接/启动时同步。
  - 参数热更新：`LLM_CAMERA_SAMPLE_INTERVAL_MS`（默认 2000，500–5000）、`LLM_CAMERA_MAX_FRAMES`（默认 4，1–16）、`SCREEN_CHAT_MAX_AGE_SECONDS`（默认 8）、`SCREEN_CAPTURE_MIN_INTERVAL`（默认 30）（`app/config_manager/env_store.py`、`SettingsPanel.tsx` Vision 卡片）。
  - UI 美化：Vision 设置拆为“能力与开关 / 实时感知 / 传输限制”卡片分组；摄像头小窗有标题栏、关闭按钮、拖拽与位置记忆；摄像头权限/占用失败时在小窗内显示错误并可重试（`CameraWindow.tsx`、`index.css`）。
  - `TurnInput` 允许语音 + 视觉附件同回合（`app/runtime/character_turn.py`），解决语音附带摄像头/屏幕帧时报 “requires exactly one primary payload” 的问题。
- **验证（本沙箱已跑通）**
  - `D:\conda\python.exe -m pytest -p no:cacheprovider --basetemp=.pytest-tmp-v2 -q`：**706 passed, 30 skipped**（需先设置 `$env:TMP`/`$env:TEMP` 为可写目录）。
  - 前端 `tsc --noEmit` 通过、`vite build` 通过；`node --test --experimental-strip-types src/vision/camera.test.ts` **4 passed**。
  - `soulctl.cmd start`：`FULL_READY`，bridge/llm/asr/tts/gsvi 全部 ready。
> 事实来源：代码、协议、配置、测试优先；本文是设计记录，不覆盖当前实现。文档维护规则见 `docs/README.md`。

---

## 1. 背景：Aurora 当前视觉能力

### 1.1 已完成的“图片视觉”链路

- 前端支持 PNG/JPEG/WebP 选择、拖拽、粘贴，上传后再随文本发送：
  - `frontend/src/ui/InputBar.tsx`（文件选择/粘贴/拖拽，`InputBar.tsx:11,72-142,180-205`）
  - `frontend/src/session/DesktopSessionProvider.tsx:371-392`（`sendVisual` 分支）
  - `frontend/src/runtime/client.ts:220-229`（`user.visual` 事件发送）
- 后端临时视觉附件仓库：校验、归一化、TTL、隐私剥离：
  - `app/runtime/visual_attachments.py`（限额 `:24-33,52-80`；保存/解析 `:134-249`；归一化 `:287-318`）
  - `app/bridge/server.py:390-413`（`/api/visual-attachments`、`/api/visual-policy`）
- 协议：`user.visual` 只传附件描述符，不传字节：
  - `contracts/v3/events.py:70-83,329`（`UserVisualPayload`、`VisualAttachmentPayload`）
  - `app/transport/websocket/handler.py:103-124`（校验并解析附件）
- 提示词编译：`app/runtime/prompt_compiler.py:158-206`（`image_url` data URL + VISUAL GROUNDING 约束）
- 模型侧：`app/models/http_adapters.py:157-165,224-239,271-275`（`LLM_ENABLE_VISION`、视觉策略、请求校验）
- 诊断/记忆只存元数据，不存图片字节：`app/runtime/turn_recorder.py:43-76`、`app/memory/store.py:36-48`

### 1.2 已有的“屏幕相关”能力（弱）

- **按需截图工具**：`screen_capture(region=full|active)` → 视觉附件（`app/legacy/tools/builtins/screen.py:15-67`），工具结果注入视觉链路（`app/runtime/tool_coordinator.py:200-249`）。
- **屏幕监视器（元数据级）**：只取前台窗口标题 + 进程名，不抓像素；变化时推送 initiative 队列（`app/services/screen_watcher.py:52-109`；`app/runtime/runtime.py:530-545` 附近）。
- **桌宠/桌面投影形态**：透明置顶、可点选穿透的 Pet 模式已存在（`frontend/electron/main.cjs:85-86,120-130,206-249,474-509`；`frontend/src/session/electron-window-bridge.ts:29-36`）。

### 1.3 缺口

| 能力 | 现状 | 目标 |
|---|---|---|
| 用户上传图片 | ✅ | 保持 |
| 按需截图（一次一张） | ✅ | 保持并增强（区域/缩放） |
| 摄像头实时画面 | ❌ | P1 帧采样（≤1 FPS 级别） |
| 屏幕持续像素感知 | ❌（只有窗口标题） | P2 事件/节流截帧 |
| 低延迟语音+视频会话 | ❌（回合制 WebSocket） | P3（可选评估） |
| 桌面操作闭环 | ❌（没有输入动作） | P4（高风险，需单独决策） |

---

## 2. 外部项目调研：视频聊天 / 桌面投影 AI 是怎么做的

### 2.1 ChatGPT Advanced Voice（摄像头 + 屏幕共享）

- 官方：语音会话中可选开启摄像头或屏幕共享，仅高级语音模式可用；有使用额度限制。
  - https://help.openai.com/articles/8400625-voice-mode-faq
  - https://community.openai.com/t/new-screen-sharing-and-video-camera-features/756423
- 实现要点：把摄像头/屏幕画面 **降级为按帧采样的图片输入**，与实时音频并行喂给多模态模型，支持随时打断（barge-in）。
- 实测局限：对动态画面理解有限、易被画面误导、不能主动“盯住”物体汇报——对 Aurora 的意义是**预期管理**：帧采样≠视频理解。

### 2.2 Gemini Live API（最接近“低成本接入”的现成协议）

官方技术规格（关键事实）：

- 输入：音频（16-bit PCM, 16kHz LE）+ **图像 JPEG ≤ 1 FPS** + 文本；输出：24kHz PCM 音频。
- 协议：有状态 WebSocket（WSS）；支持服务端到服务端 / 客户端到服务端两种接入；支持 barge-in、工具调用、主动音频。
- 视频理解侧：默认 **1 FPS 采样**，低分辨率约 **66 tokens/帧**；Gemini 视频标准分辨率约 768×768。
  - https://ai.google.dev/gemini-api/docs/live-api
  - https://ai.google.dev/gemini-api/docs/video-understanding
- 社区实践：Gemini 2.0 Multimodal Live API 做实时屏幕共享语音助手已有公开教程。
  - https://www.youtube.com/watch?v=GFBa2IdRGLI

设计启示：**“视频”到 LLM 前通常被降成“采样帧图片”**，帧率、分辨率、JPEG 编码、token 预算、语音/画面并行是核心工程点。

### 2.3 Claude Computer Use（桌面“看到-行动-验证”代理环）

- 核心循环：`screenshot` → 模型规划（click/type/zoom 等 17 个成员工具）→ 应用执行 → 返回 `tool_result`（含截图）→ 再规划。
- 关键设计：
  - **batch action**：模型可一次返回多个动作，按序执行，失败后跳过后继动作。
  - **zoom 区域**：小字/密集 UI 用区域截图保持清晰度。
  - **坐标缩放**：高分辨率显示器与模型截图分辨率不一致时做坐标换算。
  - **安全**：截图内容注入攻击的自动分类器、检测到注入时要求用户确认、默认跑在隔离环境。
  - **提示工程**：文本指令放在截图之前能提升点击准确度；鼓励每次动作后截图验证。
  - https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

设计启示：屏幕感知的“操作派”是 `截图 → 动作 → 验证` 闭环；隐私与注入防护不是可选项。

### 2.4 微软 Copilot Vision（桌面/浏览器屏幕共享）

- 桌面：选择要共享的屏幕或应用，最多同时 2 个应用，共享时显示高亮框（用户可见的隐私提示）。
- 移动端：Voice 会话中点“Share screen”即开摄像头。
- Edge：浏览器内语音会话可直接“Share screen”。
  - https://support.microsoft.com/en-us/microsoft-copilot/using-copilot-vision-with-microsoft-copilot
  - https://belitsoft.com/news/microsoft-copilot-vision-launch-12062025

设计启示：屏幕共享需要**明确的选择边界 + 常驻高亮反馈**，而不是“默默录全屏”。

### 2.5 LiveKit Agents / Pipecat（实时媒体基建）

- LiveKit Agents：Agent 作为 WebRTC 房间参与者，**视频、屏幕共享、多参与者、重连、barge-in 是平台原生能力**；适合真·实时媒体会话。
- Pipecat：帧处理器管道（STT→LLM→TTS），传输无关（WebRTC/电话/WebSocket）。
- 对比：Aurora 已有回合制 V3 WebSocket 链路，**先做帧采样不需要引入 LiveKit**；只有要上“实时语音+视频房间”才考虑。
  - https://docs.livekit.io/agents/
  - https://www.forasoft.com/blog/article/pipecat-vs-livekit-agents

### 2.6 screenpipe（本地视觉记忆基建）

- Rust 实现，跨平台**持续录屏 + OCR + 音频**，存 SQLite/FTS5，暴露本地 API 与 MCP，供任意 agent 检索“刚才看过/说过什么”。
- 与 Aurora 的关系：是“屏幕像素 → 可检索记忆”的参考形态；Aurora 已有 SQLite+FTS 记忆层，可借鉴其索引/隐私设计。
  - https://github.com/screenpipe/screenpipe
  - https://screenpipe.com/

### 2.7 Open-LLM-VTuber（与 Aurora 最接近的开源项目）

- 已支持：**摄像头 / 屏幕录制 / 截图** 三种视觉感知 + Live2D 形象 + 本地优先 + 透明置顶点击穿透桌宠模式 + MCP。
- 与 Aurora 几乎同产品形态，是“同赛道先行者”的对照实现。
  - https://github.com/Open-LLM-VTuber/Open-LLM-VTuber

### 2.8 共性结论

1. **视频输入普遍被降级为采样帧图片**（≤1 FPS、JPEG、降分辨率、token 预算控制）；真正的视频流只在 WebRTC 媒体层传输。
2. **语音与画面并行**，支持 barge-in，而不是“录一段再处理”。
3. **屏幕感知两派**：闲聊/上下文派（Copilot Vision、Gemini Live：事件/按需采样）与操作派（Computer Use：截图→动作→验证）。
4. **隐私/安全是硬约束**：本地优先、像素尽量不持久、用户可见的共享高亮、对屏幕内容注入攻击设防。

---

## 3. 设计目标与原则

### 3.1 目标

- **G1**：让 Aurora 能“看”摄像头实时画面（帧采样，走现有 V3 回合）。
- **G2**：让 Aurora 能“持续感知”桌面像素（事件/节流截帧，喂给主动回合与用户问答）。
- **G3（可选）**：评估并原型低延迟语音+视频会话（Gemini Live / LiveKit）。
- **G4（远期/高风险）**：桌面操作闭环（Computer Use 风格），需单独立项。

### 3.2 非目标（不做）

- 不把完整视频流塞进 LLM 请求（token/延迟不可接受）。
- 不持久保存摄像头/屏幕像素到记忆库（除非未来按 screenpipe 模式另立可检索索引并做密钥/同意管理）。
- P3 低延迟实时会话：本轮不实现（帧采样回合制已满足当前需求）。
- P4 桌面操作闭环：本轮不立项；保持只读视觉感知，不做点击/输入等桌面自动化。

### 3.3 对齐 Aurora 架构原则

- **语义化下游**：Runtime 只产生语义表现意图，视觉输入也必须保持“渲染无关、provider 无关”。
- **统一入口**：所有回合归一为 `CharacterRuntime.handle_turn(TurnInput)`；摄像头/屏幕帧最终都变成 `TurnInput.visual_attachments`。
- **隐私管道**：字节只存在 `VisualAttachmentStore` 短暂 TTL；历史/诊断只存元数据。
- **策略先行**：新输入源同样受 `LLM_ENABLE_VISION` 与 `get_visual_limits()` 约束。

---

## 4. 分阶段设计

### P1 摄像头实时帧（推荐先做）

#### 4.1 交互设计

- 聊天栏新增“摄像头”按钮（类似麦克风）；点击后出现预览小窗 + “发送一帧 / 按住说话期间自动采样 N 帧”。
- 用户显式开启摄像头；开启期间前端显示常驻红点/边框（隐私反馈）。
- 首版简化：**用户点“拍一张/发送当前画面”**，采样一帧 JPEG → 走现有 `user.visual`；后续再叠加“语音会话中自动随帧”。

#### 4.2 技术改动

| 层 | 改动 | 复用/新增 |
|---|---|---|
| 前端采集 | `navigator.mediaDevices.getUserMedia({ video: true })` → canvas 采样 → `canvas.toBlob('image/jpeg')` | 新增 `frontend/src/vision/camera.ts`（预览/采样/清理） |
| 前端 UI | `InputBar` 增加摄像头按钮与预览浮层 | `InputBar.tsx` 扩展 |
| 前端协议 | `sendVisual(text, attachments)` 已兼容；附件描述符新增可选 `source: 'camera'` | `client.ts` 不变或微调 |
| 后端 store | `VisualAttachmentStore.save_bytes(..., source="camera")` 已支持自定义 source | `visual_attachments.py` 无需大改；`SUPPORTED_MIME_TYPES` 已含 JPEG |
| 协议 | `VisualAttachmentPayload` 增加可选 `source` 字段（向后兼容） | `contracts/v3/events.py:70-83`；镜像 `frontend/src/runtime/event-types.ts:78-87` |
| 策略 | 摄像头帧直接复用 `LLM_VISUAL_MAX_*`；新增 `LLM_CAMERA_SAMPLE_MS`/`LLM_CAMERA_EDGE` 默认值（可选） | `visual_attachments.py` 或 bot 常量 |
| Settings | Vision 页增加“摄像头输入”开关与每秒帧上限说明 | `frontend/src/ui/SettingsPanel.tsx` VisionTab |

#### 4.3 测试

- 前端：摄像头 mock（`getUserMedia` stub）→ 采样 Blob → 上传 → `sendVisual` 事件载荷断言；权限拒绝/设备缺失回退。
- 后端：`source="camera"` 附件保存/解析；与 `user_upload` 同等校验；`VisualAttachmentPayload` 可选 `source` 的协议测试（`tests/test_v3_event_registry.py` 扩展）。
- 视觉链路：`pytest` 现有 `tests/test_visual_input.py` 扩展覆盖摄像头帧。

### P2 屏幕持续像素感知

#### 5.1 交互设计

- 复用/升级 `ScreenWatcher`：前台窗口**变化时**截一帧（而不是每 5 秒）→ 节流（如最短 30s）→ 存 `VisualAttachmentStore` → 作为**主动回合的可选视觉上下文**注入。
- 用户提问“我现在屏幕上是什么”时：优先使用最近帧，无则即时 `screen_capture`（保留现有工具）。
- Settings 增加“屏幕感知”开关、节流间隔、是否允许它参与主动对话；`SCREEN_ENABLED` 继续作为总闸。

#### 5.2 技术改动

| 层 | 改动 | 复用/新增 |
|---|---|---|
| 采集 | `screen_watcher.py` 的 `capture()` 在 `changed` 时额外 `ImageGrab.grab()` → `visual_attachments.save_bytes(source="screen_watcher")` | 复用 `screen.py` 的 PIL 路径与 store |
| 事件 | InitiativeEvent 携带 `visual_attachment_id`（+ `mimeType/width/height/sizeBytes` 元数据） | `app/core/initiative_queue.py`、`app/core/intent.py` 扩展 |
| 主动回合 | `runtime.py._dispatch_initiative` 把最近一帧放进 `TurnInput(visual_attachments=...)`；受策略/预算限制 | `app/runtime/runtime.py:492-528` 附近 |
| 预算 | 主动回合带图时遵守 `get_visual_limits()`；新增“每主动回合最多 N 帧（默认 1）” | `app/runtime/context_budget.py` 已有计数 |
| 隐私 | 帧 TTL 沿用 30 分钟；不做历史持久化；屏幕感知开关关闭时清空当前帧 | `visual_attachments.py` TTL/cleanup 已有 |
| 诊断 | turn visual 诊断增加 `source="screen_watcher"` 计数 | `turn_recorder.py` 投影字段扩展 |

#### 5.3 测试

- `screen_watcher` 单元测试：窗口变化触发截帧、节流内不重复截、`SCREEN_ENABLED=0` 不截。
- initiative 回合测试：带帧的 `TurnInput` 编译出 `image_url`，且字节不进历史。
- 回归：现有截图像素上限/隐私剥离测试保持绿。

### P3 低延迟实时会话（已决定：本轮不实现）

> 范围决定：**不做**。P1/P2 的“问一句看一帧 + 帧采样”回合制已接近当前产品需求；只有未来需要“边说边看 + 打断式连续对话”时才重新启动评估。

- 两条路的预留记录：
  - **Gemini Live API**：Aurora 后端作为 server-to-server WSS 客户端，前端把音频+帧经现有 WS 转发；需要新 provider（`app/providers/llm/`），但 **Transport/Runtime 回合模型保持 V3 语义不冲突**。
  - **LiveKit Agents**：Agent 作为房间参与者，适合未来多人/屏幕分享/推流；引入外部服务（可自托管），改动大。
- 重启门槛：是否必须做到“边说边看 + 打断式连续对话”；如果只是“问一句看一帧”，P1/P2 已够。

### P4 桌面操作闭环（已决定：本轮不立项）

> 范围决定：**不做**。保持只读视觉感知，不做点击/输入等桌面自动化。

- 前置条件（未来若立项）：P2 的帧感知稳定、风险面小；新增 `computer` 工具集（点击/输入/滚轮/缩放），全部 **confirm 门**，默认不自动执行。
- 参考 Computer Use 的 batch action、坐标缩放、每次动作后截图验证、注入检测。
- 首版若立项，建议只做“读屏幕 + 建议下一步”的只读模式，不做写操作。

---

## 6. 变更面清单（按阶段）

> 动代码前必须按 AGENTS.md 重新核对并列出 文件/行/连带调用方/连带测试，经确认后再动手。

### P1 变更面（预估）

- 前端：`frontend/src/vision/camera.ts`（新增）、`frontend/src/ui/InputBar.tsx`、`frontend/src/runtime/event-types.ts`
- 协议：`contracts/v3/events.py`（`VisualAttachmentPayload.source`）
- 后端：`app/runtime/visual_attachments.py`（如加摄像头专属边界）、`app/bridge/server.py`（如需策略字段）
- Settings：`frontend/src/ui/SettingsPanel.tsx`（VisionTab）
- 测试：`tests/test_visual_input.py`、`tests/test_v3_event_registry.py`、前端 `InputBar` 相关单测
- 调用方：`DesktopSessionProvider.tsx`（`onSend` 不变，UI 触发变）
- 文档：`docs/runtime/V3_PROTOCOL.md`（`user.visual` 加 `source` 说明）、根 README 视觉段落

### P2 变更面（预估）

- `app/services/screen_watcher.py`、`app/core/initiative_queue.py`、`app/core/intent.py`、`app/runtime/runtime.py`
- `app/runtime/tool_coordinator.py` 或 `screen.py`（共用采集函数）、`app/runtime/turn_recorder.py`
- `frontend/src/ui/SettingsPanel.tsx`（General/Proactive 或 Vision）
- 测试：`screen_watcher` 单测、initiative 回合测试、`test_visual_input.py` 扩展
- 文档：`docs/runtime/LAUNCH_ARCHITECTURE.md`、ARCHITECTURE.md（屏幕感知段落）、README

### P3/P4 变更面（已决定：不纳入本轮，仅保留评估门槛记录）

P3（若未来重启）：新增 provider + 服务配置（`config/services.json` 需登记端口/依赖）+ transport 评估文档。
P4（若未来立项）：新增 `computer` 工具集 + confirm 门 + 坐标/缩放换算 + 注入检测，变更面最大，需单独计划。

---

## 7. 待决策问题（P1/P2 开工前确认）

1. P1 首版交互：**手动拍帧**（推荐）还是**按住说话期间自动采样**？
2. P2 屏幕帧是否参与**主动对话**（推荐默认参与但可关），还是只服务用户提问？
3. 视觉模型路线：`opencode` 免费视觉模型优先，还是本地/OpenAI/Gemini 优先生效？
4. 实施顺序：先 P1（前端改动为主）还是先 P2（后端/initiative 改动为主），或同步推进？

---

## 8. 参考来源汇总

- ChatGPT Advanced Voice 官方 FAQ：https://help.openai.com/articles/8400625-voice-mode-faq
- ChatGPT 视频/屏幕共享社区讨论：https://community.openai.com/t/new-screen-sharing-and-video-camera-features/756423
- ChatGPT 实时视频实测分析：https://www.understandingai.org/p/chatgpt-gets-confused-easily-in-advanced
- Gemini Live API：https://ai.google.dev/gemini-api/docs/live-api
- Gemini 视频理解（1 FPS / token）：https://ai.google.dev/gemini-api/docs/video-understanding
- 实时屏幕共享助手（Gemini 2.0 Live）教程：https://www.youtube.com/watch?v=GFBa2IdRGLI
- Claude Computer Use：https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Microsoft Copilot Vision：https://support.microsoft.com/en-us/microsoft-copilot/using-copilot-vision-with-microsoft-copilot
- Copilot Vision 产品分析：https://belitsoft.com/news/microsoft-copilot-vision-launch-12062025
- LiveKit Agents：https://docs.livekit.io/agents/
- Pipecat vs LiveKit vs OpenAI：https://www.forasoft.com/blog/article/pipecat-vs-livekit-agents
- screenpipe：https://github.com/screenpipe/screenpipe · https://screenpipe.com/
- Open-LLM-VTuber：https://github.com/Open-LLM-VTuber/Open-LLM-VTuber