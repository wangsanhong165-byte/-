import json
import wave
import zipfile
from pathlib import Path

import pytest

from app.character.voices import VoiceRegistry
from app.domain.character.character import Character
from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.steps import tts_step


def _write_voice_assets(tmp_path: Path, vits_tag: bytes = b"05") -> dict[str, str]:
    """Create valid reference audio + GPT/SoVITS checkpoint files."""
    ref = tmp_path / "ref.wav"
    with wave.open(str(ref), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(b"\0\0" * 320)

    t2s = tmp_path / "gpt.ckpt"
    vits = tmp_path / "sovits.pth"
    for path in (t2s, vits):
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("model/data.pkl", b"checkpoint" * 128)
    vits_bytes = vits.read_bytes()
    vits.write_bytes(vits_tag + vits_bytes[2:])
    return {
        "reference_audio": str(ref),
        "t2s_model": str(t2s),
        "vits_model": str(vits),
    }


def _spec(assets: dict[str, str], **overrides) -> dict:
    base = {
        "id": "monika",
        "name": "Monika",
        "prompt_text": "reference transcript",
        "prompt_lang": "en",
        **assets,
    }
    base.update(overrides)
    return base


def _character_with_tts(**tts_fields) -> Character:
    return Character({
        "id": "lantern",
        "name": {"en": "Lantern"},
        "reply_language": "zh",
        "tts": {"engine": "gsvi-v2pro", **tts_fields},
    })


def test_voice_registry_adds_lists_and_resolves_packs(tmp_path: Path):
    assets = _write_voice_assets(tmp_path)
    registry = VoiceRegistry(tmp_path)

    added = registry.add(_spec(assets))
    assert added == {
        "id": "monika",
        "name": "Monika",
        "prompt_text": "reference transcript",
        "prompt_lang": "en",
        "configured": True,
    }

    assert registry.list() == [added]

    voice_dir = tmp_path / "config" / "voices" / "monika"
    resolved = registry.resolve("monika")
    assert resolved["ref_audio"] == str(voice_dir / "ref.wav")
    assert resolved["gpt_weights"] == str(voice_dir / "gpt.ckpt")
    assert resolved["sovits_weights"] == str(voice_dir / "sovits.pth")
    assert resolved["prompt_text"] == "reference transcript"
    assert resolved["prompt_lang"] == "en"
    # Files were copied into the voice pack, not referenced in place.
    assert (voice_dir / "ref.wav").is_file()
    assert (voice_dir / "gpt.ckpt").is_file()
    assert (voice_dir / "sovits.pth").is_file()


def test_voice_registry_accepts_v2proplus_tagged_weights(tmp_path: Path):
    """A v2ProPlus ("06" tag) SoVITS checkpoint is a valid voice weight."""
    assets = _write_voice_assets(tmp_path, vits_tag=b"06")
    registry = VoiceRegistry(tmp_path)

    added = registry.add(_spec(assets))

    assert added["configured"] is True
    voice_dir = tmp_path / "config" / "voices" / "monika"
    assert (voice_dir / "sovits.pth").is_file()


def test_voice_registry_rejects_invalid_specs(tmp_path: Path):
    assets = _write_voice_assets(tmp_path)
    registry = VoiceRegistry(tmp_path)

    with pytest.raises(ValueError, match="voice id"):
        registry.add(_spec(assets, id="bad id"))
    with pytest.raises(ValueError, match="voice name"):
        registry.add(_spec(assets, name=""))
    with pytest.raises(ValueError, match="transcript"):
        registry.add(_spec(assets, prompt_text=""))
    with pytest.raises(ValueError, match="prompt language"):
        registry.add(_spec(assets, prompt_lang="xx"))
    with pytest.raises(ValueError, match="not a readable file"):
        registry.add(_spec(assets, t2s_model="missing.ckpt"))
    bad_wav = tmp_path / "bad.wav"
    bad_wav.write_bytes(b"not-a-real-wav")
    with pytest.raises(ValueError, match="content does not match"):
        registry.add(_spec(assets, reference_audio=str(bad_wav)))


def test_voice_registry_duplicate_and_missing(tmp_path: Path):
    assets = _write_voice_assets(tmp_path)
    registry = VoiceRegistry(tmp_path)
    registry.add(_spec(assets))
    with pytest.raises(ValueError, match="already exists"):
        registry.add(_spec(assets))
    with pytest.raises(KeyError, match="not found"):
        registry.resolve("ghost")


def _install_ref_only_pack(tmp_path: Path, extra_fields: dict) -> None:
    """Install a hand-written voice pack that declares only a reference audio."""
    voice_dir = tmp_path / "config" / "voices" / "monika"
    voice_dir.mkdir(parents=True)
    ref = voice_dir / "ref.wav"
    with wave.open(str(ref), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(b"\0\0" * 320)
    manifest = {
        "id": "monika",
        "name": "Monika",
        "ref": "ref.wav",
        "prompt_text": "reference transcript",
        "prompt_lang": "en",
        **extra_fields,
    }
    (voice_dir / "voice.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )


def test_ref_only_voice_pack_is_configured(tmp_path: Path):
    """A GSVI-style pack (reference audio only) is complete without weights."""
    _install_ref_only_pack(tmp_path, {})
    assert VoiceRegistry(tmp_path).get("monika")["configured"] is True


def test_pack_declaring_missing_weight_is_not_configured(tmp_path: Path):
    """A pack that declares a weight which is missing is incomplete."""
    _install_ref_only_pack(tmp_path, {"gpt": "missing.ckpt", "vits": "missing.pth"})
    assert VoiceRegistry(tmp_path).get("monika")["configured"] is False


def test_tts_step_resolves_system_voice_id(tmp_path: Path, monkeypatch):
    assets = _write_voice_assets(tmp_path)
    VoiceRegistry(tmp_path).add(_spec(assets))
    voice_dir = tmp_path / "config" / "voices" / "monika"

    turn = CharacterTurn(TurnInput(text="hello"))
    turn.character = _character_with_tts(voice_id="monika")
    monkeypatch.setattr(tts_step, "_PROJECT_ROOT", tmp_path)

    # No explicit tts.text_lang on the card: engine auto-detects from content.
    assert tts_step._extract_voice_kwargs(turn) == {
        "engine": "gsvi-v2pro",
        "voice": "Monika",
        "prompt_lang": "en",
        "prompt_text": "reference transcript",
        "ref_audio_path": str(voice_dir / "ref.wav"),
        "gpt_weights": str(voice_dir / "gpt.ckpt"),
        "sovits_weights": str(voice_dir / "sovits.pth"),
    }


def test_tts_step_falls_back_to_embedded_voice_when_voice_id_unknown(
    tmp_path: Path, monkeypatch
):
    character_dir = tmp_path / "config" / "characters" / "lantern"
    model_dir = character_dir / "model"
    model_dir.mkdir(parents=True)
    for filename in ("reference.wav", "voice.ckpt", "voice.pth"):
        (model_dir / filename).write_bytes(b"asset")

    turn = CharacterTurn(TurnInput(text="hello"))
    turn.character = _character_with_tts(
        voice_id="missing-voice",
        ref_audio={"neutral": "model/reference.wav"},
        custom_model={"t2s": "model/voice.ckpt", "vits": "model/voice.pth"},
    )
    monkeypatch.setattr(tts_step, "_PROJECT_ROOT", tmp_path)

    kwargs = tts_step._extract_voice_kwargs(turn)
    assert kwargs["ref_audio_path"] == str(model_dir / "reference.wav")
    assert kwargs["gpt_weights"] == str(model_dir / "voice.ckpt")
    assert kwargs["sovits_weights"] == str(model_dir / "voice.pth")
