"""Ephemeral, normalized image attachments for multimodal runtime turns.

The browser sends only a safe descriptor over V3. Image bytes stay in a
short-lived local store and are resolved only at the prompt/tool boundary.
History, telemetry, and developer snapshots contain metadata, never bytes,
data URLs, or local paths.
"""

from __future__ import annotations

import base64
from copy import deepcopy
import hashlib
import io
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4


MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
MAX_ATTACHMENT_PIXELS = 12_000_000
MAX_ATTACHMENT_EDGE = 2048
MAX_ATTACHMENT_COUNT = 4
_HARD_MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
_HARD_MAX_ATTACHMENT_PIXELS = 50_000_000
_HARD_MAX_ATTACHMENT_EDGE = 8192
_HARD_MAX_ATTACHMENT_COUNT = 16
ATTACHMENT_TTL_SECONDS = 30 * 60
SUPPORTED_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
ALLOWED_ATTACHMENT_SOURCES = frozenset({
    "user_upload",
    "camera",
    "screen_capture",
    "screen_watcher",
    "screen_chat",
})
_ATTACHMENT_ID = re.compile(r"^att_[a-f0-9]{32}$")
_FORMAT_TO_MIME = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
_MIME_TO_SUFFIX = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


class VisualAttachmentError(ValueError):
    """Raised when an uploaded or referenced image is not safe to use."""


def validate_attachment_source(source: str | None) -> str:
    """Normalize and allowlist the producer of a visual attachment."""
    value = (source or "").strip().lower()
    if value not in ALLOWED_ATTACHMENT_SOURCES:
        raise VisualAttachmentError(
            f"Unsupported visual attachment source: {value or '<empty>'}"
        )
    return value


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def get_visual_limits() -> dict[str, int]:
    """Return user-controlled visual limits with bounded safety ceilings."""
    max_megabytes = _bounded_int(
        "LLM_VISUAL_MAX_MB",
        MAX_ATTACHMENT_BYTES // (1024 * 1024),
        1,
        _HARD_MAX_ATTACHMENT_BYTES // (1024 * 1024),
    )
    return {
        "maxImages": _bounded_int(
            "LLM_VISUAL_MAX_IMAGES",
            MAX_ATTACHMENT_COUNT,
            1,
            _HARD_MAX_ATTACHMENT_COUNT,
        ),
        "maxImageBytes": max_megabytes * 1024 * 1024,
        "maxImagePixels": _bounded_int(
            "LLM_VISUAL_MAX_PIXELS",
            MAX_ATTACHMENT_PIXELS,
            1_000_000,
            _HARD_MAX_ATTACHMENT_PIXELS,
        ),
        "maxImageEdge": _bounded_int(
            "LLM_VISUAL_MAX_EDGE",
            MAX_ATTACHMENT_EDGE,
            256,
            _HARD_MAX_ATTACHMENT_EDGE,
        ),
    }


def get_camera_policy() -> dict[str, int]:
    """Return bounded camera sampling settings for voice turns."""
    return {
        "sampleIntervalMs": _bounded_int(
            "LLM_CAMERA_SAMPLE_INTERVAL_MS",
            2000,
            500,
            5000,
        ),
        "maxFrames": _bounded_int(
            "LLM_CAMERA_MAX_FRAMES",
            4,
            1,
            _HARD_MAX_ATTACHMENT_COUNT,
        ),
    }


def validate_visual_attachment_policy(
    *,
    count: int | None = None,
    size_bytes: int | None = None,
    width: int | None = None,
    height: int | None = None,
) -> None:
    """Apply the current user policy to resolved attachment metadata."""
    limits = get_visual_limits()
    if count is not None and count > limits["maxImages"]:
        raise VisualAttachmentError(
            f"Visual request contains {count} images; maximum is {limits['maxImages']}"
        )
    if size_bytes is not None and size_bytes > limits["maxImageBytes"]:
        raise VisualAttachmentError(
            f"Visual image exceeds {limits['maxImageBytes']} bytes"
        )
    if width is not None and height is not None:
        if width * height > limits["maxImagePixels"]:
            raise VisualAttachmentError("Image dimensions exceed the current visual pixel limit")
        if max(width, height) > limits["maxImageEdge"]:
            raise VisualAttachmentError("Image dimensions exceed the current visual edge limit")


@dataclass(frozen=True)
class VisualAttachment:
    attachment_id: str
    source: str
    mime_type: str
    width: int
    height: int
    size_bytes: int
    sha256: str
    created_at: float
    expires_at: float
    path: Path

    def to_public_dict(self) -> dict[str, int | float | str]:
        """Return metadata safe to send to the browser and runtime."""
        return {
            "id": self.attachment_id,
            "source": self.source,
            "mimeType": self.mime_type,
            "width": self.width,
            "height": self.height,
            "sizeBytes": self.size_bytes,
            "sha256": self.sha256,
            "expiresAt": self.expires_at,
        }


class VisualAttachmentStore:
    """Store and resolve short-lived, validated local image attachments."""

    def __init__(self, root: Path | None = None) -> None:
        configured = os.environ.get("SOULLINK_VISUAL_ATTACHMENT_DIR", "").strip()
        self.root = Path(root) if root is not None else Path(configured) if configured else (
            Path(__file__).resolve().parents[2] / "data" / "runtime" / "visual_attachments"
        )
        self.root.mkdir(parents=True, exist_ok=True)

    def save_bytes(
        self,
        data: bytes,
        declared_mime_type: str | None = None,
        *,
        source: str = "user_upload",
    ) -> VisualAttachment:
        if not data:
            raise VisualAttachmentError("Image attachment is empty")
        limits = get_visual_limits()
        if len(data) > limits["maxImageBytes"]:
            raise VisualAttachmentError(
                f"Image attachment exceeds {limits['maxImageBytes'] // 1024 // 1024} MB"
            )

        normalized, width, height, detected_mime = self._normalize(data)
        declared = (declared_mime_type or "").split(";", 1)[0].strip().lower()
        if declared and declared not in SUPPORTED_MIME_TYPES:
            raise VisualAttachmentError("Only PNG, JPEG, and WebP images are supported")
        if declared and declared != detected_mime:
            raise VisualAttachmentError("Image content does not match its declared type")
        if len(normalized) > limits["maxImageBytes"]:
            raise VisualAttachmentError(
                f"Image attachment exceeds {limits['maxImageBytes'] // 1024 // 1024} MB after normalization"
            )

        attachment_id = f"att_{uuid4().hex}"
        path = self.root / f"{attachment_id}{_MIME_TO_SUFFIX[detected_mime]}"
        created_at = time.time()
        expires_at = created_at + ATTACHMENT_TTL_SECONDS
        sha256 = hashlib.sha256(normalized).hexdigest()
        temporary = path.with_suffix(path.suffix + ".tmp")
        try:
            temporary.write_bytes(normalized)
            temporary.replace(path)
            self._write_metadata(
                attachment_id,
                {
                    "source": source,
                    "mimeType": detected_mime,
                    "width": width,
                    "height": height,
                    "sizeBytes": len(normalized),
                    "sha256": sha256,
                    "createdAt": created_at,
                    "expiresAt": expires_at,
                },
            )
        except Exception:
            temporary.unlink(missing_ok=True)
            path.unlink(missing_ok=True)
            self._metadata_path(attachment_id).unlink(missing_ok=True)
            raise
        return VisualAttachment(
            attachment_id=attachment_id,
            source=source,
            mime_type=detected_mime,
            width=width,
            height=height,
            size_bytes=len(normalized),
            sha256=sha256,
            created_at=created_at,
            expires_at=expires_at,
            path=path,
        )

    def resolve(self, attachment_id: str) -> VisualAttachment:
        if not _ATTACHMENT_ID.fullmatch(attachment_id):
            raise VisualAttachmentError("Invalid visual attachment id")
        matches = list(self.root.glob(f"{attachment_id}.*"))
        paths = [path for path in matches if path.suffix in {".jpg", ".png", ".webp"}]
        if len(paths) != 1:
            raise VisualAttachmentError("Visual attachment was not found")
        path = paths[0]
        metadata_path = self._metadata_path(attachment_id)
        metadata = self._read_metadata(metadata_path)
        expires_at = float(metadata.get("expiresAt", path.stat().st_mtime + ATTACHMENT_TTL_SECONDS))
        if expires_at <= time.time():
            path.unlink(missing_ok=True)
            metadata_path.unlink(missing_ok=True)
            raise VisualAttachmentError("Visual attachment has expired")
        data = path.read_bytes()
        width, height, mime_type = self._inspect(data)
        validate_visual_attachment_policy(
            size_bytes=len(data),
            width=width,
            height=height,
        )
        sha256 = hashlib.sha256(data).hexdigest()
        return VisualAttachment(
            attachment_id=attachment_id,
            source=str(metadata.get("source", "user_upload")),
            mime_type=mime_type,
            width=width,
            height=height,
            size_bytes=len(data),
            sha256=sha256,
            created_at=float(metadata.get("createdAt", path.stat().st_mtime)),
            expires_at=expires_at,
            path=path,
        )

    def load_data_url(self, attachment_id: str) -> str:
        attachment = self.resolve(attachment_id)
        encoded = base64.b64encode(attachment.path.read_bytes()).decode("ascii")
        return f"data:{attachment.mime_type};base64,{encoded}"

    def cleanup(self, max_age_seconds: float = ATTACHMENT_TTL_SECONDS) -> int:
        cutoff = time.time() - max_age_seconds
        removed = 0
        for path in self.root.iterdir():
            if path.is_file() and path.suffix in {".jpg", ".png", ".webp"} and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
                self._metadata_path(path.stem).unlink(missing_ok=True)
                removed += 1
            elif path.is_file() and path.suffix == ".json" and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        return removed

    @staticmethod
    def _inspect(data: bytes) -> tuple[int, int, str]:
        max_pixels = get_visual_limits()["maxImagePixels"]
        try:
            from PIL import Image

            with Image.open(io.BytesIO(data)) as image:
                image.verify()
                image_format = str(image.format or "").upper()
            with Image.open(io.BytesIO(data)) as image:
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > max_pixels:
                    raise VisualAttachmentError("Image dimensions are too large")
                image.load()
        except VisualAttachmentError:
            raise
        except Exception as exc:
            raise VisualAttachmentError("Invalid or unreadable image attachment") from exc
        mime_type = _FORMAT_TO_MIME.get(image_format)
        if mime_type is None:
            raise VisualAttachmentError("Only PNG, JPEG, and WebP images are supported")
        return width, height, mime_type

    @classmethod
    def _normalize(cls, data: bytes) -> tuple[bytes, int, int, str]:
        """Decode, bound, resize, and re-encode without carrying EXIF data."""
        max_edge = get_visual_limits()["maxImageEdge"]
        try:
            from PIL import Image

            width, height, mime_type = cls._inspect(data)
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                image = image.copy()
                if max(width, height) > max_edge:
                    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
                if mime_type == "image/jpeg" and image.mode not in {"RGB", "L"}:
                    image = image.convert("RGB")
                output = io.BytesIO()
                save_kwargs: dict[str, object] = {
                    "format": {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}[mime_type],
                }
                if mime_type == "image/jpeg":
                    save_kwargs.update(quality=88, optimize=True)
                elif mime_type == "image/webp":
                    save_kwargs.update(quality=88, method=6)
                else:
                    save_kwargs.update(optimize=True)
                image.save(output, **save_kwargs)
                normalized = output.getvalue()
                normalized_width, normalized_height = image.size
        except VisualAttachmentError:
            raise
        except Exception as exc:
            raise VisualAttachmentError("Invalid or unreadable image attachment") from exc
        return normalized, normalized_width, normalized_height, mime_type

    def _metadata_path(self, attachment_id: str) -> Path:
        return self.root / f"{attachment_id}.json"

    def _write_metadata(self, attachment_id: str, metadata: dict[str, object]) -> None:
        path = self._metadata_path(attachment_id)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)

    @staticmethod
    def _read_metadata(path: Path) -> dict[str, object]:
        if not path.exists():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError, TypeError):
            return {}


def redact_prompt_messages(messages: list[dict]) -> list[dict]:
    """Redact image data before prompt messages enter diagnostics/history."""
    redacted = deepcopy(messages)
    for message in redacted:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "image_url":
                continue
            image_url = block.get("image_url")
            if isinstance(image_url, dict) and "url" in image_url:
                image_url["url"] = "[visual attachment redacted]"
    return redacted
