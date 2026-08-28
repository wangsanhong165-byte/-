import asyncio

import pytest

from app.runtime.character_turn import (
    CharacterTurn,
    TurnError,
    TurnInput,
    TurnOrigin,
    TurnPhase,
)
from app.runtime.runtime import CharacterRuntime


def test_turn_input_requires_exactly_one_primary_payload():
    with pytest.raises(ValueError, match="exactly one"):
        TurnInput()

    with pytest.raises(ValueError, match="exactly one"):
        TurnInput(text="hello", audio=b"wav")

    audio_with_visual = TurnInput(
        audio=b"wav",
        sample_rate=16000,
        visual_attachments=({"id": "att_0123456789abcdef0123456789abcdef"},),
    )
    assert audio_with_visual.audio == b"wav"
    assert len(audio_with_visual.visual_attachments) == 1


def test_character_turn_has_stable_id_and_valid_phase_transitions():
    turn = CharacterTurn(input=TurnInput(text="hello"))

    assert turn.turn_id
    assert turn.phase is TurnPhase.CREATED

    turn.transition_to(TurnPhase.PROCESSING)
    turn.transition_to(TurnPhase.COMPLETED)

    with pytest.raises(ValueError, match="terminal"):
        turn.transition_to(TurnPhase.PROCESSING)


def test_character_turn_records_structured_error():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    turn.fail("decision.invalid_response", "model output was invalid")

    assert turn.phase is TurnPhase.FAILED
    assert turn.error == TurnError(
        code="decision.invalid_response",
        message="model output was invalid",
        retryable=False,
    )


def test_turn_input_carries_transport_identity_into_character_turn():
    turn_input = TurnInput(
        text="hello",
        session_id="session-1",
        turn_id="turn-1",
    )
    turn = CharacterTurn(
        input=turn_input,
        session_id=turn_input.session_id,
        turn_id=turn_input.turn_id,
    )

    assert turn.session_id == "session-1"
    assert turn.turn_id == "turn-1"


def test_expression_intensity_and_motion_energy_are_independent():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    turn.live2d_intent = {
        "emotion": "happy",
        "intensity": 0.82,
        "energy": 0.31,
    }

    assert turn.emotion_intensity == 0.82
    assert turn.output.performance.intensity == 0.82
    assert turn.output.performance.energy == 0.31
    assert turn.live2d_intent["intensity"] == 0.82
    assert turn.live2d_intent["energy"] == 0.31


def test_character_runtime_handle_turn_is_the_only_public_turn_entrypoint():
    runtime = CharacterRuntime()
    turn = asyncio.run(runtime.handle_turn(TurnInput(text="hello")))

    assert isinstance(turn, CharacterTurn)
    assert turn.input.origin is TurnOrigin.USER
    assert turn.phase in {TurnPhase.COMPLETED, TurnPhase.FAILED}
    assert not hasattr(runtime, "dispatch")
    runtime.shutdown()
