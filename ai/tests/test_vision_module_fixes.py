"""Regression tests for the vision-module audit fixes (both rounds).

Covers: master-toggle degrade (strip images, not fail), screen_capture tool
gating, initiative visual grounding, desktop-frame image budget, watcher
default/kill-switch, and set_screen_vision lifecycle wiring.
"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from app.runtime.character_turn import CharacterTurn, TurnInput, TurnOrigin
from app.runtime.context_budget import ContextBudget
from app.runtime.prompt_compiler import PromptCompiler
from app.runtime.visual_attachments import enforce_image_budget


# ── Fix 3: desktop frame shares the image budget ─────────────────────────


def test_enforce_image_budget_drops_oldest_and_keeps_reserved_frame(monkeypatch):
    monkeypatch.setenv("LLM_VISUAL_MAX_IMAGES", "4")
    frames = [{"id": f"a{i}"} for i in range(6)]
    screen = {"id": "screen"}

    # The helper trims the main list only; the caller appends the frame.
    out = enforce_image_budget(frames, screen)
    assert [item["id"] for item in out] == ["a3", "a4", "a5"]

    # Without a reserved frame only the maxImages cap applies.
    assert [item["id"] for item in enforce_image_budget(frames, None)] == [
        "a2", "a3", "a4", "a5",
    ]

    # Budget 1 with a reserved frame keeps nothing from the main list.
    monkeypatch.setenv("LLM_VISUAL_MAX_IMAGES", "1")
    assert enforce_image_budget([{"id": "x"}], screen) == []


# ── Fix 1: master toggle off degrades to text-only ───────────────────────


class _MockOpenAIHandler(BaseHTTPRequestHandler):
    captured: list[dict] = []

    def do_POST(self):  # noqa: N802 — stdlib naming
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).captured.append(body)
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
def llm_mock(monkeypatch, tmp_path):
    handler = type("_Handler", (_MockOpenAIHandler,), {"captured": []})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}/v1"

    providers_path = tmp_path / "llm_providers.json"
    providers_path.write_text(json.dumps({
        "version": 1, "active": "prov",
        "providers": [{
            "id": "prov", "name": "P", "kind": "openai",
            "base_url": base_url, "model": "model-a", "api_key": "sk-a",
        }],
    }), "utf-8")
    monkeypatch.setenv("LLM_PROVIDERS_PATH", str(providers_path))
    from app.config_manager import llm_providers as llm_providers_mod
    monkeypatch.setattr(llm_providers_mod, "llm_provider_store", llm_providers_mod.LLMProviderStore())

    yield handler.captured
    server.shutdown()


def test_provider_strips_images_when_vision_disabled(llm_mock, monkeypatch):
    from app.providers.llm.openai_adapter import OpenAILLMProvider

    captured = llm_mock
    monkeypatch.delenv("LLM_ENABLE_VISION", raising=False)
    provider = OpenAILLMProvider()
    image_block = {"type": "image_url", "image_url": {"url": "data:image/png;base64,QQ=="}}

    async def turn(messages):
        await provider.generate(messages)

    mixed = [{"role": "user", "content": [
        {"type": "text", "text": "看图"},
        dict(image_block),
    ]}]
    asyncio.run(turn([dict(m) for m in mixed]))
    sent = captured[-1]["messages"][-1]["content"]
    assert all(block.get("type") != "image_url" for block in sent)

    # An image-only message would otherwise become an empty content list.
    image_only = [{"role": "user", "content": [dict(image_block)]}]
    asyncio.run(turn([dict(m) for m in image_only]))
    sent = captured[-1]["messages"][-1]["content"]
    assert sent == [{"type": "text", "text": "[image not sent: vision input is disabled in settings]"}]

    # Toggle back on: images pass through untouched.
    monkeypatch.setenv("LLM_ENABLE_VISION", "1")
    asyncio.run(turn([dict(m) for m in mixed]))
    sent = captured[-1]["messages"][-1]["content"]
    assert any(block.get("type") == "image_url" for block in sent)


# ── Fix 6: screen_capture tool gating ─────────────────────────────────────


def test_screen_capture_tool_respects_switches(monkeypatch):
    from app.legacy.tools.builtins.screen import screen_capture

    monkeypatch.setenv("SCREEN_ENABLED", "0")
    assert "screen capture disabled" in json.loads(screen_capture())["error"]

    monkeypatch.setenv("SCREEN_ENABLED", "1")
    monkeypatch.delenv("LLM_ENABLE_VISION", raising=False)
    out = json.loads(screen_capture())
    assert out["type"] == "screenshot_error"
    assert "LLM_ENABLE_VISION" in out["error"]
    # The enabled path performs a real desktop capture — deliberately not
    # exercised in tests.


# ── Fix 5: initiative turns carry the grounded image ─────────────────────


def test_prompt_compiler_initiative_visual_carries_image_blocks():
    class FakeStore:
        def load_data_url(self, attachment_id: str) -> str:
            return "data:image/png;base64,QQ=="

    turn = CharacterTurn(input=TurnInput(
        text="桌面上有什么？",
        origin=TurnOrigin.INITIATIVE,
        visual_attachments=({"id": "att_0123456789abcdef0123456789abcdef"},),
        metadata={"initiative": {"topic": "screen_change"}},
    ))
    compiled = PromptCompiler(
        context_budget=ContextBudget(soft_tokens=20_000, hard_tokens=24_000),
        visual_attachment_store=FakeStore(),
    ).compile(turn, None)

    last = compiled.messages[-1]
    assert last["role"] == "user"
    block_types = [block.get("type") for block in last["content"]]
    assert "image_url" in block_types
    assert any(
        isinstance(m.get("content"), str) and "VISUAL GROUNDING" in m["content"]
        for m in compiled.messages
    )


# ── Fix 2: watcher default, kill-switch, and lifecycle wiring ────────────


def test_screen_watcher_enabled_default_and_kill_switch(monkeypatch):
    from app.services.screen_watcher import ScreenWatcher

    monkeypatch.delenv("SCREEN_ENABLED", raising=False)
    assert ScreenWatcher().enabled is True
    monkeypatch.setenv("SCREEN_ENABLED", "0")
    assert ScreenWatcher().enabled is False


def test_set_screen_vision_drives_watcher_lifecycle():
    from app.runtime.management import RuntimeManager

    calls = {"start": 0, "stop": 0}
    runtime = SimpleNamespace(
        _screen_vision_enabled=True,
        screen_watcher=SimpleNamespace(
            start=lambda: calls.__setitem__("start", calls["start"] + 1),
            stop=lambda: calls.__setitem__("stop", calls["stop"] + 1),
        ),
        initiative_checker=SimpleNamespace(_running=True),
    )
    manager = RuntimeManager.__new__(RuntimeManager)
    manager._runtime = runtime

    # Proactive still active → watcher keeps running even when vision turns off.
    manager.set_screen_vision(False)
    assert calls["stop"] == 0

    runtime.initiative_checker._running = False
    manager.set_screen_vision(False)
    assert calls["stop"] == 1

    manager.set_screen_vision(True)
    assert calls["start"] == 1


def test_set_proactive_keeps_watcher_for_screen_vision():
    from app.runtime.management import RuntimeManager

    calls = {"start": 0, "stop": 0}
    runtime = SimpleNamespace(
        initiative_checker=None,
        _screen_vision_enabled=True,
        screen_watcher=SimpleNamespace(
            start=lambda: calls.__setitem__("start", calls["start"] + 1),
            stop=lambda: calls.__setitem__("stop", calls["stop"] + 1),
        ),
    )
    manager = RuntimeManager.__new__(RuntimeManager)
    manager._runtime = runtime

    manager.set_proactive(False)
    assert calls["stop"] == 0  # screen vision still needs the watcher
    runtime._screen_vision_enabled = False
    manager.set_proactive(False)
    assert calls["stop"] == 1


# ── Fix 4: camera sources are frontend-owned ─────────────────────────────


def test_set_vision_source_ignores_camera_sources_and_keeps_screen_sources():
    from app.runtime.management import RuntimeManager

    runtime = SimpleNamespace(_voice_screen_enabled=True, _text_screen_enabled=False)
    manager = RuntimeManager.__new__(RuntimeManager)
    manager._runtime = runtime

    manager.set_vision_source("voice_camera", True)   # no-op, no attribute touched
    manager.set_vision_source("text_camera", False)
    manager.set_vision_source("voice_screen", False)
    manager.set_vision_source("text_screen", True)
    assert runtime._voice_screen_enabled is False
    assert runtime._text_screen_enabled is True
