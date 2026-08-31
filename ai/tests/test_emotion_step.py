"""EmotionStep — negation-aware fallback and LLM-result preservation."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.steps.emotion_step import EmotionStep, _detect_emotion


def _ctx(reply_text: str = "", user_text: str = "", segments=None, emotion="neutral") -> CharacterTurn:
    ctx = CharacterTurn(input=TurnInput(text=user_text or "（fallback 回合）"))
    ctx.reply_text = reply_text
    ctx.segments = segments if segments is not None else []
    ctx.emotion = emotion
    return ctx


class TestDetectEmotion(unittest.TestCase):
    """The keyword fallback itself."""

    def test_plain_anger_marker(self):
        self.assertEqual(_detect_emotion("哼，真是太让人生气了"), "angry")

    def test_negated_anger_is_not_anger(self):
        # The reported production bug: "你不要生气了" produced an angry face.
        self.assertEqual(_detect_emotion("好啦好啦，你不要生气了嘛"), "neutral")

    def test_negated_anger_falls_to_other_present_emotion(self):
        # Negated anger + positive token → the positive token wins.
        self.assertEqual(_detect_emotion("别生气了，今天有你在我真的很开心"), "happy")

    def test_negated_english(self):
        self.assertEqual(_detect_emotion("don't be mad at me"), "neutral")

    def test_plain_positive(self):
        self.assertEqual(_detect_emotion("太好了，我等这句话好久啦"), "happy")

    def test_negated_graded_positive(self):
        # 度量副词缓冲：不/没 + (是/有) + 很/太 … + 正向词 → 不判正向
        self.assertEqual(_detect_emotion("我不是很喜欢那个"), "neutral")
        self.assertEqual(_detect_emotion("我不太喜欢那个"), "neutral")
        self.assertEqual(_detect_emotion("我没有很开心"), "neutral")

    def test_no_keyword_is_neutral(self):
        # 寒暄含正向词（"天气不错"）判 happy 是词表设计的预期行为；
        # 中性句预期指完全不含词表标记的句子。
        self.assertEqual(_detect_emotion("现在时间是下午三点"), "neutral")

    def test_wow_standalone_no_longer_triggers(self):
        # "oh" was removed from surprised markers: it fires on nearly every
        # English sentence ("oh i see", "cool oh", ...) and shadowed real moods.
        self.assertEqual(_detect_emotion("oh, that's nice"), "happy")

    def test_genuine_surprise_still_triggers(self):
        self.assertEqual(_detect_emotion("真的吗？竟然是这样！"), "surprised")


class TestEmotionStepPriority(unittest.IsolatedAsyncioTestCase):
    """The step must never override an LLM-provided verdict."""

    async def test_segments_present_short_circuits(self):
        ctx = _ctx(reply_text="你不要生气了嘛", segments=[{"text": "x", "emotion": "calm"}])
        ctx.emotion = "calm"
        before = ctx.emotion
        await EmotionStep().run(ctx)
        self.assertEqual(ctx.emotion, before)

    async def test_upstream_nonneutral_short_circuits(self):
        ctx = _ctx(reply_text="你不要生气了嘛", emotion="sad")
        await EmotionStep().run(ctx)
        self.assertEqual(ctx.emotion, "sad")

    async def test_fallback_runs_when_no_llm_signal(self):
        ctx = _ctx(reply_text="哼，真让人生气")
        await EmotionStep().run(ctx)
        self.assertEqual(ctx.emotion, "angry")

    async def test_negated_reply_leaves_neutral_untouched(self):
        ctx = _ctx(reply_text="好啦，你不要生气了嘛，抱抱")
        await EmotionStep().run(ctx)
        self.assertEqual(ctx.emotion, "neutral")

    async def test_empty_text_noop(self):
        ctx = _ctx()
        await EmotionStep().run(ctx)
        self.assertEqual(ctx.emotion, "neutral")


if __name__ == "__main__":
    unittest.main()
