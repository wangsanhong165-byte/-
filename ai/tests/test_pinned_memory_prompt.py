"""P3 pinned-memory tests: config/characters/{id}/pinned.md — user-pinned
fixed memory — is injected into every prompt ahead of compiled memory, and
inherits the per-character enable/replace policy from the prompt config store.
"""

from pathlib import Path

from app.domain.character import Character
from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.prompt_compiler import PromptCompiler
from app.runtime.prompt_config import PromptConfigStore


def _turn_for(character_id: str) -> CharacterTurn:
    character = Character({
        "id": character_id,
        "name": {"zh": "测试角色"},
        "character_setting": "保持自然。",
    })
    turn = CharacterTurn(input=TurnInput(text="你好"))
    turn.character = character
    return turn


def _compiler(tmp_path: Path) -> PromptCompiler:
    return PromptCompiler(
        prompt_config_store=PromptConfigStore(tmp_path / "prompts"),
        pinned_dir=tmp_path / "characters",
    )


def _pinned_messages(compiled) -> list[str]:
    return [
        item["content"] for item in compiled.messages
        if item.get("_source_id") == "pinned"
    ]


def test_pinned_source_is_registered_as_editable(tmp_path):
    definitions = PromptConfigStore(tmp_path).definitions()
    pinned = next(d for d in definitions if d["id"] == "pinned")
    assert pinned["editable"] is True
    assert pinned["dynamic"] is True
    assert pinned["title"] == "固定记忆"


def test_pinned_md_is_injected_ahead_of_compiled_memory(tmp_path):
    pinned_file = tmp_path / "characters" / "monika" / "pinned.md"
    pinned_file.parent.mkdir(parents=True)
    pinned_file.write_text("叫我大哥；不要建议我早睡", encoding="utf-8")

    compiled = _compiler(tmp_path).compile(_turn_for("monika"), None)

    pinned = _pinned_messages(compiled)
    assert len(pinned) == 1
    assert pinned[0].startswith("[固定记忆]")
    assert "叫我大哥" in pinned[0]
    # Injected ahead of the memory sections (when memory sections exist).
    source_ids = [item.get("_source_id", "") for item in compiled.messages]
    assert "pinned" in source_ids
    if "memory_summary" in source_ids:
        assert source_ids.index("pinned") < source_ids.index("memory_summary")


def test_missing_pinned_md_injects_nothing(tmp_path):
    compiled = _compiler(tmp_path).compile(_turn_for("monika"), None)
    assert _pinned_messages(compiled) == []


def test_pinned_can_be_disabled_per_character(tmp_path):
    pinned_file = tmp_path / "characters" / "monika" / "pinned.md"
    pinned_file.parent.mkdir(parents=True)
    pinned_file.write_text("不该出现", encoding="utf-8")
    store = PromptConfigStore(tmp_path / "prompts")
    store.set("monika", {"pinned": {"mode": "disabled", "content": ""}})

    compiled = _compiler(tmp_path).compile(_turn_for("monika"), None)

    assert _pinned_messages(compiled) == []


def test_pinned_can_be_replaced_per_character(tmp_path):
    pinned_file = tmp_path / "characters" / "monika" / "pinned.md"
    pinned_file.parent.mkdir(parents=True)
    pinned_file.write_text("文件内容", encoding="utf-8")
    store = PromptConfigStore(tmp_path / "prompts")
    store.set("monika", {"pinned": {
        "mode": "replace", "content": "用替换内容",
    }})

    compiled = _compiler(tmp_path).compile(_turn_for("monika"), None)

    pinned = _pinned_messages(compiled)
    assert pinned == ["用替换内容"]


def test_pinned_is_character_scoped(tmp_path):
    pinned_file = tmp_path / "characters" / "monika" / "pinned.md"
    pinned_file.parent.mkdir(parents=True)
    pinned_file.write_text("monika 的固定记忆", encoding="utf-8")

    alice = _compiler(tmp_path).compile(_turn_for("alice"), None)
    monika = _compiler(tmp_path).compile(_turn_for("monika"), None)

    assert _pinned_messages(alice) == []
    assert "monika 的固定记忆" in _pinned_messages(monika)[0]
