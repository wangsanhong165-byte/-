import asyncio

from app.runtime.character_turn import CharacterTurn, TurnInput, TurnPhase
from app.transport.domain_event import DomainEvent
from app.transport.emitter import TransportEmitter
from app.transport.websocket.handler import RuntimeEventHandler
from contracts.v3.registry import EventRegistry


def test_success_lifecycle_has_one_canonical_order():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    turn.transition_to(TurnPhase.PROCESSING)
    turn.reply_text = "world"
    turn.audio = b"wav"
    turn.output.performance.emotion = "happy"
    turn.output.performance.intensity = 0.85
    turn.output.performance.energy = 0.35
    turn.output.performance.behavior = "greet"
    turn.output.performance.motion_plan = {
        "durationMs": 900,
        "steps": [{
            "atMs": 0,
            "durationMs": 600,
            "primitive": "nod",
            "intensity": 0.5,
        }],
    }
    turn.output.performance.speaking = True
    turn.transition_to(TurnPhase.COMPLETED)

    messages = TransportEmitter().emit(turn)

    assert [message.event_type for message in messages] == [
        "turn.started",
        "assistant.text.started",
        "assistant.text.completed",
        "tts.started",
        "tts.audio",
        "tts.completed",
        "character.intent",
        "turn.completed",
        "runtime.status",
    ]
    assert all(isinstance(message, DomainEvent) for message in messages)
    update = messages[-3]
    assert update.payload.behavior == "greet"
    assert update.payload.intensity == 0.85
    assert update.payload.energy == 0.35
    assert not hasattr(update.payload, "model_id")
    assert not hasattr(update.payload, "expression")
    assert not hasattr(update.payload, "motion")
    assert update.payload.motion_plan.steps[0].primitive == "nod"


def test_failure_lifecycle_is_error_then_idle():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    turn.fail("decision.invalid", "bad response")

    messages = TransportEmitter().emit(turn)

    assert [message.event_type for message in messages] == [
        "turn.started",
        "turn.failed",
        "runtime.status",
    ]
    assert messages[1].payload.code == "decision.invalid"


def test_empty_asr_failure_is_identified_before_the_turn_failure():
    turn = CharacterTurn(input=TurnInput(audio=b"RIFF-silence"))
    turn.fail("asr.empty_transcript", "No speech was recognized")

    messages = TransportEmitter().emit(turn)

    assert [message.event_type for message in messages] == [
        "turn.started",
        "asr.started",
        "asr.failed",
        "turn.failed",
        "runtime.status",
    ]
    assert messages[2].payload.code == "asr.empty_transcript"


def test_websocket_pushes_processing_before_runtime_work_starts():
    pushed = []

    async def push(message):
        pushed.append(message)

    class RuntimeProbe:
        async def handle_turn(self, turn_input, **kwargs):
            assert [message.event_type for message in pushed] == ["turn.started"]
            turn = CharacterTurn(input=turn_input)
            turn.turn_id = turn_input.turn_id
            turn.session_id = turn_input.session_id
            turn.transition_to(TurnPhase.PROCESSING)
            turn.reply_text = "done"
            turn.transition_to(TurnPhase.COMPLETED)
            return turn

    handler = RuntimeEventHandler(runtime=RuntimeProbe())
    handler.send_event = push
    incoming = EventRegistry.parse({
        "protocolVersion": "3.0",
        "eventId": "event-1",
        "eventType": "user.text",
        "sessionId": "session-1",
        "turnId": "turn-1",
        "sequence": 1,
        "source": "frontend",
        "timestamp": 1.0,
        "payload": {"text": "hello"},
    })

    async def scenario():
        responses = await handler.handle_event(incoming)
        assert responses == []
        assert handler._active_task is not None
        await handler._active_task

    asyncio.run(scenario())

    assert [message.event_type for message in pushed] == [
        "turn.started",
        "assistant.text.started",
        "assistant.text.completed",
        "character.intent",
        "turn.completed",
        "runtime.status",
    ]
