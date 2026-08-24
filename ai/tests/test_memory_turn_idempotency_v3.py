import sqlite3
from pathlib import Path

from app.memory.store import MemoryStore


def test_default_memory_store_honors_isolated_database_path(tmp_path, monkeypatch):
    isolated = tmp_path / "isolated" / "memory.db"
    monkeypatch.setenv("MEMORY_DB_PATH", str(isolated))

    store = MemoryStore()
    try:
        assert Path(store._db_path) == isolated
        assert isolated.exists()
    finally:
        store.stop()


def test_memory_schema_migration_is_repeatable(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    store._init_db()

    conn = sqlite3.connect(store._db_path)
    version = conn.execute(
        "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
    ).fetchone()[0]
    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(logs)").fetchall()
    }

    assert version >= 3
    assert {"turn_id", "write_token"} <= columns


def test_log_turn_is_idempotent_for_character_turn_and_token(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    reply = {"reply_text": "world", "intent": "conversation"}

    first = store.log_turn(
        "hello",
        reply,
        character_id="monika",
        turn_id="turn-1",
        write_token="conversation",
    )
    second = store.log_turn(
        "hello",
        reply,
        character_id="monika",
        turn_id="turn-1",
        write_token="conversation",
    )

    conn = sqlite3.connect(store._db_path)
    count = conn.execute(
        "SELECT COUNT(*) FROM logs WHERE character_id = ? AND turn_id = ?",
        ("monika", "turn-1"),
    ).fetchone()[0]

    assert first is True
    assert second is False
    assert count == 2


def test_delete_history_removes_only_its_turn_commit_markers(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    reply = {"reply_text": "world", "intent": "conversation"}

    assert store.log_turn(
        "hello",
        reply,
        character_id="monika",
        turn_id="turn-deleted",
        write_token="conversation",
        history_uid="hist-deleted",
    )
    assert store.log_turn(
        "keep",
        reply,
        character_id="monika",
        turn_id="turn-kept",
        write_token="conversation",
        history_uid="hist-kept",
    )

    assert store.delete_history("hist-deleted", character_id="monika") == 2

    conn = sqlite3.connect(store._db_path)
    deleted_commit_count = conn.execute(
        "SELECT COUNT(*) FROM turn_commits WHERE character_id = ? AND turn_id = ?",
        ("monika", "turn-deleted"),
    ).fetchone()[0]
    kept_commit_count = conn.execute(
        "SELECT COUNT(*) FROM turn_commits WHERE character_id = ? AND turn_id = ?",
        ("monika", "turn-kept"),
    ).fetchone()[0]

    assert deleted_commit_count == 0
    assert kept_commit_count == 1
    assert store.log_turn(
        "hello again",
        reply,
        character_id="monika",
        turn_id="turn-deleted",
        write_token="conversation",
        history_uid="hist-replayed",
    )
