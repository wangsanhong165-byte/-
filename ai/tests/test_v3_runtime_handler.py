from __future__ import annotations

import asyncio
from pathlib import Path

from app.runtime.character_turn import CharacterTurn, TurnInput, TurnOrigin, TurnPhase
from app.transport.websocket.handler import RuntimeEventHandler
from contracts.v3.registry import EventRegistry


ROOT = Path(__file__).resolve().parents[1]


def event(event_type: str, payload: dict, *, turn_id: str = "turn-1"):
    return EventRegistry.parse({
        "protocolVersion": "3.0",
        "eventId": f"event-{event_type}",
        "eventType": event_type,
        "sessionId": "session-1",
        "turnId": turn_id,
        "sequence": 1,
        "source": "frontend",
        "timestamp": 1.0,
        "payload": payload,
    })


class RuntimeProbe:
    def __init__(self):
        self.inputs: list[TurnInput] = []

    async def handle_turn(self, turn_input: TurnInput, **_kwargs) -> CharacterTurn:
        self.inputs.append(turn_input)
        turn = CharacterTurn(
            input=turn_input,
            turn_id=turn_input.turn_id,
            session_id=turn_input.session_id,
        )
        turn.transition_to(TurnPhase.PROCESSING)
        turn.reply_text = "done"
        turn.transition_to(TurnPhase.COMPLETED)
        return turn


class CancellableRuntimeProbe:
    def __init__(self):
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def handle_turn(self, turn_input: TurnInput, **_kwargs) -> CharacterTurn:
        self.started.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.cancelled.set()


class InputActivityRuntimeProbe(RuntimeProbe):
    def __init__(self):
        super().__init__()
        self.input_activity: list[bool] = []

    def set_user_input_active(self, active: bool) -> None:
        self.input_activity.append(active)


def test_text_event_reaches_domain_with_session_and_turn_identity() -> None:
    runtime = RuntimeProbe()
    handler = RuntimeEventHandler(runtime=runtime)

    responses = asyncio.run(handler.handle_event(event("user.text", {"text": "hello"})))

    assert runtime.inputs == [
        TurnInput(text="hello", session_id="session-1", turn_id="turn-1")
    ]
    assert responses
    assert all(
        response.turn_id == "turn-1"
        for response in responses
        if response.event_type not in {"runtime.status", "protocol.error"}
    )


def test_audio_events_assemble_one_turn_without_v2_messages() -> None:
    runtime = RuntimeProbe()
    handler = RuntimeEventHandler(runtime=runtime)

    async def scenario():
        await handler.handle_event(event(
            "user.audio.started",
            {"sampleRate": 16000, "channels": 1, "format": "pcm_f32"},
        ))
        await handler.handle_event(event("user.audio.chunk", {"samples": [0.0, 0.5]}))
        return await handler.handle_event(event("user.audio.completed", {"sampleRate": 16000}))

    responses = asyncio.run(scenario())

    assert len(runtime.inputs) == 1
    assert runtime.inputs[0].audio.startswith(b"RIFF")
    assert runtime.inputs[0].session_id == "session-1"
    assert runtime.inputs[0].turn_id == "turn-1"
    assert responses


def test_stale_audio_chunk_is_rejected_before_pipeline() -> None:
    runtime = RuntimeProbe()
    handler = RuntimeEventHandler(runtime=runtime)

    async def scenario():
        await handler.handle_event(event(
            "user.audio.started",
            {"sampleRate": 16000, "channels": 1, "format": "pcm_f32"},
            turn_id="turn-current",
        ))
        return await handler.handle_event(event(
            "user.audio.chunk",
            {"samples": [0.1]},
            turn_id="turn-stale",
        ))

    responses = asyncio.run(scenario())

    assert runtime.inputs == []
    assert responses[0].event_type == "protocol.error"
    assert responses[0].payload["code"] == "stale_turn"


def test_cancel_clears_audio_and_emits_canonical_cancel_events() -> None:
    runtime = RuntimeProbe()
    handler = RuntimeEventHandler(runtime=runtime)

    async def scenario():
        await handler.handle_event(event(
            "user.audio.started",
            {"sampleRate": 16000, "channels": 1, "format": "pcm_f32"},
        ))
        await handler.handle_event(event("user.audio.chunk", {"samples": [0.1]}))
        return await handler.handle_event(event("turn.cancelled", {"reason": "user_interrupt"}))

    responses = asyncio.run(scenario())

    assert runtime.inputs == []
    assert [response.event_type for response in responses] == [
        "tts.cancelled",
        "turn.cancelled",
    ]


def test_cancel_ack_waits_until_the_runtime_turn_has_stopped() -> None:
    runtime = CancellableRuntimeProbe()
    pushed = []

    async def capture(response):
        pushed.append(response)

    async def scenario():
        handler = RuntimeEventHandler(runtime=runtime, send_event=capture)
        await handler.handle_event(event("user.text", {"text": "hello"}))
        await runtime.started.wait()
        responses = await handler.handle_event(
            event("turn.cancelled", {"reason": "user_interrupt"})
        )
        return responses, runtime.cancelled.is_set()

    responses, stopped = asyncio.run(scenario())

    assert stopped is True
    assert [response.event_type for response in responses] == [
        "tts.cancelled",
        "turn.cancelled",
    ]


def test_audio_recording_blocks_initiative_until_cancelled() -> None:
    runtime = InputActivityRuntimeProbe()
    handler = RuntimeEventHandler(runtime=runtime)

    async def scenario():
        await handler.handle_event(event(
            "user.audio.started",
            {"sampleRate": 16000, "channels": 1, "format": "pcm_f32"},
        ))
        await handler.handle_event(
            event("user.audio.cancelled", {"reason": "user_cancelled"})
        )

    asyncio.run(scenario())

    assert runtime.input_activity == [True, False]


def test_successful_initiative_push_contains_text_performance_audio_and_completion() -> None:
    """A background trigger must become a complete visible and audible V3 turn."""
    pushed = []

    async def capture(response):
        pushed.append(response)

    turn = CharacterTurn(
        input=TurnInput(
            text="主动聊聊天",
            origin=TurnOrigin.INITIATIVE,
            metadata={"initiative": {"intent": "idle_chat"}},
        ),
        turn_id="initiative-1",
    )
    turn.transition_to(TurnPhase.PROCESSING)
    turn.reply_text = "要不要休息一下？"
    turn.segments = [{
        "text": turn.reply_text,
        "emotion": "happy",
        "behavior": "care",
        "intensity": 0.6,
    }]
    turn.output.performance.emotion = "happy"
    turn.output.performance.behavior = "care"
    turn.output.performance.intensity = 0.6
    turn.audio = b"wav"
    turn.transition_to(TurnPhase.COMPLETED)

    handler = RuntimeEventHandler(runtime=RuntimeProbe(), send_event=capture)
    asyncio.run(handler._on_proactive_reply(turn))

    event_types = [response.event_type for response in pushed]
    assert event_types[0] == "turn.started"
    assert "assistant.text.completed" in event_types
    assert "character.intent" in event_types
    assert "tts.audio" in event_types
    assert "turn.completed" in event_types
    text_event = next(
        response for response in pushed
        if response.event_type == "assistant.text.completed"
    )
    assert text_event.payload.text == "要不要休息一下？"
    assert all(response.turn_id == "initiative-1" for response in pushed[:-1])


def test_management_event_is_routed_without_v2_inbound_message() -> None:
    handler = RuntimeEventHandler(runtime=RuntimeProbe())

    class ManagementProbe:
        async def handle(self, action, params, request_id):
            assert action == "get_status"
            assert params == {}
            assert request_id == "request-1"
            return []

    handler._management = ManagementProbe()
    responses = asyncio.run(handler.handle_event(event(
        "management.requested",
        {"requestId": "request-1", "action": "get_status", "params": {}},
        turn_id="turn-unused",
    )))

    assert responses == []


def test_production_ingress_has_no_v2_message_conversion() -> None:
    handler_source = (
        ROOT / "app" / "transport" / "websocket" / "handler.py"
    ).read_text("utf-8")
    session_source = (
        ROOT / "app" / "transport" / "session.py"
    ).read_text("utf-8")
    assert "InboundMessage" not in handler_source
    assert "V2CompatibilityAdapter" not in session_source
    assert not (ROOT / "app" / "transport" / "v2_adapter.py").exists()
