from __future__ import annotations

import asyncio
import io
import time
import json
from types import SimpleNamespace

import pytest
from PIL import Image

from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.context_budget import ContextBudget
from app.runtime.prompt_compiler import PromptCompiler
from app.runtime.visual_attachments import (
    VisualAttachmentError,
    VisualAttachmentStore,
    redact_prompt_messages,
)
from app.transport.websocket.handler import RuntimeEventHandler
from contracts.v3.registry import EventRegistry


def _png_bytes(width: int = 4, height: int = 3) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (255, 120, 20)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_visual_attachment_store_validates_and_resolves_image(tmp_path):
    store = VisualAttachmentStore(tmp_path)
    attachment = store.save_bytes(_png_bytes(), "image/png")

    public = attachment.to_public_dict()
    assert public["id"] == attachment.attachment_id
    assert public["source"] == "user_upload"
    assert public["mimeType"] == "image/png"
    assert public["width"] == 4
    assert public["height"] == 3
    assert public["sizeBytes"] == attachment.size_bytes
    assert len(public["sha256"]) == 64
    assert public["expiresAt"] > time.time()
    resolved = store.resolve(attachment.attachment_id)
    assert resolved.path == attachment.path
    assert store.load_data_url(attachment.attachment_id).startswith("data:image/png;base64,")


def test_visual_attachment_store_normalizes_large_edges_and_has_short_ttl(tmp_path):
    store = VisualAttachmentStore(tmp_path)
    attachment = store.save_bytes(_png_bytes(4096, 2048), "image/png")

    assert attachment.width == 2048
    assert attachment.height == 1024
    assert attachment.expires_at - attachment.created_at == 30 * 60

    metadata = attachment.to_public_dict()
    assert "path" not in metadata
    assert "data" not in metadata


def test_visual_attachment_store_rejects_mismatched_and_invalid_images(tmp_path):
    store = VisualAttachmentStore(tmp_path)

    with pytest.raises(VisualAttachmentError, match="declared type"):
        store.save_bytes(_png_bytes(), "image/jpeg")
    with pytest.raises(VisualAttachmentError, match="Invalid or unreadable"):
        store.save_bytes(b"not an image", "image/png")
    with pytest.raises(VisualAttachmentError, match="not found"):
        store.resolve("att_0123456789abcdef0123456789abcdef")


def test_visual_attachment_source_allowlist(tmp_path):
    from app.runtime.visual_attachments import (
        ALLOWED_ATTACHMENT_SOURCES,
        validate_attachment_source,
    )

    assert ALLOWED_ATTACHMENT_SOURCES == {
        "user_upload",
        "camera",
        "screen_capture",
        "screen_watcher",
        "screen_chat",
    }
    assert validate_attachment_source("camera") == "camera"
    assert validate_attachment_source("  Screen_Capture ") == "screen_capture"
    with pytest.raises(VisualAttachmentError, match="Unsupported"):
        validate_attachment_source("microphone")
    with pytest.raises(VisualAttachmentError, match="Unsupported"):
        validate_attachment_source("")

    store = VisualAttachmentStore(tmp_path)
    attachment = store.save_bytes(
        _png_bytes(),
        "image/png",
        source=validate_attachment_source("camera"),
    )
    assert attachment.source == "camera"


def test_prompt_compiler_injects_provider_image_blocks_without_exposing_them_in_snapshot():
    class FakeStore:
        def load_data_url(self, attachment_id: str) -> str:
            assert attachment_id == "att_0123456789abcdef0123456789abcdef"
            return "data:image/png;base64,secret-image-bytes"

    turn = CharacterTurn(input=TurnInput(
        text="这是什么？",
        visual_attachments=(
            {
                "id": "att_0123456789abcdef0123456789abcdef",
                "mimeType": "image/png",
                "width": 4,
                "height": 3,
                "sizeBytes": 10,
            },
        ),
    ))
    compiled = PromptCompiler(
        context_budget=ContextBudget(soft_tokens=20_000, hard_tokens=24_000),
        visual_attachment_store=FakeStore(),
    ).compile(turn, None)

    visual_message = compiled.messages[-1]
    assert visual_message["role"] == "user"
    assert visual_message["content"][0] == {"type": "text", "text": "这是什么？"}
    assert visual_message["content"][1]["type"] == "image_url"
    assert visual_message["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")

    redacted = redact_prompt_messages(compiled.messages)
    assert "secret-image-bytes" not in str(redacted)
    assert redacted[-1]["content"][1]["image_url"]["url"] == "[visual attachment redacted]"


def test_context_budget_keeps_multimodal_content_shape_and_counts_images():
    messages = [
        {"role": "system", "content": "system"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "请看图"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,x"}},
            ],
        },
    ]
    fitted, report = ContextBudget(soft_tokens=1_000, hard_tokens=1_000).fit_messages(messages)

    assert isinstance(fitted[-1]["content"], list)
    assert fitted[-1]["content"][1]["type"] == "image_url"
    assert report["visual_images"] == 1


def test_visual_setting_controls_unknown_model_requests():
    from app.interfaces.llm import VisionRequestError
    from app.models.http_adapters import validate_visual_request

    with pytest.raises(VisionRequestError, match="disabled in settings") as error:
        validate_visual_request(
            False,
            {"hasVisionInput": True, "imageCount": 1, "imageByteSizes": [10]},
        )
    assert error.value.code == "vision.disabled_by_settings"

    validate_visual_request(
        True,
        {"hasVisionInput": True, "imageCount": 1, "imageByteSizes": [10]},
    )


def test_existing_adapter_observes_a_saved_vision_toggle(monkeypatch):
    from unittest.mock import patch

    from app.models.http_adapters import OpenAILLMAdapter

    monkeypatch.setenv("LLM_ENGINE", "deepseek")
    monkeypatch.delenv("LLM_ENABLE_VISION", raising=False)
    with patch("openai.OpenAI", return_value=object()):
        adapter = OpenAILLMAdapter(
            api_key="test-key",
            base_url="https://example.test/v1",
            model="unknown-vision-model",
        )

    assert adapter.vision_enabled is False
    monkeypatch.setenv("LLM_ENABLE_VISION", "1")
    assert adapter.vision_enabled is True


def test_visual_limits_follow_settings_and_bound_requests(monkeypatch):
    from app.models.http_adapters import validate_visual_request
    from app.runtime.visual_attachments import get_visual_limits

    monkeypatch.setenv("LLM_VISUAL_MAX_IMAGES", "2")
    monkeypatch.setenv("LLM_VISUAL_MAX_MB", "1")
    monkeypatch.setenv("LLM_VISUAL_MAX_PIXELS", "24000000")
    monkeypatch.setenv("LLM_VISUAL_MAX_EDGE", "4096")

    limits = get_visual_limits()
    assert limits == {
        "maxImages": 2,
        "maxImageBytes": 1024 * 1024,
        "maxImagePixels": 24000000,
        "maxImageEdge": 4096,
    }

    from app.interfaces.llm import VisionRequestError

    with pytest.raises(VisionRequestError, match="maximum is 2"):
        validate_visual_request(
            True,
            {"hasVisionInput": True, "imageCount": 3, "imageByteSizes": [10, 10, 10]},
        )
    with pytest.raises(VisionRequestError, match="1048576 bytes"):
        validate_visual_request(
            True,
            {"hasVisionInput": True, "imageCount": 1, "imageByteSizes": [2 * 1024 * 1024]},
        )


def test_visual_contract_accepts_configured_size_above_the_old_four_mb_limit():
    from contracts.v3.events import UserVisualPayload

    payload = UserVisualPayload.model_validate({
        "text": "请看图",
        "attachments": [{
            "id": "att_0123456789abcdef0123456789abcdef",
            "mimeType": "image/png",
            "width": 4096,
            "height": 2048,
            "sizeBytes": 4_459_444,
        }],
    })

    assert payload.attachments[0].size_bytes == 4_459_444


def test_resolved_attachment_policy_uses_current_settings(monkeypatch):
    from app.runtime.visual_attachments import (
        VisualAttachmentError,
        validate_visual_attachment_policy,
    )

    monkeypatch.setenv("LLM_VISUAL_MAX_MB", "10")
    monkeypatch.setenv("LLM_VISUAL_MAX_PIXELS", "24000000")
    monkeypatch.setenv("LLM_VISUAL_MAX_EDGE", "4096")
    validate_visual_attachment_policy(size_bytes=4_459_444, width=4096, height=2048)

    monkeypatch.setenv("LLM_VISUAL_MAX_MB", "4")
    with pytest.raises(VisualAttachmentError, match="4194304 bytes"):
        validate_visual_attachment_policy(size_bytes=4_459_444)


def test_visual_response_failure_is_not_replaced_with_generic_success():
    from app.interfaces.llm import LLMResponse
    from app.interfaces.llm import VisionRequestError
    from app.runtime.steps.decision_step import DecisionStep

    class EmptyVisionLLM:
        def __init__(self):
            self.calls = []

        async def generate(self, messages, **kwargs):
            self.calls.append(messages)
            return LLMResponse(
                visual={"hasVisionInput": True, "engine": "opencode", "model": "x-preview-f-free"},
            )

    class FakeStore:
        def load_data_url(self, attachment_id: str) -> str:
            return "data:image/png;base64,placeholder"

    turn = CharacterTurn(input=TurnInput(
        text="这是什么？",
        visual_attachments=({
            "id": "att_0123456789abcdef0123456789abcdef",
            "mimeType": "image/png",
            "width": 4,
            "height": 3,
            "sizeBytes": 10,
        },),
    ))
    llm = EmptyVisionLLM()
    step = DecisionStep(llm)
    step.prompt_compiler._visual_attachment_store = FakeStore()

    with pytest.raises(VisionRequestError) as error:
        asyncio.run(step.run(turn))
    assert error.value.code == "vision.response_invalid"
    assert turn.visual_diagnostics["visualError"] == "vision.response_invalid"
    assert len(llm.calls) == 2
    assert any(
        block.get("type") == "image_url"
        for message in llm.calls[1]
        for block in (message.get("content", []) if isinstance(message.get("content"), list) else [])
        if isinstance(block, dict)
    )


def test_screen_capture_tool_result_injects_the_image_block(tmp_path, monkeypatch):
    store = VisualAttachmentStore(tmp_path)
    attachment = store.save_bytes(_png_bytes(), "image/png", source="screen_capture")
    payload = {
        "type": "screenshot",
        "attachmentId": attachment.attachment_id,
        "mimeType": attachment.mime_type,
        "width": attachment.width,
        "height": attachment.height,
        "sizeBytes": attachment.size_bytes,
    }
    monkeypatch.setenv("SOULLINK_VISUAL_ATTACHMENT_DIR", str(tmp_path))

    class Supervisor:
        async def execute(self, *args, **kwargs):
            return SimpleNamespace(text=json.dumps(payload), audit={
                "tool": "screen_capture", "status": "ok",
            })

    from app.runtime.tool_coordinator import ToolCoordinator

    turn = CharacterTurn(input=TurnInput(text="看一下屏幕"))
    messages: list[dict] = []
    asyncio.run(ToolCoordinator(
        tools=object(),
        tool_supervisor=Supervisor(),
    )._execute_one_tool(
        turn,
        messages,
        [{"function": {"name": "screen_capture"}, "risk": "read_only"}],
        SimpleNamespace(name="screen_capture", args={}),
        0,
        0,
        [],
    ))

    assert isinstance(messages[-1]["content"], list)
    assert messages[-1]["content"][1]["type"] == "image_url"
    assert turn.visual_diagnostics["screenshotToolSuccess"] is True
    assert turn.visual_diagnostics["screenshotInjected"] is True


def test_screen_capture_returns_ephemeral_reference_without_base64(tmp_path, monkeypatch):
    from PIL import ImageGrab

    monkeypatch.setenv("SOULLINK_VISUAL_ATTACHMENT_DIR", str(tmp_path))
    monkeypatch.setattr(ImageGrab, "grab", lambda *args, **kwargs: Image.new("RGB", (8, 6), (1, 2, 3)))
    from app.legacy.tools.builtins.screen import screen_capture

    payload = json.loads(screen_capture())
    assert payload["type"] == "screenshot"
    assert payload["attachmentId"].startswith("att_")
    assert "data" not in payload
    assert "base64" not in str(payload).lower()
    assert VisualAttachmentStore(tmp_path).resolve(payload["attachmentId"]).source == "screen_capture"


def test_visual_v3_event_completes_full_runtime_turn(tmp_path, monkeypatch):
    from app.interfaces.asr import ASRInterface, MockASR
    from app.interfaces.llm import LLMInterface, LLMResponse
    from app.interfaces.memory import MemoryInterface, MockMemory
    from app.interfaces.tts import TTSInterface, MockTTS
    from app.providers.registry import provider_registry
    from app.runtime.runtime import CharacterRuntime

    class VisualRuntimeLLM(LLMInterface):
        def __init__(self):
            self.seen_images = 0

        async def generate(self, messages, **kwargs):
            self.seen_images = sum(
                1 for message in messages
                for block in (message.get("content", []) if isinstance(message.get("content"), list) else [])
                if isinstance(block, dict) and block.get("type") == "image_url"
            )
            return LLMResponse(
                reply="我看到了这张图片。",
                segments=[{
                    "text": "我看到了这张图片。",
                    "emotion": "neutral",
                    "behavior": "speak",
                    "attention": "user",
                    "energy": 0.5,
                    "intensity": 0.5,
                }],
                visual={"hasVisionInput": self.seen_images > 0, "providerSuccess": True},
                finish_reason="stop",
            )

        async def generate_stream(self, messages, **kwargs):
            yield "我看到了这张图片。"

    provider_registry.register(LLMInterface, "default", VisualRuntimeLLM)
    provider_registry.register(ASRInterface, "default", MockASR)
    provider_registry.register(TTSInterface, "default", MockTTS)
    provider_registry.register(MemoryInterface, "default", MockMemory)
    monkeypatch.setenv("SOULLINK_VISUAL_ATTACHMENT_DIR", str(tmp_path))
    attachment = VisualAttachmentStore(tmp_path).save_bytes(_png_bytes(), "image/png")
    runtime = CharacterRuntime()
    event = EventRegistry.parse({
        "protocolVersion": "3.0",
        "eventId": "evt-visual-runtime",
        "eventType": "user.visual",
        "sessionId": "session-visual",
        "turnId": "turn-visual",
        "sequence": 1,
        "source": "frontend",
        "timestamp": time.time(),
        "payload": {
            "text": "请看看",
            "attachments": [{
                "id": attachment.attachment_id,
                "mimeType": attachment.mime_type,
                "width": attachment.width,
                "height": attachment.height,
                "sizeBytes": attachment.size_bytes,
            }],
        },
    })

    responses = asyncio.run(RuntimeEventHandler(runtime=runtime).handle_event(event))
    turn = runtime.conversation.last_turn
    assert any(item.event_type == "turn.completed" for item in responses)
    assert turn is not None
    assert runtime.providers["llm"].seen_images == 1


def test_history_metadata_keeps_visual_reference_without_bytes_or_paths(tmp_path):
    from app.memory.store import MemoryStore

    memory = MemoryStore(tmp_path)
    memory.log_turn(
        "用户发送了 1 张图片",
        {"reply_text": "我看到了。"},
        character_id="test",
        turn_id="turn-visual-history",
        write_token="conversation",
        history_uid="hist-visual",
        metadata={"visual": {
            "hasVisionInput": True,
            "imageCount": 1,
            "imageHashes": ["a" * 64],
            "attachmentIds": ["att_0123456789abcdef0123456789abcdef"],
            "dataUrl": "data:image/png;base64,secret",
            "localPath": "C:/secret.png",
        }},
    )

    messages = memory.history_messages("hist-visual", character_id="test")
    serialized = str(messages)
    assert messages[0]["content"] == "用户发送了 1 张图片"
    assert messages[0]["metadata"]["visual"]["imageCount"] == 1
    assert "secret" not in serialized
    assert "C:/secret.png" not in serialized


def test_runtime_handler_rejects_missing_visual_attachment_without_running_a_turn(tmp_path, monkeypatch):
    monkeypatch.setenv("SOULLINK_VISUAL_ATTACHMENT_DIR", str(tmp_path))
    event = EventRegistry.parse({
        "protocolVersion": "3.0",
        "eventId": "evt-visual-invalid",
        "eventType": "user.visual",
        "sessionId": "session-1",
        "turnId": "turn-1",
        "sequence": 1,
        "source": "frontend",
        "timestamp": 1.0,
        "payload": {
            "text": "看一下",
            "attachments": [{
                "id": "att_0123456789abcdef0123456789abcdef",
                "mimeType": "image/png",
                "width": 4,
                "height": 3,
                "sizeBytes": 10,
            }],
        },
    })

    responses = asyncio.run(RuntimeEventHandler(runtime=object()).handle_event(event))

    assert len(responses) == 1
    assert responses[0].to_dict()["payload"]["code"] == "visual_attachment_invalid"
