"""Read/write config/.env for the settings UI.

Exposes the "root" configuration (LLM/ASR/TTS/GSVI engine, URL, key, model)
that previously required hand-editing the .env file. Reads parse the file
directly; writes update only the exposed keys and preserve layout/comments.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_BASE = Path(__file__).resolve().parents[2]
_ENV_PATH = _BASE / "config" / ".env"

# Keys the settings UI may read/edit, grouped for display.
EXPOSED_KEYS: dict[str, list[str]] = {
    "llm": [
        "LLM_ENGINE", "LLM_BASE_URL", "LLM_MODEL",
        "LLM_ENABLE_VISION",
        "LLM_VISUAL_MAX_IMAGES", "LLM_VISUAL_MAX_MB",
        "LLM_VISUAL_MAX_PIXELS", "LLM_VISUAL_MAX_EDGE",
        "SCREEN_CAPTURE_MIN_INTERVAL", "SCREEN_CHAT_MAX_AGE_SECONDS",
        "LLM_CAMERA_SAMPLE_INTERVAL_MS", "LLM_CAMERA_MAX_FRAMES",
        "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
        "OPENCODE_API_KEY", "OPENCODE_BASE_URL", "OPENCODE_MODEL",
        "LLM_TEMPERATURE", "LLM_REASONING_EFFORT", "LLM_TIMEOUT_SECONDS",
        "LLM_MAX_TOKENS", "LLM_EMPTY_REPLY_FALLBACK",
    ],
    "asr": ["ASR_ENGINE", "ASR_API_KEY", "ASR_BASE_URL"],
    "tts": ["TTS_ENGINE", "TTS_API_KEY", "TTS_BASE_URL"],
    "gsvi": [
        "GSVI_URL", "GSVI_TEXT_LANG", "GSVI_PROMPT_LANG",
        "GSVI_SPEED", "GSVI_TIMEOUT",
    ],
}


def read_env_values() -> dict[str, dict[str, str]]:
    """Return current values of every exposed key, grouped."""
    current = _parse_env()
    return {
        group: {key: current.get(key, "") for key in keys}
        for group, keys in EXPOSED_KEYS.items()
    }


def write_env_values(updates: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Apply grouped updates to config/.env atomically, preserving other lines."""
    current = _parse_env()
    for group, values in (updates or {}).items():
        for key, value in (values or {}).items():
            if key in EXPOSED_KEYS.get(group, []):
                current[key] = str(value)
    _write_env(current)
    visual_updates = updates.get("llm", {}) or {}
    visual_runtime_keys = (
        "LLM_ENABLE_VISION",
        "LLM_VISUAL_MAX_IMAGES",
        "LLM_VISUAL_MAX_MB",
        "LLM_VISUAL_MAX_PIXELS",
        "LLM_VISUAL_MAX_EDGE",
        "SCREEN_CAPTURE_MIN_INTERVAL",
        "SCREEN_CHAT_MAX_AGE_SECONDS",
        "LLM_CAMERA_SAMPLE_INTERVAL_MS",
        "LLM_CAMERA_MAX_FRAMES",
    )
    # Visual policy is read at request/upload time, so these settings apply to
    # the already-running process; engine/model changes keep their old lifecycle.
    for key in visual_runtime_keys:
        if key in visual_updates:
            os.environ[key] = str(visual_updates[key])
    return read_env_values()


def _parse_env() -> dict[str, str]:
    result: dict[str, str] = {}
    if not _ENV_PATH.exists():
        return result
    for raw in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        # Strip an inline ` # comment` so stored values are clean; _write_env
        # re-attaches the original comment when it rewrites the line.
        result[key.strip()] = value.strip().split(" #")[0].strip()
    return result


def _write_env(values: dict[str, str]) -> None:
    """Rewrite config/.env in place, updating known keys and preserving layout.

    Inline `# comments` after a value are preserved; a value containing '#'
    is rare for these keys. New keys are appended at the end.
    """
    if not _ENV_PATH.exists():
        _ENV_PATH.write_text("", encoding="utf-8")
    lines = _ENV_PATH.read_text(encoding="utf-8").splitlines()
    pending = dict(values)
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in pending:
                value = pending.pop(key)
                if " #" in line:
                    comment = line.split(" #", 1)[1]
                    line = f"{key}={value} #{comment}"
                else:
                    line = f"{key}={value}"
        out.append(line)
    for key, value in pending.items():
        out.append(f"{key}={value}")
    _ENV_PATH.write_text("\n".join(out) + "\n", encoding="utf-8")
