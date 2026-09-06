"""Built-in tools: screen capture.

These are registered by default and can be toggled via ToolRegistry group control.
"""
from __future__ import annotations

import os
import sys
import io
import json

def _screen_enabled() -> bool:
    """Read per call so toggling SCREEN_ENABLED applies without a restart."""
    return os.environ.get("SCREEN_ENABLED", "1") not in {"0", "false", "no"}


def _vision_master_enabled() -> bool:
    """The screen_capture tool is a visual entry path: with the vision master
    toggle off it must not capture (the captured frame could never be sent,
    and the injection would just fail the turn)."""
    return os.environ.get("LLM_ENABLE_VISION", "").strip().lower() in {"1", "true", "yes", "on"}


def screen_capture(region: str = "full") -> str:
    """Capture current screen into an ephemeral visual attachment.

    Args:
        region: "full" for entire screen or "active" for active window.
    """
    if not _screen_enabled():
        return '{"error": "screen capture disabled (set SCREEN_ENABLED=1)"}'
    if not _vision_master_enabled():
        return json.dumps({
            "type": "screenshot_error",
            "error": "vision input disabled in settings (LLM_ENABLE_VISION)",
        })
    try:
        from PIL import ImageGrab

        if region == "active":
            try:
                import ctypes
                from ctypes import wintypes
                user32 = ctypes.windll.user32
                hwnd = user32.GetForegroundWindow()
                rect = wintypes.RECT()
                ctypes.windll.dwmapi.DwmGetWindowAttribute(
                    hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)
                )
                bbox = (rect.left, rect.top, rect.right, rect.bottom)
                img = ImageGrab.grab(bbox)
            except Exception:
                img = ImageGrab.grab()
        else:
            img = ImageGrab.grab()

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        from app.runtime.visual_attachments import VisualAttachmentStore

        attachment = VisualAttachmentStore().save_bytes(
            buf.getvalue(),
            "image/png",
            source="screen_capture",
        )
        return json.dumps({
            "type": "screenshot",
            "attachmentId": attachment.attachment_id,
            "mimeType": attachment.mime_type,
            "width": attachment.width,
            "height": attachment.height,
            "sizeBytes": attachment.size_bytes,
            "sha256": attachment.sha256,
        }, ensure_ascii=False)
    except ImportError:
        return json.dumps({
            "type": "screenshot_error",
            "error": "PIL not installed (pip install Pillow)",
        }, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"type": "screenshot_error", "error": str(exc)}, ensure_ascii=False)


def _register_all(registry) -> None:
    """Register all built-in tools into the given ToolRegistry."""
    from app.legacy.tools.registry import ToolRegistry

    registry.register(
        name="screen_capture",
        fn=screen_capture,
        description="Capture the current screen as an ephemeral visual attachment. Args: region (full|active).",
        group="builtin",
        risk="safe",
        confirm="auto_allow",
        parameters={
            "region": {
                "type": "string",
                "description": "full or active window",
                "enum": ["full", "active"],
            }
        },
    )
