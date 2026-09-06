from app.runtime.character_intent import CharacterIntent


def test_segment_adapter_accepts_only_high_level_intent_fields():
    intent = CharacterIntent.from_llm_segment({
        "emotion": "happy", "behavior": "greet", "attention": "user",
        "energy": 0.8, "ParamAngleX": 99,
    }, 0.7)
    assert intent.emotion == "happy"
    assert intent.behavior == "greet"
    assert "ParamAngleX" not in intent.to_dict()


def test_segment_adapter_rejects_unknown_intent_values():
    intent = CharacterIntent.from_llm_segment({"emotion": "ParamMouthOpenY", "behavior": "keyframe"})
    assert intent.emotion == "neutral"
    assert intent.behavior == ""


def test_segment_adapter_filters_emotion_against_active_model_capabilities():
    intent = CharacterIntent.from_llm_segment(
        {"emotion": "shy", "behavior": "speak"},
        allowed_emotions=("neutral", "happy"),
    )

    assert intent.emotion == "neutral"


def test_segment_adapter_does_not_restore_removed_v2_fields():
    intent = CharacterIntent.from_llm_segment({
        "tone": "happy",
        "gesture": "wave",
    })
    assert intent.emotion == "neutral"
    assert intent.behavior == ""


def test_segment_adapter_derives_vad_from_emotion_and_keeps_context_tags():
    intent = CharacterIntent.from_llm_segment({
        "emotion": "worried",
        "behavior": "comfort",
        "naturalVAD": {"valence": -0.65, "arousal": 0.7, "dominance": -0.4},
        "contextTags": ["reassuring", " close-up ", "reassuring", 42],
    })
    assert intent.emotion == "worried"
    # 2026-09-05 slimming: the LLM no longer emits naturalVAD — the static
    # affect table derives it from the emotion label, whatever the model sends.
    assert intent.natural_vad == {
        "valence": -0.4, "arousal": 0.3, "dominance": -0.25,
    }
    assert intent.context_tags == ("reassuring", "close-up")
    assert intent.to_dict()["natural_vad"]["arousal"] == 0.3


def test_segment_adapter_ignores_llm_motion_plans():
    # 2026-09-05 slimming: choreography timing is local business — whatever
    # motionPlan the LLM emits is dropped before it can reach performance.
    intent = CharacterIntent.from_llm_segment({
        "emotion": "happy",
        "behavior": "agree",
        "motionPlan": {
            "durationMs": 1400,
            "steps": [
                {
                    "atMs": 0,
                    "durationMs": 700,
                    "primitive": "lean_forward",
                    "intensity": 0.25,
                },
                {
                    "atMs": 350,
                    "durationMs": 650,
                    "primitive": "nod",
                    "intensity": 0.6,
                },
            ],
        },
    })

    assert intent.motion_plan is None


def test_segment_adapter_rejects_motion_plans_with_renderer_fields():
    intent = CharacterIntent.from_llm_segment({
        "motionPlan": {
            "durationMs": 1000,
            "steps": [{
                "atMs": 0,
                "durationMs": 500,
                "primitive": "ParamAngleX",
                "intensity": 1,
                "parameter": "ParamAngleX",
            }],
        },
    })

    assert intent.motion_plan is None


def test_segment_adapter_ignores_oversized_llm_motion_plans():
    intent = CharacterIntent.from_llm_segment({
        "motionPlan": {
            "durationMs": 1800,
            "steps": [
                {"atMs": index * 300, "durationMs": 240, "primitive": "nod", "intensity": 0.4}
                for index in range(4)
            ],
        },
    })

    assert intent.motion_plan is None


def test_segment_adapter_ignores_llm_motion_plans_even_with_renderer_fields():
    # Plans smuggling renderer params are dropped outright, never salvaged.
    intent = CharacterIntent.from_llm_segment({
        "motionPlan": {
            "durationMs": 1200,
            "source": "llm-semantic-plan",
            "steps": [
                {
                    "atMs": 0,
                    "durationMs": 600,
                    "primitive": "nod",
                    "intensity": 0.55,
                    "note": "agreement beat",
                },
                {
                    "atMs": 200,
                    "durationMs": 500,
                    "primitive": "ParamAngleX",
                    "intensity": 1,
                    "parameter": "ParamAngleX",
                },
            ],
        },
    })

    assert intent.motion_plan is None
