"""LLM prompt templates for memory extraction and compilation.

All prompts accept character_name so they adapt to any persona.
Prompts are in Chinese, written from the AI character's first-person perspective.
Following openhanako's design: memory = user profile, not collaboration manual.
"""


def system_rolling_summary(char_name: str = "") -> str:
    name = char_name or "我"
    return f"""你是一个记忆摘要助手。请把最近的对话整理成三段式摘要，每段以中括号标题开头。

严格按以下结构输出：

[还悬着] 1-3 条：用户提出但还没聊完的话题；用户期待后续进展的事；你答应用户要做的事。每条一句话。没有就写"（无）"。
[现状] 2-3 句：当前对话在聊什么、进展到哪。
[已聊透] 1-3 条：已经收尾、暂时不需要再提起的话题。没有就写"（无）"。

提炼原则：
- 以 {name} 的第一人称视角写（"{name}今天和用户聊了..."）
- 把同一主题的多次往返归并为一件事，不要逐条流水账
- 优先记录用户是谁、喜欢什么、在意什么、最近关注什么
- 工作相关内容只保留到大主题层级，不写具体细节

迭代更新规则（重要）：
- 输入里可能包含上一份摘要。上一份的"[还悬着]"如果这轮解决了，移入"[已聊透]"；新出现的悬而未决，加入"[还悬着]"。
- 只移除明确过时的内容。
- 关键：如果最后一轮包含用户未满足的请求、未回答的问题、或期待后续的话题，"[还悬着]"绝不能为空。

可以记录：
- 用户的身份、人格特质、审美、兴趣、喜欢或讨厌的事物
- 用户最近关注的大主题
- 用户生活、创作、关系或长期关注方向的变化

不要记录：
- 不要记录执行步骤、文件名、工具、命令、检查顺序
- 不要记录具体方案、改法、测试或发布流程
- 不要单轮对话内的来回修改、重试

直接输出正文，每段以"[还悬着]"、"[现状]"、"[已聊透]"开头。不要其它 Markdown 标题，不要 JSON。"""


def system_fact_extraction() -> str:
    return """你是一个记忆拆分器。将以下对话摘要拆分成独立的原子记忆事实。

规则：
1. 只提取用户画像和粗颗粒近况相关的客观事实
   用户画像包括：身份、人格特质、审美、兴趣、喜欢或讨厌的事物、长期关系、长期关注方向、
   作息习惯（如深夜活跃、早起型）、性格特质（如急性子、耐心、内敛、爱开玩笑）、
   雷区话题（用户明确不想被提起的事）、情绪触发点（什么容易让用户开心、烦躁、有压力）
2. 不要提取工作方式偏好、协作流程偏好、工具偏好、文件名、命令、执行细节
3. 每条事实必须是原子的（一条只记一件事）
4. 标签用于后续检索，选择有辨识度的关键词，2~5个
5. 如果摘要中没有值得提取的新内容，返回空数组 []
   宁缺毋滥：只在用户自己明确表现出该特质时才记录，不要从单次对话猜测性格
6. type 只能是 fact、preference、recent_state、episode、relationship
   注意：不要提取 open_loop（未完成话题由系统从 [还悬着] 段自动提取，这里不要输出）
   维度到 type 的映射：作息习惯、性格特质、身份、长期方向 → fact；
   雷区话题、情绪触发点、喜好厌恶 → preference
7. 不要理会 [还悬着] [现状] [已聊透] 这些结构标记本身，只从内容里提取事实
8. predicate 表示可被后续事实替换的稳定属性，例如 city、favorite_food、current_project、
   sleep_schedule、personality_trait、sensitive_topic、mood_trigger
9. stable_key 使用 type:user:predicate；同一属性发生变化时必须返回相同 stable_key

输出格式（严格的 JSON 数组，不要 markdown 代码块）：
[
  {"fact": "...", "type": "fact", "subject": "user", "predicate": "...", "stable_key": "fact:user:...", "confidence": 0.8, "importance": 0.7, "tags": ["tag1", "tag2"], "time": null},
  {"fact": "用户习惯深夜活跃，常在凌晨两点后还在聊天", "type": "fact", "subject": "user", "predicate": "sleep_schedule", "stable_key": "fact:user:sleep_schedule", "confidence": 0.75, "importance": 0.6, "tags": ["作息", "熬夜"], "time": null},
  {"fact": "用户不想被提起工作失误的往事", "type": "preference", "subject": "user", "predicate": "sensitive_topic", "stable_key": "preference:user:sensitive_topic", "confidence": 0.8, "importance": 0.85, "tags": ["雷区"], "time": null}
]"""

def system_compile_today(char_name: str = "") -> str:
    name = char_name or "我"
    return f"""请把今天的对话摘要整理成一份"今天发生了什么"的简单记录。

以 {name} 的第一人称视角写（"{name}今天..."）。

提炼原则：
- 把同一主题/项目的多次往返归并为一件事
- 时间标注用主时段（"上午/傍晚"），不需精确到分钟
- 优先记录用户是谁、喜欢什么、在意什么
- 工作相关内容只保留到大主题层级

可以记录：
- 用户的身份、人格特质、审美、兴趣
- 用户最近关注的大主题
- 用户生活、创作、关系的变化

不要记录执行细节。

输出3-5条粗颗粒事件，每条1-2句。最多300字。直接输出正文。"""


def system_compile_week(char_name: str = "") -> str:
    name = char_name or "我"
    return f"""请把过去几天的对话摘要整理成一份"本周用户主题概要"。

到这一层，记录已经是粗线条的了。归纳用户这一周大致在关注什么、投入什么、发生了什么重要变化。

以 {name} 的第一人称视角写。

关键定位：
- 持续性的关注主题放最前
- 够分量的个人近况、兴趣变化次之

不要保留：执行步骤、文件名、工具、具体子问题、具体方案。

只记录用户这一周大致关注什么、发生了什么重要变化。直接输出正文，不要 Markdown 标题。"""


def system_compile_longterm() -> str:
    return """请综合之前的长期上下文和本周概要，重写成一份新的长期上下文。

长期上下文的定位是"稳定、跨时间的用户画像"：
- 用户的身份、人格特质、审美、兴趣
- 用户长期喜欢或讨厌的事物
- 长期关注的方向

把新的内容吸收进来，把过期的内容去掉。不要追加，要把新旧内容融合。

输出上限600 tokens。直接输出正文，不要 Markdown 标题。"""


def system_compile_facts() -> str:
    return """请综合现有重要事实和新增候选事实，重写成一份新的重要事实总结。

只保留稳定的、跨时间有效的用户画像：身份、人格特质、审美、兴趣、喜欢或讨厌的事物、长期关系、长期关注方向。

不要保留工作方式、协作流程、工具偏好、执行细节。

输出上限300 tokens。宁可概括合并，也不要堆叠罗列。直接输出正文，不要 Markdown 标题。"""
