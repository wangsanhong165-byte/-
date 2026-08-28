from __future__ import annotations

import asyncio
import io
from types import SimpleNamespace

import pytest
from PIL import Image

from app.runtime.initiative import InitiativeCandidate
from app.runtime.runtime import CharacterRuntime
from app.runtime.visual_attachments import VisualAttachmentStore
from app.services.screen_watcher import ScreenWatcher


def _png_bytes(width: int = 8, height: int = 6) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (1, 2, 3)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_screen_watcher_captures_frame_on_change_with_throttle(tmp_path, monkeypatch):
    from PIL import ImageGrab

    monkeypatch.setenv("SCREEN_ENABLED", "1")
    monkeypatch.setenv("SOULLINK_VISUAL_ATTACHMENT_DIR", str(tmp_path))
    monkeypatch.setattr(ImageGrab, "grab", lambda *args, **kwargs: Image.new("RGB", (8, 6), (1, 2, 3)))

    watcher = ScreenWatcher(interval=5.0, frame_min_interval=3600.0)
    first = watcher._capture_frame_if_due()
    assert first is not None
    assert first["source"] == "screen_watcher"
    assert first["id"].startswith("att_")
    assert watcher._capture_frame_if_due() is None


def test_screen_watcher_frame_capture_respects_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("SCREEN_ENABLED", "0")
    watcher = ScreenWatcher(frame_min_interval=1.0)
    assert watcher._capture_frame_if_due() is None


def test_screen_capture_interval_reads_env_for_live_tuning(monkeypatch):
    watcher = ScreenWatcher(frame_min_interval=3600.0)
    assert watcher._current_frame_min_interval() == 3600.0

    monkeypatch.setenv("SCREEN_CAPTURE_MIN_INTERVAL", "10")
    assert watcher._current_frame_min_interval() == 10.0

    monkeypatch.setenv("SCREEN_CAPTURE_MIN_INTERVAL", "not-a-number")
    assert watcher._current_frame_min_interval() == 3600.0

    monkeypatch.setenv("SCREEN_CAPTURE_MIN_INTERVAL", "")
    assert watcher._current_frame_min_interval() == 3600.0


def test_screen_watcher_constructor_tolerates_blank_or_invalid_interval_env(monkeypatch):
    monkeypatch.setenv("SCREEN_CAPTURE_MIN_INTERVAL", "")
    blank = ScreenWatcher()
    assert blank.frame_min_interval == 30.0

    monkeypatch.setenv("SCREEN_CAPTURE_MIN_INTERVAL", "   ")
    whitespace = ScreenWatcher()
    assert whitespace.frame_min_interval == 30.0

    monkeypatch.setenv("SCREEN_CAPTURE_MIN_INTERVAL", "not-a-number")
    invalid = ScreenWatcher()
    assert invalid.frame_min_interval == 30.0

    monkeypatch.setenv("SCREEN_CAPTURE_MIN_INTERVAL", "12.5")
    tuned = ScreenWatcher()
    assert tuned.frame_min_interval == 12.5


def test_set_screen_vision_toggles_runtime_flag():
    from app.runtime.management import RuntimeManager

    class StubRuntime:
        pass

    stub = StubRuntime()
    stub._screen_vision_enabled = True
    manager = RuntimeManager.__new__(RuntimeManager)
    manager._runtime = stub

    manager.set_screen_vision(False)
    assert stub._screen_vision_enabled is False

    manager.set_screen_vision(True)
    assert stub._screen_vision_enabled is True


def test_first_screen_frame_picks_valid_attachment():
    events = [
        SimpleNamespace(payload={"visual_attachment": None}),
        SimpleNamespace(payload={"visual_attachment": {"id": "att_0123456789abcdef0123456789abcdef"}}),
    ]
    picked = CharacterRuntime._first_screen_frame(events)
    assert picked is not None
    assert picked["id"] == "att_0123456789abcdef0123456789abcdef"

    assert CharacterRuntime._first_screen_frame(
        [SimpleNamespace(payload={"visual_attachment": None})]
    ) is None


def test_dispatch_initiative_injects_screen_frame(tmp_path, monkeypatch):
    store = VisualAttachmentStore(tmp_path)
    attachment = store.save_bytes(_png_bytes(), "image/png", source="screen_watcher")
    monkeypatch.setenv("SOULLINK_VISUAL_ATTACHMENT_DIR", str(tmp_path))

    runtime = object.__new__(CharacterRuntime)
    captured_inputs: list = []

    async def fake_handle_turn(turn_input):
        captured_inputs.append(turn_input)
        return SimpleNamespace(
            error=None,
            reply_text="我注意到你切换了窗口。",
            initiative={},
            character=None,
        )

    runtime.handle_turn = fake_handle_turn  # type: ignore[method-assign]
    runtime._proactive_handlers = []  # type: ignore[attr-defined]

    pending = InitiativeCandidate.create(
        source="test",
        topic="user switched windows",
        priority=0.6,
        freshness=1.0,
        ttl_seconds=60,
        payload={
            "prompt": "screen change prompt",
            "initiative": {
                "intent": "curiosity",
                "topic": "user is coding",
                "source_type": "screen_change",
                "source_payload": {},
                "urgency": 0.6,
                "visual_attachment": attachment.to_public_dict(),
            },
        },
    )
    asyncio.run(runtime._dispatch_initiative(pending))

    assert len(captured_inputs) == 1
    visuals = captured_inputs[0].visual_attachments
    assert len(visuals) == 1
    assert visuals[0]["source"] == "screen_watcher"
    assert visuals[0]["id"] == attachment.attachment_id


def test_dispatch_initiative_drops_expired_screen_frame_and_still_speaks(tmp_path, monkeypatch):
    monkeypatch.setenv("SOULLINK_VISUAL_ATTACHMENT_DIR", str(tmp_path))
    # Reference an id that was never persisted; resolve must fail gracefully.
    ghost = {"id": "att_0123456789abcdef0123456789abcdef"}

    runtime = object.__new__(CharacterRuntime)
    captured_inputs: list = []

    async def fake_handle_turn(turn_input):
        captured_inputs.append(turn_input)
        return SimpleNamespace(
            error=None,
            reply_text="屏幕上好像没有可用的画面。",
            initiative={},
            character=None,
        )

    runtime.handle_turn = fake_handle_turn  # type: ignore[method-assign]
    runtime._proactive_handlers = []  # type: ignore[attr-defined]

    pending = InitiativeCandidate.create(
        source="test",
        topic="expired frame",
        priority=0.5,
        freshness=1.0,
        ttl_seconds=60,
        payload={
            "prompt": "screen change prompt",
            "initiative": {
                "intent": "curiosity",
                "topic": "user is coding",
                "source_type": "screen_change",
                "source_payload": {},
                "urgency": 0.5,
                "visual_attachment": ghost,
            },
        },
    )
    asyncio.run(runtime._dispatch_initiative(pending))

    assert len(captured_inputs) == 1
    assert captured_inputs[0].visual_attachments == ()