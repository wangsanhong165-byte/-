import json
import asyncio
from pathlib import Path

from app.bridge import server
from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.default_planner import DefaultPlanner
from app.runtime.presentation_capabilities import Live2DPresentationRegistry
from app.runtime.response_validator import ResponseValidator
from app.runtime.prompt_compiler import PromptCompiler


def _registry(tmp_path, config):
    config_dir = tmp_path / "config"
    models_dir = tmp_path / "models" / "live2d-models"
    config_dir.mkdir(parents=True)
    models_dir.mkdir(parents=True)
    (config_dir / "live2d_models.json").write_text(
        json.dumps(config), encoding="utf-8",
    )
    for model in config:
        (models_dir / model).mkdir()
    return Live2DPresentationRegistry(tmp_path)


def test_registry_exposes_only_configured_emotions_plus_safe_neutral(tmp_path):
    registry = _registry(tmp_path, {
        "model_a": {"prompt_emotions": ["happy", "shy", "not_real", "happy"]},
    })

    snapshot = registry.select("model_a")

    assert snapshot.model == "model_a"
    assert snapshot.allowed_emotions == ("neutral", "happy", "shy")


def test_registry_prefers_shirone_when_no_model_is_selected(tmp_path):
    registry = _registry(tmp_path, {
        "Design_genius_White": {"prompt_emotions": ["happy"]},
        "shirone": {"prompt_emotions": ["happy", "shy"]},
    })

    assert registry.snapshot().model == "shirone"


def test_planner_freezes_model_capabilities_for_the_whole_turn(tmp_path):
    registry = _registry(tmp_path, {
        "model_a": {"prompt_emotions": ["happy"]},
        "model_b": {"prompt_emotions": ["sad"]},
    })
    registry.select("model_a")
    turn = CharacterTurn(input=TurnInput(text="hello"))
    planner = DefaultPlanner(presentation_registry=registry)

    first = planner.plan(turn)
    registry.select("model_b")
    second = planner.plan(turn)

    assert turn.allowed_emotions == ("neutral", "happy")
    assert 'emotion" from: neutral, happy' in "\n".join(
        message["content"] for message in first.messages
    )
    assert 'emotion" from: neutral, happy' in "\n".join(
        message["content"] for message in second.messages
    )


def test_validator_rejects_globally_known_but_model_unsupported_emotion():
    result = ResponseValidator().validate(
        "",
        [{"text": "Hello", "emotion": "shy", "behavior": "speak"}],
        allowed_emotions=("neutral", "happy"),
    )

    assert result.segments[0]["emotion"] == "neutral"


def test_bridge_model_switch_updates_the_shared_planner_registry(tmp_path, monkeypatch):
    registry = _registry(tmp_path, {
        "model_a": {"prompt_emotions": ["happy"], "emotion_map": {"happy": "joy"}},
        "model_b": {"prompt_emotions": ["sad"], "emotion_map": {"sad": "tears"}},
    })
    registry.select("model_a")
    monkeypatch.setattr(server, "_get_presentation_registry", lambda: registry)
    monkeypatch.setattr(server, "_live2d_config", registry.config())
    monkeypatch.setattr(server, "_live2d_model", "model_a")
    monkeypatch.setattr(server, "_avatar_controller", None)

    result = asyncio.run(server.set_model({"model": "model_b"}))
    info = server._build_model_info()

    assert result["model"] == "model_b"
    assert result["promptEmotions"] == ["neutral", "sad"]
    assert registry.snapshot().model == "model_b"
    assert info["promptEmotions"] == ["neutral", "sad"]


def test_shirone_exposes_distinct_ordinary_and_strong_happiness():
    root = Path(__file__).resolve().parents[1]
    registry = Live2DPresentationRegistry(root)
    snapshot = registry.select("shirone")
    config = registry.model_config("shirone")

    assert "happy" in snapshot.allowed_emotions
    assert "joyful" in snapshot.allowed_emotions
    assert config["emotion_map"]["happy"] != config["emotion_map"]["joyful"]
    assert config["emotion_map"]["joyful"] == "星星眼"


def test_output_protocol_explains_happy_joyful_and_shy_semantics():
    prompt = PromptCompiler._output_protocol(
        "Chinese",
        "neutral, happy, joyful, shy",
        "speak",
    )

    assert "happy is for ordinary joy" in prompt
    assert "joyful for unmistakable high joy" in prompt
    assert "being praised" in prompt
    # Negated emotion words must not be read as the character's own emotion
    # (the "你不要生气了" production bug).
    assert "negated" in prompt.lower()


def test_semantic_fallback_distinguishes_strong_happiness_from_ordinary_happy():
    allowed = ("neutral", "happy", "joyful")
    ordinary = ResponseValidator().validate(
        "今天很开心。", [], allowed_emotions=allowed,
    )
    strong = ResponseValidator().validate(
        "太好了，我开心得想欢呼！", [], allowed_emotions=allowed,
    )

    assert ordinary.segments[0]["emotion"] == "happy"
    assert strong.segments[0]["emotion"] == "joyful"
    assert strong.segments[0]["intensity"] > ordinary.segments[0]["intensity"]
