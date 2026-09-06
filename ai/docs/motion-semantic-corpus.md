# 动作语义语料（motion semantic corpus）

第 3 层（经验层）的数据资产。**当前状态：语料先行阶段——未接运行时**，接线条件见下。

## 是什么

`config/motion_semantic_corpus.json`：每条 entry = 情境描述句数组（供 qwen3-emb-0.6B 检索匹配）+ 表演参数（脸参数配方 / 动作预设 / 姿态 / 能量 / 编排弧线注释）。

三层表演系统的定位：
```
第 1 层 动作元库+语法（已落地）：对任何句子生成"正确"的表演基线
第 2 层 双情绪 schema（已落地）：surface + leak + energy
第 3 层 本语料（数据已建，接线后置）：已验收的表演先例 → 检索后在基线上校准出变体与个性
```

## 生产流程（质量闸门）

现场编排循环：用户出题 → 编排（探针面/校准滑条执行）→ 用户过目 → **verified: true 写入**。
未走现场的条目必须标 `verified: false` 并写 `arc` 设计注释，抽查时逐条补验。

## 检索基线（2026-09-05 实测，qwen3-emb-0.6B）

| 探针句 | 期望 | 第一命中 | 前2分差 |
|---|---|---|---|
| 哇，这个真的太棒了，我等了好久！ | excited | playful_tease 0.655（相邻情绪，可由融合层仲裁） | 0.037 |
| 哼，才不是因为你呢 | tsundere | **tsundere_deny 0.633** ✓ | 0.040 |
| 最近感觉什么都提不起劲 | sad | **sad_low 0.624** ✓ | 0.034 |
| 你这样子真的好可爱 | shy | **shy_compliment 0.678** ✓ | 0.134 |

基线远好于残留语料的 0.003 分离度（本语料句子是"表演情境描述"而非宽泛心情分类）。已知局限：相邻情绪（excited/playful）会串，字面陷阱类仍需 leak 字段/融合权重仲裁。

## 接线条件（全部满足才动运行时）

1. 条目 ≥ 40（当前 13）
2. 用 turns.db 真实句子回放测命中率：top-1 正确率 ≥ 70%，且 top-1 属相邻情绪可接受
3. 融合权重按 E2 设计：情绪硬映射 0.55 + 语义检索 0.30 + tags 0.15
4. 消费面只做候选生成+参数校准，裁决权在 policy（红线：60fps 路径无模型）

## schema

```
entries.<label> = {
  sentences: string[≥4]        // 情境描述句，风格多样，供嵌入匹配
  performance: {
    emotion: 情绪标签            // 表面情绪
    leak?: 情绪标签              // 口是心非时的真实情绪（≠emotion）
    energy: 0-1
    face: { Param*: number }    // 脸参数配方（量程见 tests 白名单）
    posture: { 轴: 度数 }        // 校准滑条量程内
    motion: { preset, intensityScale 0.5-1.2 }
    arc: string                 // 编排弧线设计注释
    verified: bool              // 是否现场验收过
  }
}
```

结构校验测试：`tests/test_motion_semantic_corpus.py`（条目数/标签格式/句式唯一性/量程/验收锚点/未验收注释）。
