from __future__ import annotations

import json
import os
from typing import Any, Generator, Iterator

import requests

# ASR/TTS are loopback services. Lifecycle-launched processes may inherit a
# desktop HTTP proxy, so routing 127.0.0.1 traffic through it turns healthy
# local services into spurious 502s. Disable proxy lookup for these adapters.
_LOCAL_SESSION = requests.Session()
_LOCAL_SESSION.trust_env = False


class HTTPASRAdapter:
    """ASR adapter backed by the local ASR HTTP service."""

    def __init__(self, base_url: str | None = None, timeout: float = 120.0) -> None:
        from app.config_manager.service_config import service_config
        fallback = service_config.url("asr")
        self.base_url = (base_url or os.environ.get("ASR_URL", fallback)).rstrip("/")
        self.timeout = timeout

    def transcribe(self, audio_path: str, language: str | None = None) -> dict[str, Any]:
        response = _LOCAL_SESSION.post(
            f"{self.base_url}/v1/asr/transcribe",
            json={"audio_path": audio_path, "language": language},
            timeout=self.timeout,
        )
        response.raise_for_status()
        body = response.json()
        result = body.get("result", {})
        return {
            "text": str(result.get("text", "")).strip(),
            "language": result.get("language"),
            "raw": body,
        }


class HTTPTTSAdapter:
    """TTS adapter backed by the local TTS HTTP service."""

    def __init__(self, base_url: str | None = None, timeout: float = 120.0) -> None:
        from app.config_manager.service_config import service_config
        fallback = service_config.url("tts")
        self.base_url = (base_url or os.environ.get("TTS_URL", fallback)).rstrip("/")
        self.timeout = timeout

    def synthesize(self, text: str, **options: Any) -> bytes:
        payload: dict[str, Any] = {"text": text}
        allowed = (
            "engine",
            "voice",
            "speaker",
            "text_lang",
            "prompt_lang",
            "prompt_text",
            "ref_audio_path",
            "gpt_weights",
            "sovits_weights",
            "speed_factor",
            "emotion",
        )
        for key in allowed:
            if options.get(key) not in (None, ""):
                payload[key] = options[key]

        # Keep older callers working while normalizing onto the engine's names.
        if "text_lang" not in payload:
            payload["text_lang"] = str(
                options.get("language") or os.environ.get("TTS_LANGUAGE", "zh")
            )
        if "ref_audio_path" not in payload and options.get("ref_audio"):
            payload["ref_audio_path"] = options["ref_audio"]
        response = _LOCAL_SESSION.post(
            f"{self.base_url}/v1/tts/synthesize",
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.content


# Sentinel to distinguish "not passed by caller" from "explicitly None"
_JSON_SENTINEL: dict | None = object()  # type: ignore[assignment]


def _has_vision_content(messages: list) -> bool:
    """Check if any message contains image_url content blocks."""
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "image_url":
                    return True
    return False


class OpenAILLMAdapter:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        temperature: float = 0.3,
        max_tool_rounds: int = 5,
    ) -> None:
        from openai import OpenAI

        engine = os.environ.get("LLM_ENGINE", "").strip().lower()
        self._engine = engine or "deepseek"
        if engine == "opencode":
            # OpenCode serve — OpenAI-compatible local server (default port 4096
            # per opencode.json server.port). Uses a placeholder key.
            self._api_key = api_key or os.environ.get("OPENCODE_API_KEY", "local")
            self._base_url = base_url or os.environ.get(
                "OPENCODE_BASE_URL", "http://127.0.0.1:4096/v1"
            )
            self._model = model or os.environ.get("OPENCODE_MODEL", "opencode")
        else:
            # deepseek (default) / openai via the shared LLM_BASE_URL/LLM_MODEL.
            self._api_key = api_key or os.environ.get("DEEPSEEK_API_KEY", os.environ.get("OPENAI_API_KEY", ""))
            self._base_url = base_url or os.environ.get("LLM_BASE_URL", "https://api.deepseek.com")
            self._model = model or os.environ.get("LLM_MODEL", "deepseek-v4-flash")
        self._temperature = temperature
        self._max_tool_rounds = max_tool_rounds
        client_kwargs: dict[str, Any] = {
            "api_key": self._api_key,
            "base_url": self._base_url,
        }
        if self._engine == "opencode":
            # OpenCode Zen's current free stealth route rejects the SDK's
            # default user-agent with an HTML error page. Keep this scoped to
            # OpenCode so other OpenAI-compatible providers are unchanged.
            client_kwargs["default_headers"] = {"User-Agent": "curl/8.5.0"}
        self._client = OpenAI(**client_kwargs)

    @property
    def model(self) -> str:
        return self._model

    @property
    def engine(self) -> str:
        return self._engine

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def api_key_configured(self) -> bool:
        return bool(self._api_key)

    # ---- non-streaming ---------------------------------------------------
    def generate(
        self,
        messages: list[dict[str, Any]],
        temperature: float | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_tool_rounds: int | None = None,
        response_format: dict | None | object = _JSON_SENTINEL,
        max_tokens: int | None = None,
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        """Run a complete turn: chat completion with optional tool-calling loop.

        Args:
            messages: Conversation messages.
            temperature: Sampling temperature.
            tools: OpenAI tool schemas for function calling.
            max_tool_rounds: Max tool call iterations.
            response_format: Optional response format override.
                Pass a dict (e.g. {"type": "json_object"}) to enforce JSON.
                Pass None to disable JSON enforcement (plain text).
                Omit (default) to auto-enable JSON for tool-free calls.
            max_tokens: Max tokens in the response. None = model default.
            reasoning_effort: Optional reasoning budget hint ("low"/"medium"/
                "high") for reasoning models. Empty/None = provider default.
        """
        rounds = 0
        max_rounds = max_tool_rounds or self._max_tool_rounds
        temp = temperature if temperature is not None else self._temperature
        msgs = list(messages)

        while rounds < max_rounds:
            rounds += 1
            kwargs: dict[str, Any] = {
                "model": self._model,
                "messages": msgs,
                "temperature": temp,
            }
            if max_tokens is not None:
                kwargs["max_tokens"] = max_tokens
            if reasoning_effort:
                kwargs["reasoning_effort"] = reasoning_effort
            # response_format: sentinel = auto (JSON for tool-free),
            # None = no enforcement, dict = use as-is
            if response_format is _JSON_SENTINEL:
                if not tools and not _has_vision_content(msgs):
                    kwargs["response_format"] = {"type": "json_object"}
            else:
                # Explicitly set: could be None (disable) or a dict
                if response_format is not None:
                    kwargs["response_format"] = response_format
            if tools:
                kwargs["tools"] = tools

            resp = self._client.chat.completions.create(**kwargs)
            msg = resp.choices[0].message
            # DeepSeek/OpenAI-compatible reasoning models may return their
            # chain separately from message.content.
            reasoning = getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None) or ""
            # Preserve the completion signal: "length" with empty content means
            # the output budget was exhausted on reasoning, not a real reply.
            finish_reason = ""
            if resp.choices:
                finish_reason = str(getattr(resp.choices[0], "finish_reason", "") or "")

            usage = {}
            if resp.usage:
                prompt_details = getattr(resp.usage, "prompt_tokens_details", None)
                usage = {
                    "prompt_tokens": resp.usage.prompt_tokens,
                    "completion_tokens": resp.usage.completion_tokens,
                    "total_tokens": resp.usage.total_tokens,
                    "cached_tokens": (
                        getattr(prompt_details, "cached_tokens", 0)
                        if prompt_details is not None else 0
                    ),
                }

            if msg.tool_calls and tools:
                assistant_message = {
                    "role": "assistant",
                    "content": msg.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                        }
                        for tc in msg.tool_calls
                    ],
                }
                # DeepSeek thinking mode requires the exact reasoning trace from
                # a tool-call response to be echoed in the following request.
                # Dropping it makes the continuation fail with HTTP 400 even
                # though the tool itself executed successfully.
                if reasoning:
                    assistant_message["reasoning_content"] = reasoning
                msgs.append(assistant_message)
                return {
                    "content": msg.content or "",
                    "reasoning": reasoning,
                    "finish_reason": finish_reason,
                    "tool_calls": [
                        {"name": tc.function.name, "args": _safe_json_loads(tc.function.arguments)}
                        for tc in msg.tool_calls
                    ],
                    "tool_rounds": rounds,
                    "model": self._model,
                    "usage": usage,
                    "raw_message": msg,
                    "_messages": msgs,
                }

            return {
                "content": msg.content or "",
                "reasoning": reasoning,
                "finish_reason": finish_reason,
                "tool_calls": [],
                "tool_rounds": rounds,
                "model": self._model,
                "usage": usage,
                "raw_message": msg,
            }

        return {
            "content": "",
            "tool_calls": [],
            "tool_rounds": rounds,
            "model": self._model,
            "usage": {},
            "raw_message": None,
        }

    def continue_with_tool_results(
        self,
        messages: list[dict[str, Any]],
        tool_results: list[dict[str, Any]],
        temperature: float | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_tool_rounds: int | None = None,
    ) -> dict[str, Any]:
        """Continue a conversation after tool results are available."""
        msgs = list(messages)
        for tr in tool_results:
            msgs.append({
                "role": "tool",
                "tool_call_id": tr["tool_call_id"],
                "content": tr["content"],
            })
        return self.generate(
            msgs,
            temperature=temperature,
            tools=tools,
            max_tool_rounds=max_tool_rounds,
        )

    # ---- streaming -------------------------------------------------------
    def generate_stream(
        self,
        messages: list[dict[str, Any]],
        temperature: float | None = None,
    ) -> Generator[str, None, dict[str, Any]]:
        """Stream tokens from the LLM.

        Yields token strings. The final return value is a result dict
        (sent via StopIteration.value or GeneratorExit).

        Usage:
            gen = adapter.generate_stream(messages)
            try:
                for token in gen:
                    print(token, end="")
            except StopIteration as e:
                result = e.value
        """
        temp = temperature if temperature is not None else self._temperature
        stream = self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            temperature=temp,
            stream=True,
        )

        full_content: list[str] = []
        usage = {}
        finish_reason = ""

        for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue
            if delta.content:
                full_content.append(delta.content)
                yield delta.content
            if chunk.choices[0].finish_reason:
                finish_reason = chunk.choices[0].finish_reason
            if chunk.usage:
                usage = {
                    "prompt_tokens": chunk.usage.prompt_tokens,
                    "completion_tokens": chunk.usage.completion_tokens,
                    "total_tokens": chunk.usage.total_tokens,
                }

        result: dict[str, Any] = {
            "content": "".join(full_content),
            "tool_calls": [],
            "tool_rounds": 1,
            "model": self._model,
            "usage": usage,
            "finish_reason": finish_reason,
        }
        return result


    # ---- plain text generation (for memory prompts, no JSON enforcement) --
    def generate_text(
        self,
        system: str,
        user: str,
        temperature: float = 0.3,
        max_tokens: int = 1024,
        timeout: float = 30.0,
    ) -> str:
        """Generate plain text from system+user prompts.

        Unlike generate(), this does NOT enforce JSON response_format.
        Used by memory compilation and extraction pipelines.

        Returns the plain text content, or empty string on failure.
        """
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        try:
            result = self.generate(
                messages,
                temperature=temperature,
                response_format=None,  # plain text, no JSON force
                tools=None,
                max_tokens=max_tokens,
            )
            content = str(result.get("content", "")).strip()
            # Strip potential markdown code fences
            if content.startswith("```"):
                lines = content.split("\n")
                content = "\n".join(
                    l for l in lines
                    if not l.strip().startswith("```") and not l.strip().startswith("```json")
                ).strip()
            return content
        except Exception:
            return ""


def _safe_json_loads(raw: str) -> dict[str, Any]:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}
