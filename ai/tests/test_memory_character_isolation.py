"""Character isolation guards for the memory system.

One retrieval test existed before; this suite pins the remaining isolation
surfaces that any memory-write upgrade depends on:
  - writes (upsert) are scoped by character_id
  - the rolling-summary window only consumes a character's own rows
  - compiled sections live in per-character directories
  - memory edit/forget from the management layer cannot cross characters
"""

from app.memory.lifecycle import store_candidates
from app.memory.store import MemoryStore
from app.memory import compiler as compiler_mod
from app.memory.compiler import (
    write_conversation_summary,
    get_conversation_summary,
    get_compiled_memory,
)


def test_hybrid_retrieval_does_not_leak_other_character_facts(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    store_candidates(store, [{"fact": "Alpha owns a unique blue key"}], "alpha")
    store_candidates(store, [{"fact": "Beta owns a unique red key"}], "beta")

    alpha = store.search_memories("key", character_id="alpha", limit=10)
    contents = [row["content"] for row in alpha]
    assert any("blue" in content for content in contents)
    assert all("red" not in content for content in contents)


def test_upsert_and_list_are_character_scoped(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="city",
        content="Alpha lives in Kyoto", character_id="alpha",
        stable_key="fact:user:city",
    )
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="city",
        content="Beta lives in Oslo", character_id="beta",
        stable_key="fact:user:city",
    )

    alpha_rows = store.list_memories(character_id="alpha")
    beta_rows = store.list_memories(character_id="beta")

    assert [row["content"] for row in alpha_rows] == ["Alpha lives in Kyoto"]
    assert [row["content"] for row in beta_rows] == ["Beta lives in Oslo"]


def test_summary_window_only_consumes_own_character_rows(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    for i in range(3):
        store.log_turn(
            f"alpha message {i}", {"reply_text": "alpha reply"},
            character_id="alpha", turn_id=f"a{i}", write_token=f"aw{i}",
        )
        store.log_turn(
            f"beta message {i}", {"reply_text": "beta reply"},
            character_id="beta", turn_id=f"b{i}", write_token=f"bw{i}",
        )

    alpha_window = store.summary_window(
        "alpha", after_log_id=0, keep_recent=1, limit=20
    )
    beta_window = store.summary_window(
        "beta", after_log_id=0, keep_recent=1, limit=20
    )

    assert alpha_window, "alpha window should have rows"
    assert all("alpha" in row["content"] for row in alpha_window)
    assert all("beta" not in row["content"] for row in alpha_window)
    assert beta_window, "beta window should have rows"
    assert all("beta" in row["content"] for row in beta_window)


def test_compiled_sections_are_per_character(tmp_path, monkeypatch):
    monkeypatch.setattr(compiler_mod, "_get_base", lambda: tmp_path)

    write_conversation_summary("alpha", "alpha summary", through_log_id=5)
    write_conversation_summary("beta", "beta summary", through_log_id=9)

    assert get_conversation_summary("alpha") == "alpha summary"
    assert get_conversation_summary("beta") == "beta summary"

    compiled_root = tmp_path / "data" / "memory" / "compiled"
    assert (compiled_root / "alpha" / "conversation_summary.md").exists()
    assert (compiled_root / "beta" / "conversation_summary.md").exists()
    # Cross-read must not fall back to another character's content.
    assert "beta" not in get_conversation_summary("alpha")
    assert "alpha" not in get_conversation_summary("beta")
    # Unrelated characters read empty, never another character's file.
    assert get_conversation_summary("gamma") == ""
    assert get_compiled_memory("gamma") == ""


def test_update_and_forget_cannot_cross_characters(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    memory_id = store.upsert_memory(
        memory_type="fact", subject="user", predicate="city",
        content="Alpha lives in Kyoto", character_id="alpha",
        stable_key="fact:user:city",
    )

    # Editing through another character's scope must find nothing.
    assert store.update_memory(memory_id, character_id="beta",
                               content="Beta hack") is None
    assert store.forget_memory(memory_id, character_id="beta") is False
    rows = store.list_memories(character_id="alpha", active_only=True)
    assert rows and rows[0]["content"] == "Alpha lives in Kyoto"

    # The owning character can still edit and forget.
    updated = store.update_memory(memory_id, character_id="alpha",
                                  content="Alpha moved to Osaka")
    assert updated is not None and updated["content"] == "Alpha moved to Osaka"
    assert store.forget_memory(memory_id, character_id="alpha") is True
    assert store.list_memories(character_id="alpha", active_only=True) == []
    # Soft-deleted row stays visible to the owning scope only.
    inactive = store.list_memories(character_id="alpha", active_only=False)
    assert len(inactive) == 1
    assert store.list_memories(character_id="beta", active_only=False) == []
