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


class TestNewMarkerVocabulary(unittest.TestCase):
    """pout/worried/confused markers and the expanded negation guards."""

    def test_pout_marker(self):
        self.assertEqual(_detect_emotion("哼，不理你了"), "pout")

    def test_worried_marker(self):
        self.assertEqual(_detect_emotion("你没事吧，我很担心你"), "worried")

    def test_confused_marker(self):
        self.assertEqual(_detect_emotion("这个我不明白，搞不懂你在说什么"), "confused")

    def test_negated_worry_is_not_worry(self):
        # "别担心" comforts — the negation prefix demotes the worried marker.
        self.assertNotEqual(_detect_emotion("别担心啦，我没事的"), "worried")

    def test_negated_sad_is_not_sad(self):
        self.assertNotEqual(_detect_emotion("你不要难过了嘛"), "sad")


class TestRecoverSentenceNegationGuard(unittest.TestCase):
    """The JSON-recovery path must not wear a sad face while comforting."""

    def _recover(self, text):
        from app.runtime.response_validator import ResponseValidator
        return ResponseValidator._recover_sentence(text)

    def test_comforting_sad_words_recovers_calm_not_sad(self):
        seg = self._recover("好啦，别难过了，我在呢")
        self.assertEqual(seg["emotion"], "calm")
        self.assertEqual(seg["behavior"], "comfort")

    def test_genuine_sadness_still_recovers_sad(self):
        # "眼泪" escalates to cry (the crying face) — the correct stronger
        # verdict, never the comforting calm the negation guard produces.
        seg = self._recover("我真的好难过，眼泪都出来了")
        self.assertEqual(seg["emotion"], "cry")

    def test_dont_cry_recovers_calm(self):
        seg = self._recover("别哭别哭，没事的")
        self.assertEqual(seg["emotion"], "calm")


class TestMoodTrendHighFrequencyEmotions(unittest.TestCase):
    """The mood table must cover the LLM's high-frequency emotion words.

    Regression lock for the gap where joyful/cheerful/love/playful/pout/shy
    were missing from _EMOTION_TO_MOOD_SHIFT: a stream of those segments
    never moved the long-term mood off neutral.
    """

    def test_joyful_stream_lifts_mood_to_bright(self):
        from app.domain.character.mood import MoodTrend
        mood = MoodTrend()
        for _ in range(8):
            mood.shift_from_emotion("joyful")
        self.assertEqual(mood.current, "bright")

    def test_shirone_prompt_emotions_all_shift_the_mood(self):
        from app.domain.character.mood import MoodTrend
        # Every emotion shirone's prompt actually emits must be non-dead in
        # the mood table (either a shift or an explicit 0.0 entry — the bug
        # was KeyError -> silent decay-only).
        for emotion in ["neutral", "happy", "joyful", "playful", "love",
                        "sad", "angry", "surprised", "shy", "calm", "pout"]:
            mood = MoodTrend()
            mood.shift_from_emotion(emotion)
            # A single call with a nonzero delta must move valence; a zero
            # entry keeps it. Either way the call must not be a silent no-op
            # for a MISSING key (same observable, but the table asserts
            # coverage directly below).
        from app.domain.character.mood import MoodTrend as MT
        for emotion in ["joyful", "cheerful", "laughing", "love", "playful",
                        "shy", "embarrassed", "pout", "sad", "cry", "worried",
                        "calm", "surprised", "angry"]:
            self.assertIn(emotion, MT._EMOTION_TO_MOOD_SHIFT,
                          f"{emotion} missing from mood shift table")

    def test_sad_stream_sinks_mood_to_melancholy(self):
        from app.domain.character.mood import MoodTrend
        mood = MoodTrend()
        for _ in range(8):
            mood.shift_from_emotion("sad")
        self.assertEqual(mood.current, "melancholy")

    def test_neutral_still_decays(self):
        # The original lock (test_memory_role_hardening) must keep holding.
        from app.domain.character.mood import MoodTrend
        mood = MoodTrend()
        for _ in range(4):
            mood.shift_from_emotion("happy")
        positive = mood.to_dict()["valence"]
        for _ in range(10):
            mood.shift_from_emotion("neutral")
        self.assertLess(mood.to_dict()["valence"], positive)


class TestEmotionStateSanitizedWrites(unittest.TestCase):
    """set_intensity/restore are the sanctioned write paths (clamped)."""

    def test_set_intensity_clamps_out_of_range(self):
        from app.domain.character.emotion import EmotionState
        state = EmotionState()
        state.set_intensity(2.5)
        self.assertEqual(state.intensity, 1.0)
        state.set_intensity(-1.0)
        self.assertEqual(state.intensity, 0.0)

    def test_restore_clamps_valence_and_capitalizes_history(self):
        from app.domain.character.mood import MoodTrend
        mood = MoodTrend()
        mood.restore(valence=7.0, history=[{"mood": "bright"}] * 40)
        self.assertEqual(mood.current, "bright")
        self.assertLessEqual(mood.to_dict()["valence"], 1.0)
        self.assertLessEqual(len(mood.to_dict()["history"]), 20)
