"""Settings-side LLM provider switches must apply on the next turn.

Regression for: switching the active provider (key/model/base_url) in the
settings UI required an app restart. The runtime constructs OpenAILLMProvider
once (app/runtime/runtime.py:84); the provider must re-resolve the ACTIVE
profile per turn instead of freezing the config captured at construction.
"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.config_manager import llm_providers as llm_providers_mod
from app.config_manager.llm_providers import LLMProviderStore, coerce_provider
from app.providers.llm.openai_adapter import OpenAILLMProvider


class _RecordingHandler(BaseHTTPRequestHandler):
    """Minimal OpenAI-compatible endpoint recording (model, auth) per call."""

    def do_POST(self):  # noqa: N802 — stdlib naming
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server.captured.append(
            (body.get("model", ""), self.headers.get("authorization", ""))
        )
        content = json.dumps({"segments": [], "final_reply": "ok"})
        resp = json.dumps({
            "id": "chatcmpl-1", "object": "chat.completion", "created": 1,
            "model": body.get("model", ""),
            "choices": [{
                "index": 0, "finish_reason": "stop",
                "message": {"role": "assistant", "content": content},
            }],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, *args):
        pass


@pytest.fixture()
def llm_route(monkeypatch, tmp_path):
    """Isolated provider store + a local recording OpenAI-compatible server."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _RecordingHandler)
    server.captured: list[tuple[str, str]] = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}/v1"

    providers_path = tmp_path / "llm_providers.json"
    providers_path.write_text(json.dumps({
        "version": 1, "active": "prov-a",
        "providers": [{
            "id": "prov-a", "name": "A", "kind": "openai",
            "base_url": base_url, "model": "model-a", "api_key": "sk-key-a",
        }],
    }), "utf-8")
    monkeypatch.setenv("LLM_PROVIDERS_PATH", str(providers_path))
    # Fresh singleton so the store resolves this test's file, not a prior
    # test's already-loaded cache.
    monkeypatch.setattr(llm_providers_mod, "llm_provider_store", LLMProviderStore())

    yield base_url, server.captured
    server.shutdown()


def _turn(provider: OpenAILLMProvider) -> None:
    asyncio.run(provider.generate([{"role": "user", "content": "hi"}]))


def _save_active_provider(provider_id: str, model: str, api_key: str, base_url: str) -> None:
    """Same store calls as POST /api/config/llm-providers (bridge/server.py)."""
    store = llm_providers_mod.llm_provider_store
    store.load()
    store.upsert(coerce_provider({
        "id": provider_id, "name": provider_id, "kind": "openai",
        "base_url": base_url, "model": model, "api_key": api_key,
    }))
    assert store.set_active(provider_id)
    store.save()


def test_switching_active_provider_applies_without_restart(llm_route):
    base_url, captured = llm_route
    provider = OpenAILLMProvider()

    _turn(provider)
    assert captured == [("model-a", "Bearer sk-key-a")]

    _save_active_provider("prov-b", "model-b", "sk-key-b", base_url)

    _turn(provider)
    assert captured[-1] == ("model-b", "Bearer sk-key-b")
    assert provider.model == "model-b"


def test_adapter_rebuilt_only_when_config_changes(llm_route):
    base_url, captured = llm_route
    provider = OpenAILLMProvider()
    _turn(provider)
    adapter_after_first = provider._adapter

    _turn(provider)  # unchanged config → same adapter, no per-turn rebuild
    assert provider._adapter is adapter_after_first

    _save_active_provider("prov-b", "model-b", "sk-key-b", base_url)
    _turn(provider)
    assert provider._adapter is not adapter_after_first
    assert captured[-1] == ("model-b", "Bearer sk-key-b")


def test_explicit_constructor_route_stays_pinned(llm_route):
    base_url, _ = llm_route
    provider = OpenAILLMProvider(
        api_key="sk-explicit", base_url=base_url, model="pinned-m"
    )
    _turn(provider)
    adapter_before = provider._adapter

    _save_active_provider("prov-b", "model-b", "sk-key-b", base_url)
    _turn(provider)

    assert provider._adapter is adapter_before
    assert provider.model == "pinned-m"
