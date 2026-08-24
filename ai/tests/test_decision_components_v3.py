import asyncio

from app.interfaces.llm import LLMResponse
from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.prompt_compiler import PromptCompiler
from app.runtime.response_interpreter import ResponseInterpreter
from app.runtime.steps.decision_step import DecisionStep


class _Planner:
    def plan(self, turn):
        return type("Plan", (), {"messages": [{"role": "user", "content": turn.user_text}]})()


def test_prompt_compiler_returns_detached_messages_without_mutating_turn():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    compiler = PromptCompiler(planner=_Planner())

    request = compiler.compile(turn, character_self=None)
    request.messages[0]["content"] = "changed"

    assert turn.user_text == "hello"
    assert compiler.compile(turn, None).messages == [
        {"role": "user", "content": "hello"}
    ]


def test_response_interpreter_produces_semantic_performance_only():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    response = LLMResponse(
        reply="Hi",
        segments=[{
            "text": "Hi",
            "emotion": "happy",
            "behavior": "greet",
            "attention": "user",
            "energy": 0.8,
        }],
    )

    interpreted = ResponseInterpreter().interpret(response, turn)

    assert interpreted.reply_text == "Hi"
    assert interpreted.performance.emotion == "happy"
    assert interpreted.performance.behavior == "greet"
    assert not hasattr(interpreted.performance, "parameter_id")
    assert "Param" not in repr(interpreted.performance)


def test_response_interpreter_rejects_renderer_details():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    response = LLMResponse(
        reply="Hi",
        segments=[{"text": "Hi", "emotion": "happy", "ParamAngleX": 12}],
    )

    interpreted = ResponseInterpreter().interpret(response, turn)

    assert interpreted.warnings == ["renderer_details_removed"]
    assert "ParamAngleX" not in interpreted.segments[0]


def test_response_interpreter_preserves_only_safe_motion_plan():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    response = LLMResponse(
        reply="Hi",
        segments=[{
            "text": "Hi",
            "emotion": "happy",
            "motionPlan": {
                "durationMs": 900,
                "steps": [{
                    "atMs": 0,
                    "durationMs": 600,
                    "primitive": "nod",
                    "intensity": 0.5,
                }],
            },
        }],
    )

    performance = ResponseInterpreter().interpret(response, turn).performance

    assert performance.motion_plan["steps"][0]["primitive"] == "nod"


def test_response_interpreter_selects_dominant_segment_and_keeps_intensity_separate():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    response = LLMResponse(
        reply="Hi",
        segments=[
            {"text": "one", "emotion": "calm", "intensity": 0.6, "energy": 0.9},
            {"text": "two", "emotion": "happy", "intensity": 0.8, "energy": 0.2,
             "attention": "screen"},
            {"text": "three", "emotion": "angry", "intensity": 0.8, "energy": 0.1},
        ],
    )

    performance = ResponseInterpreter().interpret(response, turn).performance

    assert performance.emotion == "happy"
    assert performance.intensity == 0.8
    assert performance.energy == 0.2
    assert performance.attention == "screen"


def test_decision_step_preserves_one_coherent_dominant_segment_performance():
    class SegmentedLLM:
        async def generate(self, messages, **kwargs):
            return LLMResponse(
                reply="先开心地回应，再平静收尾。",
                segments=[
                    {
                        "text": "先开心地回应。",
                        "emotion": "happy",
                        "behavior": "greet",
                        "intensity": 0.8,
                        "energy": 0.7,
                    },
                    {
                        "text": "再平静收尾。",
                        "emotion": "neutral",
                        "behavior": "speak",
                        "intensity": 0.3,
                        "energy": 0.3,
                    },
                ],
            )

    turn = CharacterTurn(input=TurnInput(text="你好"))
    asyncio.run(DecisionStep(SegmentedLLM()).run(turn))

    assert turn.output.performance.emotion == "happy"
    assert turn.output.performance.behavior == "greet"
    assert turn.output.performance.intensity == 0.8
    assert turn.output.performance.energy == 0.7


def test_response_interpreter_canonicalizes_every_segment_motion_plan():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    response = LLMResponse(
        reply="Hi",
        segments=[{
            "text": "Hi",
            "emotion": "playful",
            "motionPlan": {
                "durationMs": 1000,
                "debugLabel": "harmless",
                "steps": [
                    {"atMs": 0, "durationMs": 600, "primitive": "tilt_left", "intensity": 0.4},
                    {"atMs": 100, "durationMs": 500, "primitive": "ParamAngleX", "intensity": 1},
                ],
            },
        }],
    )

    interpreted = ResponseInterpreter().interpret(response, turn)

    assert interpreted.segments[0]["motionPlan"] == {
        "durationMs": 1000,
        "steps": [
            {"atMs": 0, "durationMs": 600, "primitive": "tilt_left", "intensity": 0.4},
        ],
    }
    assert "motion_plan_step_removed" in interpreted.warnings


def test_response_interpreter_tolerates_malformed_segment_ranking_values():
    turn = CharacterTurn(input=TurnInput(text="hello"))
    response = LLMResponse(
        reply="Hi",
        segments=[
            {"text": "broken", "emotion": "sad", "intensity": "not-a-number"},
            {"text": "valid", "emotion": "happy", "intensity": 0.7, "energy": 0.8},
        ],
    )

    performance = ResponseInterpreter().interpret(response, turn).performance

    assert performance.emotion == "happy"
    assert performance.intensity == 0.7


def test_response_interpreter_does_not_keep_shy_without_current_semantic_evidence():
    turn = CharacterTurn(input=TurnInput(text="现在说话是怎么回事，看一下"))
    response = LLMResponse(
        reply="哎呀，刚才只是有一点卡住了，现在继续看吧。",
        segments=[{
            "text": "哎呀，刚才只是有一点卡住了，现在继续看吧。",
            "emotion": "shy",
            "behavior": "speak",
            "energy": 0.45,
            "intensity": 0.5,
            "naturalVAD": {"valence": 0.3, "arousal": 0.35, "dominance": 0.1},
        }],
    )

    interpreted = ResponseInterpreter().interpret(response, turn)

    assert interpreted.segments[0]["emotion"] == "playful"
    assert interpreted.performance.emotion == "playful"
    assert "emotion_semantically_adapted:shy->playful" in interpreted.warnings


def test_response_interpreter_preserves_shy_when_bashfulness_is_explicit():
    turn = CharacterTurn(input=TurnInput(text="你现在是不是害羞了？"))
    response = LLMResponse(
        reply="被你看出来了，确实有点不好意思。",
        segments=[{
            "text": "被你看出来了，确实有点不好意思。",
            "emotion": "shy",
            "behavior": "speak",
        }],
    )

    interpreted = ResponseInterpreter().interpret(response, turn)

    assert interpreted.performance.emotion == "shy"
    assert not any(item.startswith("emotion_semantically_adapted") for item in interpreted.warnings)
