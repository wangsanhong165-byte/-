"""OpenAILLMProvider — implements LLMInterface via OpenAI-compatible HTTP API.

Wraps the existing OpenAILLMAdapter (from app.models.http_adapters) into
the canonical LLMInterface. Handles sync-to-async bridge via asyncio.to_thread.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, AsyncIterator

from app.interfaces.llm import LLMInterface, LLMResponse, LLMUsage, ToolCall
from app.models.http_adapters import OpenAILLMAdapter

# Explicit output budget for the main chat path. Reasoning models spend part of
# this on their hidden chain, so an overly tight cap truncates the reply before
# any visible text is produced. This is a ceiling, not a target — normal replies
# stay far below it and are unaffected.
_DEFAULT_MAX_TOKENS = 8192
_STRUCTURED_OUTPUT_KEYS = frozenset({"segments", "final_reply", "tool_calls"})
_PROTOCOL_OBJECT_START = re.compile(
    r'\{\s*"(?:segments|final_reply|tool_calls)"\s*:',
    re.IGNORECASE,
)
_FINAL_REPLY_FIELD = re.compile(r'"final_reply"\s*:\s*', re.IGNORECASE)


def _extract_structured_output(content: str) -> dict[str, Any] | None:
    """Find one protocol object without treating arbitrary inline JSON as a reply.

    Some OpenAI-compatible models prepend the spoken answer or wrap the object in
    a Markdown fence even when JSON mode was requested.  ``raw_decode`` lets us
    recover that object without a greedy brace regex, which would break on braces
    inside quoted segment text.
    """
    decoder = json.JSONDecoder()

    def scan(value: str) -> dict[str, Any] | None:
        for index, char in enumerate(value):
            if char != "{":
                continue
            try:
                decoded, _ = decoder.raw_decode(value[index:])
            except (json.JSONDecodeError, ValueError):
                continue
            if (
                isinstance(decoded, dict)
                and _STRUCTURED_OUTPUT_KEYS.intersection(decoded)
            ):
                return decoded
        return None

    envelope = scan(content)
    if envelope is not None:
        return envelope

    # Tolerate a provider that JSON-encodes the whole structured payload once
    # more.  Keep this bounded to one unwrap so malformed input cannot recurse.
    try:
        decoded_content = json.loads(content)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if isinstance(decoded_content, str):
        return scan(decoded_content)
    return None


def _recover_spoken_text_from_malformed_output(content: str) -> str | None:
    """Remove a recognizable but invalid protocol tail from spoken content."""
    protocol_start = _PROTOCOL_OBJECT_START.search(content)
    if protocol_start is None:
        return None

    protocol_text = content[protocol_start.start():]
    decoder = json.JSONDecoder()
    # final_reply is commonly still a valid JSON string even when a nested
    # motionPlan is malformed.  Prefer the last field occurrence, which is the
    # top-level field in the canonical output contract.
    for match in reversed(list(_FINAL_REPLY_FIELD.finditer(protocol_text))):
        try:
            value, _ = decoder.raw_decode(protocol_text[match.end():].lstrip())
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
        if isinstance(value, str) and value.strip():
            return value.strip()

    prefix = content[:protocol_start.start()].strip()
    prefix = re.sub(r"^```(?:json)?\s*", "", prefix, count=1, flags=re.IGNORECASE)
    prefix = re.sub(r"\s*```$", "", prefix, count=1)
    return prefix.strip()


class OpenAILLMProvider(LLMInterface):
    """Async wrapper around OpenAILLMAdapter for the CharacterTurn Runtime.

    Runs the synchronous OpenAILLMAdapter.generate() in a thread pool
    via asyncio.to_thread so the CharacterTurn pipeline stays async.

    Response normalization:
      The DefaultPlanner instructs the LLM to output structured JSON:
        {"segments":[...], "tool_calls":[...], "final_reply":"..."}
      This JSON lands in msg.content (the LLM's text output). This provider
      extracts final_reply, segments, and tool_calls from the nested JSON
      and returns a canonical LLMResponse — no JSON strings leak out.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ):
        # Resolve the ACTIVE provider profile and pass its values explicitly so
        # the adapter never guesses across providers (each provider carries its
        # own api_key/base_url/model atomically).
        from app.config_manager.llm_providers import resolve_active_llm_config

        cfg = resolve_active_llm_config()
        temperature = cfg.get("temperature")
        self._temperature = float(temperature) if temperature is not None else 0.3
        self._reasoning_effort = cfg.get("reasoning_effort")
        self._max_tokens = cfg.get("max_tokens")

        self._adapter = OpenAILLMAdapter(
            api_key=api_key or cfg.get("api_key"),
            base_url=base_url or cfg.get("base_url"),
            model=model or cfg.get("model"),
            temperature=self._temperature,
            engine=cfg.get("engine"),
            timeout=cfg.get("timeout"),
        )

    @property
    def model(self) -> str:
        return self._adapter.model

    def diagnostics(self) -> dict[str, Any]:
        """Expose the effective provider route without exposing credentials."""
        return {
            "status": "ready",
            "engine": self._adapter.engine,
            "model": self._adapter.model,
            "base_url": self._adapter.base_url,
            "api_key_configured": self._adapter.api_key_configured,
            "visionEnabled": self._adapter.vision_enabled,
            "visualPolicy": self._adapter.visual_policy,
        }

    async def generate(
        self,
        messages: list,
        tools: list[dict] | None = None,
        **kwargs,
    ) -> LLMResponse:
        """Call LLM and return a canonical LLMResponse.

        Runs the sync adapter in a thread to avoid blocking the event loop.
        Normalizes provider-specific response format into LLMResponse.

        The output budget is an explicit, relaxed ceiling by default (override
        with LLM_MAX_TOKENS) so reasoning models have room to finish the reply
        after their hidden chain. LLM_REASONING_EFFORT optionally trims that
        chain ("low") when truncation still happens.
        """
        max_tokens = kwargs.get("max_tokens")
        if max_tokens is None:
            # Per-provider value wins; fall back to env (also handles providers
            # instantiated via object.__new__ in tests, which have no attrs).
            configured = getattr(self, "_max_tokens", None)
            if configured is not None:
                max_tokens = int(configured)
            else:
                raw = os.environ.get("LLM_MAX_TOKENS", "")
                max_tokens = int(raw) if raw.isdigit() else _DEFAULT_MAX_TOKENS
        reasoning_effort = (
            getattr(self, "_reasoning_effort", None)
            or os.environ.get("LLM_REASONING_EFFORT")
            or None
        )
        temperature = kwargs.get("temperature", getattr(self, "_temperature", 0.3))
        result = await asyncio.to_thread(
            self._adapter.generate,
            messages,
            temperature=temperature,
            tools=tools,
            max_tool_rounds=1,  # single round per call; loop handled by DecisionStep
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
        )

        return self._normalize(result, messages)

    def _normalize(
        self,
        result: dict[str, Any],
        original_messages: list,
    ) -> LLMResponse:
        """Convert raw adapter result dict into canonical LLMResponse.

        Handles:
          - Native OpenAI tool_calls (msg.tool_calls from SDK)
          - JSON-in-text structured output (per DefaultPlanner format)
          - Plain text fallback (no JSON in content)
        """
        # ── Extract tool_calls from native SDK mechanism ──────────────
        raw_tool_calls = result.get("tool_calls", [])
        tool_calls = [
            ToolCall(name=tc["name"], args=tc.get("args", {}))
            for tc in raw_tool_calls
        ]

        # ── Parse LLM text content ────────────────────────────────────
        content = result.get("content", "")
        visual = dict(result.get("_visual") or {})
        if visual.get("hasVisionInput"):
            visual.setdefault("engine", self._adapter.engine)
            visual.setdefault("model", self._adapter.model)
            visual.setdefault("providerSuccess", not bool(result.get("error")))
            visual.setdefault("finishReason", str(result.get("finish_reason", "") or ""))
        segments: list[dict] = []
        # Only expose a transcript when the provider actually returned one.
        # JSON-in-text tool calls have no native assistant/tool_call message;
        # DecisionStep must synthesize that message before appending tool results.
        messages: list = result.get("_messages", [])
        reply = content
        reasoning = str(result.get("reasoning", "") or "")

        inner = _extract_structured_output(content) if content else None
        if inner is not None:
            # Once a protocol envelope is recognized, never retain its source as
            # spoken text.  ResponseValidator can reconstruct a reply from valid
            # segments when final_reply is absent.
            inner_reply = inner.get("final_reply", "")
            reply = inner_reply.strip() if isinstance(inner_reply, str) else ""

            inner_segments = inner.get("segments")
            if isinstance(inner_segments, list):
                segments = [item for item in inner_segments if isinstance(item, dict)]

            # Extract JSON-in-text tool_calls as fallback.
            inner_tool_calls = inner.get("tool_calls")
            if isinstance(inner_tool_calls, list) and inner_tool_calls and not tool_calls:
                tool_calls = [
                    ToolCall(name=tc.get("name", ""), args=tc.get("args", {}))
                    for tc in inner_tool_calls
                    if isinstance(tc, dict)
                ]
        else:
            if visual.get("hasVisionInput"):
                visual["visualFallback"] = True
            if content:
                recovered_reply = _recover_spoken_text_from_malformed_output(content)
                if recovered_reply is not None:
                    reply = recovered_reply

        raw_usage = result.get("usage") or {}
        cached = raw_usage.get("cached_tokens", 0)
        usage_details = raw_usage.get("prompt_tokens_details") or {}
        cached = cached or usage_details.get("cached_tokens", 0)
        return LLMResponse(
            reply=reply,
            reasoning=reasoning,
            segments=segments,
            tool_calls=tool_calls,
            messages=messages,
            usage=LLMUsage(
                prompt_tokens=int(raw_usage.get("prompt_tokens", 0) or 0),
                completion_tokens=int(raw_usage.get("completion_tokens", 0) or 0),
                total_tokens=int(raw_usage.get("total_tokens", 0) or 0),
                cached_tokens=int(cached or 0),
                model=str(result.get("model", "")),
            ),
            finish_reason=str(result.get("finish_reason", "") or ""),
            visual=visual,
        )

    async def generate_stream(
        self,
        messages: list,
        **kwargs,
    ) -> AsyncIterator[str]:
        """Stream tokens from the LLM via the sync adapter's generator."""
        gen = self._adapter.generate_stream(
            messages,
            temperature=kwargs.get("temperature", 0.3),
        )
        loop = asyncio.get_running_loop()

        while True:
            try:
                token = await loop.run_in_executor(None, lambda: next(gen))
                yield token
            except StopIteration:
                break
