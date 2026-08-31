"""Voice registry — system-level voice packs shared across characters.

A voice pack is the atomic unit of GPT-SoVITS voice cloning: reference audio
+ GPT weights + SoVITS weights + transcript + language. Registering a voice
once under config/voices/<id>/ lets any character reference it by id instead
of embedding a copy inside its own directory.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from app.character.catalog import CharacterCatalog


class VoiceRegistry:
    """Own voice-pack registration and resolution under config/voices/<id>/."""

    _ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,47}$")
    _AUDIO_SUFFIXES = {".wav", ".flac", ".mp3", ".ogg", ".m4a"}
    _LANGUAGES = {"zh", "en", "ja", "ko", "yue"}

    def __init__(self, base_dir: Path | str | None = None) -> None:
        self._base = Path(base_dir or Path(__file__).resolve().parents[2]).resolve()
        self._voices_dir = self._base / "config" / "voices"

    # ── read ─────────────────────────────────────────────────────────────

    def list(self) -> list[dict[str, Any]]:
        """Return descriptors for every installed voice pack."""
        result: list[dict[str, Any]] = []
        if not self._voices_dir.exists():
            return result
        for directory in sorted(self._voices_dir.iterdir()):
            manifest = directory / "voice.json"
            if not directory.is_dir() or not manifest.is_file():
                continue
            try:
                data = json.loads(manifest.read_text("utf-8"))
                result.append(self._descriptor(str(data.get("id") or directory.name), data))
            except (KeyError, json.JSONDecodeError, OSError):
                continue
        return result

    def get(self, voice_id: str) -> dict[str, Any]:
        return self._descriptor(voice_id, self._manifest(voice_id))

    def resolve(self, voice_id: str) -> dict[str, Any]:
        """Absolute file paths plus metadata for a voice pack, or raise KeyError."""
        voice_dir = self._voice_dir(voice_id)
        manifest = self._manifest(voice_id)
        resolved: dict[str, Any] = {
            "id": voice_id,
            "name": str(manifest.get("name") or voice_id),
            "prompt_text": str(manifest.get("prompt_text") or ""),
            "prompt_lang": str(manifest.get("prompt_lang") or "en"),
            "ref_audio": self._abs(voice_dir, manifest.get("ref", "")),
            "gpt_weights": self._abs(voice_dir, manifest.get("gpt", "")),
            "sovits_weights": self._abs(voice_dir, manifest.get("vits", "")),
        }
        # Per-emotion delivery overrides (temperature/speed_factor...) consumed
        # by TTSStep._apply_emotion_params. Copied verbatim — an absent or
        # malformed key simply falls through to the built-in defaults there.
        emotion_params = manifest.get("emotion_params")
        if isinstance(emotion_params, dict):
            resolved["emotion_params"] = emotion_params
        return resolved

    # ── write ────────────────────────────────────────────────────────────

    def add(self, spec: dict[str, Any]) -> dict[str, Any]:
        """Validate and install a voice pack from selected files."""
        voice_id = str(spec.get("id", "")).strip().lower()
        if not self._ID.fullmatch(voice_id):
            raise ValueError("voice id must use 2-48 lowercase letters, numbers, _ or -")
        name = str(spec.get("name", "")).strip()
        if not name or len(name) > 80:
            raise ValueError("voice name is required and must be at most 80 characters")
        prompt_text = str(spec.get("prompt_text", "")).strip()
        prompt_lang = str(spec.get("prompt_lang", "")).strip().lower()
        if not prompt_text:
            raise ValueError("voice reference transcript is required")
        if prompt_lang not in self._LANGUAGES:
            raise ValueError(f"unsupported voice prompt language: {prompt_lang}")

        ref = self._required_file(spec, "reference_audio")
        gpt = self._required_file(spec, "t2s_model")
        vits = self._required_file(spec, "vits_model")
        if ref.suffix.lower() not in self._AUDIO_SUFFIXES:
            raise ValueError("reference audio must be wav, flac, mp3, ogg or m4a")
        if gpt.suffix.lower() != ".ckpt":
            raise ValueError("GPT text-to-semantic model must be a .ckpt file")
        if vits.suffix.lower() != ".pth":
            raise ValueError("SoVITS model must be a .pth file")
        CharacterCatalog._validate_audio_header(ref)
        CharacterCatalog._validate_weight_file(gpt, "GPT text-to-semantic")
        CharacterCatalog._validate_weight_file(vits, "SoVITS")

        voice_dir = self._voice_dir(voice_id)
        if voice_dir.exists():
            raise ValueError(f"voice already exists: {voice_id}")
        self._voices_dir.mkdir(parents=True, exist_ok=True)
        voice_dir.mkdir()
        try:
            shutil.copy2(ref, voice_dir / ref.name)
            shutil.copy2(gpt, voice_dir / gpt.name)
            shutil.copy2(vits, voice_dir / vits.name)
            manifest = {
                "id": voice_id,
                "name": name,
                "ref": ref.name,
                "gpt": gpt.name,
                "vits": vits.name,
                "prompt_text": prompt_text,
                "prompt_lang": prompt_lang,
            }
            self._write_manifest(voice_dir, manifest)
        except Exception:
            shutil.rmtree(voice_dir, ignore_errors=True)
            raise
        return self._descriptor(voice_id, manifest)

    # ── helpers ──────────────────────────────────────────────────────────

    def _voice_dir(self, voice_id: str) -> Path:
        return self._voices_dir / voice_id

    def _manifest(self, voice_id: str) -> dict[str, Any]:
        manifest = self._voice_dir(voice_id) / "voice.json"
        if not manifest.is_file():
            raise KeyError(f"voice not found: {voice_id}")
        try:
            return json.loads(manifest.read_text("utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise KeyError(f"voice not found: {voice_id}") from exc

    def _descriptor(self, voice_id: str, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": voice_id,
            "name": str(data.get("name") or voice_id),
            "prompt_text": str(data.get("prompt_text") or ""),
            "prompt_lang": str(data.get("prompt_lang") or "en"),
            "configured": self._configured(voice_id, data),
        }

    def _configured(self, voice_id: str, data: dict[str, Any]) -> bool:
        """True when every asset the manifest declares is present on disk.

        A pack that only declares a reference audio (GSVI-style, where model
        weights live on the TTS server) is complete with just that file; a
        pack that declares GPT/SoVITS weights must ship all of them.
        """
        voice_dir = self._voice_dir(voice_id)
        return bool(data.get("ref")) and all(
            (voice_dir / str(data[key])).is_file()
            for key in ("ref", "gpt", "vits")
            if data.get(key)
        )

    @staticmethod
    def _abs(voice_dir: Path, relative: object) -> str:
        value = str(relative or "").strip()
        if not value:
            return ""
        target = (voice_dir / value).resolve()
        try:
            target.relative_to(voice_dir)
        except ValueError:
            return ""
        return str(target)

    @staticmethod
    def _required_file(container: dict[str, Any], key: str) -> Path:
        path = Path(str(container.get(key, ""))).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"{key} is not a readable file")
        return path

    @staticmethod
    def _write_manifest(voice_dir: Path, manifest: dict[str, Any]) -> None:
        temporary = voice_dir / "voice.json.tmp"
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(voice_dir / "voice.json")
