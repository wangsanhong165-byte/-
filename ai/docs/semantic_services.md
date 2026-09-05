# 语义服务接缝规范（Qwen3-Embedding-0.6B 小脑基础设施）

供各层消费本地嵌入能力的两个管理命令与两份语料。所有服务**只读**、失败开放
（向量通道不可用时返回 `available: false` / `matched: false`，消费方保持现
有行为）。

## 命令一：`semantic_classify`（通用语义排序）

把一组候选文本按与上下文的语义相关度排序。

- 请求：`requestCommand('semantic_classify', { texts: [...], context: '...' })`
- 响应：`{"available": true, "ranking": [{"text": "...", "score": 0.83}, ...]}`
  （score 为与 context 的原始余弦，降序；`available: false` = 向量通道未启用）
- 适用：表演层 E2 动作语料检索、任何"候选 vs 情境"的匹配需求。
- 注意：查询侧已带任务指令；不要自行再包装。

## 命令二：`classify_residue`（对话残留 → 待机画像）

把最近几轮对话与 `config/conversation_residue_prototypes.json` 的情境原型做
最近邻匹配。

- 请求：`requestCommand('classify_residue', { recent_texts: ['最近几轮对话原文', ...] })`
- 响应：`{"matched": true, "label": "playful_residue", "score": 0.71, "idle_profile": {energy, expression_hint, gesture_tendency}}`
  或 `{"matched": false}`（低于置信线 / 语料缺失 / 无最近对话）
- 消费建议（IdleBehaviorScheduler 薄适配器，待表演层 WIP 落地后接线）：
  1. 进入待机时调用一次（非热路径，~100-300ms 无感）；
  2. `matched=true` 时按 `idle_profile` 调整待机姿态基调/活动倾向/表情底色；
  3. `matched=false` 或超时（建议 >500ms 放弃等待）完全回落现有行为；
  4. 原型语料用户可编辑，语料变更后向量缓存自动重算。

## 语料文件

- `config/emotion_prototypes.json`：情绪第二意见（emotion_step 在 LLM 情绪
  缺失时、关键词兜底之前的最近邻匹配；标签对齐 VALID_EMOTIONS）。
- `config/conversation_residue_prototypes.json`：待机情境残留原型。

两份语料编辑保存后向量缓存（`data/memory/*.vectors.json`）按内容 hash 自动
失效重算，无需手动操作。
