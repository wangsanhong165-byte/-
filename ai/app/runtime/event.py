from dataclasses import dataclass, field
from datetime import datetime
from uuid import uuid4
from typing import Any


@dataclass
class Event:
    """Unified event — the single entry point for all interaction types."""
    type: str
    payload: dict = field(default_factory=dict)
    source: str = "system"
    timestamp: float = field(default_factory=lambda: datetime.now().timestamp())
    id: str = field(default_factory=lambda: str(uuid4()))


class EventType:
    """Canonical event type constants."""
    SPEECH_RECEIVED = "speech_received"
    TEXT_RECEIVED = "text_received"
    VISUAL_RECEIVED = "visual_received"
    INITIATIVE_TRIGGERED = "initiative_triggered"
    TOOL_FINISHED = "tool_finished"
    SESSION_RESUMED = "session_resumed"
