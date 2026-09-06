<div align="center">

# Aurora

### 住在你电脑里的本地 AI 陪伴者

**会说话 · 有表情 · 记得你 · 可配置 · 本地优先**

Aurora 是一个面向 Windows 的桌面 AI 陪伴项目。它把实时语音、LLM 对话、Live2D 虚拟形象、持久记忆、角色人格和主动行为放进同一条可观测的运行链路。

<p>
  <a href="ai/">进入项目目录</a> ·
  <a href="ai/README.md">完整运行文档</a> ·
  <a href="README.en.md">English</a>
</p>

</div>

---

## Aurora 是什么

Aurora 不是只返回文字的聊天窗口，也不是把语音、模型和动画简单拼在一起的 Demo。它的目标是让一个 AI 角色同时拥有“理解、表达、记忆和存在感”。

用户可以通过文字或麦克风输入内容。系统完成识别、上下文组装、记忆检索、对话推理、工具调用、角色意图判断和语音合成，再把结果传递给桌面端，让角色以声音、口型、表情和动作回应。

这个仓库适合三类人：想拥有本地桌面 AI 伴侣的用户；想研究语音、记忆和 Live2D 协同的开发者；想在真实运行链路上实验角色人格、主动行为和多模型配置的人。

## 为什么它和普通聊天机器人不同

| 维度 | 普通聊天窗口 | Aurora 的方向 |
|---|---|---|
| 交互 | 以文字消息为中心 | 文字、语音、声音、表情和动作协同响应 |
| 角色 | 通常是无形的对话接口 | 具有 Live2D 形象、声线、人格和状态 |
| 上下文 | 主要依赖当前会话 | 历史、长期记忆、角色状态和关系上下文共同参与 |
| 输出 | 生成一段文本 | 生成可读、可听、可表现的完整角色回应 |
| 运行 | 常见为远程服务 | 本地服务优先，LLM 可配置本地或兼容接口 |
| 生命周期 | 进程能启动即可 | 关注服务依赖、模型预热、就绪等级和完整关闭 |

## 核心能力

### 1. 完整的实时语音链路

语音交互不是一个单独的“录音按钮”，而是一条连续的运行链路：VAD 判断说话边界，ASR 将声音转换为文本，Runtime 组织当前回合，LLM 生成回应，TTS 输出语音，前端再同步播放状态和 Live2D 表现。

```text
麦克风
  ↓
VAD：判断何时开始与结束说话
  ↓
ASR：语音识别
  ↓
Character Runtime：上下文、记忆、人格、工具与回合决策
  ↓
LLM：生成角色回应
  ↓
TTS / GPT-SoVITS：合成角色声音
  ↓
Electron + Live2D：播放、口型同步与表现控制
```

文本模式仍然可用，因此可以在不启动完整语音模型的情况下验证对话、记忆、工具和角色逻辑。

### 2. 有表现力的 Live2D 角色

前端不是只把模型显示在画布上。角色表现链路将语义化的 `character.intent` 转换为可执行的姿态、表情、动作、注视、口型和微动作，再通过统一参数写入路径交给 Cubism 渲染。

```text
CharacterBehaviorResolver
        ↓
CharacterPerformancePolicy
        ↓
PerformanceCoordinator / MotionArbiter
        ↓
ParameterMixer
        ↓
Live2DModelAdapter
        ↓
Cubism Web Framework + WebGL
```

语音播放、情绪变化、用户交互和待机行为可以共享同一套表现协调机制，减少多个控制器互相抢写模型参数的问题。

### 3. 会持续生长的记忆系统

记忆模块不只保存一段聊天记录。它包含历史存储、内容提取、检索、记忆编译、复核和生命周期管理等环节，使用 SQLite 与 FTS5 支持本地检索，并叠加时间语义（时间锚/有效期）与本地小模型驱动的向量通道（Qwen3-Embedding-0.6B 嵌入召回、Qwen3-Reranker-0.6B 交叉编码精排），外加冲突仲裁与每周反思。

记忆可以参与后续回合的上下文组装，让角色不只记住“上一句说了什么”，还可以逐步形成对用户、偏好和关系的连续认识。具体记忆策略以 `ai/app/memory/` 和当前配置为准。

### 4. 角色人格与主动行为

Runtime V3 将一次交互视为结构化回合，而不是简单的“输入字符串 → 输出字符串”。回合链会处理角色自我、上下文预算、意图、工具策略、回应校验、语音路由、表现语义和回合记录。

项目还包含 initiative、initiative memory、scheduler 等模块，为空闲检测、主动关怀和更有连续性的角色行为提供运行基础。主动行为是否启用、何时触发，取决于当前配置和服务状态。

### 5. 多模型、角色和声线组合

模型资源、角色配置和声音资源分开管理。更换角色不需要复制一套后端代码，只需选择模型、声线和人格配置，并由角色目录和头像配置完成组合。

当前仓库中可以看到这些 Live2D 模型资源：

- `Design_genius_White`
- `ariu`
- `hiyori_zh-Hans`
- `mao_zh-Hans`
- `youxiaomiao`
- `shirone`

角色配置包括 `alice` / `jingyu` / `monika`；声音目录中包含 `alims` / `amiya` / `monika` 三个声线包。模型、声线和第三方资源可能具有各自的授权要求，使用或分发前请分别确认许可。

### 6. 可诊断的本地服务生命周期

项目使用 `soulctl.cmd` 作为 Windows 源码环境的正式入口，Python Lifecycle Supervisor 负责服务依赖、启动顺序、readiness、模型预热、端口状态、进程身份、回滚和停止。

这意味着“进程存在”或“HTTP 端口能访问”并不等于服务真的可用。语音模式需要等待相应模型加载和预热完成，桌面端也会根据实际能力状态进入可用界面。

## 服务架构

服务清单的事实来源是 [`ai/config/services.json`](ai/config/services.json)。端口支持动态分配和 fallback，下面的表格描述职责，不把端口号写死在文档中。

| 服务 | 职责 | 依赖 / 特点 |
|---|---|---|
| `llm` | 文本理解与生成 | 支持 OpenAI-compatible 接口；可配置本地或兼容服务 |
| `bridge` | 后端与客户端之间的 HTTP / WebSocket 连接 | 连接 Runtime、Electron 和前端能力 |
| `gsvi` | GPT-SoVITS 语音模型服务 | 负责模型级语音能力；可隔离失败 |
| `tts` | 统一语音合成接口 | 依赖语音模型服务，并支持 warmup |
| `asr` | 语音识别服务 | 在语音链路中负责输入转写 |
| `frontend` | Vite 开发界面 | 由完整开发 profile 启动 |

服务能力按 profile 组合。文本能力和语音能力有不同的就绪要求，Electron 启动器会根据当前 profile 管理对应服务，而不是无条件启动所有进程。

## 一次对话如何完成

```text
1. 用户输入文字，或通过麦克风说话
2. Bridge / CLI 将输入交给 Character Runtime
3. Runtime 读取角色配置、历史、长期记忆和当前状态
4. Context Assembler 生成本回合上下文，并控制上下文预算
5. LLM 生成回应；需要时进入工具确认和工具执行流程
6. Response Interpreter / Validator 解析回应与角色意图
7. TTS 输出声音，TransportEmitter 发布运行事件
8. Electron 前端更新字幕、播放状态、口型、表情和动作
9. Turn Recorder 与 Memory 模块记录本回合，供后续检索
```

V3 协议定义了 envelope、事件和生产链路边界，相关说明见 [`ai/docs/runtime/V3_PROTOCOL.md`](ai/docs/runtime/V3_PROTOCOL.md)。

## 快速开始

### 环境准备

- Windows 10 / 11
- Python 3.10 或更高版本，及项目所需的本地环境
- Node.js 与 npm，用于 Electron / Vite 前端
- 麦克风和音频输出设备（使用语音模式时）
- 对应的 ASR、TTS、Live2D 和 LLM 资源或服务配置

部分大型模型、权重和本地运行数据不适合直接提交到 Git 仓库。请根据 `ai/config/`、项目文档和自己的模型目录准备运行环境。

### 推荐启动方式

```powershell
cd "ai"

# 检查解释器、配置和服务端点
.\soulctl.cmd doctor

# 启动服务并打开 Electron 桌面端
.\soulctl.cmd electron
```

开发调试模式：

```powershell
cd "ai"
.\soulctl.cmd electron --hot
```

只启动后端并输出 Bridge 地址：

```powershell
cd "ai"
.\soulctl.cmd web
```

查看状态、重启和停止：

```powershell
.\soulctl.cmd status
.\soulctl.cmd restart
.\soulctl.cmd stop
```

诊断命令：

```powershell
.\soulctl.cmd diagnostics
```

### 轻量文本模式

当你只想验证文本链路时，可以使用兼容入口：

```powershell
python run.py --text
```

完整命令、启动状态和关闭行为见 [`ai/docs/runtime/LAUNCH_ARCHITECTURE.md`](ai/docs/runtime/LAUNCH_ARCHITECTURE.md)。

## 配置从哪里开始

| 路径 | 作用 |
|---|---|
| `ai/config/services.json` | 服务清单、profile、依赖、readiness 和启动参数 |
| `ai/config/characters/` | 角色卡、人格和角色级配置 |
| `ai/config/avatar_profiles/` | Live2D 模型能力、表现和头像配置 |
| `ai/config/voices/` | 声线资源和声线相关配置 |
| `ai/config/.env` | 本地密钥、服务地址和环境变量；不要提交 |
| `ai/config/runtime.local.json` | 本地运行时覆盖配置；不要提交 |
| `ai/config/mcp_servers.json` | MCP 服务配置（如本地环境启用） |
| `ai/frontend/src/` | React、会话、Live2D 和桌面 UI 实现 |

配置优先级和具体字段以代码与 `services.json` 为准。不要把 API key、模型权重或个人记忆数据库写进公开提交。

## 前端与桌面端

前端使用 React、TypeScript、Vite 和 Electron。`ai/frontend/src/` 按功能拆分为角色、会话、对话、运行时、设置和 UI 模块；Electron 负责桌面窗口、启动就绪、资源选择和客户端桥接。

前端不是服务状态的唯一来源。启动页和 Electron 会读取后端生命周期状态，只有达到对应 readiness 后才进入完整角色界面，这样可以把“窗口打开了”和“语音真的准备好了”区分开。

## 测试与验证

后端测试从 `ai` 目录运行：

```powershell
cd "ai"
python -m pytest -p no:cacheprovider -q
```

前端测试和构建从 `ai/frontend` 目录运行：

```powershell
cd "ai/frontend"
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

涉及 Live2D 的改动不能只凭 TypeScript 编译通过判断完成。应在真实模型、实际语音播放和具体交互场景中检查口型、动作、参数竞争、窗口生命周期和服务关闭结果。

## 目录导航

```text
.
└─ ai/
   ├─ app/
   │  ├─ lifecycle/       Supervisor、健康检查、readiness 与停止
   │  ├─ runtime/         Runtime V3 回合、上下文、意图与工具协调
   │  ├─ memory/          记忆提取、检索、编译、复核与存储
   │  ├─ bridge/           HTTP / WebSocket Bridge
   │  ├─ modules/          ASR、LLM、TTS、MCP 等服务模块
   │  ├─ providers/        外部能力适配器
   │  └─ transport/        事件发布与会话传输
   ├─ config/
   │  ├─ services.json     服务生命周期事实来源
   │  ├─ characters/       Alice、Monika 等角色配置
   │  ├─ avatar_profiles/  Live2D 模型表现配置
   │  └─ voices/           声线配置
   ├─ contracts/v3/        Runtime V3 协议契约
   ├─ frontend/             React、Electron、Live2D 和 UI
   ├─ models/               ASR、TTS、Live2D 等本地资源
   ├─ scripts/              启动器、诊断和开发脚本
   ├─ tests/                Python、生命周期和协议测试
   ├─ docs/                 当前架构、协议、审计与历史资料
   ├─ soulctl.cmd           Windows 统一入口
   ├─ run.py                CLI 兼容入口
   ├─ README.md             项目详细说明
   └─ ARCHITECTURE.md       Runtime V3 架构说明
```

## 文档地图

- [项目目录内的完整说明](ai/README.md)：快速开始、能力概览、技术栈和日常入口
- [架构总览](ai/ARCHITECTURE.md)：分层、生命周期、Runtime V3、Transport、Live2D 和记忆边界
- [启动架构](ai/docs/runtime/LAUNCH_ARCHITECTURE.md)：Supervisor、启动 profile、readiness 和停止链路
- [V3 协议](ai/docs/runtime/V3_PROTOCOL.md)：envelope、事件清单和生产链路
- [文档总览](ai/docs/README.md)：当前资料与历史资料的阅读规则

仓库中的审计、计划和归档文件用于追溯历史，不一定代表当前行为。遇到文档与代码冲突时，优先查看 `services.json`、生命周期实现、Runtime、前端实现和测试。

## 项目状态与边界

Aurora 是一个持续演进中的个人 / 实验性桌面 AI 项目。它的价值在于把多个通常分散的系统连接成一条真实可运行、可诊断、可扩展的角色交互链路，而不是承诺所有机器开箱即用。

不同电脑的 GPU、驱动、Python 环境、模型权重、音频设备和 LLM 服务会影响启动时间与可用能力。大型模型和第三方 Live2D / 声音资源也可能有独立的版权与使用限制。

如果你想快速了解项目，从本页开始；如果你要运行项目，进入 [`ai/`](ai/)；如果你要理解实现边界，阅读 [`ai/ARCHITECTURE.md`](ai/ARCHITECTURE.md)。

<div align="center">

**让 AI 不只回答你，也真正出现在你面前。**

</div>
