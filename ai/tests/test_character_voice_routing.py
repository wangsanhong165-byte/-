from pathlib import Path

from app.domain.character.character import Character
from app.models.http_adapters import HTTPTTSAdapter
from app.modules.tts import api as tts_api
from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.default_planner import DefaultPlanner
from app.runtime.prompt_config import PromptConfigStore
from app.runtime.prompt_overrides import PromptOverrideStore
from app.runtime.steps import tts_step


def test_character_voice_configuration_is_routed_with_separate_reply_and_reference_languages(
    tmp_path: Path,
    monkeypatch,
):
    character_dir = tmp_path / "config" / "characters" / "lantern"
    model_dir = character_dir / "model"
    model_dir.mkdir(parents=True)
    for filename in ("reference.wav", "voice.ckpt", "voice.pth"):
        (model_dir / filename).write_bytes(b"asset")

    character = Character({
        "id": "lantern",
        "name": {"en": "Lantern"},
        "character_setting": "A concise persona.",
        "reply_language": "zh",
        "tts": {
            "engine": "gsvi-v2pro",
            "voice": "Lantern",
            "prompt_lang": "ja",
            "prompt_text": "reference transcript",
            "ref_audio": {"neutral": "model/reference.wav"},
            "custom_model": {
                "t2s": "model/voice.ckpt",
                "vits": "model/voice.pth",
            },
        },
    })
    turn = CharacterTurn(TurnInput(text="hello"))
    turn.character = character
    monkeypatch.setattr(tts_step, "_PROJECT_ROOT", tmp_path)

    # reply_language must NOT be forced as TTS text_lang: only an explicit
    # tts.text_lang overrides the engine's content-based auto-detection.
    assert tts_step._extract_voice_kwargs(turn) == {
        "engine": "gsvi-v2pro",
        "voice": "Lantern",
        "prompt_lang": "ja",
        "prompt_text": "reference transcript",
        "ref_audio_path": str(model_dir / "reference.wav"),
        "gpt_weights": str(model_dir / "voice.ckpt"),
        "sovits_weights": str(model_dir / "voice.pth"),
    }


def test_http_tts_adapter_forwards_character_specific_gsvi_options(monkeypatch):
    captured = {}

    class Response:
        content = b"audio"

        @staticmethod
        def raise_for_status():
            return None

    def fake_post(url, *, json, timeout):
        captured.update({"url": url, "json": json, "timeout": timeout})
        return Response()

    monkeypatch.setattr("app.models.http_adapters._LOCAL_SESSION.post", fake_post)
    adapter = HTTPTTSAdapter("http://tts.local", timeout=9)

    result = adapter.synthesize(
        "hello",
        engine="gsvi-v2pro",
        voice="Lantern",
        text_lang="zh",
        prompt_lang="ja",
        prompt_text="reference transcript",
        ref_audio_path="C:/roles/lantern/reference.wav",
        gpt_weights="C:/roles/lantern/voice.ckpt",
        sovits_weights="C:/roles/lantern/voice.pth",
    )

    assert result == b"audio"
    assert captured == {
        "url": "http://tts.local/v1/tts/synthesize",
        "timeout": 9,
        "json": {
            "text": "hello",
            "engine": "gsvi-v2pro",
            "voice": "Lantern",
            "text_lang": "zh",
            "prompt_lang": "ja",
            "prompt_text": "reference transcript",
            "ref_audio_path": "C:/roles/lantern/reference.wav",
            "gpt_weights": "C:/roles/lantern/voice.ckpt",
            "sovits_weights": "C:/roles/lantern/voice.pth",
        },
    }


def test_tts_api_selects_the_engine_declared_by_the_character(monkeypatch):
    captured = {}

    class Engine:
        def synthesize(self, text, **options):
            captured.update({"text": text, "options": options})
            return b"RIFFaudio"

    def fake_get_engine(name):
        captured["engine"] = name
        return Engine()

    monkeypatch.setattr(tts_api, "_get_engine", fake_get_engine)
    response = tts_api.synthesize_endpoint({
        "text": "hello", "engine": "gsvi-v2pro", "text_lang": "zh",
    })

    assert response.body == b"RIFFaudio"
    assert captured == {
        "engine": "gsvi-v2pro",
        "text": "hello",
        "options": {"text_lang": "zh"},
    }


def test_reply_language_does_not_follow_voice_reference_language(tmp_path: Path):
    character = Character({
        "id": "lantern",
        "name": {"en": "Lantern"},
        "character_setting": "A concise persona.",
        "reply_language": "zh",
        "tts": {"prompt_lang": "ja"},
    })
    turn = CharacterTurn(TurnInput(text="hello"))
    turn.character = character
    prompt_dir = tmp_path / "prompts"

    messages = DefaultPlanner(
        prompt_store=PromptOverrideStore(prompt_dir),
        prompt_config_store=PromptConfigStore(prompt_dir),
    ).plan(turn).messages
    system_text = "\n".join(
        message["content"] for message in messages if message["role"] == "system"
    )

    assert "native language is Chinese" in system_text
    assert "MUST be written in Chinese" in system_text
    assert "native language is Japanese" not in system_text


def test_cantonese_reply_language_is_not_silently_changed_to_english(tmp_path: Path):
    character = Character({
        "id": "lantern", "name": {"en": "Lantern"},
        "character_setting": "A concise persona.", "reply_language": "yue",
        "tts": {"prompt_lang": "zh"},
    })
    turn = CharacterTurn(TurnInput(text="hello"))
    turn.character = character
    prompt_dir = tmp_path / "prompts"
    messages = DefaultPlanner(
        prompt_store=PromptOverrideStore(prompt_dir),
        prompt_config_store=PromptConfigStore(prompt_dir),
    ).plan(turn).messages
    system_text = "\n".join(
        message["content"] for message in messages if message["role"] == "system"
    )
    assert "native language is Cantonese Chinese" in system_text
    assert "MUST be written in Cantonese Chinese" in system_text


def test_previous_emotion_is_context_not_a_default_for_the_next_turn(tmp_path: Path):
    character = Character({
        "id": "lantern", "name": {"en": "Lantern"},
        "character_setting": "A concise persona.", "reply_language": "zh",
    })
    character.emotion.current = "shy"
    turn = CharacterTurn(TurnInput(text="介绍一下今天的安排"))
    turn.character = character

    messages = DefaultPlanner(
        prompt_store=PromptOverrideStore(tmp_path / "prompts"),
        prompt_config_store=PromptConfigStore(tmp_path / "prompts"),
    ).plan(turn).messages
    system_text = "\n".join(
        message["content"] for message in messages if message["role"] == "system"
    )

    assert "Previous expression state: shy" in system_text
    assert "do not reuse it by default" in system_text
    assert "shy only for explicit embarrassment or romantic bashfulness" in system_text
    assert "never copy the previous expression" in system_text
