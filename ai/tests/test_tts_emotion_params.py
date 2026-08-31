"""TTSStep emotion→delivery param mapping (GSVI v2Pro has no emotion field)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.steps.tts_step import (
    TTSStep,
    _apply_emotion_params,
    _DEFAULT_EMOTION_PARAMS,
)


class _CaptureTTS:
    def __init__(self, audio: bytes = b"wav"):
        self.audio = audio
        self.calls: list[tuple[str, dict]] = []

    async def synthesize(self, text: str, **options):
        self.calls.append((text, options))
        return self.audio


def _ctx(reply: str, emotion: str) -> CharacterTurn:
    ctx = CharacterTurn(input=TurnInput(text="你好"))
    ctx.reply_text = reply
    ctx.emotion = emotion
    return ctx


class TestApplyEmotionParams(unittest.TestCase):
    def test_defaults_per_emotion(self):
        kwargs: dict = {}
        _apply_emotion_params(kwargs, None, "angry")
        self.assertEqual(kwargs["temperature"], 0.9)
        self.assertEqual(kwargs["speed_factor"], 1.05)

    def test_neutral_sets_nothing(self):
        kwargs: dict = {}
        _apply_emotion_params(kwargs, None, "neutral")
        self.assertEqual(kwargs, {})

    def test_unknown_emotion_sets_nothing(self):
        kwargs: dict = {}
        _apply_emotion_params(kwargs, None, "dizzy")
        self.assertEqual(kwargs, {})

    def test_card_override_wins_over_defaults(self):
        kwargs: dict = {}
        _apply_emotion_params(kwargs, {"angry": {"temperature": 0.5}}, "angry")
        self.assertEqual(kwargs["temperature"], 0.5)
        self.assertEqual(kwargs["speed_factor"], 1.05)

    def test_explicit_kwargs_never_clobbered(self):
        kwargs: dict = {"speed_factor": 1.2}
        _apply_emotion_params(kwargs, None, "sad")
        self.assertEqual(kwargs["speed_factor"], 1.2)
        self.assertEqual(kwargs["temperature"], 0.3)


class TestTTSStepPassesEmotionParams(unittest.IsolatedAsyncioTestCase):
    async def test_single_clip_carries_emotion_params(self):
        tts = _CaptureTTS()
        ctx = _ctx("哼，生气了！", "angry")
        ctx.character = None  # no card → kwargs from emotion defaults only
        await TTSStep(tts).run(ctx)
        self.assertEqual(len(tts.calls), 1)
        options = tts.calls[0][1]
        self.assertEqual(options["temperature"], 0.9)
        self.assertEqual(options["speed_factor"], 1.05)

    async def test_segmented_clips_each_carry_emotion_params(self):
        tts = _CaptureTTS()
        ctx = _ctx("第一段。第二段。", "sad")
        ctx.character = None
        ctx.segments = [
            {"text": "第一段。", "emotion": "sad"},
            {"text": "第二段。", "emotion": "sad"},
        ]
        await TTSStep(tts).run(ctx)
        self.assertEqual(len(tts.calls), 2)
        for _, options in tts.calls:
            self.assertEqual(options["temperature"], 0.3)
            self.assertEqual(options["speed_factor"], 0.92)

    async def test_segmented_clips_get_per_segment_emotion(self):
        tts = _CaptureTTS()
        ctx = _ctx("哼，谁要谢谢你了。不过这次就原谅你啦。", "pout")
        ctx.character = None
        ctx.segments = [
            {"text": "哼，谁要谢谢你了。", "emotion": "pout"},
            {"text": "不过这次就原谅你啦。", "emotion": "happy"},
        ]
        await TTSStep(tts).run(ctx)
        self.assertEqual(len(tts.calls), 2)
        # Dominant is pout, but the happy closing line must not inherit it.
        self.assertEqual(tts.calls[0][1]["temperature"], 0.75)
        self.assertEqual(tts.calls[1][1]["temperature"], 0.7)
        self.assertEqual(tts.calls[1][1]["speed_factor"], 1.0)

    async def test_all_empty_clips_fall_back_then_surface_failure(self):
        tts = _CaptureTTS(audio=b"")
        ctx = _ctx("第一段。第二段。", "sad")
        ctx.character = None
        ctx.segments = [
            {"text": "第一段。", "emotion": "sad"},
            {"text": "第二段。", "emotion": "sad"},
        ]
        await TTSStep(tts).run(ctx)
        # 2 segment calls + 1 whole-reply fallback attempt = 3, and the silent
        # no-audio outcome must be visible as a tts.failed warning.
        self.assertEqual(len(tts.calls), 3)
        self.assertTrue(any(w.startswith("tts.failed:") for w in ctx.warnings))

    async def test_emotion_neutral_stays_clean(self):
        tts = _CaptureTTS()
        ctx = _ctx("普通陈述。", "neutral")
        ctx.character = None
        await TTSStep(tts).run(ctx)
        options = tts.calls[0][1]
        self.assertNotIn("temperature", options)
        self.assertNotIn("speed_factor", options)


if __name__ == "__main__":
    unittest.main()
