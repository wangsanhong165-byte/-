"""Empty-reply handling: truncation detection + relaxation + fallback.

Regression coverage for the "model returns no visible text" failure chain:
  DeepSeek reasoning exhausts the output budget (finish_reason="length")
  -> adapter drops finish_reason -> empty reply validated as success
  -> frontend stuck on "正在组织语言…".

The fix threads finish_reason through the adapter/provider, treats an empty
reply as invalid, repairs once, and falls back to a spoken line when the
repair is also empty. The main chat path also gets an explicit relaxed
output budget so reasoning has room to finish the reply.
"""

import asyncio
from types import SimpleNamespace

from app.interfaces.llm import LLMResponse
from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.steps.decision_step import DecisionStep


def run(coro):
    return asyncio.run(coro)


def _fake_adapter_client(create):
    """Wrap a create(**kwargs) callable as the OpenAI SDK client shape."""
    return SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=create))
    )


def _fake_completion(
    content="",
    finish_reason="stop",
    *,
    reasoning_content=None,
    tool_calls=None,
):
    message = SimpleNamespace(
        content=content,
        reasoning_content=reasoning_content,
        tool_calls=tool_calls or [],
    )
    usage = SimpleNamespace(
        prompt_tokens=10,
        completion_tokens=5,
        total_tokens=15,
        prompt_tokens_details=None,
    )
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason=finish_reason)],
        usage=usage,
        model="deepseek-v4-flash",
    )


def _make_adapter(create):
    from app.models.http_adapters import OpenAILLMAdapter

    adapter = object.__new__(OpenAILLMAdapter)
    adapter._model = "deepseek-v4-flash"
    adapter._max_tool_rounds = 5
    adapter._temperature = 0.3
    adapter._client = _fake_adapter_client(create)
    return adapter


# ── OpenAILLMAdapter: finish_reason + forward the relaxed budget ──────────


def test_adapter_captures_finish_reason_on_truncated_empty():
    """A reasoning-truncated response keeps its finish_reason and empty content."""
    create = lambda **kw: _fake_completion(content=None, finish_reason="length")
    result = _make_adapter(create).generate([{"role": "user", "content": "hi"}])

    assert result["finish_reason"] == "length"
    assert result["content"] == ""


def test_adapter_keeps_finish_reason_stop_for_normal_reply():
    create = lambda **kw: _fake_completion(content="hello", finish_reason="stop")
    result = _make_adapter(create).generate([{"role": "user", "content": "hi"}])

    assert result["finish_reason"] == "stop"
    assert result["content"] == "hello"


def test_adapter_forwards_max_tokens_and_reasoning_effort():
    captured = {}

    def create(**kw):
        captured.update(kw)
        return _fake_completion(content="ok")

    result = _make_adapter(create).generate(
        [{"role": "user", "content": "hi"}],
        max_tokens=16384,
        reasoning_effort="low",
    )
    assert result["finish_reason"] == "stop"
    assert captured["max_tokens"] == 16384
    assert captured["reasoning_effort"] == "low"


def test_adapter_omits_reasoning_effort_when_unset():
    captured = {}

    def create(**kw):
        captured.update(kw)
        return _fake_completion(content="ok")

    _make_adapter(create).generate([{"role": "user", "content": "hi"}])
    assert "reasoning_effort" not in captured
    assert "max_tokens" not in captured


def test_adapter_preserves_reasoning_content_in_assistant_tool_call_history():
    """DeepSeek thinking tool continuations must echo the original reasoning."""
    tool_call = SimpleNamespace(
        id="call_weather",
        function=SimpleNamespace(name="get_weather", arguments='{"city":"杭州"}'),
    )

    def create(**_kwargs):
        return _fake_completion(
            content=None,
            reasoning_content="先查询天气，再组织主动关心。",
            tool_calls=[tool_call],
        )

    result = _make_adapter(create).generate(
        [{"role": "user", "content": "主动关心一下天气"}],
        tools=[{"type": "function", "function": {"name": "get_weather"}}],
    )

    assistant = result["_messages"][-1]
    assert assistant["role"] == "assistant"
    assert assistant["reasoning_content"] == "先查询天气，再组织主动关心。"
    assert assistant["tool_calls"][0]["id"] == "call_weather"


def test_adapter_resolves_opencode_engine(monkeypatch):
    """LLM_ENGINE=opencode points the adapter at the OpenCode local server."""
    from app.models.http_adapters import OpenAILLMAdapter

    monkeypatch.setenv("LLM_ENGINE", "opencode")
    monkeypatch.setenv("OPENCODE_BASE_URL", "http://127.0.0.1:4096/v1")
    monkeypatch.setenv("OPENCODE_MODEL", "opencode")
    monkeypatch.setenv("OPENCODE_API_KEY", "local")

    adapter = OpenAILLMAdapter()

    assert adapter._base_url == "http://127.0.0.1:4096/v1"
    assert adapter._model == "opencode"
    assert adapter._api_key == "local"


def test_opencode_adapter_sets_compatible_user_agent(monkeypatch):
    """OpenCode Zen currently requires its compatible client user-agent."""
    from app.models.http_adapters import OpenAILLMAdapter

    captured = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("openai.OpenAI", FakeOpenAI)
    monkeypatch.setenv("LLM_ENGINE", "opencode")
    monkeypatch.setenv("OPENCODE_BASE_URL", "https://opencode.ai/zen/v1")
    monkeypatch.setenv("OPENCODE_MODEL", "x-preview-f-free")
    monkeypatch.setenv("OPENCODE_API_KEY", "test-key")

    OpenAILLMAdapter()

    assert captured["base_url"] == "https://opencode.ai/zen/v1"
    assert captured["default_headers"]["User-Agent"] == "curl/8.5.0"


def test_adapter_defaults_opencode_url(monkeypatch):
    """Unset OPENCODE_* falls back to the documented OpenCode serve defaults."""
    from app.models.http_adapters import OpenAILLMAdapter

    monkeypatch.setenv("LLM_ENGINE", "opencode")
    monkeypatch.delenv("OPENCODE_BASE_URL", raising=False)
    monkeypatch.delenv("OPENCODE_MODEL", raising=False)
    monkeypatch.delenv("OPENCODE_API_KEY", raising=False)

    adapter = OpenAILLMAdapter()

    assert adapter._base_url == "http://127.0.0.1:4096/v1"
    assert adapter._model == "opencode"
    assert adapter._api_key == "local"


def test_adapter_keeps_deepseek_default_when_engine_unset(monkeypatch):
    """Without LLM_ENGINE=opencode the adapter keeps the DeepSeek path."""
    from app.models.http_adapters import OpenAILLMAdapter

    monkeypatch.delenv("LLM_ENGINE", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setenv("LLM_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("LLM_MODEL", "deepseek-v4-flash")

    adapter = OpenAILLMAdapter()

    assert adapter._base_url == "https://api.deepseek.com"
    assert adapter._model == "deepseek-v4-flash"


# ── OpenAILLMProvider: thread finish_reason, relax max_tokens ─────────────


def test_provider_threads_finish_reason_into_llm_response():
    from app.providers.llm.openai_adapter import OpenAILLMProvider

    provider = object.__new__(OpenAILLMProvider)
    response = provider._normalize({
        "content": "",
        "reasoning": "…thinking…",
        "finish_reason": "length",
        "tool_calls": [],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        "model": "deepseek-v4-flash",
    }, [{"role": "user", "content": "hi"}])

    assert response.reply == ""
    assert response.finish_reason == "length"


def test_provider_defaults_to_relaxed_max_tokens(monkeypatch):
    from app.providers.llm.openai_adapter import OpenAILLMProvider

    monkeypatch.delenv("LLM_MAX_TOKENS", raising=False)
    monkeypatch.delenv("LLM_REASONING_EFFORT", raising=False)

    class Recorder:
        model = "deepseek-v4-flash"

        def __init__(self):
            self.kwargs = None

        def generate(self, messages, **kwargs):
            self.kwargs = kwargs
            return {"content": '{"final_reply": "hi", "segments": []}', "reasoning": "",
                    "finish_reason": "stop", "tool_calls": [], "usage": {}, "model": "deepseek-v4-flash"}

    provider = OpenAILLMProvider.__new__(OpenAILLMProvider)
    provider._adapter = Recorder()
    response = run(provider.generate([{"role": "user", "content": "x"}]))

    assert provider._adapter.kwargs["max_tokens"] == 8192
    assert provider._adapter.kwargs.get("reasoning_effort") is None
    assert response.reply == "hi"


def test_provider_extracts_structured_envelope_appended_after_spoken_reply(monkeypatch):
    """Provider quirks must not leak presentation JSON into subtitles or TTS."""
    from app.providers.llm.openai_adapter import OpenAILLMProvider

    monkeypatch.delenv("LLM_MAX_TOKENS", raising=False)
    content = (
        '好呀，我就在这儿听着呢，你说。  '
        '{"segments":[{"text":"好呀，我就在这儿听着呢，你说。",'
        '"emotion":"happy","behavior":"listen"}],'
        '"tool_calls":[],"final_reply":"好呀，我就在这儿听着呢，你说。"}'
    )

    class MixedEnvelopeAdapter:
        model = "deepseek-v4-flash"

        def generate(self, messages, **kwargs):
            return {
                "content": content,
                "reasoning": "",
                "finish_reason": "stop",
                "tool_calls": [],
                "usage": {},
                "model": self.model,
            }

    provider = OpenAILLMProvider.__new__(OpenAILLMProvider)
    provider._adapter = MixedEnvelopeAdapter()

    response = run(provider.generate([{"role": "user", "content": "你在吗"}]))

    assert response.reply == "好呀，我就在这儿听着呢，你说。"
    assert response.segments == [{
        "text": "好呀，我就在这儿听着呢，你说。",
        "emotion": "happy",
        "behavior": "listen",
    }]
    assert "segments" not in response.reply
    assert "emotion" not in response.reply
    assert "behavior" not in response.reply


def test_mixed_structured_envelope_keeps_motion_plan_out_of_spoken_text():
    """A recovered protocol tail must still drive Character and never reach TTS."""
    from app.providers.llm.openai_adapter import OpenAILLMProvider
    from app.runtime.steps.tts_step import TTSStep

    class MixedEnvelopeAdapter:
        model = "deepseek-v4-flash"

        def generate(self, messages, **kwargs):
            return {
                "content": (
                    '你好呀。  '
                    '{"segments":[{"text":"你好呀。","emotion":"happy",'
                    '"behavior":"wave","attention":"user","energy":0.8,'
                    '"intensity":0.7,"motionPlan":{"durationMs":1800,'
                    '"steps":[{"atMs":0,"durationMs":600,'
                    '"primitive":"nod","intensity":0.5}]}}],'
                    '"tool_calls":[],"final_reply":"你好呀。"}'
                ),
                "tool_calls": [],
                "usage": {},
                "model": self.model,
            }

    class RecordingTTS:
        def __init__(self):
            self.texts = []

        async def synthesize(self, text, **kwargs):
            self.texts.append(text)
            return b"wav"

    provider = OpenAILLMProvider.__new__(OpenAILLMProvider)
    provider._adapter = MixedEnvelopeAdapter()
    response = run(provider.generate([{"role": "user", "content": "你好"}]))

    assert response.reply == "你好呀。"
    assert all(key not in response.reply for key in ("segments", "emotion", "motionPlan"))

    tts = RecordingTTS()
    ctx = CharacterTurn(input=TurnInput(text="你好"))
    run(DecisionStep(provider).run(ctx))
    run(TTSStep(tts).run(ctx))

    assert ctx.reply_text == "你好呀。"
    assert tts.texts == ["你好呀。"]
    assert ctx.output.performance.behavior == "wave"
    # 2026-09-05 slimming: a motionPlan smuggled inside a recovered protocol
    # tail is dropped — performance never carries an LLM motion plan.
    assert ctx.output.performance.motion_plan is None


def test_provider_extracts_markdown_fenced_structured_output():
    from app.providers.llm.openai_adapter import OpenAILLMProvider

    provider = object.__new__(OpenAILLMProvider)
    response = provider._normalize({
        "content": (
            "```json\n"
            '{"segments":[{"text":"我在。","emotion":"neutral",'
            '"behavior":"listen"}],"final_reply":"我在。"}'
            "\n```"
        ),
        "tool_calls": [],
    }, [])

    assert response.reply == "我在。"
    assert response.segments[0]["text"] == "我在。"


def test_provider_never_speaks_a_malformed_structured_tail():
    from app.providers.llm.openai_adapter import OpenAILLMProvider

    provider = object.__new__(OpenAILLMProvider)
    response = provider._normalize({
        "content": (
            '好呀，我就在这儿听着呢，你说。  '
            '{"segments":[{"text":"好呀，我就在这儿听着呢，你说。",'
            '"emotion":"happy","behavior":"listen",'
            '"motionPlan":{"durationMs":1800,"steps":}}],'
            '"tool_calls":[],"final_reply":"好呀，我就在这儿听着呢，你说。"}'
        ),
        "tool_calls": [],
    }, [])

    assert response.reply == "好呀，我就在这儿听着呢，你说。"
    assert response.segments == []
    assert "segments" not in response.reply
    assert "motionPlan" not in response.reply


def test_malformed_provider_protocol_never_reaches_turn_subtitle_or_tts():
    from app.providers.llm.openai_adapter import OpenAILLMProvider
    from app.runtime.steps.tts_step import TTSStep

    class MixedEnvelopeAdapter:
        model = "deepseek-v4-flash"

        def generate(self, messages, **kwargs):
            return {
                "content": (
                    '我在听，你继续。  '
                    '{"segments":[{"text":"我在听，你继续。",'
                    '"emotion":"neutral","behavior":"listen",'
                    '"motionPlan":{"durationMs":1200,"steps":}}],'
                    '"final_reply":"我在听，你继续。"}'
                ),
                "tool_calls": [],
                "usage": {},
                "model": self.model,
            }

    class RecordingTTS:
        def __init__(self):
            self.texts = []

        async def synthesize(self, text, **kwargs):
            self.texts.append(text)
            return b"wav"

    provider = OpenAILLMProvider.__new__(OpenAILLMProvider)
    provider._adapter = MixedEnvelopeAdapter()
    tts = RecordingTTS()
    ctx = CharacterTurn(input=TurnInput(text="你在吗"))

    run(DecisionStep(provider).run(ctx))
    run(TTSStep(tts).run(ctx))

    assert ctx.reply_text == "我在听，你继续。"
    assert ctx.segments
    assert tts.texts == ["我在听，你继续。"]
    assert all("segments" not in value for value in [ctx.reply_text, *tts.texts])


def test_provider_honors_env_max_tokens_and_reasoning_effort(monkeypatch):
    from app.providers.llm.openai_adapter import OpenAILLMProvider

    monkeypatch.setenv("LLM_MAX_TOKENS", "4096")
    monkeypatch.setenv("LLM_REASONING_EFFORT", "low")

    class Recorder:
        model = "deepseek-v4-flash"

        def __init__(self):
            self.kwargs = None

        def generate(self, messages, **kwargs):
            self.kwargs = kwargs
            return {"content": "ok", "reasoning": "", "finish_reason": "stop",
                    "tool_calls": [], "usage": {}, "model": "deepseek-v4-flash"}

    provider = OpenAILLMProvider.__new__(OpenAILLMProvider)
    provider._adapter = Recorder()
    run(provider.generate([{"role": "user", "content": "x"}]))

    assert provider._adapter.kwargs["max_tokens"] == 4096
    assert provider._adapter.kwargs["reasoning_effort"] == "low"


# ── ResponseValidator: empty reply is invalid ──────────────────────────────


def test_validator_marks_empty_reply_invalid():
    from app.runtime.response_validator import ResponseValidator

    result = ResponseValidator().validate("", [])
    assert result.valid is False
    assert result.reply == ""


def test_validator_marks_empty_text_segments_invalid():
    from app.runtime.response_validator import ResponseValidator

    result = ResponseValidator().validate("", [
        {"text": "", "emotion": "neutral", "behavior": "speak"},
    ])
    assert result.valid is False


def test_validator_marks_whitespace_only_reply_invalid():
    """Whitespace-only content must not be recovered into a phantom segment."""
    from app.runtime.response_validator import ResponseValidator

    result = ResponseValidator().validate("   ", [])
    assert result.valid is False
    assert result.reply == ""
    assert result.segments == []

    newline_result = ResponseValidator().validate("\t\n  ", [])
    assert newline_result.valid is False
    assert newline_result.segments == []


def test_validator_requires_semantic_segments_for_non_empty_reply():
    from app.runtime.response_validator import ResponseValidator

    plain = ResponseValidator().validate("hello", [])
    assert plain.valid is False
    assert plain.reply == "hello"
    assert plain.segments[0]["contextTags"] == ["semantic_recovery"]
    assert ResponseValidator().validate(
        "", [{"text": "hello", "emotion": "neutral", "behavior": "speak"}]
    ).valid is True


def test_validator_recovers_all_supported_expression_families_from_plain_text():
    from app.runtime.response_validator import ResponseValidator

    cases = {
        "我眨眨眼逗你一下。": "playful",
        "有点委屈，真的想哭。": "cry",
        "我有点不满，撅嘴了。": "pout",
        "我真的生气了。": "angry",
        "吓了一跳，好惊讶。": "surprised",
        "我有点疑惑，没明白。": "confused",
        "被你夸得不好意思了。": "shy",
        "我真的很喜欢你。": "love",
        "今天很开心。": "happy",
    }

    for reply, emotion in cases.items():
        recovered = ResponseValidator().validate(reply, [])
        assert recovered.segments[0]["emotion"] == emotion, reply


def test_validator_does_not_turn_a_negated_anger_reference_into_current_anger():
    from app.runtime.response_validator import ResponseValidator

    reply = (
        "好好好，我不欺负你了，乖乖陪你玩。你想玩啥呀？"
        "我陪你玩到尽兴为止，可不能再生气了哦~"
    )

    recovered = ResponseValidator().validate(reply, [])

    assert recovered.segments[-1]["emotion"] == "calm"
    assert recovered.segments[-1]["behavior"] == "comfort"
    assert all(segment["emotion"] != "angry" for segment in recovered.segments)


def test_validator_uses_user_intent_and_collapses_aliases_to_model_palette():
    from app.runtime.response_validator import ResponseValidator

    crying = ResponseValidator().validate(
        "好呀。",
        [],
        allowed_emotions=["neutral", "sad", "playful"],
        semantic_context="做个哭哭脸吧",
    )
    playful = ResponseValidator().validate(
        "好呀。",
        [],
        allowed_emotions=["neutral", "sad", "playful"],
        semantic_context="向我卖个萌",
    )

    assert crying.segments[0]["emotion"] == "sad"
    assert playful.segments[0]["emotion"] == "playful"


def test_validator_recovers_supported_body_language_behaviors_from_plain_text():
    from app.runtime.response_validator import ResponseValidator

    cases = {
        "嗯，我同意。": "agree",
        "不，我不同意。": "disagree",
        "让我想一想。": "think",
        "哈哈，太有趣了。": "laugh",
        "没关系，慢慢来。": "comfort",
        "我点点头。": "nod",
        "我歪头看着你。": "tilt",
        "我耸耸肩。": "shrug",
        "我挥挥手。": "wave",
    }

    for reply, behavior in cases.items():
        recovered = ResponseValidator().validate(reply, [])
        assert recovered.segments[0]["behavior"] == behavior, reply


def test_validator_keeps_visible_stage_directions_out_of_spoken_text():
    from app.runtime.response_validator import ResponseValidator

    plain = ResponseValidator().validate(
        "呜……（做出委屈巴巴的哭哭脸）你看，我都这么可怜了。",
        [],
    )
    structured = ResponseValidator().validate(
        "呜……（做出委屈巴巴的哭哭脸）你看，我都这么可怜了。",
        [{
            "text": "呜……（做出委屈巴巴的哭哭脸）你看，我都这么可怜了。",
            "emotion": "cry",
            "behavior": "speak",
        }],
    )

    assert plain.valid is False
    assert plain.reply == "呜……你看，我都这么可怜了。"
    assert plain.segments[0]["emotion"] == "cry"
    assert structured.valid is False
    assert structured.reply == "呜……你看，我都这么可怜了。"
    assert structured.segments[0]["text"] == "呜……你看，我都这么可怜了。"


def test_validator_strips_unbracketed_performance_narration_from_tts():
    from app.runtime.response_validator import ResponseValidator

    result = ResponseValidator().validate(
        "那我这就做给你看~ 呜呜呜，装出一副可怜巴巴的样子，"
        "眼角都往下耷拉着。这样够不够惨？要不要再配点抽搭声给你？",
        [],
        allowed_emotions=["neutral", "sad", "playful"],
        semantic_context="哭哭好",
    )

    assert "装出" not in result.reply
    assert "眼角" not in result.reply
    assert "配点抽搭声" not in result.reply
    assert result.reply == "那我这就做给你看~ 呜呜呜。这样够不够惨？"
    assert result.segments[0]["emotion"] == "sad"


def test_validator_preserves_non_action_parentheses_and_keeps_action_only_reply_spoken():
    from app.runtime.response_validator import ResponseValidator

    ordinary = ResponseValidator().validate(
        "这个方案（仅限测试环境）和说明（笑话示例、表情识别模块）可以使用。",
        [{
            "text": "这个方案（仅限测试环境）和说明（笑话示例、表情识别模块）可以使用。",
            "emotion": "neutral",
        }],
    )
    action_only = ResponseValidator().validate("（眨眨眼）", [])

    assert ordinary.valid is True
    assert ordinary.reply == "这个方案（仅限测试环境）和说明（笑话示例、表情识别模块）可以使用。"
    assert action_only.reply == "这样可以吗？"
    assert action_only.segments[0]["emotion"] == "playful"


def test_llm_response_finish_reason_defaults_to_empty():
    assert LLMResponse().finish_reason == ""


# ── DecisionStep: repair truncated-empty, fall back when repair fails ─────


def test_decision_step_repairs_truncated_empty_reply_once():
    class TruncatedThenRepairedLLM:
        def __init__(self):
            self.calls = 0

        async def generate(self, messages, **kwargs):
            self.calls += 1
            if self.calls == 1:
                return LLMResponse(reply="", finish_reason="length")
            return LLMResponse(
                reply="fixed",
                segments=[{"text": "fixed", "emotion": "neutral", "behavior": "speak"}],
            )

    llm = TruncatedThenRepairedLLM()
    ctx = CharacterTurn(input=TurnInput(text="hello"))
    run(DecisionStep(llm).run(ctx))

    assert llm.calls == 2
    assert ctx.reply_text == "fixed"


def test_decision_step_repairs_plain_text_into_structured_performance_once():
    class PlainTextLLM:
        def __init__(self):
            self.calls = []

        async def generate(self, messages, **kwargs):
            self.calls.append(kwargs)
            if len(self.calls) == 1:
                return LLMResponse(reply="好呀，逗你一下。")
            return LLMResponse(
                reply="好呀，逗你一下。",
                segments=[{
                    "text": "好呀，逗你一下。",
                    "emotion": "playful",
                    "behavior": "speak",
                    "motionPlan": {
                        "durationMs": 1200,
                        "steps": [{
                            "atMs": 0,
                            "durationMs": 650,
                            "primitive": "tilt_left",
                            "intensity": 0.55,
                        }],
                    },
                }],
            )

    llm = PlainTextLLM()
    ctx = CharacterTurn(input=TurnInput(text="卖个萌吧"))
    run(DecisionStep(llm).run(ctx))

    assert len(llm.calls) == 2
    assert llm.calls[1]["tools"] is None
    assert llm.calls[1]["temperature"] == 0
    assert ctx.reply_text == "好呀，逗你一下。"
    assert ctx.output.performance.emotion == "playful"
    assert ctx.output.performance.behavior == "speak"
    # 2026-09-05 slimming: even a repaired plain-text reply gets no LLM
    # motion plan — beat scheduling belongs to the local director.
    assert ctx.output.performance.motion_plan is None
    assert "assistant_reply_semantic_recovered" not in ctx.warnings


def test_decision_step_falls_back_when_repair_is_also_empty():
    class TwiceEmptyLLM:
        def __init__(self):
            self.calls = 0

        async def generate(self, messages, **kwargs):
            self.calls += 1
            return LLMResponse(reply="", finish_reason="stop")

    llm = TwiceEmptyLLM()
    ctx = CharacterTurn(input=TurnInput(text="hello"))
    run(DecisionStep(llm).run(ctx))

    assert llm.calls == 2
    assert ctx.reply_text == "我刚才走神了，能再跟我说一遍吗？"
    assert ctx.segments[0]["contextTags"] == ["empty_reply_fallback"]
    assert ctx.output.performance.speaking is True


def test_decision_step_repairs_whitespace_only_reply_and_falls_back():
    """Whitespace-only content must trigger repair, then fall back if needed."""

    class WhitespaceThenEmptyLLM:
        def __init__(self):
            self.calls = 0

        async def generate(self, messages, **kwargs):
            self.calls += 1
            if self.calls == 1:
                return LLMResponse(reply="   \n  ", finish_reason="stop")
            return LLMResponse(reply="", finish_reason="length")

    llm = WhitespaceThenEmptyLLM()
    ctx = CharacterTurn(input=TurnInput(text="hello"))
    run(DecisionStep(llm).run(ctx))

    assert llm.calls == 2
    assert ctx.reply_text == "我刚才走神了，能再跟我说一遍吗？"
    assert ctx.segments[0]["contextTags"] == ["empty_reply_fallback"]


def test_decision_step_keeps_whitespace_trimmed_real_reply():
    """A reply that trims to real text is used as-is (no repair)."""

    class TrimmedLLM:
        def __init__(self):
            self.calls = 0

        async def generate(self, messages, **kwargs):
            self.calls += 1
            return LLMResponse(
                reply="  你好呀  ",
                segments=[{"text": "  你好呀  ", "emotion": "neutral", "behavior": "speak"}],
            )

    llm = TrimmedLLM()
    ctx = CharacterTurn(input=TurnInput(text="hello"))
    run(DecisionStep(llm).run(ctx))

    assert llm.calls == 1
    assert ctx.reply_text == "你好呀"


def test_decision_step_fallback_text_is_configurable(monkeypatch):
    monkeypatch.setenv("LLM_EMPTY_REPLY_FALLBACK", "再试一次？")

    class TwiceEmptyLLM:
        async def generate(self, messages, **kwargs):
            return LLMResponse(reply="", finish_reason="length")

    ctx = CharacterTurn(input=TurnInput(text="hello"))
    run(DecisionStep(TwiceEmptyLLM()).run(ctx))

    assert ctx.reply_text == "再试一次？"


def test_decision_step_does_not_repair_a_normal_reply():
    class NormalLLM:
        def __init__(self):
            self.calls = 0

        async def generate(self, messages, **kwargs):
            self.calls += 1
            return LLMResponse(
                reply="hello",
                segments=[{"text": "hello", "emotion": "neutral", "behavior": "speak"}],
            )

    llm = NormalLLM()
    ctx = CharacterTurn(input=TurnInput(text="hello"))
    run(DecisionStep(llm).run(ctx))

    assert llm.calls == 1
    assert ctx.reply_text == "hello"


def test_default_planner_requires_nonempty_reply():
    """The output protocol keeps speech nonempty and visible actions out of it."""
    from app.runtime.default_planner import DefaultPlanner
    from app.domain.character import Character

    ctx = CharacterTurn(input=TurnInput(text="hi"))
    ctx.character = Character({
        "id": "monika", "name": {"en": "Monika"}, "character_setting": "Be natural.",
    })
    plan = DefaultPlanner().plan(ctx)
    prompt = " ".join(
        m["content"] for m in plan.messages if m["role"] == "system"
    )
    assert "Never return empty, blank, or whitespace-only content" in prompt
    assert "only words the character actually says aloud" in prompt
    assert "Visible performance belongs only in" in prompt
    assert "do not claim that it happened" in prompt


def test_decision_step_fallback_not_written_to_conversation_history():
    """The recovery line must not pollute the LLM conversation context."""

    class TwiceEmptyLLM:
        async def generate(self, messages, **kwargs):
            return LLMResponse(reply="", finish_reason="stop")

    class RecordingConversation:
        def __init__(self):
            self.turns = []

        def add_turn(self, role, content, **metadata):
            self.turns.append((role, content))

        def get_history(self, limit=10):
            return [
                {"role": role, "content": content}
                for role, content in self.turns[-limit:]
            ]

    conv = RecordingConversation()
    ctx = CharacterTurn(input=TurnInput(text="hello"))
    ctx.conversation = conv
    run(DecisionStep(TwiceEmptyLLM()).run(ctx))

    assert ctx.reply_text == "我刚才走神了，能再跟我说一遍吗？"
    assert conv.turns == [("user", "hello")]
    assert any(w.startswith("assistant_reply_fallback") for w in ctx.warnings)


def test_decision_step_keeps_original_plain_text_when_structured_repair_fails():
    """A usable plain-text reply survives one failed structured repair.

    When tools are present the adapter stops forcing JSON output, so DeepSeek
    can answer with a single prose sentence. The validator requests one
    structured repair, but discarding the original after a failed repair would
    lose an otherwise usable spoken reply.
    """

    class PlainTextLLM:
        def __init__(self):
            self.calls = 0

        async def generate(self, messages, **kwargs):
            self.calls += 1
            return LLMResponse(reply="当然可以，交给我吧。")

    llm = PlainTextLLM()
    ctx = CharacterTurn(input=TurnInput(text="hi"))
    run(DecisionStep(llm).run(ctx))

    assert llm.calls == 2
    assert ctx.reply_text == "当然可以，交给我吧。"
    assert "assistant_reply_semantic_recovered" in ctx.warnings
    assert not any(w.startswith("assistant_reply_fallback") for w in ctx.warnings)


def test_decision_step_sanitizes_stage_direction_after_failed_repair():
    class NarratedActionLLM:
        def __init__(self):
            self.calls = 0

        async def generate(self, messages, **kwargs):
            self.calls += 1
            return LLMResponse(
                reply="呜……（做出委屈巴巴的哭哭脸）你看，我都这么可怜了。"
            )

    llm = NarratedActionLLM()
    ctx = CharacterTurn(input=TurnInput(text="做个哭哭脸吧"))
    run(DecisionStep(llm).run(ctx))

    assert llm.calls == 2
    assert ctx.reply_text == "呜……你看，我都这么可怜了。"
    # Shirone deliberately exposes one supported sad family for both the
    # semantic ``cry`` request and its native sad replacement expression.
    assert ctx.output.performance.emotion == "sad"
    assert "assistant_reply_semantic_recovered" in ctx.warnings
    assert "assistant_reply_sanitized" in ctx.warnings
    assert not any(w.startswith("assistant_reply_fallback") for w in ctx.warnings)
