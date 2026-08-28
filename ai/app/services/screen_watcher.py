"""Screen monitor — watches active window and pushes context events.

Never calls LLM directly. Events go to InitiativeQueue; the Runtime
InitiativeChecker picks them up and decides whether to trigger the pipeline.
"""

from __future__ import annotations

import io
import os
import threading
import time
from typing import Any, Callable

from app.core.event_bus import bus
from app.core.events import EventType
from app.core.initiative_queue import initiative_queue

_DEFAULT_FRAME_MIN_INTERVAL_SECONDS = 30.0


class ScreenWatcher:
    """Periodically captures screen context and pushes to initiative queue.

    Usage:
        watcher = ScreenWatcher(interval=5.0)
        watcher.on_context_change = lambda old, new: initiative_queue.push(...)
        watcher.start()
    """

    def __init__(self, interval: float = 5.0, frame_min_interval: float | None = None) -> None:
        self.interval = interval
        if frame_min_interval is None:
            self.frame_min_interval = self._parse_frame_min_interval(
                os.environ.get("SCREEN_CAPTURE_MIN_INTERVAL"),
                _DEFAULT_FRAME_MIN_INTERVAL_SECONDS,
            )
        else:
            self.frame_min_interval = frame_min_interval
        self._thread: threading.Thread | None = None
        self._running = False
        self._last_context: dict[str, Any] = {}
        self._last_frame_at = 0.0
        self._latest_frame: dict[str, Any] | None = None
        self._latest_frame_at = 0.0
        self.on_context_change: Callable[[dict, dict], None] | None = None

    @staticmethod
    def _parse_frame_min_interval(raw: str | None, default: float) -> float:
        """Parse SCREEN_CAPTURE_MIN_INTERVAL, treating blank values as default."""
        try:
            return float((raw or "").strip() or str(default))
        except (TypeError, ValueError):
            return default

    @property
    def enabled(self) -> bool:
        return os.environ.get("SCREEN_ENABLED", "0") == "1"

    def start(self) -> None:
        if self._running or not self.enabled:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="screen-watcher")
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=3.0)
            self._thread = None

    def capture(self) -> dict[str, Any]:
        """Capture current screen context.

        Returns dict with keys: app, title, changed
        """
        try:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32

            hwnd = user32.GetForegroundWindow()
            length = user32.GetWindowTextLengthW(hwnd)
            if length == 0:
                return {"app": "unknown", "title": "", "changed": False}

            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value

            # Get process name
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            process_name = "unknown"
            try:
                handle = kernel32.OpenProcess(0x0400 | 0x0010, False, pid)
                if handle:
                    exe_buf = ctypes.create_unicode_buffer(260)
                    exe_len = wintypes.DWORD(260)
                    if kernel32.QueryFullProcessImageNameW(handle, 0, exe_buf, ctypes.byref(exe_len)):
                        path = exe_buf.value
                        process_name = path.rsplit("\\", 1)[-1].replace(".exe", "")
                    kernel32.CloseHandle(handle)
            except Exception:
                pass

            context = {"app": process_name, "title": title}
            context["changed"] = (
                context["app"] != self._last_context.get("app")
                or context["title"] != self._last_context.get("title")
            )
            if context["changed"]:
                frame = self._capture_frame_if_due()
                if frame is not None:
                    context["visual_attachment"] = frame
            return context
        except Exception:
            return {"app": "unknown", "title": "", "changed": False}

    def _capture_frame_if_due(self) -> dict[str, Any] | None:
        """Capture one bounded screen frame, throttled to frame_min_interval.

        Reads the env value on each call so Vision settings can tune the
        throttle on an already-running watcher.
        """
        if not self.enabled:
            return None
        interval = self._current_frame_min_interval()
        now = time.time()
        if now - self._last_frame_at < interval:
            return None
        self._last_frame_at = now
        try:
            from PIL import ImageGrab

            image = ImageGrab.grab()
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            from app.runtime.visual_attachments import VisualAttachmentStore

            attachment = VisualAttachmentStore().save_bytes(
                buffer.getvalue(),
                "image/png",
                source="screen_watcher",
            )
            public = attachment.to_public_dict()
            self._latest_frame = dict(public)
            self._latest_frame_at = now
            return public
        except Exception:
            return None

    def latest_frame(self, max_age_seconds: float | None = None) -> dict[str, Any] | None:
        """Return the most recent captured frame when fresh enough."""
        if not self._latest_frame:
            return None
        if max_age_seconds is not None and time.time() - self._latest_frame_at > max_age_seconds:
            return None
        return dict(self._latest_frame)

    def _current_frame_min_interval(self) -> float:
        try:
            return float(os.environ.get("SCREEN_CAPTURE_MIN_INTERVAL", self.frame_min_interval))
        except (TypeError, ValueError):
            return self.frame_min_interval

    # App → activity mapping for state auto-inference
    _APP_ACTIVITY_MAP: dict[str, str] = {
        "code": "coding", "devenv": "coding", "cursor": "coding",
        "vscode": "coding", "pycharm": "coding", "idea64": "coding",
        "Code": "coding", "clion64": "coding", "rider64": "coding",
        "chrome": "browsing", "msedge": "browsing", "firefox": "browsing",
        "explorer": "file_browsing", "terminal": "coding",
        "wechat": "chatting", "qq": "chatting", "discord": "chatting",
        "spotify": "music", "wmplayer": "video",
        "notepad": "writing", "obsidian": "writing", "notion": "writing",
        "steam": "gaming", "league of legends": "gaming",
    }

    def _loop(self) -> None:
        while self._running:
            try:
                ctx = self.capture()

                if ctx.get("changed") and self._last_context:
                    old = dict(self._last_context)
                    visual_attachment = ctx.get("visual_attachment")
                    bus.publish(
                        EventType.STATE_CHANGED,
                        {
                            "screen": {
                                "from": {"app": old.get("app"), "title": old.get("title")},
                                "to": {"app": ctx["app"], "title": ctx["title"]},
                            },
                            "visual_attachment": visual_attachment,
                        },
                        source="screen_watcher",
                    )
                    if self.on_context_change:
                        self.on_context_change(old, ctx)

                self._last_context = ctx
            except Exception as exc:
                print(f"[ScreenWatcher] Error: {exc}")

            time.sleep(self.interval)
