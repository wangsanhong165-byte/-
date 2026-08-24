"""Single runtime source for active Live2D presentation capabilities."""

from __future__ import annotations

import json
import logging
import os
import threading
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.runtime.character_intent import EMOTIONS


logger = logging.getLogger("runtime.presentation")


@dataclass(frozen=True)
class PresentationCapabilities:
    """Immutable capability snapshot owned by one CharacterTurn."""

    model: str
    allowed_emotions: tuple[str, ...]


class Live2DPresentationRegistry:
    """Load model presentation data and atomically select the active model.

    The registry owns runtime interpretation of ``live2d_models.json``.  File
    persistence remains the responsibility of ``CharacterCatalog``; callers
    consume only immutable capability snapshots through this interface.
    """

    _PREFERRED_MODELS = ("shirone", "Design_genius_White", "youxiaomiao", "ariu")

    def __init__(self, base_dir: Path | str | None = None) -> None:
        self._base_dir = Path(
            base_dir or Path(__file__).resolve().parents[2]
        ).resolve()
        self._config_path = self._base_dir / "config" / "live2d_models.json"
        self._models_dir = self._base_dir / "models" / "live2d-models"
        self._lock = threading.RLock()
        self._config: dict[str, dict[str, Any]] | None = None
        self._active_model = ""

    def refresh(self) -> None:
        """Invalidate file data while preserving a still-valid selection."""
        with self._lock:
            self._config = None

    def select(self, model: str) -> PresentationCapabilities:
        """Select a configured model and return its immutable capabilities."""
        normalized = str(model or "").strip()
        with self._lock:
            config = self._load_locked()
            if not normalized or normalized not in config:
                raise KeyError(normalized)
            self._active_model = normalized
            return self._snapshot_locked(normalized)

    def snapshot(self) -> PresentationCapabilities:
        """Return the active model snapshot, choosing a safe default lazily."""
        with self._lock:
            config = self._load_locked()
            if self._active_model not in config:
                self._active_model = self._choose_default_locked(config)
            return self._snapshot_locked(self._active_model)

    def capabilities_for(self, model: str) -> PresentationCapabilities:
        """Read one model without changing the active selection."""
        normalized = str(model or "").strip()
        with self._lock:
            config = self._load_locked()
            if not normalized or normalized not in config:
                raise KeyError(normalized)
            return self._snapshot_locked(normalized)

    def model_config(self, model: str | None = None) -> dict[str, Any]:
        """Return an isolated copy of one model's renderer-facing config."""
        with self._lock:
            selected = model or self.snapshot().model
            return deepcopy(self._load_locked().get(selected, {}))

    def config(self) -> dict[str, dict[str, Any]]:
        """Return an isolated copy for Bridge model-info construction."""
        with self._lock:
            return deepcopy(self._load_locked())

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        if self._config is not None:
            return self._config
        try:
            raw = json.loads(self._config_path.read_text("utf-8"))
            self._config = {
                str(name): value
                for name, value in raw.items()
                if isinstance(name, str) and isinstance(value, dict)
            } if isinstance(raw, dict) else {}
        except (OSError, json.JSONDecodeError, TypeError):
            logger.exception("Failed to load Live2D presentation config")
            self._config = {}
        return self._config

    def _choose_default_locked(self, config: dict[str, dict[str, Any]]) -> str:
        if not config:
            return ""
        installed = {
            path.name
            for path in self._models_dir.iterdir()
            if path.is_dir()
        } if self._models_dir.exists() else set()
        env_model = os.environ.get("LIVE2D_MODEL", "").strip()
        if env_model in config and (not installed or env_model in installed):
            return env_model
        for model in self._PREFERRED_MODELS:
            if model in config and (not installed or model in installed):
                return model
        configured_installed = sorted(set(config) & installed)
        return configured_installed[0] if configured_installed else sorted(config)[0]

    def _snapshot_locked(self, model: str) -> PresentationCapabilities:
        model_config = self._load_locked().get(model, {})
        configured = model_config.get("prompt_emotions", [])
        ordered: list[str] = ["neutral"]
        if isinstance(configured, list):
            for value in configured:
                emotion = str(value).strip().lower()
                if emotion in EMOTIONS and emotion not in ordered:
                    ordered.append(emotion)
        return PresentationCapabilities(
            model=model,
            allowed_emotions=tuple(ordered),
        )


_REGISTRY = Live2DPresentationRegistry()


def get_presentation_registry() -> Live2DPresentationRegistry:
    return _REGISTRY
