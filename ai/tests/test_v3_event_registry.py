from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from contracts.v3.envelope import CANONICAL_ENVELOPE_FIELDS
from contracts.v3.events import EVENT_PAYLOAD_MODELS, SYSTEM_EVENT_TYPES
from contracts.v3.registry import EventRegistry, UnsupportedEventError


ROOT = Path(__file__).resolve().parents[1]


VALID_PAYLOADS: dict[str, dict] = {
    "session.open": {"capabilities": ["text", "audio"]},
    "session.opened": {"capabilities": ["text", "audio"], "config": {}},
    "session.closed": {"reason": "client_closed"},
    "session.ping": {"nonce": "ping-1"},
    "session.pong": {"nonce": "ping-1"},
    "runtime.status": {"state": "idle", "message": ""},
    "runtime.ready": {"services": ["bridge"]},
    "runtime.degraded": {"services": ["tts"], "reason": "optional service unavailable"},
    "service.status": {"service": "tts", "state": "ready"},
    "configuration.updated": {"config": {"voice": "monika"}},
    "protocol.error": {"code": "invalid_payload", "message": "bad payload"},
    "user.text": {"text": "hello"},
    "user.audio.started": {"sampleRate": 16000, "channels": 1, "format": "pcm_f32"},
    "user.audio.chunk": {"samples": [0.0, 0.25]},
    "user.audio.completed": {"sampleRate": 16000},
    "user.audio.cancelled": {"reason": "interrupted"},
    "turn.started": {"origin": "user", "inputMode": "text"},
    "turn.progress": {"stage": "thinking", "message": ""},
    "turn.completed": {"reason": "complete"},
    "turn.failed": {"code": "pipeline_error", "message": "failed"},
    "turn.cancelled": {"reason": "user_interrupt"},
    "asr.started": {"language": "zh"},
    "asr.result": {"text": "你好", "confidence": 0.98},
    "asr.failed": {"code": "asr_error", "message": "failed"},
    "assistant.text.started": {},
    "assistant.text.chunk": {"delta": "你", "text": "你"},
    "assistant.text.completed": {"text": "你好", "reasoning": ""},
    "assistant.failed": {"code": "llm_error", "message": "failed"},
    "character.intent": {
        "emotion": "happy",
        "behavior": "speak",
        "attention": "user",
        "energy": 0.7,
        "motionPlan": {
            "durationMs": 900,
            "steps": [{
                "atMs": 0,
                "durationMs": 600,
                "primitive": "nod",
                "intensity": 0.5,
            }],
        },
    },
    "character.expression": {"name": "smile", "intensity": 0.8},
    "character.motion": {"name": "wave", "priority": 2, "loop": False},
    "character.component": {"name": "ribbon", "enabled": True},
    "character.snapshot": {"components": {"ribbon": True}},
    "character.suggestion": {
        "suggestionId": "suggestion-1",
        "target": "expression",
        "name": "smile",
        "action": "apply",
        "reason": "reply",
    },
    "character.control.requested": {
        "action": "set_expression",
        "params": {"name": "smile"},
        "requestId": "request-1",
    },
    "character.suggestion.accepted": {"suggestionId": "suggestion-1"},
    "character.suggestion.rejected": {"suggestionId": "suggestion-1", "reason": "user"},
    "tts.started": {"format": "wav", "audioSequence": 1},
    "tts.audio": {"data": "UklGRg==", "format": "wav", "audioSequence": 1, "volumes": [0.2]},
    "tts.completed": {"reason": "complete"},
    "tts.failed": {"code": "tts_error", "message": "failed"},
    "tts.cancelled": {"reason": "interrupted"},
    "tool.requested": {
        "requestId": "tool-1",
        "tool": "open_url",
        "args": {"url": "https://example.test"},
        "risk": "medium",
    },
    "tool.started": {"requestId": "tool-1", "tool": "open_url"},
    "tool.result": {"requestId": "tool-1", "tool": "open_url", "result": {"ok": True}},
    "tool.failed": {"requestId": "tool-1", "tool": "open_url", "code": "failed", "message": "failed"},
    "management.requested": {"requestId": "cmd-1", "action": "get_status", "params": {}},
    "management.result": {"requestId": "cmd-1", "action": "get_status", "data": {"ready": True}},
    "management.failed": {"requestId": "cmd-1", "action": "get_status", "code": "failed", "message": "failed"},
    "telemetry.batch": {"events": [{"name": "turn.completed", "timestamp": 1.0, "data": {}}]},
}


def raw_event(event_type: str, payload: dict, *, turn_id: str | None = "turn-1") -> dict:
    return {
        "protocolVersion": "3.0",
        "eventId": f"evt-{event_type}",
        "eventType": event_type,
        "sessionId": "session-1",
        "turnId": turn_id,
        "sequence": 1,
        "source": "frontend",
        "timestamp": 1.0,
        "payload": payload,
    }


def test_registry_covers_the_declared_v3_event_set() -> None:
    assert set(EVENT_PAYLOAD_MODELS) == set(VALID_PAYLOADS)
    assert "character.state" not in EVENT_PAYLOAD_MODELS


@pytest.mark.parametrize("event_type", sorted(VALID_PAYLOADS))
def test_all_events_round_trip_with_typed_payload(event_type: str) -> None:
    turn_id = None if event_type in SYSTEM_EVENT_TYPES else "turn-1"
    event = EventRegistry.parse(raw_event(event_type, VALID_PAYLOADS[event_type], turn_id=turn_id))

    assert event.event_type == event_type
    assert type(event.payload) is EVENT_PAYLOAD_MODELS[event_type]
    assert set(event.to_dict()) == set(CANONICAL_ENVELOPE_FIELDS)
    assert EventRegistry.parse(event.to_dict()) == event


def test_system_event_does_not_require_turn_id() -> None:
    event = EventRegistry.parse(raw_event("runtime.ready", {"services": []}, turn_id=None))
    assert event.turn_id is None


def test_turn_event_requires_turn_id() -> None:
    with pytest.raises(ValidationError, match="turnId"):
        EventRegistry.parse(raw_event("user.text", {"text": "hello"}, turn_id=None))


@pytest.mark.parametrize("version", ["2.0", "4.0"])
def test_unknown_or_old_protocol_version_is_rejected(version: str) -> None:
    raw = raw_event("session.open", {"capabilities": []}, turn_id=None)
    raw["protocolVersion"] = version
    with pytest.raises(ValidationError, match="protocolVersion"):
        EventRegistry.parse(raw)


def test_unknown_event_is_rejected_explicitly() -> None:
    with pytest.raises(UnsupportedEventError, match="unknown.event"):
        EventRegistry.parse(raw_event("unknown.event", {}, turn_id=None))


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({}, "text"),
        ({"text": 42}, "text"),
        ({"text": "hello", "unexpected": True}, "unexpected"),
    ],
)
def test_payload_schema_rejects_missing_wrong_and_extra_fields(payload: dict, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        EventRegistry.parse(raw_event("user.text", payload))


def test_exported_schema_matches_registry() -> None:
    schema_path = ROOT / "contracts" / "v3" / "runtime-events.schema.json"
    exported = json.loads(schema_path.read_text(encoding="utf-8"))
    assert set(exported["events"]) == set(EVENT_PAYLOAD_MODELS)
    assert exported["envelope"]["required"] == list(CANONICAL_ENVELOPE_FIELDS)


def test_current_v3_emitter_only_emits_registered_events() -> None:
    from app.runtime.character_turn import CharacterTurn, TurnInput, TurnPhase
    from app.transport.emitter import TransportEmitter

    turn = CharacterTurn(input=TurnInput(text="hello"))
    turn.transition_to(TurnPhase.PROCESSING)
    turn.reply_text = "world"
    turn.audio = b"wav"
    turn.output.performance.emotion = "happy"
    turn.output.performance.behavior = "greet"
    turn.transition_to(TurnPhase.COMPLETED)

    emitted = TransportEmitter().emit(turn)
    parsed = [
        EventRegistry.parse(
            event.to_envelope("session-1", sequence).to_dict()
        )
        for sequence, event in enumerate(emitted, 1)
    ]

    assert [event.event_type for event in parsed] == [
        "turn.started",
        "assistant.text.started",
        "assistant.text.completed",
        "character.intent",
        "tts.started",
        "tts.audio",
        "tts.completed",
        "turn.completed",
        "runtime.status",
    ]


def test_character_intent_defaults_intensity_without_reusing_energy() -> None:
    event = EventRegistry.parse(raw_event("character.intent", {
        "emotion": "calm",
        "behavior": "speak",
        "attention": "user",
        "energy": 0.9,
        "contextTags": [],
    }))

    assert event.payload.intensity == 0.5
    assert event.payload.energy == 0.9
