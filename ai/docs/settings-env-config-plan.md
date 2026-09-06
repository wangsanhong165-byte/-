# Settings 暴露 .env 根本配置 — 方案（已完成，2026-08 实施）

> **状态：已实施**。`app/config_manager/env_store.py`（写回机制）+ `GET/POST /api/config/env`（bridge/server.py 的 `/api/config/env` 路由）+ Settings 面板 General tab 接线均已在代码中。本文保留为设计记录（行号会随代码漂移，按路由名检索）。

> 目标:Settings 面板暴露 `config/.env` 的根本配置(LLM API key/base_url/model 等),无需手动编辑文件。

## 现状

- `config/.env` 持有根本配置:`LLM_ENGINE` / `LLM_BASE_URL` / `LLM_MODEL` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `LLM_TEMPERATURE` / `LLM_REASONING_EFFORT` / `LLM_TIMEOUT_SECONDS`,以及 ASR/TTS/GSVI 相关。**2026-09-06 增补**：记忆侧本地小模型变量同住此域——`MEMORY_EMBEDDINGS` 与 `RERANKER_*`（ENABLED / DEVICE / PREWARM / TOPK / MIN_SCORE / MARGIN / RETRIEVAL / RETRIEVAL_K，生效于 app/memory/reranker.py、store.py、prototypes.py）
- `config_manager/llm.py` 有 LLMConfig schema(engine/deepseek/openai/ollama + base_url/model/api_key/temperature/reasoning_effort/timeout),但**只读**(经 os.environ)
- 前端 `/api/settings`（bridge/server.py 的 `/api/settings` 路由）存的是**运行时 UI 设置**(data/settings.json),不含 .env 根本配置
- **无写回 .env 的机制**

## 方案

### 后端

**1. config_manager 加 .env 读写**
- `app/config_manager/env_store.py`(新):`read_env(keys)` 解析 `config/.env` 返回指定 key;`write_env(updates)` 原子更新指定 key 写回(保留注释与其他行)
- 用 LLMConfig schema 约束:engine/base_url/model/api_key/temperature/reasoning_effort/timeout

**2. bridge 加配置端点**
- `GET /api/config/env` → 返回 `.env` 的根本配置(LLM 全部 + ASR/TTS/GSVI 引擎)
- `POST /api/config/env` → 校验 + 写回 `.env`,返回新值
- api_key 处理:本地桌面应用,返回完整值供编辑(存回原样);前端输入时用 password 类型

### 前端

**3. Settings 面板加「LLM 配置」section**
- 位置:Settings → General tab 底部(Interaction 之后),或独立 section
- 字段:引擎(deepseek/openai/local)、Base URL、Model、API Key(password)、Temperature、Reasoning Effort、Timeout
- 加载 `GET /api/config/env`;保存 `POST /api/config/env`
- 保存后提示「部分配置需重启生效」

### 运行时生效

- `.env` 改动在**下次启动**生效(LLM adapter 启动时读 env)
- 不做热更新(避免运行中切换 API key 的不一致)

## 涉及文件

| 文件 | 改动 |
|---|---|
| `app/config_manager/env_store.py` | 新增:.env 读写 |
| `app/bridge/server.py` | 加 GET/POST `/api/config/env` |
| `frontend/src/core/store.tsx` | AppSettings 或独立 state 加 LLM 配置字段 |
| `frontend/src/ui/SettingsPanel.tsx` | General tab 加「LLM 配置」section |
| `frontend/src/session/DesktopSessionProvider.tsx` | fetch `/api/config/env`(加载/保存) |

## 验证

1. 后端:`GET /api/config/env` 返回 .env 值;`POST` 写回后文件更新
2. 前端:Settings 显示/编辑 LLM 配置,保存成功
3. 前端 157 测试 + TS + 构建
4. 内置浏览器操作验证

## 待确认

1. **暴露范围**:只 LLM,还是连 ASR/TTS/GSVI 引擎/URL 也暴露?("更多更加根本的接口"——建议至少 LLM 全量 + ASR/TTS/GSVI 引擎,URL/key 按需)
2. **api_key 显示**:本地桌面应用返回完整值(可编辑),还是默认掩码、可单独覆盖?
3. **section 位置**:General tab 底部,还是独立 tab?
