# ✨ Aurora — 住在你电脑里的 AI 陪伴者

> **会说话 · 有表情 · 记得你 · 全本地运行**
>
> Aurora 是一个 Windows 本地 AI 语音陪伴系统：用 **Live2D 虚拟形象**与你面对面，用**实时语音**和你交谈，用**持久记忆**记住你们之间的点滴，并会在你空闲时**主动关心你**。

<!--
  徽章占位：仓库创建后可按需替换
  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Windows-0078d6.svg)]()
-->

---

## 🌟 为什么是 Aurora？

| | 优势 | 说明 |
|---|------|------|
| 🎙️ | **实时语音对话** | VAD 说话检测 → ASR 语音识别 → LLM 理解 → GPT-SoVITS 定制声线合成，一条完整语音链路，说一句答一句 |
| 😊 | **会动的 Live2D 形象** | 说话时**口型同步**、情绪驱动**表情变化**、自然微动与安全动作编排，渲染走官方 Cubism 引擎 |
| 🧠 | **持久记忆** | 记得你是谁、聊过什么；SQLite + FTS5 存储，后台自动编译记忆，陪伴越久人格越完整 |
| 🔒 | **本地私有** | 对话与记忆保存在自己的电脑上，默认本地服务；LLM 可配置为本地或任意 OpenAI 兼容服务 |
| 💝 | **主动关怀** | 空闲检测 + 屏幕监控，它不只是等你说——也会主动找你搭话 |
| 👁️ | **看得见** | 可发图片、语音时自动采样摄像头帧（可拖拽浮动窗预览）、屏幕变化或文字/语音回合时让 Aurora 看见桌面画面（需启用视觉模型） |
| 🎭 | **角色自由定制** | 6 款 Live2D 模型 × 多种声线自由组合，角色卡只引用资源、不复制资源，创建新角色只需选模型和声线 |

它不是一个聊天框——它是一个**有形象的、会记住你的、住在你电脑里的 AI 伙伴**。

---

## 🚀 快速开始

环境要求：**Windows 10/11** · Python ≥ 3.10 · Node.js（运行前端时需要）· 麦克风（语音模式需要）

### 推荐方式：`soulctl` 统一入口

```powershell
# 先检查配置、解释器和服务端点
.\soulctl.cmd doctor

# 启动全部服务并打开 Electron 桌面端（生产构建）
.\soulctl.cmd electron

# 启动服务并打开 Electron（Vite 热更新开发模式）
.\soulctl.cmd electron --hot

# 仅启动后端服务并打印 Bridge 地址
.\soulctl.cmd web

# 查看 / 重启 / 停止服务
.\soulctl.cmd status
.\soulctl.cmd restart
.\soulctl.cmd stop
```

### 命令行入口

```powershell
python run.py            # 语音模式
python run.py --text     # 纯文本模式
python run.py --web      # 启动后端 Web/Bridge
```

> 停止时请使用 `soulctl.cmd stop`，Supervisor 会按服务依赖关系有序清理。

---

## 🖼️ 界面预览

<!--
  在这里放置截图（建议 2~3 张：对话界面 / Live2D 形象 / 设置面板）。
  示例：
  <p align="center">
    <img src="docs/screenshots/chat.png" width="45%" />
    <img src="docs/screenshots/live2d.png" width="45%" />
  </p>
-->

*（截图待补充：对话界面 / Live2D 形象 / 记忆面板 / 设置面板）*

---

## 🎭 角色与声线

Live2D 模型资源库与声线包分离，角色 = **模型 + 声线 + 性格提示词** 的任意组合：

| 模型 | 说明 |
|------|------|
| shirone | 当前默认主模型，重点适配表情、嘴部、头身与耳尾身体语言 |
| Design_genius_White / ariu / hiyori / mao / youxiaomiao | 多款风格可选 |

- 声线：`config/voices/` 下的声线包（如 Monika 定制声线，GPT-SoVITS v2Pro）
- 角色卡：`config/characters/<id>/character.json` 是薄声明，**引用**系统级资源而非复制
- 表情映射、动作编排、模型视口均可按角色独立配置

---

## 🏗️ 架构一览

**运行时链路**

```text
用户文本/语音
  → Bridge / CLI
  → CharacterRuntime.handle_turn()   ← 唯一回合入口
  → ASR / 角色上下文 / 记忆 / 决策 / 工具 / 情绪与表现意图
  → TTS
  → TransportEmitter → /client-ws (V3 协议)
  → React/Electron + Live2D 表现层
```

**Live2D 表现控制链**（所有参数写入必须经过统一仲裁，互不抢占）

```text
CharacterBehaviorResolver
  → CharacterPerformancePolicy
  → PerformanceCoordinator / MotionArbiter
  → ParameterMixer
  → Live2DModelAdapter
  → Cubism SDK（官方 CubismWebFramework 5）
```

后端只下发语义化的 `character.intent`，不直接操作 Cubism 参数；模型能力与渲染细节由前端角色配置解析——**角色逻辑与渲染实现彻底解耦**。

---

## 🛠️ 技术栈

| 层 | 技术 |
|------|------|
| 语音识别 | Qwen3-ASR + VAD（语音活动检测） |
| 对话引擎 | OpenAI-compatible LLM（本地或任意兼容服务） |
| 语音合成 | GPT-SoVITS v2Pro（GSVI），支持定制声线 |
| Live2D | 官方 CubismWebFramework-5-r.5（WebGL） |
| 记忆 | SQLite + FTS5，后台编译管线 |
| 前端 | React + Vite + Electron（浏览器 / 桌面双端） |
| 服务编排 | Python Supervisor + `config/services.json` 生命周期 |
| 工具 | MCP 工具系统（搜索、时间等） |

---

## 📁 项目结构

```text
ai/
├─ soulctl.cmd                 # Windows 统一启动/停止入口
├─ scripts/soulctl.cjs         # 启动器与命令分发
├─ run.py                      # CLI 兼容入口
├─ config/services.json        # 服务、端口、依赖与 profile 配置
├─ config/characters/          # 角色卡与角色注册
├─ config/avatar_profiles/     # 模型能力与表现配置
├─ models/live2d-models/       # Live2D 模型资源
├─ app/lifecycle/              # Supervisor、健康检查、生命周期
├─ app/runtime/                # CharacterRuntime 与 Runtime V3 回合链
├─ app/bridge/                 # HTTP/WebSocket Bridge
├─ contracts/v3/               # V3 协议定义
├─ frontend/src/               # React、Live2D 与表现控制器
├─ frontend/electron/          # Electron 主进程
├─ tests/ + frontend/src/**/*.test.*   # Python / 前端测试
└─ docs/                       # 协议、生命周期与架构资料
```

---

## 📚 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — Runtime V3、Bridge、Live2D 与生命周期边界
- [docs/runtime/V3_PROTOCOL.md](docs/runtime/V3_PROTOCOL.md) — V3 事件与 WebSocket 协议
- [docs/runtime/LAUNCH_ARCHITECTURE.md](docs/runtime/LAUNCH_ARCHITECTURE.md) — 启动、就绪与关闭链路
- [docs/README.md](docs/README.md) — 文档总览

---

## 🧪 测试与构建

```powershell
# Python 后端测试
python -m pytest -p no:cacheprovider -q

# 前端类型检查 / 测试 / 构建
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

> Live2D 表现类改动请在真实模型上验证口型、表情、微动与参数仲裁，不能只看构建通过。

---

## 📜 License

MIT
