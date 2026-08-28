"""LLM provider profiles: store CRUD, seeding, and engine-aware resolution."""

from __future__ import annotations

import json

from app.config_manager.llm_providers import (
    LLMProviderStore,
    coerce_provider,
    resolve_active_llm_config,
)


def test_openai_engine_resolves_openai_key_not_deepseek(monkeypatch, tmp_path):
    """Regression: LLM_ENGINE=openai must use OPENAI_API_KEY, never DeepSeek's."""
    monkeypatch.setenv("LLM_PROVIDERS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("LLM_ENGINE", "openai")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-deepseek-stale")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-correct")
    monkeypatch.setenv("LLM_BASE_URL", "https://tokenrhythm.studio/v1")
    monkeypatch.setenv("LLM_MODEL", "glm-5.3-flash")

    cfg = resolve_active_llm_config()

    assert cfg["engine"] == "openai"
    assert cfg["api_key"] == "sk-openai-correct"
    assert cfg["base_url"] == "https://tokenrhythm.studio/v1"
    assert cfg["model"] == "glm-5.3-flash"


def test_deepseek_engine_default_uses_deepseek_key(monkeypatch, tmp_path):
    monkeypatch.setenv("LLM_PROVIDERS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.delenv("LLM_ENGINE", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-deepseek")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai")

    cfg = resolve_active_llm_config()

    assert cfg["engine"] == "deepseek"
    assert cfg["api_key"] == "sk-deepseek"


def test_opencode_engine_uses_opencode_vars(monkeypatch, tmp_path):
    monkeypatch.setenv("LLM_PROVIDERS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("LLM_ENGINE", "opencode")
    monkeypatch.setenv("OPENCODE_API_KEY", "oc-key")
    monkeypatch.setenv("OPENCODE_BASE_URL", "https://opencode.example/v1")
    monkeypatch.setenv("OPENCODE_MODEL", "mimo")

    cfg = resolve_active_llm_config()

    assert cfg["engine"] == "opencode"
    assert cfg["api_key"] == "oc-key"
    assert cfg["base_url"] == "https://opencode.example/v1"
    assert cfg["model"] == "mimo"


def test_store_seeds_from_env_and_crud(tmp_path, monkeypatch):
    monkeypatch.setenv("LLM_PROVIDERS_PATH", str(tmp_path / "providers.json"))
    monkeypatch.setenv("LLM_ENGINE", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-deepseek")
    monkeypatch.setenv("LLM_BASE_URL", "https://x.example/v1")
    monkeypatch.setenv("LLM_MODEL", "x-model")

    store = LLMProviderStore()
    store.load()

    ids = {p.id for p in store.list_providers()}
    assert {"openai", "deepseek"} <= ids
    assert store.active_id() == "openai"

    # duplicate ids overwrite (upsert), then activate the custom one
    custom = coerce_provider({
        "id": "custom", "name": "Custom", "base_url": "https://c/v1",
        "model": "c-m", "api_key": "k",
    })
    store.upsert(custom)
    store.set_active("custom")
    assert store.active_id() == "custom"

    # delete removes the active provider and re-points elsewhere
    assert store.delete("custom") is True
    assert "custom" not in {p.id for p in store.list_providers()}
    assert store.delete("custom") is False

    # persist and reload from disk
    store.set_active("deepseek")
    store.save()
    reloaded = LLMProviderStore()
    reloaded.load()
    assert reloaded.active_id() == "deepseek"
    assert {p.id for p in reloaded.list_providers()} == {"openai", "deepseek"}


def test_resolve_uses_provider_file_when_present(tmp_path, monkeypatch):
    from app.config_manager import llm_providers as mod

    path = tmp_path / "providers.json"
    path.write_text(json.dumps({
        "version": 1,
        "active": "primary",
        "providers": [
            {
                "id": "primary", "name": "Primary", "kind": "openai",
                "base_url": "https://primary/v1", "model": "p-m",
                "api_key": "sk-primary",
            },
            {
                "id": "backup", "name": "Backup", "kind": "opencode",
                "base_url": "https://opencode.example/v1", "model": "b-m",
                "api_key": "sk-backup",
            },
        ],
    }), "utf-8")

    monkeypatch.setenv("LLM_PROVIDERS_PATH", str(path))
    # environment disagrees with the file; the file must win
    monkeypatch.setenv("LLM_ENGINE", "opencode")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    monkeypatch.setattr(mod, "llm_provider_store", LLMProviderStore())

    cfg = resolve_active_llm_config()

    assert cfg["engine"] == "openai"
    assert cfg["api_key"] == "sk-primary"
    assert cfg["base_url"] == "https://primary/v1"
    assert cfg["model"] == "p-m"


def test_coerce_provider_validation_and_coercion():
    assert coerce_provider(None) is None
    assert coerce_provider({"base_url": "x"}) is None  # missing id
    assert coerce_provider({"id": "a"}).base_url == ""  # draft with no base_url yet

    p = coerce_provider({"id": "  a  ", "base_url": " x ", "kind": "opencode"})
    assert p is not None
    assert p.id == "a"
    assert p.base_url == "x"
    assert p.kind == "opencode"

    n = coerce_provider({
        "id": "a", "base_url": "x",
        "temperature": "0.5", "max_tokens": "100", "timeout": "30",
    })
    assert n is not None
    assert n.temperature == 0.5
    assert n.max_tokens == 100
    assert n.timeout == 30.0