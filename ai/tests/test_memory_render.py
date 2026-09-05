"""M3 read-side tests: dated memory rendering, initiative validity filtering,
and the key-expansion (tags) retrieval channel.
"""

from datetime import datetime, timedelta, timezone

from app.memory.retrieval import score_memory
from app.memory.store import MemoryStore
from app.runtime.context_assembler import ContextAssembler
from app.runtime.initiative_memory import InitiativeMemorySelector
from app.runtime.user_views import build_memory_view


def _iso(days_ago: float) -> str:
    return (
        datetime.now(timezone.utc) - timedelta(days=days_ago)
    ).isoformat()


def _local_label(days_ago: float) -> str:
    local = (datetime.now(timezone.utc) - timedelta(days=days_ago)).astimezone()
    return f"{local.month}月{local.day}日"


# ── dated rendering ───────────────────────────────────────────────────────


def test_recent_state_renders_with_observed_date():
    _, parts = ContextAssembler().assemble_memories([{
        "type": "recent_state",
        "data": {
            "content": "主人在凌晨仍未睡觉，处于熬夜状态",
            "observed_at": _iso(8),
        },
        "source": "hybrid",
    }])
    assert parts == [f"[Recent state · {_local_label(8)}] 主人在凌晨仍未睡觉，处于熬夜状态"]


def test_fact_renders_with_recorded_date():
    _, parts = ContextAssembler().assemble_memories([{
        "type": "fact",
        "data": {"content": "用户是软件开发人员", "observed_at": _iso(20)},
        "source": "hybrid",
    }])
    assert parts == [f"[Fact · 记录于{_local_label(20)}] 用户是软件开发人员"]


def test_memory_without_timestamp_renders_plain():
    _, parts = ContextAssembler().assemble_memories([{
        "type": "preference",
        "data": {"content": "用户喜欢巧克力蛋糕", "score": 0.9},
        "source": "hybrid",
    }])
    assert parts == ["[Preference] 用户喜欢巧克力蛋糕"]


def test_open_loop_renders_without_date():
    _, parts = ContextAssembler().assemble_memories([{
        "type": "open_loop",
        "data": {"content": "等用户接话", "observed_at": _iso(1)},
        "source": "hybrid",
    }])
    assert parts == ["[Unfinished topic] 等用户接话"]


# ── initiative validity filter ────────────────────────────────────────────


def test_initiative_selector_skips_expired_and_reports_observed(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    expired = store.upsert_memory(
        memory_type="recent_state", subject="user", predicate="sleep_schedule",
        content="主人在凌晨仍未睡觉，处于熬夜状态", character_id="jingyu",
        confidence=0.9,
    )
    conn = store._get_conn()
    conn.execute(
        "UPDATE memories SET expires_at = ? WHERE id = ?",
        ((datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(), expired),
    )
    conn.commit()

    assert InitiativeMemorySelector(store, cooldown_seconds=0).select("jingyu") is None

    live = store.upsert_memory(
        memory_type="open_loop", subject="user", predicate="pending_topic",
        content="等用户接话", character_id="jingyu", confidence=0.9,
        observed_at="2026-08-27T12:00:00+00:00",
    )
    picked = InitiativeMemorySelector(store, cooldown_seconds=0).select("jingyu")
    assert picked is not None
    assert picked["memory_id"] == live
    assert picked["observed_at"].startswith("2026-08-27")


# ── user-facing memory view (M4) ──────────────────────────────────────────


def test_memory_view_reports_status_and_observed():
    view = build_memory_view([{
        "id": 7,
        "memory_type": "recent_state",
        "subject": "user",
        "content": "主人在凌晨仍未睡觉",
        "importance": 0.6,
        "state": "active",
        "observed_at": "2026-08-27T21:41:21+00:00",
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        "created_at": "2026-08-27T21:41:21+00:00",
        "updated_at": "2026-08-27T21:41:21+00:00",
    }])
    item = view["items"][0]
    assert item["status"] == "active"
    assert item["observedAt"].startswith("2026-08-27")
    assert item["formationReason"] == "从你当时的状态中形成"
    assert any(c["id"] == "expired" for c in view["categories"])


def test_memory_view_expired_rows_surface_only_in_expired_category():
    rows = [
        {
            "id": 1, "memory_type": "recent_state", "subject": "user",
            "content": "过期的状态", "importance": 0.6,
            "state": "expired", "active": 0,
            "created_at": _iso(9), "updated_at": _iso(9),
        },
        {
            "id": 2, "memory_type": "fact", "subject": "user",
            "content": "用户已被遗忘的行", "importance": 0.6,
            "state": "active", "active": 0,
            "created_at": _iso(9), "updated_at": _iso(9),
        },
        {
            "id": 3, "memory_type": "fact", "subject": "user",
            "content": "仍然有效的事实", "importance": 0.6,
            "state": "active", "active": 1,
            "created_at": _iso(0), "updated_at": _iso(0),
        },
    ]
    all_view = build_memory_view(rows, category="all")
    assert [i["ref"] for i in all_view["items"]] == ["memory:3"]

    expired_view = build_memory_view(rows, category="expired")
    assert [i["ref"] for i in expired_view["items"]] == ["memory:1"]
    assert expired_view["items"][0]["status"] == "expired"


# ── tags retrieval channel ────────────────────────────────────────────────


def test_tag_match_lifts_score_and_flags_reason():
    base = {
        "content": "用户习惯在深夜还保持活跃状态",
        "importance": 0.6,
        "confidence": 0.8,
        "access_count": 0,
    }
    with_tags = {**base, "tags": ["熬夜", "失眠", "几点睡"]}
    score_plain, reasons_plain = score_memory("我最近老失眠怎么办", base)
    score_tagged, reasons_tagged = score_memory("我最近老失眠怎么办", with_tags)
    assert score_tagged > score_plain
    assert "tag_match" in reasons_tagged
    assert "tag_match" not in reasons_plain


def test_vector_weights_apply_only_when_enabled():
    item = {
        "content": "用户喜欢徒步",
        "importance": 0.5,
        "confidence": 0.6,
        "vector_enabled": True,
        "vector_score": 0.95,
    }
    score, reasons = score_memory("远足", item)
    assert score > 0
    assert "vector_match" in reasons

    plain = {k: v for k, v in item.items() if k != "vector_score"}
    plain["vector_enabled"] = False
    score_plain, _ = score_memory("远足", plain)
    assert score_plain < score
