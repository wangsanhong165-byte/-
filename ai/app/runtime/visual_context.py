"""Turn-level visual context for user turns.

Resolves optional desktop frames for a user turn. Prefers the freshest frame
already captured by ScreenWatcher, and only captures a new frame when the
cached one is older than the configured threshold. Frames are ephemeral: they
flow through VisualAttachmentStore and history never retains bytes or paths.
"""

from __future__ import annotations

import io
import os
from typing import Any

_DEFAULT_SCREEN_CHAT_MAX_AGE_SECONDS = 8.0


def screen_chat_max_age_seconds() -> float:
    """Return the maximum age (seconds) for reusing a ScreenWatcher frame."""
    try:
        return max(
            0.0,
            float(
                os.environ.get(
                    "SCREEN_CHAT_MAX_AGE_SECONDS",
                    str(_DEFAULT_SCREEN_CHAT_MAX_AGE_SECONDS),
                )
            ),
        )
    except (TypeError, ValueError):
        return _DEFAULT_SCREEN_CHAT_MAX_AGE_SECONDS


class TurnVisualContext:
    """Supply bounded desktop context for a single user turn."""

    def __init__(self, runtime: Any) -> None:
        self.runtime = runtime

    def screen_frame(self) -> dict[str, Any] | None:
        """Return one desktop frame, reusing a fresh watcher frame first."""
        watcher = getattr(self.runtime, "screen_watcher", None)
        recent = None
        if watcher is not None:
            recent = watcher.latest_frame(
                max_age_seconds=screen_chat_max_age_seconds()
            )
        if recent is not None:
            return recent
        return self.capture_screen_frame()

    @staticmethod
    def capture_screen_frame() -> dict[str, Any] | None:
        """Capture the current desktop as an ephemeral visual attachment."""
        try:
            from PIL import ImageGrab

            image = ImageGrab.grab()
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            from app.runtime.visual_attachments import VisualAttachmentStore

            return VisualAttachmentStore().save_bytes(
                buffer.getvalue(),
                "image/png",
                source="screen_chat",
            ).to_public_dict()
        except Exception:
            return None