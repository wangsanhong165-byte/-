"""M2 semantic-time tests: observed_at/expires_at/tags columns, recent_state
validity windows, cross-type supersession, and the one-time v5 cleanup with
its backup.
"""

import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone

from app.memory.store import MemoryStore, _migrate_v5_cleanup
from app.memory.extractor import _turn_label
from app.memory.prompts import system_fact_extraction, system_rolling_summary


def _days_ago(days: float) -> str:
    return datetime.fromtimestamp(
        time.time() - days * 86400, tz=timezone.utc
    ).isoformat()


def _make_store(tmp_path) -> MemoryStore:
    return MemoryStore(base_dir=tmp_path)


def _row(store, memory_id) -> dict:
    rows = store.list_memories(active_only=False, limit=500)
    return next(r for r in rows if r["id"] == memory_id)


def _active(store, character_id="monika") -> list[dict]:
    return store.list_memories(character_id=character_id)


# ── schema v5 ─────────────────────────────────────────────────────────────


def test_v5_columns_exist_on_fresh_store(tmp_path):
    store = _make_store(tmp_path)
    columns = {
        r[1] for r in store._get_conn().execute("PRAGMA table_info(memories)")
    }
    assert {"tags", "observed_at", "expires_at"} <= columns


def test_v5_migration_backfills_observed_at_and_cleans_legacy(tmp_path):
    """A legacy table gains the new columns; observed_at falls back to
    created_at; a stale '今天'-style recent_state gets expired with a backup."""
    db = tmp_path / "data" / "memory" / "memory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE memories ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "memory_type TEXT NOT NULL,"
        "subject TEXT NOT NULL DEFAULT 'user',"
        "predicate TEXT NOT NULL DEFAULT '',"
        "content TEXT NOT NULL,"
        "character_id TEXT NOT NULL DEFAULT '',"
        "stable_key TEXT NOT NULL,"
        "importance REAL NOT NULL DEFAULT 0.5,"
        "confidence REAL NOT NULL DEFAULT 0.6,"
        "active INTEGER NOT NULL DEFAULT 1,"
        "access_count INTEGER NOT NULL DEFAULT 0,"
        "last_retrieved_at TEXT,"
        "state TEXT NOT NULL DEFAULT 'active',"
        "created_at TEXT NOT NULL,"
        "updated_at TEXT NOT NULL)"
    )
    old = _days_ago(10)
    conn.execute(
        "INSERT INTO memories(memory_type, subject, predicate, content, "
        "character_id, stable_key, created_at, updated_at) "
        "VALUES ('recent_state', 'user', 'sleep_schedule', '主人在凌晨仍未睡觉', "
        "'jingyu', 'recent_state:user:sleep_schedule', ?, ?)",
        (old, old),
    )
    conn.commit()
    conn.close()

    store = _make_store(tmp_path)
    row = _row(store, 1)
    assert row["observed_at"] == old
    assert row["active"] == 0
    assert row["state"] == "expired"

    backups = list((tmp_path / "data" / "memory").glob("memories_backup_*.json"))
    assert len(backups) == 1
    payload = json.loads(backups[0].read_text(encoding="utf-8"))
    assert payload["rows"]


def test_v5_cleanup_is_idempotent_and_skips_fresh_rows(tmp_path):
    store = _make_store(tmp_path)
    fresh = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="mood",
        content="用户今天很累", character_id="monika",
    )
    conn = store._get_conn()
    assert _migrate_v5_cleanup(conn, tmp_path) == 0
    assert _row(store, fresh)["active"] == 1


# ── validity windows ──────────────────────────────────────────────────────


def test_recent_state_gets_default_expiry_fact_does_not(tmp_path):
    store = _make_store(tmp_path)
    state_id = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="mood",
        content="用户情绪低落", character_id="monika",
    )
    fact_id = store.upsert_memory(
        memory_type="fact", subject="user", predicate="occupation",
        content="用户是软件开发人员", character_id="monika",
    )
    state_row = _row(store, state_id)
    fact_row = _row(store, fact_id)
    assert state_row["expires_at"]
    expiry = datetime.fromisoformat(state_row["expires_at"])
    remaining = expiry - datetime.now(timezone.utc)
    assert timedelta(hours=47) < remaining <= timedelta(hours=48)
    assert fact_row["expires_at"] is None


def test_expire_memories_flips_past_due_rows_only(tmp_path):
    store = _make_store(tmp_path)
    due = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="mood",
        content="用户此刻很烦躁", character_id="monika",
    )
    future = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="activity",
        content="用户正在休息", character_id="monika",
    )
    conn = store._get_conn()
    conn.execute(
        "UPDATE memories SET expires_at = ? WHERE id = ?",
        (_days_ago(0.01), due),
    )
    conn.commit()

    result = store.expire_memories(character_id="monika")

    assert result["expired"] == 1
    assert _row(store, due)["state"] == "expired"
    assert _row(store, due)["active"] == 0
    assert _row(store, future)["active"] == 1
    # Expired rows vanish from active retrieval…
    assert all(r["id"] != due for r in _active(store))
    # …and decay no longer re-transitions them.
    decayed = store.decay_memories(character_id="monika")
    assert due not in decayed["staled"]
    assert due not in decayed["archived"]


def test_reconfirmation_pushes_validity_window_forward(tmp_path):
    store = _make_store(tmp_path)
    mid = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="mood",
        content="用户还在熬夜", character_id="monika",
    )
    conn = store._get_conn()
    conn.execute(
        "UPDATE memories SET state = 'expired', active = 0, expires_at = ? "
        "WHERE id = ?",
        (_days_ago(1), mid),
    )
    conn.commit()

    store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="mood",
        content="用户还在熬夜", character_id="monika",
    )

    row = _row(store, mid)
    assert row["active"] == 1
    assert row["state"] == "active"
    new_expiry = datetime.fromisoformat(row["expires_at"])
    assert new_expiry > datetime.now(timezone.utc)


# ── cross-type supersession ───────────────────────────────────────────────


def test_fact_write_retires_same_predicate_recent_state(tmp_path):
    store = _make_store(tmp_path)
    snapshot = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="sleep_schedule",
        content="主人在凌晨仍未睡觉，处于熬夜状态", character_id="jingyu",
        stable_key="recent_state:user:sleep_schedule",
    )
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="sleep_schedule",
        content="用户习惯深夜活跃", character_id="jingyu",
        stable_key="fact:user:sleep_schedule",
    )
    assert _row(store, snapshot)["active"] == 0
    active = _active(store, "jingyu")
    assert [r["memory_type"] for r in active] == ["fact"]


def test_supersession_is_predicate_scoped(tmp_path):
    store = _make_store(tmp_path)
    other = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="mood",
        content="用户情绪不错", character_id="monika",
    )
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="sleep_schedule",
        content="用户习惯深夜活跃", character_id="monika",
    )
    assert _row(store, other)["active"] == 1


def test_preference_write_does_not_retire_recent_state(tmp_path):
    store = _make_store(tmp_path)
    snapshot = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="sleep_schedule",
        content="用户在熬夜", character_id="monika",
    )
    store.upsert_memory(
        memory_type="preference", subject="user", predicate="sleep_schedule",
        content="用户喜欢深夜闲聊", character_id="monika",
    )
    assert _row(store, snapshot)["active"] == 1


def test_supersession_is_character_scoped(tmp_path):
    store = _make_store(tmp_path)
    other_char = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="mood",
        content="alpha 的状态", character_id="alpha",
    )
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="mood",
        content="monika 视角的新事实", character_id="monika",
    )
    assert _row(store, other_char)["active"] == 1


# ── tags + observed ───────────────────────────────────────────────────────


def test_tags_and_observed_round_trip(tmp_path):
    store = _make_store(tmp_path)
    mid = store.upsert_memory(
        memory_type="fact", subject="user", predicate="sleep_schedule",
        content="用户8月27日凌晨5点还没睡", character_id="monika",
        observed_at="2026-08-27", tags=["作息", "熬夜", "熬夜"],
    )
    row = _row(store, mid)
    assert row["tags"] == ["作息", "熬夜"]
    assert row["observed_at"].startswith("2026-08-27")


# ── v5 cleanup rules ──────────────────────────────────────────────────────


def test_cleanup_expires_stale_relative_states_and_leaked_empty_marker(tmp_path):
    store = _make_store(tmp_path)
    fresh_relative = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="mode",
        content="用户今天只重复说你好", character_id="monika",
    )
    stale_state = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="mode",
        content="主人在凌晨仍未睡觉", character_id="jingyu",
        observed_at=_days_ago(8),
    )
    clockless = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="status",
        content="用户现在不想说话", character_id="monika",
    )
    leaked = store.upsert_memory(
        memory_type="open_loop", subject="user", predicate="pending_topic",
        content="（无）——昨晚熬夜话题已收尾", character_id="jingyu",
    )
    tomorrow = store.upsert_memory(
        memory_type="fact", subject="user", predicate="upcoming_exam",
        content="用户明天有物理考试", character_id="monika",
        observed_at=_days_ago(20),
    )
    keeper = store.upsert_memory(
        memory_type="fact", subject="user", predicate="occupation",
        content="用户是软件开发人员", character_id="monika",
    )
    conn = store._get_conn()
    conn.execute(
        "UPDATE memories SET observed_at = NULL, created_at = 'not-a-date' "
        "WHERE id = ?",
        (clockless,),
    )
    conn.commit()

    expired = _migrate_v5_cleanup(conn, tmp_path)
    conn.commit()

    # A fresh "今天…" row with a real clock is legitimate current state.
    assert _row(store, fresh_relative)["active"] == 1
    for mid in (stale_state, clockless, leaked, tomorrow):
        row = _row(store, mid)
        assert row["active"] == 0
        assert row["state"] == "expired"
    assert _row(store, keeper)["active"] == 1
    assert expired == 4


# ── extraction input + prompt contract ────────────────────────────────────


def test_turn_label_prefixes_local_date():
    utc_stamp = datetime(2026, 8, 27, 21, 5, tzinfo=timezone.utc).isoformat()
    line = _turn_label(
        {"role": "user", "content": "五点了还没睡", "created_at": utc_stamp},
        "鲸鱼",
    )
    assert line.startswith("用户（08月")
    assert "五点了还没睡" in line
    assert "鲸鱼" not in line


def test_turn_label_tolerates_missing_timestamp():
    line = _turn_label({"role": "user", "content": "你好"}, "鲸鱼")
    assert line == "用户: 你好"


def test_extraction_prompt_requires_absolute_dates_and_observed():
    prompt = system_fact_extraction()
    assert "observed" in prompt
    assert "YYYY-MM-DD" in prompt
    assert "绝对日期" in prompt
    assert "sleep_schedule" in prompt


def test_rolling_summary_prompt_requires_absolute_dates():
    assert "绝对表述" in system_rolling_summary("鲸鱼")
