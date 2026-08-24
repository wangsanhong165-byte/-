import asyncio
import json

from app.runtime.character_turn import (
    CharacterTurn,
    PerformancePlan,
    TurnInput,
    TurnOutput,
    TurnPhase,
)
from app.transport.domain_event import DomainEvent
from app.transport.emitter import TransportEmitter
from app.transport.session import WebSocketSession
from contracts.v3.events import AssistantTextCompletedPayload, TtsAudioPayload


def completed_turn(*, audio_input: bool = False, audio_output: bool = False) -> CharacterTurn:
    turn_input = TurnInput(
        audio=b"input-wav" if audio_input else b"",
        text="" if audio_input else "hello",
        session_id="session-from-domain",
        turn_id="turn-1",
    )
    turn = CharacterTurn(
        input=turn_input,
        turn_id="turn-1",
        session_id="session-from-domain",
        output=TurnOutput(
            reply_text="world",
            reasoning="",
            segments=[{"text": "world", "emotion": "happy", "behavior": "greet"}],
            performance=PerformancePlan(emotion="happy", behavior="greet"),
            audio=b"output-wav" if audio_output else b"",
        ),
    )
    turn.transition_to(TurnPhase.PROCESSING)
    turn.transition_to(TurnPhase.COMPLETED)
    return turn


def test_text_completion_is_typed_v3_domain_events_in_canonical_order():
    events = TransportEmitter().emit(completed_turn())

    assert [event.event_type for event in events] == [
        "turn.started",
        "assistant.text.started",
        "assistant.text.completed",
        "character.intent",
        "turn.completed",
        "runtime.status",
    ]
    assert all(isinstance(event, DomainEvent) for event in events)
    assert all(event.turn_id == "turn-1" for event in events[:-1])
    assert events[-1].turn_id is None
    assistant = events[2]
    assert isinstance(assistant.payload, AssistantTextCompletedPayload)
    assert assistant.payload.text == "world"
    assert assistant.payload.segments[0].behavior == "greet"
    assert "diagnostics" not in assistant.payload.model_dump()
    intent = events[3]
    assert intent.payload.segments[0].text == "world"


def test_audio_turn_has_asr_and_strict_tts_event_order():
    events = TransportEmitter().emit(completed_turn(audio_input=True, audio_output=True))

    assert [event.event_type for event in events] == [
        "turn.started",
        "asr.started",
        "asr.result",
        "assistant.text.started",
        "assistant.text.completed",
        "character.intent",
        "tts.started",
        "tts.audio",
        "tts.completed",
        "turn.completed",
        "runtime.status",
    ]
    audio = next(event for event in events if event.event_type == "tts.audio")
    assert isinstance(audio.payload, TtsAudioPayload)
    assert audio.payload.data
    assert audio.payload.format == "wav"


def test_turn_failure_is_typed_and_still_returns_runtime_to_idle():
    turn = CharacterTurn(
        input=TurnInput(
            text="hello",
            session_id="session-from-domain",
            turn_id="turn-1",
        ),
        turn_id="turn-1",
        session_id="session-from-domain",
    )
    turn.fail("decision.invalid", "bad response")

    events = TransportEmitter().emit(turn)

    assert [event.event_type for event in events] == [
        "turn.started",
        "turn.failed",
        "runtime.status",
    ]
    assert events[1].payload.code == "decision.invalid"


def test_tts_failure_is_explicit_and_text_turn_still_completes():
    turn = completed_turn()
    turn.warnings.append("tts.failed:service unavailable")

    events = TransportEmitter().emit(turn)

    assert "assistant.text.completed" in [event.event_type for event in events]
    assert "character.intent" in [event.event_type for event in events]
    assert "turn.completed" in [event.event_type for event in events]
    failed = next(event for event in events if event.event_type == "tts.failed")
    assert failed.payload.code == "tts.unavailable"
    assert failed.payload.message == "service unavailable"


def test_tool_audit_becomes_typed_started_and_result_events():
    turn = completed_turn()
    turn.tool_audit = [{
        "tool": "clock",
        "status": "ok",
        "duration_ms": 12,
        "attempts": 1,
    }]

    events = TransportEmitter().emit(turn)
    tool_events = [
        event for event in events if event.event_type.startswith("tool.")
    ]

    assert [event.event_type for event in tool_events] == [
        "tool.started",
        "tool.result",
    ]
    assert tool_events[0].payload.tool == "clock"
    assert tool_events[1].payload.result["status"] == "ok"


class WebSocketProbe:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_text(self, raw: str) -> None:
        self.sent.append(json.loads(raw))


def test_session_writer_owns_identity_sequence_and_unique_event_ids():
    probe = WebSocketProbe()
    session = WebSocketSession(probe, lambda _event: None)
    session.session_id = "wire-session"
    events = TransportEmitter().emit(completed_turn(audio_output=True))

    async def send_all():
        for event in events:
            await session.send(event)

    asyncio.run(send_all())

    assert [frame["sequence"] for frame in probe.sent] == list(
        range(1, len(probe.sent) + 1)
    )
    assert {frame["sessionId"] for frame in probe.sent} == {"wire-session"}
    assert len({frame["eventId"] for frame in probe.sent}) == len(probe.sent)
    assert all(
        frame["turnId"] == "turn-1"
        for frame in probe.sent
        if frame["eventType"] != "runtime.status"
    )


def test_character_intent_emission_never_fails_on_a_partially_invalid_segment_plan():
    turn = completed_turn()
    turn.output.segments = [{
        "text": "world",
        "emotion": "happy",
        "motionPlan": {
            "durationMs": 1100,
            "steps": [
                {"atMs": 0, "durationMs": 700, "primitive": "nod", "intensity": 0.5},
                {"atMs": 100, "durationMs": 500, "primitive": "ParamAngleX", "intensity": 1},
            ],
        },
    }]

    events = TransportEmitter().emit(turn)
    intent = next(event for event in events if event.event_type == "character.intent")

    assert len(intent.payload.segments) == 1
    assert intent.payload.segments[0].motion_plan.steps[0].primitive == "nod"
    assert len(intent.payload.segments[0].motion_plan.steps) == 1
