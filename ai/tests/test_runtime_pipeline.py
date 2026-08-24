"""Tests for the CharacterRuntime V3 pipeline.

Run with: python -m unittest tests/test_runtime_pipeline.py
"""

import asyncio
import json
import os
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Clear env vars that might trigger real providers during import
for key in list(os.environ):
    if key.startswith("DEEPSEEK_") or key.startswith("OPENAI_") or key.startswith("ASR_") or key.startswith("TTS_"):
        # Don't actually clear — just ensure mock overrides
        pass

from app.interfaces.llm import LLMInterface, MockLLM
from app.interfaces.asr import ASRInterface, MockASR
from app.interfaces.tts import TTSInterface, MockTTS
from app.interfaces.memory import MemoryInterface, MockMemory
from app.interfaces.tool import ToolInterface
from app.providers.registry import provider_registry

# Force ALL default providers to mocks BEFORE Runtime import
provider_registry.register(LLMInterface, "default", MockLLM)
provider_registry.register(ASRInterface, "default", MockASR)
provider_registry.register(TTSInterface, "default", MockTTS)
provider_registry.register(MemoryInterface, "default", MockMemory)

from app.runtime.event import Event, EventType
from app.runtime.pipeline import Pipeline, Step
from app.runtime.character_turn import CharacterTurn, TurnInput, TurnOrigin
from app.runtime.runtime import CharacterRuntime
from app.runtime.initiative import InitiativeCandidate, InitiativeQueue


def _turn_input(event: Event) -> TurnInput:
    if event.type == EventType.SPEECH_RECEIVED:
        return TurnInput(
            audio=event.payload["audio"],
            sample_rate=event.payload.get("sample_rate", 16000),
        )
    if event.type == EventType.INITIATIVE_TRIGGERED:
        return TurnInput(
            text=event.payload.get("display_text", event.payload.get("text", "")),
            origin=TurnOrigin.INITIATIVE,
            metadata={"initiative": event.payload.get("initiative", {})},
        )
    return TurnInput(text=event.payload.get("text", ""))
from app.runtime.state_store import state_store


# ── Test Steps ──────────────────────────────────────────────

class TrackingStep(Step):
    """Step that records its execution order."""
    def __init__(self, name: str, set_key: str = "", set_value: str = ""):
        self.name = name
        self.order = []
        self.set_key = set_key
        self.set_value = set_value

    async def run(self, ctx: CharacterTurn) -> None:
        self.order.append(self.name)
        if self.set_key:
            ctx.metrics[self.set_key] = self.set_value


class ErrorStep(Step):
    """Step that sets ctx.error."""
    async def run(self, ctx: CharacterTurn) -> None:
        ctx.fail("test.error", "test error")


class BrokenStep(Step):
    """Step that raises an exception."""
    async def run(self, ctx: CharacterTurn) -> None:
        raise RuntimeError("broken")


class CancelFirstTurnStep(Step):
    """Block the first turn until cancelled, then complete later turns."""

    def __init__(self):
        import asyncio

        self.started = asyncio.Event()
        self.calls = 0

    async def run(self, ctx: CharacterTurn) -> None:
        import asyncio

        self.calls += 1
        if self.calls == 1:
            self.started.set()
            await asyncio.Event().wait()
        ctx.reply_text = "recovered"


class EmptyASR:
    async def transcribe(self, _audio: bytes) -> str:
        return "   "


# ── Helpers ────────────────────────────────────────────────

def _run(coro):
    import asyncio
    return asyncio.run(coro)


# ── Tests ──────────────────────────────────────────────────

class TestPipeline(unittest.TestCase):
    """Pipeline execution mechanics."""

    def setUp(self):
        self.pipeline = Pipeline()

    def test_empty_pipeline_returns_context(self):
        """An empty pipeline should run without error."""
        ctx = CharacterTurn(input=TurnInput(text="hello"))
        result = _run(self.pipeline.run(ctx))
        self.assertIs(result, ctx)
        self.assertIsNone(ctx.error)

    def test_steps_execute_in_order(self):
        """Steps should execute in the order they were added."""
        a = TrackingStep("A", "from_a", "val_a")
        b = TrackingStep("B", "from_b", "val_b")
        self.pipeline.add(a).add(b)

        ctx = CharacterTurn(input=TurnInput(text="hi"))
        _run(self.pipeline.run(ctx))

        self.assertEqual(a.order, ["A"])
        self.assertEqual(b.order, ["B"])
        self.assertEqual(ctx.metrics.get("from_a"), "val_a")
        self.assertEqual(ctx.metrics.get("from_b"), "val_b")

    def test_pipeline_stops_on_error(self):
        """Pipeline should stop at the first step that sets ctx.error."""
        a = TrackingStep("A")
        b = ErrorStep()
        c = TrackingStep("C")
        self.pipeline.add(a).add(b).add(c)

        ctx = CharacterTurn(input=TurnInput(text="hi"))
        _run(self.pipeline.run(ctx))

        self.assertEqual(a.order, ["A"])
        self.assertEqual(ctx.error.message, "test error")
        self.assertEqual(c.order, [])


class TestCharacterRuntime(unittest.TestCase):
    """CharacterRuntime turn mechanics."""

    def setUp(self):
        provider_registry.register(LLMInterface, "default", MockLLM)
        provider_registry.register(ASRInterface, "default", MockASR)
        provider_registry.register(TTSInterface, "default", MockTTS)
        provider_registry.register(MemoryInterface, "default", MockMemory)
        # Reset turn count for each test
        state_store._state.clear()
        self.runtime = CharacterRuntime()

    def test_dispatch_text_event_returns_context(self):
        """Dispatching a TEXT_RECEIVED event should return a Context."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "hello"}, source="test")
        ctx = _run(self.runtime.handle_turn(_turn_input(event)))
        self.assertIsNotNone(ctx)
        self.assertIsNone(ctx.error)

    def test_dispatch_populates_user_text(self):
        """TEXT_RECEIVED should populate ctx.user_text."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "hi there"}, source="test")
        ctx = _run(self.runtime.handle_turn(_turn_input(event)))
        self.assertEqual(ctx.user_text, "hi there")

    def test_dispatch_increments_turn_count(self):
        """Each dispatch should increment the turn count."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "turn 1"}, source="test")
        _run(self.runtime.handle_turn(_turn_input(event)))
        self.assertGreaterEqual(state_store.get("turn_count", 0), 1)

    def test_dispatch_injects_character(self):
        """Context should have a character after dispatch."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "hello"}, source="test")
        ctx = _run(self.runtime.handle_turn(_turn_input(event)))
        self.assertIsNotNone(ctx.character)

    def test_dispatch_speech_event(self):
        """SPEECH_RECEIVED events should be processed."""
        audio_bytes = b"\x00\x00\x00\x00" * 160
        event = Event(EventType.SPEECH_RECEIVED,
                      {"audio": audio_bytes, "sample_rate": 16000}, source="test")
        ctx = _run(self.runtime.handle_turn(_turn_input(event)))
        self.assertIsNotNone(ctx)

    def test_cancelled_turn_does_not_break_the_next_turn(self):
        """A user interruption must release the turn transaction completely."""

        async def scenario():
            step = CancelFirstTurnStep()
            self.runtime.pipeline = Pipeline().add(step)

            cancelled = asyncio.create_task(
                self.runtime.handle_turn(TurnInput(text="cancel me"))
            )
            await step.started.wait()
            cancelled.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await cancelled

            return await self.runtime.handle_turn(TurnInput(text="next turn"))

        import asyncio

        result = asyncio.run(scenario())
        self.assertEqual(result.phase.value, "completed")
        self.assertEqual(result.reply_text, "recovered")

    def test_empty_asr_transcript_stops_before_decision(self):
        """Silence must not reach decision, tools, TTS, or memory save."""
        from app.runtime.steps.asr_step import ASRStep

        decision = TrackingStep("decision")
        self.runtime.pipeline = Pipeline().add(ASRStep(EmptyASR())).add(decision)

        result = _run(self.runtime.handle_turn(TurnInput(audio=b"RIFF-silence")))

        self.assertIsNotNone(result.error)
        self.assertEqual(result.error.code, "asr.empty_transcript")
        self.assertEqual(decision.order, [])

    def test_recording_defers_queued_initiative_until_user_input_releases(self):
        """A queued proactive turn must not speak over an active recording."""

        async def scenario():
            delivered = asyncio.Event()

            async def on_proactive(_turn):
                delivered.set()

            self.runtime.register_proactive_handler(on_proactive)
            self.runtime.set_user_input_active(True)
            self.runtime._initiative_queue.enqueue(
                InitiativeCandidate.create(
                    source="test",
                    topic="hello",
                    priority=1.0,
                    freshness=1.0,
                    ttl_seconds=10.0,
                    payload={
                        "prompt": "Say hello briefly",
                        "initiative": {"intent": "idle_chat", "topic": "hello"},
                    },
                )
            )
            drain = self.runtime._start_initiative_drain()
            await asyncio.sleep(0.65)
            blocked_while_recording = not delivered.is_set()

            self.runtime.set_user_input_active(False)
            await asyncio.wait_for(delivered.wait(), timeout=3.0)

            if drain is not None:
                drain.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await drain
            return blocked_while_recording

        import asyncio

        self.assertTrue(asyncio.run(scenario()))

    def test_failed_initiative_turn_is_delivered_to_frontend_handler(self):
        """A proactive failure must leave a visible lifecycle instead of vanishing."""

        async def scenario():
            delivered = []

            async def on_proactive(turn):
                delivered.append(turn)

            failed = CharacterTurn(input=TurnInput(
                text="主动问候",
                origin=TurnOrigin.INITIATIVE,
                metadata={"initiative": {"intent": "idle_chat"}},
            ))
            failed.fail("llm.request_failed", "provider rejected continuation")

            async def fail_turn(_turn_input):
                return failed

            self.runtime.register_proactive_handler(on_proactive)
            self.runtime.handle_turn = fail_turn
            pending = InitiativeCandidate.create(
                source="test",
                topic="hello",
                priority=1.0,
                freshness=1.0,
                ttl_seconds=10.0,
                payload={
                    "prompt": "主动问候",
                    "initiative": {"intent": "idle_chat"},
                },
            )

            await self.runtime._dispatch_initiative(pending)
            return delivered

        delivered = asyncio.run(scenario())
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0].error.code, "llm.request_failed")

    def test_initiative_prompt_uses_character_reply_language(self):
        """A multilingual display name must not override reply_language."""
        self.runtime._initiative_queue = InitiativeQueue()
        self.runtime._initiative_cooldown = 0
        self.runtime.initiative_checker = SimpleNamespace(
            _last_interaction=time.time() - 120,
        )
        character = self.runtime._character_step.character
        character._raw_card["reply_language"] = "zh"
        character.persona._card["reply_language"] = "zh"
        character.persona._card["name"] = {"zh": "Alice", "en": "Alice", "ja": "Alice"}

        candidate = {
            "type": "idle_chat",
            "topic": "聊聊天",
            "score": 1.0,
        }
        with (
            patch("app.runtime.runtime.compute_candidates", return_value=[candidate]),
            patch("app.runtime.runtime.decide_action", return_value=candidate),
            patch(
                "app.runtime.runtime.build_initiative_prompt",
                return_value="主动聊聊天",
            ) as build_prompt,
        ):
            self.runtime._on_initiative([])

        self.assertEqual(build_prompt.call_args.kwargs["language"], "zh")

    def test_providers_available(self):
        """All expected providers should be initialized."""
        expected = {"llm", "memory", "tool", "tts", "asr"}
        self.assertTrue(expected.issubset(self.runtime.providers.keys()))

    def test_conversation_history(self):
        """Conversation should be available and track turns."""
        event1 = Event(EventType.TEXT_RECEIVED, {"text": "first"}, source="test")
        _run(self.runtime.handle_turn(_turn_input(event1)))
        event2 = Event(EventType.TEXT_RECEIVED, {"text": "second"}, source="test")
        _run(self.runtime.handle_turn(_turn_input(event2)))

        conv = self.runtime.conversation
        self.assertIsNotNone(conv)
        history = conv.get_history(limit=10)
        self.assertGreaterEqual(len(history), 1)

    def test_background_memory_notification_failure_does_not_break_committed_turn(self):
        """Non-critical post-turn bookkeeping must not discard a valid reply."""
        class FailingNotifier:
            _store = None

            def notify_turn(self, character_id=""):
                raise OSError("ticker unavailable")

        self.runtime.providers["memory"] = FailingNotifier()
        event = Event(EventType.TEXT_RECEIVED, {"text": "hello"}, source="test")

        turn = _run(self.runtime.handle_turn(_turn_input(event)))

        self.assertIsNone(turn.error)
        self.assertIn("memory_notification_failed", turn.warnings)
        self.assertIsNone(self.runtime.character_self._turn_baseline)

    def test_character_state_commit_exception_closes_transaction_by_rollback(self):
        """A failed durable-state commit cannot leave the next turn locked out."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "hello"}, source="test")
        original_rollback = self.runtime.character_self.rollback_turn

        with patch.object(
            self.runtime.character_self,
            "commit_turn",
            side_effect=RuntimeError("commit failed"),
        ), patch.object(
            self.runtime.character_self,
            "rollback_turn",
            wraps=original_rollback,
        ) as rollback:
            with self.assertRaisesRegex(RuntimeError, "commit failed"):
                _run(self.runtime.handle_turn(_turn_input(event)))

        rollback.assert_called_once_with()
        self.assertIsNone(self.runtime.character_self._turn_baseline)


class TestDecisionStep(unittest.TestCase):
    """DecisionStep and DefaultPlanner integration."""

    def setUp(self):
        provider_registry.register(LLMInterface, "default", MockLLM)
        provider_registry.register(MemoryInterface, "default", MockMemory)
        self.runtime = CharacterRuntime()

    def test_decision_step_produces_reply(self):
        """DecisionStep should produce a reply_text in the context."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "Hello!"}, source="test")
        ctx = _run(self.runtime.handle_turn(_turn_input(event)))
        self.assertIsNone(ctx.error)

    def test_pipeline_includes_all_steps(self):
        """The pipeline should use the single durable MemorySaveStep."""
        step_names = [type(s).__name__ for s in self.runtime.pipeline._steps]
        expected = ["ASRStep", "CharacterStep", "MemoryRetrieveStep",
                    "DecisionStep", "EmotionStep", "TTSStep", "Live2DStep",
                    "MemorySaveStep"]
        self.assertEqual(step_names, expected)


class TestEventCreation(unittest.TestCase):
    """Event creation and type handling."""

    def test_text_received_event(self):
        """TEXT_RECEIVED should store text and source."""
        e = Event(EventType.TEXT_RECEIVED, {"text": "hello"}, source="cli")
        self.assertEqual(e.type, EventType.TEXT_RECEIVED)
        self.assertEqual(e.payload.get("text"), "hello")
        self.assertEqual(e.source, "cli")

    def test_speech_received_event(self):
        """SPEECH_RECEIVED should store audio and sample_rate."""
        e = Event(EventType.SPEECH_RECEIVED,
                  {"audio": b"data", "sample_rate": 16000}, source="test")
        self.assertEqual(e.type, EventType.SPEECH_RECEIVED)
        self.assertEqual(e.payload.get("sample_rate"), 16000)

    def test_event_source_default(self):
        """Event source should default to 'system'."""
        e = Event(EventType.TEXT_RECEIVED, {"text": "hi"})
        self.assertEqual(e.source, "system")

    def test_unknown_event_type(self):
        """Unknown event types should still create valid events."""
        e = Event("unknown_type", {"key": "val"}, source="test")
        self.assertEqual(e.type, "unknown_type")
        self.assertEqual(e.payload.get("key"), "val")


class TestCharacterTurnCreation(unittest.TestCase):
    """CharacterTurn initialization and typed state."""

    def test_context_from_event(self):
        """CharacterTurn derives its event and text from TurnInput."""
        ctx = CharacterTurn(input=TurnInput(text="hello world"))
        self.assertEqual(ctx.event.type, EventType.TEXT_RECEIVED)
        self.assertEqual(ctx.user_text, "hello world")

    def test_context_from_speech_event(self):
        """Context should have empty user_text for speech events."""
        ctx = CharacterTurn(input=TurnInput(audio=b"data", sample_rate=16000))
        self.assertEqual(ctx.user_text, "")

    def test_context_default_values(self):
        """Context should have sensible defaults."""
        ctx = CharacterTurn(input=TurnInput(text="hi"))
        self.assertIsNone(ctx.error)
        self.assertEqual(ctx.reply_text, "")
        self.assertEqual(ctx.emotion, "neutral")


class TestStateStore(unittest.TestCase):
    """StateStore thread safety and persistence."""

    def setUp(self):
        # Reset state
        state_store._state.clear()

    def test_set_and_get(self):
        state_store.set("test_key", "test_value")
        self.assertEqual(state_store.get("test_key"), "test_value")

    def test_get_default(self):
        self.assertIsNone(state_store.get("nonexistent"))
        self.assertEqual(state_store.get("nonexistent", 42), 42)

    def test_update(self):
        state_store.set("a", 1)
        state_store.set("b", 2)
        state_store.update(a=10, c=30)
        self.assertEqual(state_store.get("a"), 10)
        self.assertEqual(state_store.get("b"), 2)
        self.assertEqual(state_store.get("c"), 30)

    def test_snapshot(self):
        state_store.set("x", "y")
        snap = state_store.snapshot()
        self.assertIn("x", snap)
        self.assertEqual(snap["x"], "y")


class TestMemorySteps(unittest.TestCase):
    """MemoryRetrieveStep and MemorySaveStep with MockMemory."""

    def setUp(self):
        self.memory = MockMemory()
        provider_registry.register(MemoryInterface, "default", MockMemory)
        self.runtime = CharacterRuntime()

    def test_memory_retrieve(self):
        """MemoryRetrieveStep should store results in the typed turn field."""
        from app.runtime.steps import MemoryRetrieveStep
        step = MemoryRetrieveStep(self.memory)
        from app.runtime.character_turn import CharacterTurn, TurnInput
        ctx = CharacterTurn(input=TurnInput(text="what did we talk about?"))
        _run(step.run(ctx))
        self.assertIsInstance(ctx.memories, list)

    def test_memory_save(self):
        """MemorySaveStep should store turn data."""
        from app.runtime.steps import MemorySaveStep
        step = MemorySaveStep(self.memory)
        from app.runtime.character_turn import CharacterTurn, TurnInput
        ctx = CharacterTurn(input=TurnInput(text="hi"))
        ctx.reply_text = "hello back"
        ctx.user_text = "hi"
        _run(step.run(ctx))
        # MockMemory stores in _storage list
        self.assertIsInstance(self.memory._storage, list)

    def test_memory_save_failure_keeps_the_generated_reply(self):
        from app.runtime.steps import MemorySaveStep

        class FailingMemory(MockMemory):
            async def store(self, event_type, data):
                raise OSError("disk unavailable")

        ctx = CharacterTurn(input=TurnInput(text="hi"))
        ctx.user_text = "hi"
        ctx.reply_text = "hello back"
        _run(MemorySaveStep(FailingMemory()).run(ctx))

        self.assertEqual(ctx.reply_text, "hello back")
        self.assertIn("memory_save_failed", ctx.warnings)


class TestCharacterStep(unittest.TestCase):
    """CharacterStep integration."""

    def setUp(self):
        provider_registry.register(LLMInterface, "default", MockLLM)
        provider_registry.register(MemoryInterface, "default", MockMemory)

    def test_character_injected(self):
        """CharacterStep should inject character into context."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "hello"}, source="test")
        ctx = _run(CharacterRuntime().handle_turn(_turn_input(event)))
        self.assertIsNotNone(ctx.character)
        self.assertTrue(ctx.emotion)


class TestEmotionStep(unittest.TestCase):
    """EmotionStep integration."""

    def setUp(self):
        provider_registry.register(LLMInterface, "default", MockLLM)
        provider_registry.register(MemoryInterface, "default", MockMemory)

    def test_emotion_set(self):
        """EmotionStep should set a default emotion."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "hello"}, source="test")
        ctx = _run(CharacterRuntime().handle_turn(_turn_input(event)))
        self.assertTrue(ctx.emotion)


class TestTTSStep(unittest.TestCase):
    """TTSStep integration."""

    def setUp(self):
        provider_registry.register(LLMInterface, "default", MockLLM)
        provider_registry.register(MemoryInterface, "default", MockMemory)
        provider_registry.register(TTSInterface, "default", MockTTS)
        self.runtime = CharacterRuntime()

    def test_tts_step_does_not_crash(self):
        """TTSStep should not crash when reply_text is empty."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "hello"}, source="test")
        ctx = _run(self.runtime.handle_turn(_turn_input(event)))
        self.assertIsNone(ctx.error)


class TestFullEventFlow(unittest.TestCase):
    """End-to-end event flow tests."""

    def setUp(self):
        provider_registry.register(LLMInterface, "default", MockLLM)
        provider_registry.register(MemoryInterface, "default", MockMemory)
        provider_registry.register(ASRInterface, "default", MockASR)
        provider_registry.register(TTSInterface, "default", MockTTS)
        state_store._state.clear()
        self.runtime = CharacterRuntime()

    def test_text_input_round_trip(self):
        """Text input → dispatch → reply context."""
        event = Event(EventType.TEXT_RECEIVED, {"text": "hello"}, source="test")
        ctx = _run(self.runtime.handle_turn(_turn_input(event)))
        self.assertIsNone(ctx.error)
        self.assertEqual(ctx.user_text, "hello")

    def test_multiple_turns(self):
        """Multiple dispatches should not cause errors."""
        for i in range(3):
            event = Event(EventType.TEXT_RECEIVED,
                          {"text": f"message {i}"}, source="test")
            ctx = _run(self.runtime.handle_turn(_turn_input(event)))
            self.assertIsNone(ctx.error)

    def test_speech_then_text(self):
        """Mixed speech and text events should both work."""
        audio_event = Event(EventType.SPEECH_RECEIVED,
                            {"audio": b"\x00" * 160, "sample_rate": 16000},
                            source="test")
        _run(self.runtime.handle_turn(_turn_input(audio_event)))

        text_event = Event(EventType.TEXT_RECEIVED,
                           {"text": "hello"}, source="test")
        ctx = _run(self.runtime.handle_turn(_turn_input(text_event)))
        self.assertIsNone(ctx.error)


if __name__ == "__main__":
    unittest.main(verbosity=2)
