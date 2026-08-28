"""LLM provider profiles — user-manageable list plus an active pointer.

The legacy stack scattered one logical "provider" across several env vars
(``LLM_ENGINE`` + ``LLM_BASE_URL`` + ``LLM_MODEL`` + ``DEEPSEEK_API_KEY`` /
``OPENAI_API_KEY`` / ``OPENCODE_*``), so the runtime could easily send the
wrong API key to the wrong endpoint (the classic 401 "未认证或登录已过期").
This module replaces that with an atomic per-provider profile: each provider
carries its own base_url / model / api_key / generation params, and the runtime
resolves exactly the ACTIVE profile.

Persistence lives in ``config/llm_providers.json`` (ignored by Git — it holds
secrets). On first run with no file present we seed an in-memory profile list
from the legacy env vars so existing installs keep working; the file is only
written when the settings UI actually saves a change.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

_BASE = Path(__file__).resolve().parents[2]
_DEFAULT_PATH = _BASE / "config" / "llm_providers.json"

_PROVIDER_FIELDS = (
    "id", "name", "kind", "base_url", "model", "api_key",
    "temperature", "reasoning_effort", "timeout", "max_tokens",
)


def _num(value: str | None, cast: type) -> Any:
    """Parse an optional numeric env value; return None on empty/invalid."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return cast(value)
    except (TypeError, ValueError):
        return None


def _resolve_path() -> Path:
    """Resolve the store path, honoring a test/dev override."""
    override = (os.environ.get("LLM_PROVIDERS_PATH") or "").strip()
    if override:
        return Path(override)
    return _DEFAULT_PATH


@dataclass
class LLMProvider:
    """One LLM endpoint's complete, atomic configuration."""

    id: str
    name: str = ""
    kind: str = "openai"  # "openai" (generic OpenAI-compatible) | "opencode"
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    temperature: float | None = None
    reasoning_effort: str | None = None
    timeout: float | None = None
    max_tokens: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "LLMProvider":
        return cls(**{f: data.get(f) for f in _PROVIDER_FIELDS})

    def to_runtime_config(self) -> dict[str, Any]:
        """Normalized dict consumed by the OpenAI-compatible adapter."""
        return {
            "engine": "opencode" if self.kind == "opencode" else "openai",
            "base_url": self.base_url,
            "model": self.model,
            "api_key": self.api_key,
            "temperature": self.temperature,
            "reasoning_effort": self.reasoning_effort,
            "timeout": self.timeout,
            "max_tokens": self.max_tokens,
        }


class LLMProviderStore:
    """Load/save the provider list and track which one is active."""

    def __init__(self) -> None:
        self._providers: dict[str, LLMProvider] = {}
        self._active_id: str = ""
        self._loaded = False

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True

        path = _resolve_path()
        if path.exists():
            try:
                raw = json.loads(path.read_text("utf-8"))
                providers = raw.get("providers") or []
                self._providers = {
                    p["id"]: LLMProvider.from_dict(p)
                    for p in providers
                    if isinstance(p, dict) and p.get("id")
                }
                self._active_id = str(raw.get("active", ""))
            except (json.JSONDecodeError, OSError, TypeError, ValueError):
                self._providers = {}
                self._active_id = ""

        if not self._providers:
            self._seed_from_env()

    def _seed_from_env(self) -> None:
        """Build provider profiles from the legacy .env keys (in-memory only)."""
        shared_base = (os.environ.get("LLM_BASE_URL") or "").strip()
        shared_model = (os.environ.get("LLM_MODEL") or "").strip()
        temperature = _num(os.environ.get("LLM_TEMPERATURE"), float)
        reasoning_effort = (os.environ.get("LLM_REASONING_EFFORT") or "").strip() or None
        timeout = _num(os.environ.get("LLM_TIMEOUT_SECONDS"), float)
        max_tokens = _num(os.environ.get("LLM_MAX_TOKENS"), int)

        providers: dict[str, LLMProvider] = {}

        if (os.environ.get("OPENCODE_API_KEY") or os.environ.get("OPENCODE_BASE_URL")):
            providers["opencode"] = LLMProvider(
                id="opencode", name="OpenCode", kind="opencode",
                base_url=(os.environ.get("OPENCODE_BASE_URL") or "http://127.0.0.1:4096/v1").strip(),
                model=(os.environ.get("OPENCODE_MODEL") or "opencode").strip(),
                api_key=(os.environ.get("OPENCODE_API_KEY") or "").strip(),
                temperature=temperature, reasoning_effort=reasoning_effort,
                timeout=timeout, max_tokens=max_tokens,
            )

        if (os.environ.get("OPENAI_API_KEY") or "").strip():
            providers["openai"] = LLMProvider(
                id="openai", name="OpenAI", kind="openai",
                base_url=(os.environ.get("OPENAI_BASE_URL") or shared_base or "https://api.openai.com/v1").strip(),
                model=(shared_model or "gpt-4o").strip(),
                api_key=(os.environ.get("OPENAI_API_KEY") or "").strip(),
                temperature=temperature, reasoning_effort=reasoning_effort,
                timeout=timeout, max_tokens=max_tokens,
            )

        if (os.environ.get("DEEPSEEK_API_KEY") or "").strip():
            providers["deepseek"] = LLMProvider(
                id="deepseek", name="DeepSeek", kind="openai",
                base_url=(shared_base or "https://api.deepseek.com").strip(),
                model=(shared_model or "deepseek-chat").strip(),
                api_key=(os.environ.get("DEEPSEEK_API_KEY") or "").strip(),
                temperature=temperature, reasoning_effort=reasoning_effort,
                timeout=timeout, max_tokens=max_tokens,
            )

        self._providers = providers

        engine = (os.environ.get("LLM_ENGINE") or "").strip().lower()
        if engine == "opencode" and "opencode" in providers:
            self._active_id = "opencode"
        elif engine == "openai" and "openai" in providers:
            self._active_id = "openai"
        elif "deepseek" in providers:
            self._active_id = "deepseek"
        elif providers:
            self._active_id = next(iter(providers))
        else:
            self._active_id = ""

    def save(self) -> None:
        path = _resolve_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "active": self._active_id,
            "providers": [p.to_dict() for p in self._providers.values()],
        }
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), "utf-8")
        tmp.replace(path)

    # -- queries ---------------------------------------------------------
    def list_providers(self) -> list[LLMProvider]:
        return list(self._providers.values())

    def get(self, provider_id: str) -> LLMProvider | None:
        return self._providers.get(provider_id)

    def active_id(self) -> str:
        return self._active_id

    def active_provider(self) -> LLMProvider | None:
        return self._providers.get(self._active_id)

    # -- mutations -------------------------------------------------------
    def upsert(self, provider: LLMProvider) -> None:
        self._providers[provider.id] = provider

    def delete(self, provider_id: str) -> bool:
        if provider_id not in self._providers:
            return False
        del self._providers[provider_id]
        if self._active_id == provider_id:
            self._active_id = next(iter(self._providers)) if self._providers else ""
        return True

    def set_active(self, provider_id: str) -> bool:
        if provider_id not in self._providers:
            return False
        self._active_id = provider_id
        return True


def _coerce_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def coerce_provider(data: dict[str, Any]) -> LLMProvider | None:
    """Validate + coerce a provider dict from the settings UI; None if invalid."""
    if not isinstance(data, dict):
        return None
    provider_id = str(data.get("id") or "").strip()
    base_url = str(data.get("base_url") or "").strip()
    if not provider_id:
        return None
    kind = "opencode" if str(data.get("kind", "")).strip().lower() == "opencode" else "openai"
    return LLMProvider(
        id=provider_id,
        name=str(data.get("name") or "").strip() or provider_id,
        kind=kind,
        base_url=base_url,
        model=str(data.get("model") or "").strip(),
        api_key=str(data.get("api_key") or ""),
        temperature=_coerce_float(data.get("temperature")),
        reasoning_effort=str(data.get("reasoning_effort") or "").strip() or None,
        timeout=_coerce_float(data.get("timeout")),
        max_tokens=_coerce_int(data.get("max_tokens")),
    )


llm_provider_store = LLMProviderStore()


def resolve_active_llm_config() -> dict[str, Any]:
    """Resolve the runtime LLM config for the ACTIVE provider.

    Precedence:
      1. ``config/llm_providers.json`` when present with a usable active profile.
      2. Legacy env vars (engine-aware — the bug fix: ``openai`` engine now uses
         ``OPENAI_API_KEY``, ``opencode`` uses ``OPENCODE_*``, ``deepseek`` uses
         ``DEEPSEEK_API_KEY``).
    The file-existence check is cheap and kept outside the cached store so tests
    that monkeypatch env vars always see fresh values.
    """
    if _resolve_path().exists():
        store = llm_provider_store
        store.load()
        provider = store.active_provider()
        if provider is not None and (provider.base_url or provider.model or provider.api_key):
            return provider.to_runtime_config()

    return _env_runtime_config()


def _env_runtime_config() -> dict[str, Any]:
    """Legacy env-based config, made engine-aware."""
    engine = (os.environ.get("LLM_ENGINE") or "").strip().lower() or "deepseek"
    common: dict[str, Any] = {
        "temperature": _num(os.environ.get("LLM_TEMPERATURE"), float),
        "reasoning_effort": (os.environ.get("LLM_REASONING_EFFORT") or "").strip() or None,
        "timeout": _num(os.environ.get("LLM_TIMEOUT_SECONDS"), float),
        "max_tokens": _num(os.environ.get("LLM_MAX_TOKENS"), int),
    }
    if engine == "opencode":
        return {
            **common,
            "engine": "opencode",
            "base_url": os.environ.get("OPENCODE_BASE_URL") or "http://127.0.0.1:4096/v1",
            "model": os.environ.get("OPENCODE_MODEL") or "opencode",
            "api_key": os.environ.get("OPENCODE_API_KEY") or "",
        }
    if engine == "openai":
        return {
            **common,
            "engine": "openai",
            "base_url": os.environ.get("LLM_BASE_URL") or "https://api.openai.com/v1",
            "model": os.environ.get("LLM_MODEL") or "gpt-4o",
            "api_key": os.environ.get("OPENAI_API_KEY") or "",
        }
    return {
        **common,
        "engine": "deepseek",
        "base_url": os.environ.get("LLM_BASE_URL") or "https://api.deepseek.com",
        "model": os.environ.get("LLM_MODEL") or "deepseek-v4-flash",
        "api_key": os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY") or "",
    }