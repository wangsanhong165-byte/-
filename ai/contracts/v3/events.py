"""Strongly typed payload models for the V3 runtime protocol."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue


class PayloadModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EmptyPayload(PayloadModel):
    pass


class SessionOpenPayload(PayloadModel):
    capabilities: list[str] = Field(default_factory=list)


class SessionOpenedPayload(PayloadModel):
    capabilities: list[str] = Field(default_factory=list)
    config: dict[str, JsonValue] = Field(default_factory=dict)


class SessionClosedPayload(PayloadModel):
    reason: str


class SessionProbePayload(PayloadModel):
    nonce: str = ""


class RuntimeStatusPayload(PayloadModel):
    state: str
    message: str = ""


class RuntimeReadyPayload(PayloadModel):
    services: list[str] = Field(default_factory=list)


class RuntimeDegradedPayload(PayloadModel):
    services: list[str] = Field(default_factory=list)
    reason: str


class ServiceStatusPayload(PayloadModel):
    service: str
    state: Literal["starting", "ready", "degraded", "failed", "stopped"]
    detail: str = ""


class ConfigurationUpdatedPayload(PayloadModel):
    config: dict[str, JsonValue]


class ProtocolErrorPayload(PayloadModel):
    code: str
    message: str
    request_id: str | None = Field(default=None, alias="requestId")
    offending_event_id: str | None = Field(default=None, alias="offendingEventId")


class UserTextPayload(PayloadModel):
    text: str = Field(min_length=1)


class VisualAttachmentPayload(PayloadModel):
    attachment_id: str = Field(alias="id", min_length=36, max_length=36)
    mime_type: Literal["image/jpeg", "image/png", "image/webp"] = Field(alias="mimeType")
    # Protocol hard ceilings; active user visual settings are enforced after
    # parsing against the resolved local attachment.
    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=8192)
    size_bytes: int = Field(alias="sizeBytes", gt=0, le=32 * 1024 * 1024)


class UserVisualPayload(PayloadModel):
    text: str = ""
    attachments: list[VisualAttachmentPayload] = Field(min_length=1, max_length=16)


class UserAudioStartedPayload(PayloadModel):
    sample_rate: int = Field(alias="sampleRate", gt=0)
    channels: int = Field(default=1, gt=0)
    format: Literal["pcm_f32", "pcm_s16", "wav"] = "pcm_f32"


class UserAudioChunkPayload(PayloadModel):
    samples: list[float]


class UserAudioCompletedPayload(PayloadModel):
    sample_rate: int | None = Field(default=None, alias="sampleRate", gt=0)
    attachments: list[VisualAttachmentPayload] = Field(
        default_factory=list,
        max_length=16,
    )


class CancelledPayload(PayloadModel):
    reason: str = "cancelled"


class TurnStartedPayload(PayloadModel):
    origin: Literal["user", "initiative", "tool", "system"] = "user"
    input_mode: Literal["text", "audio", "visual", "initiative"] = Field(default="text", alias="inputMode")


class TurnProgressPayload(PayloadModel):
    stage: str
    message: str = ""


class TurnCompletedPayload(PayloadModel):
    reason: str = "complete"


class FailurePayload(PayloadModel):
    code: str
    message: str


class AsrStartedPayload(PayloadModel):
    language: str | None = None


class AsrResultPayload(PayloadModel):
    text: str
    confidence: float | None = Field(default=None, ge=0, le=1)
    language: str | None = None


class AssistantTextChunkPayload(PayloadModel):
    delta: str
    text: str


class AssistantSegment(PayloadModel):
    text: str
    emotion: str
    behavior: str


class AssistantTextCompletedPayload(PayloadModel):
    text: str
    reasoning: str = ""
    segments: list[AssistantSegment] = Field(default_factory=list)


class NaturalVadPayload(PayloadModel):
    valence: float
    arousal: float
    dominance: float


class MotionPlanStepPayload(PayloadModel):
    at_ms: int = Field(alias="atMs", ge=0)
    duration_ms: int = Field(alias="durationMs", ge=120, le=2500)
    primitive: Literal[
        "nod", "tilt_left", "tilt_right", "lean_forward", "lean_back",
        "sway", "look_left", "look_right", "breathe", "shrug",
    ]
    intensity: float = Field(ge=0, le=1)


class MotionPlanPayload(PayloadModel):
    duration_ms: int = Field(alias="durationMs", ge=300, le=8000)
    steps: list[MotionPlanStepPayload] = Field(min_length=1, max_length=3)


class CharacterIntentSegmentPayload(PayloadModel):
    text: str | None = None
    emotion: str | None = None
    leak: str | None = None
    behavior: str | None = None
    intensity: float | None = Field(default=None, ge=0, le=1)
    attention: Literal["user", "screen", "away", "neutral"] | None = None
    energy: float | None = Field(default=None, ge=0, le=1)
    duration_ms: int | None = Field(default=None, alias="durationMs", ge=0)
    natural_vad: NaturalVadPayload | None = Field(default=None, alias="naturalVAD")
    context_tags: list[str] = Field(default_factory=list, alias="contextTags")
    motion_plan: MotionPlanPayload | None = Field(default=None, alias="motionPlan")


class CharacterIntentPayload(PayloadModel):
    emotion: str
    leak: str | None = None
    behavior: str
    intensity: float = Field(default=0.5, ge=0, le=1)
    attention: Literal["user", "screen", "away", "neutral"] = "user"
    energy: float = Field(ge=0, le=1)
    duration_ms: int | None = Field(default=None, alias="durationMs", ge=0)
    natural_vad: NaturalVadPayload | None = Field(default=None, alias="naturalVAD")
    context_tags: list[str] = Field(default_factory=list, alias="contextTags")
    motion_plan: MotionPlanPayload | None = Field(default=None, alias="motionPlan")
    segments: list[CharacterIntentSegmentPayload] = Field(default_factory=list)


class CharacterExpressionPayload(PayloadModel):
    name: str
    intensity: float = Field(default=1.0, ge=0, le=1)
    controller: str = ""
    priority: int = 0


class CharacterMotionPayload(PayloadModel):
    name: str
    controller: str = ""
    priority: int = 0
    loop: bool = False


class CharacterComponentPayload(PayloadModel):
    name: str
    enabled: bool
    display_name: str = Field(default="", alias="displayName")
    controller: str = ""
    priority: int = 0
    expression: str = ""
    param_ids: list[str] = Field(default_factory=list, alias="paramIds")


class CharacterSnapshotPayload(PayloadModel):
    components: dict[str, bool]
    expression: str = ""
    expression_intensity: float = Field(default=0.0, alias="expressionIntensity")
    motion: str = ""


class CharacterSuggestionPayload(PayloadModel):
    suggestion_id: str = Field(alias="suggestionId")
    target: str
    name: str
    action: str
    reason: str


class CharacterControlRequestedPayload(PayloadModel):
    action: str
    params: dict[str, JsonValue] = Field(default_factory=dict)
    request_id: str = Field(alias="requestId")


class CharacterSuggestionAcceptedPayload(PayloadModel):
    suggestion_id: str = Field(alias="suggestionId")


class CharacterSuggestionRejectedPayload(PayloadModel):
    suggestion_id: str = Field(alias="suggestionId")
    reason: str = ""


class TtsStartedPayload(PayloadModel):
    format: str = "wav"
    audio_sequence: int = Field(default=0, alias="audioSequence", ge=0)


class TtsAudioPayload(PayloadModel):
    data: str
    format: str = "wav"
    audio_sequence: int = Field(default=0, alias="audioSequence", ge=0)
    volumes: list[float] = Field(default_factory=list)


class ToolRequestedPayload(PayloadModel):
    request_id: str = Field(alias="requestId")
    tool: str
    args: dict[str, JsonValue]
    risk: str


class ToolStartedPayload(PayloadModel):
    request_id: str = Field(alias="requestId")
    tool: str


class ToolResultPayload(PayloadModel):
    request_id: str = Field(alias="requestId")
    tool: str
    result: dict[str, JsonValue]


class ToolFailedPayload(PayloadModel):
    request_id: str = Field(alias="requestId")
    tool: str
    code: str
    message: str


class ManagementRequestedPayload(PayloadModel):
    request_id: str = Field(alias="requestId")
    action: str
    params: dict[str, JsonValue] = Field(default_factory=dict)


class ManagementResultPayload(PayloadModel):
    request_id: str = Field(alias="requestId")
    action: str
    data: dict[str, JsonValue]


class ManagementFailedPayload(PayloadModel):
    request_id: str = Field(alias="requestId")
    action: str
    code: str
    message: str


class TelemetryEventPayload(PayloadModel):
    name: str
    timestamp: float
    data: dict[str, JsonValue] = Field(default_factory=dict)


class TelemetryBatchPayload(PayloadModel):
    events: list[TelemetryEventPayload]


EVENT_PAYLOAD_MODELS: dict[str, type[PayloadModel]] = {
    "session.open": SessionOpenPayload,
    "session.opened": SessionOpenedPayload,
    "session.closed": SessionClosedPayload,
    "session.ping": SessionProbePayload,
    "session.pong": SessionProbePayload,
    "runtime.status": RuntimeStatusPayload,
    "runtime.ready": RuntimeReadyPayload,
    "runtime.degraded": RuntimeDegradedPayload,
    "service.status": ServiceStatusPayload,
    "configuration.updated": ConfigurationUpdatedPayload,
    "protocol.error": ProtocolErrorPayload,
    "user.text": UserTextPayload,
    "user.visual": UserVisualPayload,
    "user.audio.started": UserAudioStartedPayload,
    "user.audio.chunk": UserAudioChunkPayload,
    "user.audio.completed": UserAudioCompletedPayload,
    "user.audio.cancelled": CancelledPayload,
    "turn.started": TurnStartedPayload,
    "turn.progress": TurnProgressPayload,
    "turn.completed": TurnCompletedPayload,
    "turn.failed": FailurePayload,
    "turn.cancelled": CancelledPayload,
    "asr.started": AsrStartedPayload,
    "asr.result": AsrResultPayload,
    "asr.failed": FailurePayload,
    "assistant.text.started": EmptyPayload,
    "assistant.text.chunk": AssistantTextChunkPayload,
    "assistant.text.completed": AssistantTextCompletedPayload,
    "assistant.failed": FailurePayload,
    "character.intent": CharacterIntentPayload,
    "character.expression": CharacterExpressionPayload,
    "character.motion": CharacterMotionPayload,
    "character.component": CharacterComponentPayload,
    "character.snapshot": CharacterSnapshotPayload,
    "character.suggestion": CharacterSuggestionPayload,
    "character.control.requested": CharacterControlRequestedPayload,
    "character.suggestion.accepted": CharacterSuggestionAcceptedPayload,
    "character.suggestion.rejected": CharacterSuggestionRejectedPayload,
    "tts.started": TtsStartedPayload,
    "tts.audio": TtsAudioPayload,
    "tts.completed": TurnCompletedPayload,
    "tts.failed": FailurePayload,
    "tts.cancelled": CancelledPayload,
    "tool.requested": ToolRequestedPayload,
    "tool.started": ToolStartedPayload,
    "tool.result": ToolResultPayload,
    "tool.failed": ToolFailedPayload,
    "management.requested": ManagementRequestedPayload,
    "management.result": ManagementResultPayload,
    "management.failed": ManagementFailedPayload,
    "telemetry.batch": TelemetryBatchPayload,
}


TURN_EVENT_TYPES = frozenset({
    "user.text",
    "user.visual",
    "user.audio.started",
    "user.audio.chunk",
    "user.audio.completed",
    "user.audio.cancelled",
    "turn.started",
    "turn.progress",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
    "asr.started",
    "asr.result",
    "asr.failed",
    "assistant.text.started",
    "assistant.text.chunk",
    "assistant.text.completed",
    "assistant.failed",
    "character.intent",
    "tts.started",
    "tts.audio",
    "tts.completed",
    "tts.failed",
    "tts.cancelled",
    "tool.requested",
    "tool.started",
    "tool.result",
    "tool.failed",
})

SYSTEM_EVENT_TYPES = frozenset(EVENT_PAYLOAD_MODELS) - TURN_EVENT_TYPES
