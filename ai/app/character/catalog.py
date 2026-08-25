"""Create and enumerate complete local character packs behind one interface."""

from __future__ import annotations

import json
import re
import shutil
import struct
import tempfile
import threading
import time
import zipfile
import zlib
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
import soundfile

from app.domain.character.personality_profile import (
    PersonalityProfile,
    normalize_personality_profile,
)


_IMPORT_LOCK = threading.RLock()

# GPT-SoVITS saves Pro-series weights with the zip PK magic replaced by an
# ASCII version tag so foreign loaders cannot torch.load them directly.
# v1/v2 use "00"/"01", v3 "02"/"03", v4 "04", v2Pro "05", v2ProPlus "06".
_GPT_SOVITS_VERSION_TAGS = {b"00", b"01", b"02", b"03", b"04", b"05", b"06"}


@dataclass(frozen=True)
class CharacterCatalogSnapshot:
    character_id: str
    card: bytes
    index: bytes | None


class CharacterCatalog:
    """Own character-card, Live2D, voice-asset, and index persistence."""

    _ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,47}$")
    _LANGUAGES = {"zh", "en", "ja", "ko", "yue"}
    _AUDIO_SUFFIXES = {".wav", ".flac", ".mp3", ".ogg", ".m4a"}
    _UPDATE_FIELDS = frozenset({
        "name", "persona", "personality_profile", "reply_language",
        "model_id", "voice_id",
    })

    def __init__(self, base_dir: Path | str | None = None) -> None:
        self._base = Path(base_dir or Path(__file__).resolve().parents[2]).resolve()
        self._characters_dir = self._base / "config" / "characters"
        self._models_dir = self._base / "models" / "live2d-models"
        self._profiles_dir = self._base / "config" / "avatar_profiles"
        self._live2d_config_path = self._base / "config" / "live2d_models.json"
        self._index_path = self._characters_dir / "index.yaml"

    def list(self) -> list[dict[str, Any]]:
        """Return role descriptors derived from installed character packs."""
        with _IMPORT_LOCK:
            return self._list_locked()

    def _list_locked(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        if not self._characters_dir.exists():
            return result
        for directory in sorted(self._characters_dir.iterdir()):
            card_path = directory / "character.json"
            if not directory.is_dir() or not card_path.is_file():
                continue
            try:
                card = json.loads(card_path.read_text("utf-8"))
                detail = self._detail_from_card(directory, card)
                result.append({
                    "id": detail["id"],
                    "name": detail["name"],
                    "reply_language": detail["reply_language"],
                    "live2d_model": detail["live2d_model"],
                    "voice_configured": detail["voice_configured"],
                })
            except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
                continue
        return result

    def get(self, character_id: str) -> dict[str, Any]:
        """Return the safe editable projection for one installed character."""
        with _IMPORT_LOCK:
            directory, card = self._read_card_locked(character_id)
            return self._detail_from_card(directory, card)

    def update(
        self,
        character_id: str,
        raw_changes: dict[str, Any],
    ) -> dict[str, Any]:
        """Patch one character card through the editable-field whitelist.

        The card and index are restored together if either replacement fails.
        Unknown card and index fields remain byte-for-byte equivalent at the
        data level because this method mutates only the documented fields.
        """
        with _IMPORT_LOCK:
            return self._update_locked(character_id, raw_changes)

    def snapshot(self, character_id: str) -> CharacterCatalogSnapshot:
        """Capture the exact persistence bytes needed for orchestration rollback."""
        with _IMPORT_LOCK:
            directory, _ = self._read_card_locked(character_id)
            return CharacterCatalogSnapshot(
                character_id=str(character_id).strip().lower(),
                card=(directory / "character.json").read_bytes(),
                index=self._index_path.read_bytes() if self._index_path.exists() else None,
            )

    def restore(self, snapshot: CharacterCatalogSnapshot) -> None:
        """Restore an update snapshot without reconstructing a character card."""
        with _IMPORT_LOCK:
            directory, _ = self._read_card_locked(snapshot.character_id)
            (directory / "character.json").write_bytes(snapshot.card)
            if snapshot.index is None:
                self._index_path.unlink(missing_ok=True)
            else:
                self._index_path.write_bytes(snapshot.index)

    def _update_locked(
        self,
        character_id: str,
        raw_changes: dict[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(raw_changes, dict):
            raise ValueError("character update must be an object")
        if "id" in raw_changes:
            raise ValueError("character id is read-only")
        unknown = sorted(set(raw_changes) - self._UPDATE_FIELDS)
        if unknown:
            raise ValueError(
                "unsupported character update fields: " + ", ".join(unknown)
            )

        directory, card = self._read_card_locked(character_id)
        current = self._detail_from_card(directory, card)
        resource_fields = {"model_id", "voice_id"}.intersection(raw_changes)
        if resource_fields and not current["resource_references_editable"]:
            raise ValueError("embedded character resources are read-only")

        name = str(raw_changes.get("name", current["name"])).strip()
        persona = str(raw_changes.get("persona", current["persona"]))
        persona = persona.replace("\r\n", "\n").strip()
        reply_language = str(
            raw_changes.get("reply_language", current["reply_language"])
        ).strip().lower()
        self._validate_editable_fields(name, persona, reply_language)

        updated = deepcopy(card)
        if "name" in raw_changes:
            updated["name"] = self._updated_name_map(card.get("name"), name)
        if "persona" in raw_changes:
            updated["character_setting"] = persona
        if "personality_profile" in raw_changes:
            updated["personality_profile"] = normalize_personality_profile(
                raw_changes["personality_profile"]
            )
        if "reply_language" in raw_changes:
            updated["reply_language"] = reply_language

        if "model_id" in raw_changes:
            requested_model = str(raw_changes.get("model_id") or "").strip()
            model_id = (
                requested_model
                if requested_model == current["model_id"]
                else self._validate_model_reference(requested_model)
            )
            live2d = updated.get("live2d")
            if not isinstance(live2d, dict):
                live2d = {}
                updated["live2d"] = live2d
            live2d["model"] = model_id
        if "voice_id" in raw_changes:
            requested_voice = str(raw_changes.get("voice_id") or "").strip()
            voice_id = (
                requested_voice
                if requested_voice == current["voice_id"]
                else self._validate_voice_reference(requested_voice)
            )
            tts = updated.get("tts")
            if not isinstance(tts, dict):
                tts = {}
                updated["tts"] = tts
            tts["voice_id"] = voice_id

        index = self._index_with_updated_name(str(current["id"]), name)
        card_path = directory / "character.json"
        previous_card = card_path.read_bytes()
        previous_index = self._index_path.read_bytes() if self._index_path.exists() else None
        try:
            self._atomic_text(
                card_path,
                json.dumps(updated, ensure_ascii=False, indent=2) + "\n",
            )
            self._atomic_text(
                self._index_path,
                yaml.safe_dump(index, allow_unicode=True, sort_keys=False),
            )
        except Exception:
            card_path.write_bytes(previous_card)
            if previous_index is None:
                self._index_path.unlink(missing_ok=True)
            else:
                self._index_path.write_bytes(previous_index)
            raise
        return self._detail_from_card(directory, updated)

    def _read_card_locked(
        self,
        character_id: str,
    ) -> tuple[Path, dict[str, Any]]:
        normalized = str(character_id or "").strip().lower()
        if not self._ID.fullmatch(normalized):
            raise ValueError("invalid character id")
        directory = self._characters_dir / normalized
        card_path = directory / "character.json"
        if not card_path.is_file():
            raise KeyError(f"character not found: {normalized}")
        try:
            card = json.loads(card_path.read_text("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid character card: {normalized}") from exc
        if not isinstance(card, dict) or str(card.get("id", "")) != normalized:
            raise ValueError(f"character card id mismatch: {normalized}")
        return directory, card

    def _detail_from_card(
        self,
        directory: Path,
        card: dict[str, Any],
    ) -> dict[str, Any]:
        character_id = str(card["id"])
        name = self._display_name(card.get("name"), character_id)
        tts = card.get("tts") if isinstance(card.get("tts"), dict) else {}
        live2d = card.get("live2d") if isinstance(card.get("live2d"), dict) else {}
        voice_id = str(tts.get("voice_id", "")).strip()
        embedded_voice = bool(tts.get("custom_model") or tts.get("ref_audio"))
        reference_mode = bool(voice_id) and not embedded_voice
        voice_name = str(tts.get("voice", "") or voice_id)
        if reference_mode:
            from app.character.voices import VoiceRegistry
            try:
                voice_name = str(VoiceRegistry(self._base).get(voice_id)["name"])
            except (KeyError, ValueError):
                pass
        return {
            "id": character_id,
            "name": name,
            "persona": str(
                card.get("character_setting") or card.get("system_prompt", "")
            ),
            "personality_profile": PersonalityProfile.from_card(card).to_dict(),
            "reply_language": str(
                card.get("reply_language") or tts.get("prompt_lang") or "en"
            ),
            "model_id": str(live2d.get("model", "")),
            "voice_id": voice_id,
            "voice_name": voice_name,
            "resource_mode": "reference" if reference_mode else "embedded",
            "resource_references_editable": reference_mode,
            "live2d_model": str(live2d.get("model", "")),
            "voice_configured": self._voice_configured(directory, tts),
        }

    @staticmethod
    def _display_name(raw_name: Any, character_id: str) -> str:
        if isinstance(raw_name, dict):
            return next(
                (str(value) for value in raw_name.values() if value),
                character_id,
            )
        return str(raw_name or character_id)

    @staticmethod
    def _updated_name_map(raw_name: Any, name: str) -> dict[str, Any]:
        if isinstance(raw_name, dict) and raw_name:
            return {str(language): name for language in raw_name}
        return {"zh": name, "en": name, "ja": name}

    def _voice_configured(self, directory: Path, tts: dict[str, Any]) -> bool:
        voice_id = str(tts.get("voice_id", "")).strip()
        if voice_id:
            from app.character.voices import VoiceRegistry
            try:
                return bool(VoiceRegistry(self._base).get(voice_id).get("configured"))
            except (KeyError, ValueError):
                return False
        custom = tts.get("custom_model", {})
        refs = tts.get("ref_audio", {})
        voice_paths = [
            refs.get("neutral", "") if isinstance(refs, dict) else "",
            custom.get("t2s", "") if isinstance(custom, dict) else "",
            custom.get("vits", "") if isinstance(custom, dict) else "",
        ]
        return all(
            relative and (directory / relative).is_file()
            for relative in voice_paths
        )

    @staticmethod
    def _validate_editable_fields(name: str, persona: str, reply_language: str) -> None:
        if not name or len(name) > 80:
            raise ValueError("character name is required and must be at most 80 characters")
        if not persona or len(persona) > 20_000:
            raise ValueError("persona is required and must be at most 20000 characters")
        if reply_language not in CharacterCatalog._LANGUAGES:
            raise ValueError(f"unsupported reply language: {reply_language}")

    def _validate_model_reference(self, raw_model_id: Any) -> str:
        model_id = str(raw_model_id or "").strip()
        if not model_id:
            raise ValueError("model_id is required")
        relative = Path(model_id)
        if relative.is_absolute() or len(relative.parts) != 1 or relative.name != model_id:
            raise ValueError("model_id must name one installed model directory")
        models_root = self._models_dir.resolve()
        model_dir = (models_root / relative).resolve()
        try:
            contained = model_dir.relative_to(models_root)
        except ValueError as exc:
            raise ValueError("model_id must stay inside the model directory") from exc
        if len(contained.parts) != 1:
            raise ValueError("model_id must name one installed model directory")
        if not model_dir.is_dir() or not any(model_dir.glob("*.model3.json")):
            raise ValueError(f"referenced Live2D model is not installed: {model_id}")
        return model_id

    def _validate_voice_reference(self, raw_voice_id: Any) -> str:
        voice_id = str(raw_voice_id or "").strip()
        if not voice_id:
            raise ValueError("voice_id is required")
        try:
            from app.character.voices import VoiceRegistry
            VoiceRegistry(self._base).resolve(voice_id)
        except KeyError as exc:
            raise ValueError(f"referenced voice is not installed: {voice_id}") from exc
        return voice_id

    def _index_with_updated_name(
        self,
        character_id: str,
        name: str,
    ) -> dict[str, Any]:
        index: dict[str, Any] = {}
        if self._index_path.exists():
            loaded = yaml.safe_load(self._index_path.read_text("utf-8"))
            if isinstance(loaded, dict):
                index = loaded
        characters = index.get("characters", [])
        if not isinstance(characters, list):
            characters = []
        updated_characters: list[Any] = []
        found = False
        for item in characters:
            if isinstance(item, dict) and item.get("id") == character_id:
                replacement = deepcopy(item)
                replacement["name"] = name
                updated_characters.append(replacement)
                found = True
            else:
                updated_characters.append(item)
        if not found:
            updated_characters.append({
                "id": character_id,
                "name": name,
                "path": f"characters/{character_id}/character.json",
            })
        index["characters"] = updated_characters
        index.setdefault("default", character_id)
        return index

    def create(self, raw_spec: dict[str, Any]) -> dict[str, Any]:
        """Validate and atomically install one character.

        Two shapes are accepted:
        - reference spec: ``{id, name, persona, reply_language, model_id,
          voice_id}`` — the character only references system-level model and
          voice packs, and nothing is copied.
        - full-import spec: ``{assets: {...}, voice: {...}}`` — copies a
          complete Live2D + voice pack into the character (legacy flow).
        """
        with _IMPORT_LOCK:
            return self._create_locked(raw_spec)

    def delete(self, character_id: str) -> dict[str, Any]:
        """Delete one character definition while preserving shared assets.

        Live2D models and voice packs are system-level resources and may be
        referenced by other characters, so this operation only removes the
        character card directory and its index entry.
        """
        with _IMPORT_LOCK:
            character_id = str(character_id or "").strip().lower()
            if not self._ID.fullmatch(character_id):
                raise ValueError("invalid character id")
            installed = self._list_locked()
            ids = [str(item.get("id", "")) for item in installed]
            if character_id not in ids:
                raise KeyError(f"character not found: {character_id}")
            if len(ids) <= 1:
                raise ValueError("cannot delete the last character")

            character_dir = self._characters_dir / character_id
            previous_index = (
                self._index_path.read_bytes() if self._index_path.exists() else None
            )
            staging_root = self._base / "data" / "delete-staging"
            staging_root.mkdir(parents=True, exist_ok=True)
            staged_dir = Path(tempfile.mkdtemp(
                prefix=f".{character_id}-", dir=staging_root
            )) / "character"
            fallback_id = next(item for item in ids if item != character_id)
            try:
                self._replace_directory(character_dir, staged_dir)
                self._remove_from_index(character_id, fallback_id)
                shutil.rmtree(staged_dir.parent)
            except Exception:
                if staged_dir.exists() and not character_dir.exists():
                    self._replace_directory(staged_dir, character_dir)
                if previous_index is None:
                    self._index_path.unlink(missing_ok=True)
                else:
                    self._index_path.write_bytes(previous_index)
                shutil.rmtree(staged_dir.parent, ignore_errors=True)
                raise
            return {"id": character_id, "fallback_character_id": fallback_id}

    def _create_locked(self, raw_spec: dict[str, Any]) -> dict[str, Any]:
        if self._is_reference_spec(raw_spec):
            return self._create_reference(raw_spec)
        spec = self._validate_spec(raw_spec)
        character_id = spec["id"]
        character_dir = self._characters_dir / character_id
        model_dir = self._models_dir / character_id
        if character_dir.exists() or model_dir.exists():
            raise ValueError(f"character already exists: {character_id}")

        self._characters_dir.mkdir(parents=True, exist_ok=True)
        self._models_dir.mkdir(parents=True, exist_ok=True)
        staging_dir = self._base / "data" / "import-staging"
        staging_dir.mkdir(parents=True, exist_ok=True)
        stage_root = Path(tempfile.mkdtemp(prefix=f".{character_id}-", dir=staging_dir))
        character_stage = stage_root / "character"
        model_stage = stage_root / "live2d"
        character_stage.mkdir()
        model_stage.mkdir()
        registrations = {
            path: path.read_bytes() if path.is_file() else None
            for path in (
                self._live2d_config_path,
                self._index_path,
                self._profiles_dir / f"{character_id}.json",
            )
        }
        installed: list[Path] = []
        try:
            self._stage_character(spec, character_stage)
            self._stage_live2d(spec, model_stage)
            self._replace_directory(model_stage, model_dir)
            installed.append(model_dir)
            self._replace_directory(character_stage, character_dir)
            installed.append(character_dir)
            self._register(character_id, spec["name"])
        except Exception:
            for path in reversed(installed):
                shutil.rmtree(path, ignore_errors=True)
            for path, previous in registrations.items():
                if previous is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(previous)
            raise
        finally:
            shutil.rmtree(stage_root, ignore_errors=True)

        return {
            "id": character_id,
            "name": spec["name"],
            "reply_language": spec["reply_language"],
            "live2d_model": character_id,
            "voice_configured": True,
        }

    # ── reference-mode creation ──────────────────────────────────────────

    @staticmethod
    def _is_reference_spec(raw_spec: dict[str, Any]) -> bool:
        return "model_id" in raw_spec and "voice_id" in raw_spec

    def _create_reference(self, raw_spec: dict[str, Any]) -> dict[str, Any]:
        spec = self._validate_reference_spec(raw_spec)
        character_id = spec["id"]
        character_dir = self._characters_dir / character_id
        if character_dir.exists():
            raise ValueError(f"character already exists: {character_id}")

        self._characters_dir.mkdir(parents=True, exist_ok=True)
        character_dir.mkdir()
        previous_index = (
            self._index_path.read_bytes() if self._index_path.exists() else None
        )
        try:
            self._write_card(character_dir, self._reference_card(spec))
            self._register_index(character_id, spec["name"])
        except Exception:
            shutil.rmtree(character_dir, ignore_errors=True)
            if previous_index is None:
                self._index_path.unlink(missing_ok=True)
            else:
                self._index_path.write_bytes(previous_index)
            raise
        return {
            "id": character_id,
            "name": spec["name"],
            "reply_language": spec["reply_language"],
            "live2d_model": spec["model_id"],
            "voice_configured": True,
        }

    def _validate_reference_spec(self, raw_spec: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(raw_spec, dict):
            raise ValueError("character specification must be an object")
        character_id = str(raw_spec.get("id", "")).strip().lower()
        if not self._ID.fullmatch(character_id):
            raise ValueError("character id must use 2-48 lowercase letters, numbers, _ or -")
        name = str(raw_spec.get("name", "")).strip()
        persona = str(raw_spec.get("persona", "")).replace("\r\n", "\n").strip()
        reply_language = str(raw_spec.get("reply_language", "")).strip().lower()
        self._validate_editable_fields(name, persona, reply_language)
        personality_profile = normalize_personality_profile(
            raw_spec.get("personality_profile")
        )
        model_id = self._validate_model_reference(raw_spec.get("model_id"))
        voice_id = self._validate_voice_reference(raw_spec.get("voice_id"))

        return {
            "id": character_id,
            "name": name,
            "persona": persona,
            "personality_profile": personality_profile,
            "reply_language": reply_language,
            "model_id": model_id,
            "voice_id": voice_id,
        }

    def _reference_card(self, spec: dict[str, Any]) -> dict[str, Any]:
        from app.character.voices import VoiceRegistry
        voice = VoiceRegistry(self._base).resolve(spec["voice_id"])
        card = {
            "$schema": "character/v3",
            "id": spec["id"],
            "name": {"zh": spec["name"], "en": spec["name"], "ja": spec["name"]},
            "reply_language": spec["reply_language"],
            "identity": spec["persona"],
            "character_setting": spec["persona"],
            "live2d": {"model": spec["model_id"]},
            "tts": {
                "engine": "gsvi-v2pro",
                "voice": voice["name"],
                "voice_id": spec["voice_id"],
                "prompt_text": voice["prompt_text"],
                "prompt_lang": voice["prompt_lang"],
            },
            "rules": {"max_segments_per_reply": 5, "avoid": ["Markdown"]},
        }
        if spec["personality_profile"]:
            card["personality_profile"] = spec["personality_profile"]
        return card

    @staticmethod
    def _write_card(character_dir: Path, card: dict[str, Any]) -> None:
        (character_dir / "character.json").write_text(
            json.dumps(card, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (character_dir / "pinned.md").write_text("", encoding="utf-8")

    @staticmethod
    def _replace_directory(source: Path, target: Path) -> None:
        """Retry atomic directory moves briefly while Windows scanners release handles."""
        for attempt in range(6):
            try:
                source.replace(target)
                return
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.04 * (attempt + 1))

    def register_model(self, model_id: str) -> dict[str, Any]:
        """Register a Live2D model directory at the system level.

        Dropping a directory into models/live2d-models/<id> already makes it
        visible to the model catalog; this additionally guarantees the two
        side registries (live2d_models.json and avatar_profiles/<id>.json)
        have entries so the model is switchable and attachable.
        """
        model_id = str(model_id or "").strip()
        if not model_id or not self._ID.fullmatch(model_id):
            raise ValueError("model id must use 2-48 lowercase letters, numbers, _ or -")
        model_dir = self._models_dir / model_id
        if not model_dir.is_dir() or not any(model_dir.glob("*.model3.json")):
            raise ValueError(f"model is not installed: {model_id}")

        live2d = self._read_json(self._live2d_config_path)
        if model_id not in live2d:
            live2d[model_id] = {
                "prompt_emotions": ["neutral"],
                "emotion_map": {"neutral": ""},
                "behaviors": [],
                "behavior_map": {},
            }
            self._atomic_text(
                self._live2d_config_path,
                json.dumps(live2d, ensure_ascii=False, indent=2) + "\n",
            )

        profile_path = self._profiles_dir / f"{model_id}.json"
        if not profile_path.exists():
            self._profiles_dir.mkdir(parents=True, exist_ok=True)
            self._atomic_text(
                profile_path,
                json.dumps({"model": model_id}, ensure_ascii=False, indent=2) + "\n",
            )

        return {
            "id": model_id,
            "live2d_model": model_id,
            "profile": "present",
        }

    def _validate_spec(self, raw_spec: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(raw_spec, dict):
            raise ValueError("character specification must be an object")
        character_id = str(raw_spec.get("id", "")).strip().lower()
        if not self._ID.fullmatch(character_id):
            raise ValueError("character id must use 2-48 lowercase letters, numbers, _ or -")
        name = str(raw_spec.get("name", "")).strip()
        persona = str(raw_spec.get("persona", "")).replace("\r\n", "\n").strip()
        reply_language = str(raw_spec.get("reply_language", "")).strip().lower()
        if not name or len(name) > 80:
            raise ValueError("character name is required and must be at most 80 characters")
        if not persona or len(persona) > 20_000:
            raise ValueError("persona is required and must be at most 20000 characters")
        if reply_language not in self._LANGUAGES:
            raise ValueError(f"unsupported reply language: {reply_language}")
        personality_profile = normalize_personality_profile(
            raw_spec.get("personality_profile")
        )

        assets = raw_spec.get("assets")
        voice = raw_spec.get("voice")
        if not isinstance(assets, dict) or not isinstance(voice, dict):
            raise ValueError("complete Live2D and voice assets are required")

        live2d_directory = self._required_directory(assets, "live2d_directory")
        model_files = sorted(live2d_directory.glob("*.model3.json"))
        if len(model_files) != 1:
            raise ValueError("Live2D directory must contain exactly one top-level .model3.json")
        live2d_assets = self._validate_model_references(live2d_directory, model_files[0])

        reference_audio = self._required_file(assets, "reference_audio")
        t2s_model = self._required_file(assets, "t2s_model")
        vits_model = self._required_file(assets, "vits_model")
        if reference_audio.suffix.lower() not in self._AUDIO_SUFFIXES:
            raise ValueError("reference audio must be wav, flac, mp3, ogg or m4a")
        if t2s_model.suffix.lower() != ".ckpt":
            raise ValueError("GPT text-to-semantic model must be a .ckpt file")
        if vits_model.suffix.lower() != ".pth":
            raise ValueError("SoVITS model must be a .pth file")
        self._validate_audio_header(reference_audio)
        self._validate_weight_file(t2s_model, "GPT text-to-semantic")
        self._validate_weight_file(vits_model, "SoVITS")

        prompt_text = str(voice.get("prompt_text", "")).strip()
        prompt_language = str(voice.get("prompt_language", "")).strip().lower()
        if not prompt_text:
            raise ValueError("voice reference transcript is required")
        if prompt_language not in self._LANGUAGES:
            raise ValueError(f"unsupported voice prompt language: {prompt_language}")

        return {
            "id": character_id,
            "name": name,
            "persona": persona,
            "personality_profile": personality_profile,
            "reply_language": reply_language,
            "live2d_directory": live2d_directory,
            "model_json": model_files[0],
            "live2d_assets": live2d_assets,
            "reference_audio": reference_audio,
            "t2s_model": t2s_model,
            "vits_model": vits_model,
            "prompt_text": prompt_text,
            "prompt_language": prompt_language,
        }

    @staticmethod
    def _required_directory(container: dict[str, Any], key: str) -> Path:
        path = Path(str(container.get(key, ""))).expanduser().resolve()
        if not path.is_dir():
            raise ValueError(f"{key} is not a readable directory")
        return path

    @staticmethod
    def _required_file(container: dict[str, Any], key: str) -> Path:
        path = Path(str(container.get(key, ""))).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"{key} is not a readable file")
        return path

    @staticmethod
    def _validate_model_references(source_dir: Path, model_json: Path) -> list[Path]:
        try:
            model = json.loads(model_json.read_text("utf-8"))
            references = model["FileReferences"]
            if not isinstance(references, dict):
                raise TypeError("FileReferences must be an object")
            relative_files: list[str] = []

            def collect(value: Any, key: str = "") -> None:
                if isinstance(value, dict):
                    for child_key, child in value.items():
                        collect(child, str(child_key))
                elif isinstance(value, list):
                    for child in value:
                        collect(child, key)
                elif isinstance(value, str) and key in {
                    "Moc", "File", "Sound", "Physics", "Pose",
                    "UserData", "DisplayInfo", "Textures",
                }:
                    relative_files.append(value)

            collect(references)
            if not references.get("Moc") or not references.get("Textures"):
                raise KeyError("Moc and Textures are required")
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise ValueError("invalid Live2D model3.json") from exc
        validated: list[Path] = []
        for relative in dict.fromkeys(relative_files):
            target = (source_dir / str(relative)).resolve()
            try:
                target.relative_to(source_dir.resolve())
            except ValueError as exc:
                raise ValueError("Live2D references must stay inside the selected directory") from exc
            if not target.is_file():
                raise ValueError(f"Live2D referenced asset is missing: {relative}")
            CharacterCatalog._validate_live2d_asset(target)
            validated.append(target)
        return validated

    @staticmethod
    def _validate_live2d_asset(path: Path) -> None:
        suffix = path.suffix.lower()
        with path.open("rb") as handle:
            header = handle.read(16)
        if suffix == ".moc3":
            valid = (
                path.stat().st_size >= 1024
                and header.startswith(b"MOC3")
                and header[4] in {3, 4, 5}
            )
        elif suffix == ".png":
            valid = CharacterCatalog._validate_png(path)
        elif suffix in {".jpg", ".jpeg"}:
            valid = path.stat().st_size >= 32 and header.startswith(b"\xff\xd8\xff")
        elif suffix == ".webp":
            valid = (
                path.stat().st_size >= 32
                and header.startswith(b"RIFF")
                and header[8:12] == b"WEBP"
            )
        elif suffix == ".json":
            try:
                valid = isinstance(json.loads(path.read_text("utf-8")), dict)
            except (json.JSONDecodeError, UnicodeDecodeError, OSError):
                valid = False
        else:
            # Referenced sounds and forward-compatible Cubism resources are
            # still required to be non-empty; known core formats are parsed
            # above instead of being accepted by extension alone.
            valid = path.stat().st_size > 0
        if not valid:
            raise ValueError(f"Live2D asset content does not match its file type: {path.name}")

    @staticmethod
    def _validate_png(path: Path) -> bool:
        try:
            with path.open("rb") as handle:
                if handle.read(8) != b"\x89PNG\r\n\x1a\n":
                    return False
                saw_header = saw_image = False
                while True:
                    raw_length = handle.read(4)
                    if len(raw_length) != 4:
                        return False
                    length = struct.unpack(">I", raw_length)[0]
                    if length > 256 * 1024 * 1024:
                        return False
                    chunk_type = handle.read(4)
                    data = handle.read(length)
                    raw_crc = handle.read(4)
                    if len(chunk_type) != 4 or len(data) != length or len(raw_crc) != 4:
                        return False
                    expected = struct.unpack(">I", raw_crc)[0]
                    if zlib.crc32(chunk_type + data) & 0xFFFFFFFF != expected:
                        return False
                    if chunk_type == b"IHDR":
                        if saw_header or length != 13:
                            return False
                        width, height = struct.unpack(">II", data[:8])
                        saw_header = width > 0 and height > 0
                    elif chunk_type == b"IDAT":
                        saw_image = True
                    elif chunk_type == b"IEND":
                        return saw_header and saw_image and length == 0
        except (OSError, struct.error):
            return False

    @staticmethod
    def _validate_audio_header(path: Path) -> None:
        with path.open("rb") as handle:
            header = handle.read(16)
        suffix = path.suffix.lower()
        valid = {
            ".wav": header.startswith(b"RIFF"),
            ".flac": header.startswith(b"fLaC"),
            ".mp3": header.startswith(b"ID3") or header.startswith(b"\xff"),
            ".ogg": header.startswith(b"OggS"),
            ".m4a": len(header) >= 8 and header[4:8] == b"ftyp",
        }.get(suffix, False)
        try:
            audio = soundfile.info(str(path)) if valid else None
            decodable = bool(
                audio
                and audio.frames > 0
                and audio.samplerate > 0
                and audio.channels > 0
            )
        except (OSError, RuntimeError):
            decodable = False
        if path.stat().st_size < 44 or not valid or not decodable:
            raise ValueError("reference audio content does not match its file type")

    @staticmethod
    def _validate_weight_file(path: Path, label: str) -> None:
        with path.open("rb") as handle:
            header = handle.read(4)
        if path.stat().st_size < 1024:
            raise ValueError(f"{label} weights are not a supported PyTorch checkpoint")
        if header == b"PK\x03\x04":
            restore_header = False
        elif header[:2] in _GPT_SOVITS_VERSION_TAGS and header[2:4] == b"\x03\x04":
            restore_header = True
        else:
            raise ValueError(f"{label} weights are not a supported PyTorch checkpoint")
        try:
            with path.open("rb") as handle:
                view = _CheckpointReader(handle, restore_header=restore_header)
                with zipfile.ZipFile(view) as archive:
                    if not archive.infolist() or archive.testzip() is not None:
                        raise zipfile.BadZipFile("checkpoint CRC failed")
        except (OSError, zipfile.BadZipFile) as exc:
            raise ValueError(f"{label} weights are damaged or incomplete") from exc

    @staticmethod
    def _stage_character(spec: dict[str, Any], stage: Path) -> None:
        model_dir = stage / "model"
        model_dir.mkdir()
        shutil.copy2(spec["reference_audio"], model_dir / spec["reference_audio"].name)
        shutil.copy2(spec["t2s_model"], model_dir / spec["t2s_model"].name)
        shutil.copy2(spec["vits_model"], model_dir / spec["vits_model"].name)
        (stage / "pinned.md").write_text("", encoding="utf-8")
        card = {
            "$schema": "character/v3",
            "id": spec["id"],
            "name": {"zh": spec["name"], "en": spec["name"], "ja": spec["name"]},
            "reply_language": spec["reply_language"],
            "identity": spec["persona"],
            "character_setting": spec["persona"],
            "live2d": {"model": spec["id"]},
            "tts": {
                "engine": "gsvi-v2pro",
                "voice": spec["name"],
                "prompt_text": spec["prompt_text"],
                "prompt_lang": spec["prompt_language"],
                "ref_audio": {
                    "neutral": f"model/{spec['reference_audio'].name}",
                },
                "custom_model": {
                    "t2s": f"model/{spec['t2s_model'].name}",
                    "vits": f"model/{spec['vits_model'].name}",
                },
            },
            "rules": {"max_segments_per_reply": 5, "avoid": ["Markdown"]},
        }
        if spec["personality_profile"]:
            card["personality_profile"] = spec["personality_profile"]
        (stage / "character.json").write_text(
            json.dumps(card, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _stage_live2d(spec: dict[str, Any], stage: Path) -> None:
        source = spec["live2d_directory"]
        for item in spec["live2d_assets"]:
            relative = item.relative_to(source)
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, destination)
        shutil.copy2(spec["model_json"], stage / f"{spec['id']}.model3.json")

    def _register(self, character_id: str, name: str) -> None:
        live2d = self._read_json(self._live2d_config_path)
        live2d[character_id] = {
            "prompt_emotions": ["neutral"],
            "emotion_map": {"neutral": ""},
            "behaviors": [],
            "behavior_map": {},
        }
        self._atomic_text(
            self._live2d_config_path,
            json.dumps(live2d, ensure_ascii=False, indent=2) + "\n",
        )

        self._register_index(character_id, name)

        # The frontend refuses to attach a Live2D model that has no avatar
        # capability profile (attachCommittedModel requires
        # avatarProfiles[model].model === model). Emit a minimal profile so an
        # imported character is immediately activatable; the model keeps its
        # default bindings/expressions when profile fields are absent.
        self._profiles_dir.mkdir(parents=True, exist_ok=True)
        self._atomic_text(
            self._profiles_dir / f"{character_id}.json",
            json.dumps({"model": character_id}, ensure_ascii=False, indent=2) + "\n",
        )

    def _register_index(self, character_id: str, name: str) -> None:
        index: dict[str, Any] = {}
        if self._index_path.exists():
            loaded = yaml.safe_load(self._index_path.read_text("utf-8"))
            if isinstance(loaded, dict):
                index = loaded
        characters = index.get("characters", [])
        if not isinstance(characters, list):
            characters = []
        characters = [
            item for item in characters
            if isinstance(item, dict) and item.get("id") != character_id
        ]
        characters.append({
            "id": character_id,
            "name": name,
            "path": f"characters/{character_id}/character.json",
        })
        index["characters"] = characters
        index.setdefault("default", character_id)
        self._atomic_text(
            self._index_path,
            yaml.safe_dump(index, allow_unicode=True, sort_keys=False),
        )

    def persist_default(self, character_id: str) -> None:
        """Persist the active character so the next startup loads it."""
        index: dict[str, Any] = {}
        if self._index_path.exists():
            loaded = yaml.safe_load(self._index_path.read_text("utf-8"))
            if isinstance(loaded, dict):
                index = loaded
        if index.get("default") == character_id:
            return
        index["default"] = character_id
        self._atomic_text(
            self._index_path,
            yaml.safe_dump(index, allow_unicode=True, sort_keys=False),
        )

    def _remove_from_index(self, character_id: str, fallback_id: str) -> None:
        index: dict[str, Any] = {}
        if self._index_path.exists():
            loaded = yaml.safe_load(self._index_path.read_text("utf-8"))
            if isinstance(loaded, dict):
                index = loaded
        characters = index.get("characters", [])
        if not isinstance(characters, list):
            characters = []
        index["characters"] = [
            item for item in characters
            if not isinstance(item, dict) or item.get("id") != character_id
        ]
        if index.get("default") == character_id:
            index["default"] = fallback_id
        self._atomic_text(
            self._index_path,
            yaml.safe_dump(index, allow_unicode=True, sort_keys=False),
        )

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        try:
            loaded = json.loads(path.read_text("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON file: {path.name}") from exc
        if not isinstance(loaded, dict):
            raise ValueError(f"JSON root must be an object: {path.name}")
        return loaded

    @staticmethod
    def _atomic_text(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        try:
            temporary.write_text(content, encoding="utf-8")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


class _CheckpointReader:
    """Read a GPT-SoVITS version-tagged archive as a regular PyTorch ZIP."""

    def __init__(self, handle: Any, *, restore_header: bool) -> None:
        self._handle = handle
        self._restore_header = restore_header

    def read(self, size: int = -1) -> bytes:
        position = self._handle.tell()
        data = self._handle.read(size)
        if self._restore_header and position < 2 and data:
            restored = bytearray(data)
            prefix = b"PK"[position:min(2, position + len(restored))]
            restored[:len(prefix)] = prefix
            return bytes(restored)
        return data

    def seek(self, *args: Any) -> int:
        return self._handle.seek(*args)

    def tell(self) -> int:
        return self._handle.tell()

    def seekable(self) -> bool:
        return True
