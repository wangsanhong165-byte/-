"""LLM Interface — canonical response model and provider abstraction.

Every LLM provider returns LLMResponse, regardless of SDK or API.
No JSON strings escape the provider layer.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator


class VisionRequestError(RuntimeError):
    """A visual request was blocked by local settings or provider policy."""

    def __init__(self, message: str, *, code: str = "vision.request_invalid") -> None:
        super().__init__(message)
        self.code = code


@dataclass
class ToolCall:
    """A single tool invocation requested by the LLM."""

    name: str
    args: dict[str, Any] = field(default_factory=dict)


@dataclass
class LLMUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int = 0
    model: str = ""
    estimated: bool = False

    def __post_init__(self):
        if not self.total_tokens:
            self.total_tokens = self.prompt_tokens + self.completion_tokens

    def add(self, other: "LLMUsage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        self.total_tokens += other.total_tokens
        self.cached_tokens += other.cached_tokens
        self.model = other.model or self.model
        self.estimated = self.estimated or other.estimated


@dataclass
class LLMResponse:
    """Canonical LLM response — every provider returns exactly this.

    Fields:
        reply:       Plain text reply (extracted from final_reply or content).
        segments:    Per-sentence segment dicts with text/emotion/behavior.
        tool_calls:  Tool invocations requested by the LLM.
        messages:    Full conversation history including assistant tool_calls
                     messages (used by DecisionStep's tool-calling loop).
        error:       Provider-level error string (empty on success).
    """

    reply: str = ""
    reasoning: str = ""
    segments: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)
    error: str = ""
    usage: LLMUsage = field(default_factory=LLMUsage)
    # Provider-side completion signal ("stop", "length", ...). "length" means
    # the output budget was exhausted, so an empty reply is truncation, not a
    # deliberate silence — the pipeline must treat it as abnormal.
    finish_reason: str = ""
    visual: dict[str, Any] = field(default_factory=dict)

    def add_usage(self, usage: LLMUsage) -> None:
        self.usage.add(usage)


class LLMInterface(ABC):
    """Interface for Large Language Model providers."""

    @abstractmethod
    async def generate(
        self,
        messages: list[dict[str, Any]],
        **kwargs,
    ) -> LLMResponse:
        """Call LLM and return a canonical LLMResponse.

        Args:
            messages: Conversation history (system + user + assistant).
            **kwargs: Provider-specific options (tools, temperature, etc.).

        Returns:
            LLMResponse with reply, segments, tool_calls, and messages.
        """
        ...

    @abstractmethod
    async def generate_stream(
        self,
        messages: list[dict[str, Any]],
        **kwargs,
    ) -> AsyncIterator[str]:
        """Stream tokens from the LLM.

        Yields token strings. Used for real-time display.
        The non-streaming generate() remains the canonical interface
        for the runtime pipeline.
        """
        ...


class MockLLM(LLMInterface):
    """Fixed LLMResponse for testing."""

    async def generate(
        self,
        messages: list[dict[str, Any]],
        **kwargs,
    ) -> LLMResponse:
        return LLMResponse(reply="Hello!", segments=[])

    async def generate_stream(
        self,
        messages: list[dict[str, Any]],
        **kwargs,
    ) -> AsyncIterator[str]:
        yield '{"final_reply": "Hello!", "segments": []}'


class ReplayLLM(LLMInterface):
    """Replay recorded LLMResponses for bug reproduction."""

    def __init__(self, fixture_path: str):
        self.fixture_path = fixture_path
        self._recorded: list[LLMResponse] = []
        self._index = 0

    async def generate(
        self,
        messages: list[dict[str, Any]],
        **kwargs,
    ) -> LLMResponse:
        if self._index < len(self._recorded):
            response = self._recorded[self._index]
            self._index += 1
            return response
        return LLMResponse()

    async def generate_stream(
        self,
        messages: list[dict[str, Any]],
        **kwargs,
    ) -> AsyncIterator[str]:
        if self._index < len(self._recorded):
            response = self._recorded[self._index]
            self._index += 1
            yield str(response)
