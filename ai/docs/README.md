# 文档导航与状态

本目录同时保存当前架构资料和历史审计/交接材料。为了避免把旧结论误当成当前行为，按下面的规则阅读：

## 当前资料

这些文件用于解释当前代码的边界，但遇到冲突时仍以代码、配置和测试为准：

- 根目录 [README.md](../README.md)：安装、启动、端口和日常验证入口。
- 根目录 [ARCHITECTURE.md](../ARCHITECTURE.md)：Runtime V3、生命周期、Transport 和 Live2D 控制边界。
- [architecture/character_personality_presentation_orchestration.md](architecture/character_personality_presentation_orchestration.md)：角色卡、结构化人格、Prompt、动态状态与 Live2D 表现编排的当前权威基线。
- [architecture/video_and_desktop_vision_roadmap.md](architecture/video_and_desktop_vision_roadmap.md)：视觉能力拓宽（摄像头实时帧 / 屏幕持续感知 / 实时会话 / 桌面操作）的外部调研与设计路线；P1/P2 已实施并验证。
- [runtime/V3_PROTOCOL.md](runtime/V3_PROTOCOL.md)：V3 envelope、事件和 WebSocket 协议。
- [runtime/LAUNCH_ARCHITECTURE.md](runtime/LAUNCH_ARCHITECTURE.md)：启动、就绪、停止和 Supervisor 关系。
- `architecture/`、`frontend/`、`runtime/` 下不带日期的说明：模块级设计资料，需结合当前实现阅读。

## 历史资料

以下内容保留用于追溯决策、问题和验证证据，不是当前配置的直接操作手册：

- 带日期的性能审计、Live2D 审计、交接和修复报告。
- `superpowers/plans/`、`superpowers/specs/` 下的计划与规格草案。
- `archive/` 下的归档资料。
- 文件名含 `audit`、`handoff`、`plan`、`report` 或日期的旧记录。

历史文档中的分支名、端口、性能数字、模型状态和“待实施”结论都可能已经失效。需要确认现状时，优先查看：

1. `config/services.json`
2. `scripts/soulctl.cjs` 与 `app/lifecycle/`
3. `app/runtime/`、`app/bridge/`、`contracts/v3/`
4. `frontend/src/` 与 `frontend/vite.config.ts`
5. Python/前端测试和实际运行时监控

## 文档维护规则

- 新增可执行入口、服务或协议时，先更新根目录 README，再更新对应模块文档。
- 审计结论应写明日期、验证范围和“历史快照”属性，不能覆盖当前架构说明。
- 端口、启动命令和服务依赖不在多个文档中各自维护；统一引用 `config/services.json`。
- Live2D 的“自然”“流畅”等表现结论必须附带实际模型、运行场景和监控/视觉证据。
