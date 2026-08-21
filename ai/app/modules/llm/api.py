"""Add SSE streaming endpoint and helper to LLM service."""

import argparse
import json
import os
from pathlib import Path
from typing import Any, Generator

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import StreamingResponse
from openai import OpenAI

from app.config_manager.service_config import service_config
from app.core.config import UVICORN_LOG_CONFIG, DEFAULT_ENV_PATH, load_env_file
from app.core.schemas import LLMRequest, LLMResponse


app = FastAPI(title="Cloud LLM Adapter API", version="1.1.0")


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "enabled"}


def get_api_key() -> tuple[str, str]:
    key_env = os.environ.get("LLM_API_KEY_ENV", "DEEPSEEK_API_KEY")
    api_key = os.environ.get(key_env) or os.environ.get("LLM_API_KEY")
    if not api_key:
        raise RuntimeError(f"Missing API key. Set {key_env} or LLM_API_KEY.")
    return api_key, key_env


def extract_json(content: str) -> dict[str, Any]:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        return json.loads(content[start : end + 1])


def build_messages(request: LLMRequest) -> list[dict[str, str]]:
    system_prompt = os.environ.get(
        "LLM_SYSTEM_PROMPT",
        (
            "You are a voice assistant. Return JSON only, no Markdown. "
            "JSON schema: {"
            "\"reply_text\": \"natural language response to speak to the user\", "
            "\"intent\": \"short intent name\", "
            "\"actions\": [{\"type\": \"action name\", \"args\": {}}], "
            "\"memory\": {\"summary\": \"short memory summary\", \"facts\": []}"
            "}."
        ),
    )
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(request.model_dump(), ensure_ascii=False)},
    ]


def build_stream_messages(request: LLMRequest) -> list[dict[str, str]]:
    """Plain-text context — no JSON metadata overhead, only conversation text."""
    system_prompt = os.environ.get(
        "LLM_STREAM_SYSTEM_PROMPT",
        "你是一个语音助手。用自然口语简短回复，不要用 Markdown。",
    )
    history_lines: list[str] = []
    for rec in request.recent_memory or []:
        if isinstance(rec, dict):
            user = str(rec.get("user", "")).strip()
            assistant = str(rec.get("assistant", "")).strip()
            if user:
                history_lines.append(f"用户：{user}")
            if assistant:
                history_lines.append(f"助手：{assistant}")
    history_block = "\n".join(history_lines[-10:])
    transcript = request.event.transcript.strip()
    if history_block:
        user_content = f"[对话历史]\n{history_block}\n\n[当前]\n用户：{transcript}"
    else:
        user_content = f"用户：{transcript}"
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]


def build_extra_body() -> dict[str, Any] | None:
    extra_body: dict[str, Any] = {}
    thinking_type = os.environ.get("LLM_THINKING_TYPE", "enabled").strip().lower()
    if thinking_type and thinking_type not in {"none", "off", "disabled"}:
        extra_body["thinking"] = {"type": thinking_type}
    raw_extra_body = os.environ.get("LLM_EXTRA_BODY_JSON")
    if raw_extra_body:
        extra_body.update(json.loads(raw_extra_body))
    return extra_body or None


def call_cloud_llm(request: LLMRequest) -> LLMResponse:
    api_key, _ = get_api_key()
    base_url = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com")
    model = os.environ.get("LLM_MODEL", "deepseek-v4-pro")
    reasoning_effort = os.environ.get("LLM_REASONING_EFFORT", "high")
    temperature = float(os.environ.get("LLM_TEMPERATURE", "0.3"))
    response_format = os.environ.get("LLM_RESPONSE_FORMAT", "json_object")
    timeout = float(os.environ.get("LLM_TIMEOUT_SECONDS", "60"))

    client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)

    params: dict[str, Any] = {
        "model": model,
        "messages": build_messages(request),
        "stream": False,
        "temperature": temperature,
    }
    if reasoning_effort:
        params["reasoning_effort"] = reasoning_effort
    if response_format and response_format.lower() not in {"none", "off", "disabled"}:
        params["response_format"] = {"type": response_format}

    extra_body = build_extra_body()
    if extra_body:
        params["extra_body"] = extra_body

    response = client.chat.completions.create(**params)
    content = response.choices[0].message.content or ""
    parsed = extract_json(content)

    return LLMResponse(
        ok=True,
        reply_text=str(parsed.get("reply_text", "")).strip(),
        intent=str(parsed.get("intent", "unknown")),
        actions=parsed.get("actions") or [],
        memory=parsed.get("memory") or {},
        raw=parsed,
    )


def _stream_tokens(request: LLMRequest) -> Generator[str, None, None]:
    """Generator yielding SSE-formatted token events."""
    api_key, _ = get_api_key()
    base_url = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com")
    model = os.environ.get("LLM_MODEL", "deepseek-v4-flash")
    temperature = float(os.environ.get("LLM_TEMPERATURE", "0.3"))
    reasoning_effort = os.environ.get("LLM_REASONING_EFFORT", "medium")
    timeout = float(os.environ.get("LLM_TIMEOUT_SECONDS", "120"))

    client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)

    params: dict[str, Any] = {
        "model": model,
        "messages": build_stream_messages(request),
        "stream": True,
        "temperature": temperature,
    }
    if reasoning_effort:
        params["reasoning_effort"] = reasoning_effort

    stream = client.chat.completions.create(**params)
    for chunk in stream:
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta and delta.content:
            yield f"data: {json.dumps({'token': delta.content})}\n\n"

    yield "data: [DONE]\n\n"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health(response: Response) -> dict[str, Any]:
    key_env = os.environ.get("LLM_API_KEY_ENV", "DEEPSEEK_API_KEY")
    has_api_key = bool(os.environ.get(key_env) or os.environ.get("LLM_API_KEY"))
    if not has_api_key:
        response.status_code = 503
    return {
        "ok": has_api_key,
        "module": "llm",
        "base_url": os.environ.get("LLM_BASE_URL", "https://api.deepseek.com"),
        "model": os.environ.get("LLM_MODEL", "deepseek-v4-pro"),
        "api_key_env": key_env,
        "has_api_key": has_api_key,
        "reasoning_effort": os.environ.get("LLM_REASONING_EFFORT", "high"),
        "thinking_type": os.environ.get("LLM_THINKING_TYPE", "enabled"),
    }


@app.post("/v1/llm/chat", response_model=LLMResponse)
def chat(request: LLMRequest) -> LLMResponse:
    try:
        return call_cloud_llm(request)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/v1/llm/chat/stream")
def chat_stream(request: LLMRequest):
    """SSE streaming endpoint — yields tokens as text/event-stream."""
    return StreamingResponse(
        _stream_tokens(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Cloud LLM adapter API service")
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_PATH))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int,
        default=os.environ.get("LLM_PORT", service_config.port("llm")))
    args = parser.parse_args()

    load_env_file(Path(args.env_file))

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_config=UVICORN_LOG_CONFIG)


if __name__ == "__main__":
    main()
