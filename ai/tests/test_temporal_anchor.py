"""M1 temporal-anchor tests: one clock, injected into every LLM-facing context.

Covers: prompt_compiler temporal source (+ per-character disable), extraction
system prompts carrying the anchor, initiative prompt time line, and the
formatter itself.
"""

from datetime import datetime

from app.domain.character import Character
from app.memory.extractor import extract_facts
from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.prompts import build_initiative_prompt
from app.runtime.prompt_compiler import PromptCompiler
from app.runtime.prompt_config import PromptConfigStore
from app.utils.temporal import current_time_context, time_anchor


def _turn_for(character_id: str) -> CharacterTurn:
    character = Character({
        "id": character_id,
        "name": {"zh": "测试角色"},
        "character_setting": "保持自然。",
    })
    turn = CharacterTurn(input=TurnInput(text="你好"))
    turn.character = character
    return turn


def _compiler(tmp_path) -> PromptCompiler:
    return PromptCompiler(
        prompt_config_store=PromptConfigStore(tmp_path / "prompts"),
        pinned_dir=tmp_path / "characters",
    )


def _temporal_messages(compiled) -> list[str]:
    return [
        item["content"] for item in compiled.messages
        if item.get("_source_id") == "temporal"
    ]


def test_current_time_context_formats_local_clock():
    text = current_time_context(datetime(2026, 9, 4, 23, 30))
    assert "2026年9月4日" in text
    assert "星期五" in text
    assert "23:30" in text
    assert "本地时区" in text


def test_time_anchor_carries_interpretation_rule():
    anchor = time_anchor(datetime(2026, 9, 4, 23, 30))
    assert anchor.startswith("[当前时间]")
    assert "历史观察" in anchor
    assert "重新换算" in anchor


def test_temporal_source_is_registered_as_editable(tmp_path):
    definitions = PromptConfigStore(tmp_path).definitions()
    temporal = next(d for d in definitions if d["id"] == "temporal")
    assert temporal["editable"] is True
    assert temporal["dynamic"] is True
    assert temporal["title"] == "时间感知"


def test_compile_injects_temporal_before_memory(tmp_path):
    compiled = _compiler(tmp_path).compile(_turn_for("monika"), None)
    temporal = _temporal_messages(compiled)
    assert len(temporal) == 1
    assert temporal[0].startswith("[当前时间]")
    assert "历史观察" in temporal[0]
    source_ids = [item.get("_source_id", "") for item in compiled.messages]
    if "memory_summary" in source_ids:
        assert source_ids.index("temporal") < source_ids.index("memory_summary")


def test_temporal_can_be_disabled_per_character(tmp_path):
    store = PromptConfigStore(tmp_path / "prompts")
    store.set("monika", {"temporal": {"mode": "disabled", "content": ""}})
    compiled = _compiler(tmp_path).compile(_turn_for("monika"), None)
    assert _temporal_messages(compiled) == []


class _CaptureLLM:
    def __init__(self, response: str = "[]"):
        self.calls: list[dict] = []
        self._response = response

    def generate_text(self, **kwargs):
        self.calls.append(kwargs)
        return self._response


def test_extraction_system_prompt_carries_time_anchor():
    adapter = _CaptureLLM("[]")
    extract_facts("用户说今天很累，想早点睡。", adapter, store=object())
    assert adapter.calls, "extraction should call the LLM once"
    system = adapter.calls[0]["system"]
    assert system.startswith("[当前时间]")
    assert "历史观察" in system


def test_initiative_prompt_includes_current_time():
    prompt = build_initiative_prompt(
        "care", "主人在凌晨仍未睡觉",
        language="zh",
        current_time="2026年9月4日 星期五 23:30（本地时区）",
    )
    assert "[当前时间] 2026年9月4日 星期五 23:30（本地时区）" in prompt


def test_initiative_prompt_without_time_stays_backward_compatible():
    prompt = build_initiative_prompt("care", "话题", language="zh")
    assert "[当前时间]" not in prompt
    assert "要提及的话题: 话题" in prompt
