"""EmotionStep — analyze reply text and update character emotion."""

import re

from app.runtime.pipeline import Step
from app.runtime.character_turn import CharacterTurn


# Keyword → emotion mapping for lightweight analysis. Only used when the LLM
# produced neither structured segments nor an upstream emotion — never as a
# second opinion over an LLM result.
_POSITIVE_WORDS = {
    "happy", "glad", "great", "love", "wonderful", "amazing", "awesome",
    "nice", "good", "beautiful", "fantastic", "excellent", "joy", "fun",
    "哈哈", "开心", "太棒", "真好", "喜欢", "太好了", "不错",
}

_SAD_WORDS = {
    "sad", "sorry", "miss you", "lonely", "cry", "unfortunate",
    "难过", "伤心", "可惜", "想念", "孤独", "哭",
}

_ANGRY_WORDS = {
    "angry", "mad", "furious", "annoying", "hate", "terrible",
    "生气", "烦", "讨厌", "可恶", "愤怒",
}

_POUT_WORDS = {
    "哼，", "哼！", "哼。", "嘟嘴", "撅嘴", "闹别扭", "不理你",
    "hmph", "pout",
}

_WORRIED_WORDS = {
    "担心", "忧虑", "不安", "没事吧", "还好吗", "怎么办",
    "worried", "anxious",
}

_CONFUSED_WORDS = {
    "疑惑", "不明白", "没明白", "搞不懂", "困惑",
    "confused", "puzzled",
}

_SURPRISED_WORDS = {
    "wow", "really?", "surprising", "unexpected", "incredible",
    "真的吗", "哇", "天哪", "不会吧", "竟然",
}

# A negation immediately before a marker flips its polarity: "你不要生气了"
# is appeasement, not anger. Kept in sync with the stricter scanner in
# response_validator._anger_marker_state (that one also guards the JSON
# recovery path); this copy only guards the last-resort keyword fallback.
# Beyond the validator's token list this also allows the copula 是/有 and a
# degree-adverb buffer (很/太/挺/超/好) between the negation and the marker:
# "我不是很/不太/没有很喜欢" must not read as positive.
_NEGATION_PREFIX = re.compile(
    r"(?:可不能|不能|不要|不用|别再|不要再|不能再|不再|不许|无需|不|别|没)"
    r"(?:有|是|再)?\s*(?:很|太|挺|超|好)?\s*$|"
    r"(?:don't|do not|cannot|can't|shouldn't|should not|not)"
    r"\s*(?:get|be|feel)?\s*(?:so|that|very|too)?\s*$",
    re.IGNORECASE,
)


def _marker_hits(text: str, markers: set[str]) -> list[int]:
    """Positions of markers that are NOT preceded by a negation."""
    hits: list[int] = []
    for marker in markers:
        start = 0
        while True:
            index = text.find(marker, start)
            if index < 0:
                break
            prefix = text[max(0, index - 16):index]
            if not _NEGATION_PREFIX.search(prefix):
                hits.append(index)
            start = index + len(marker)
    return hits


def _detect_emotion(text: str) -> str:
    """Negation-aware keyword fallback. Returns one of VALID_EMOTIONS."""
    lower = text.lower()

    scores = {
        "happy": len(_marker_hits(lower, _POSITIVE_WORDS)),
        "sad": len(_marker_hits(lower, _SAD_WORDS)),
        "angry": len(_marker_hits(lower, _ANGRY_WORDS)),
        "surprised": len(_marker_hits(lower, _SURPRISED_WORDS)),
        "pout": len(_marker_hits(lower, _POUT_WORDS)),
        "worried": len(_marker_hits(lower, _WORRIED_WORDS)),
        "confused": len(_marker_hits(lower, _CONFUSED_WORDS)),
    }

    best = max(scores, key=scores.get)
    if scores[best] > 0:
        return best
    return "neutral"


_ALL_MARKERS = (
    _POSITIVE_WORDS | _SAD_WORDS | _ANGRY_WORDS | _SURPRISED_WORDS
    | _POUT_WORDS | _WORRIED_WORDS | _CONFUSED_WORDS
)


def _has_negated_marker(text: str) -> bool:
    """True when an emotion marker ONLY appears negated in the text
    （如"你不要生气了"）——安抚/复杂语气，原型匹配不可信。"""
    lower = text.lower()
    for marker in _ALL_MARKERS:
        if marker in lower and not _marker_hits(lower, {marker}):
            return True
    return False


class EmotionStep(Step):
    """Analyze reply text and update character emotion state.

    Priority order:
      1. LLM-provided segments (ctx.segments with emotions) — kept as-is.
      2. Upstream emotion from DecisionStep segment extraction — kept as-is.
      3. Negation-aware keyword fallback, ONLY when both are missing.

    The step never overrides a result that came from the LLM: the keyword
    table is a fallback for degenerate turns, not a second opinion.
    """

    async def run(self, ctx: CharacterTurn) -> None:
        # LLM already expressed emotion through structured segments — commit
        # the extracted dominant verdict to character state so EmotionState
        # and MoodTrend keep evolving on normal turns. No intensity ramp: the
        # LLM's intensity already lives in ctx.emotion_intensity, and adding
        # another +0.1 per turn compounded run-away (the old bug).
        if ctx.segments:
            self._commit_llm_emotion(ctx, ctx.emotion)
            return
        if ctx.emotion != "neutral":
            self._commit_llm_emotion(ctx, ctx.emotion)
            return

        text = ctx.reply_text or ctx.user_text or ""
        if not text:
            return

        # 回退链（已定稿）：否定感知关键词扫描是首选兜底——它的否定前缀/
        # 度量副词缓冲是向量空间不具备的能力。小脑③原型匹配仅作**召回增强
        # 器**：关键词判 neutral 时，置信票（rerank 通道开启时为 P(yes)≥0.15
        # 且领先第二名 ≥0.10——按 2026-09-06 校准；通道关闭时退回旧余弦门
        # cos≥0.60/±0.05；文本 ≥6 字；含被否定情绪标记时拒绝）才采纳。
        # LLM 情绪永远优先。
        emotion = _detect_emotion(text)
        if emotion == "neutral" and len(text) >= 6:
            try:
                from app.memory.emotion_prototypes import classify_emotion

                match = classify_emotion(text)
                if match is not None and not _has_negated_marker(text):
                    emotion = match[0]
            except Exception:
                emotion = "neutral"
        if emotion != "neutral":
            self._update_character_emotion(ctx, emotion)

    @staticmethod
    def _commit_llm_emotion(ctx: CharacterTurn, emotion: str) -> None:
        """Persist an LLM-derived emotion verbatim (no intensity ramp)."""
        character = ctx.character
        if character is not None and ctx.character_self is not None:
            ctx.character_self.commit_emotion(emotion, intensity=ctx.emotion_intensity)
            ctx.emotion = character.emotion.current
        # Without a live character there is nothing to persist — ctx.emotion
        # already carries the verdict for downstream consumers.

    @staticmethod
    def _update_character_emotion(ctx: CharacterTurn, emotion: str) -> None:
        """Update character EmotionState and context emotion fields."""
        character = ctx.character
        if character is not None and ctx.character_self is not None:
            intensity = min(1.0, ctx.emotion_intensity + 0.1)
            ctx.character_self.commit_emotion(emotion, intensity=intensity)
            ctx.emotion = character.emotion.current
        else:
            ctx.emotion = emotion

        ctx.emotion_intensity = min(1.0, ctx.emotion_intensity + 0.1)
