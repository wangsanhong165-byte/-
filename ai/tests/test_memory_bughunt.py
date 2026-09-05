"""Bug-hunt round tests (post-Qwen3-landing review):
- Fix A: summary_window semantic filter must not starve the summarizer
- Fix B: update_memory observes observed_at; open_loop continuity refreshes it
- Fix C: initiative selector runs cheap filters before semantic suppression
- Fix F: prototype vector cache stays out of config/
"""

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.memory import compiler as compiler_mod
from app.memory import embedder as embedder_module
from app.memory.extractor import is_low_information_turns, sync_open_loops
from app.memory.prototypes import PrototypeClassifier
from app.memory.store import MemoryStore


class _CountingStub:
    """Same-vector stub with an embed counter (for filter-order assertions)."""

    def __init__(self):
        self.calls = 0
        self._table = {}
        self._default = None

    def available(self):
        return True

    def expected_dim(self):
        return 2

    def embed_query(self, text):
        self.calls += 1
        return [1.0, 0.0]

    def embed_document(self, text):
        self.calls += 1
        return [1.0, 0.0]


# ── Fix A: summary_window starvation fail-open ────────────────────────────


def test_summary_window_returns_raw_when_filter_starves(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    stub = _CountingStub()
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)
    # 语义过滤会把近重复窗口丢到不足 3 条 → 必须回退全量，防永久卡死。
    # 回复也用长文本（短回复 len<2 会绕过嵌入，污染饥饿场景）。
    for n in range(5):
        store.log_turn(
            f"发个测试{n}", {"reply_text": "好的收到"}, character_id="monika",
            turn_id=f"t{n}", write_token=f"w{n}",
        )
    monkeypatch.setattr(compiler_mod, "_get_base", lambda: tmp_path)
    compiler_mod.set_active_char("monika")
    compiler_mod.write_conversation_summary("monika", "用户一直在发测试消息")

    rows = store.summary_window("monika", after_log_id=0, keep_recent=2, limit=50)

    assert len(rows) == 8, (
        "starved filter must fall back to the raw window (fail-open): "
        f"got {len(rows)}"
    )


def test_summary_window_still_drops_near_dups_when_enough_remain(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)

    class _TableStub(_CountingStub):
        def __init__(self, table, default=None):
            super().__init__()
            self._table = table
            self._default = default

        def embed_document(self, text):
            self.calls += 1
            return self._lookup(text)

        def embed_query(self, text):
            self.calls += 1
            return self._lookup(text)

        def _lookup(self, text):
            for needle, vector in self._table.items():
                if needle in text:
                    return vector
            return self._default

    stub = _TableStub({
        "测试": [1.0, 0.0, 0.0],
        "动画": [0.0, 1.0, 0.0],
        "爬山": [0.0, 0.0, 1.0],
        "键盘": [0.7, 0.7, 0.0],
        "别的话题": [0.1, 0.2, 0.1],
    }, default=[0.1, 0.2, 0.1])
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)
    # 12 行（6 用户 + 6 助手）：3 条近重复刷屏 + 3 条互不相同的有信息回合
    texts = ["发个测试一", "发个测试二", "发个测试三",
             "聊了动画电影", "聊了周末爬山", "聊了新买的键盘"]
    for n, t in enumerate(texts):
        store.log_turn(t, {"reply_text": "好的收到"}, character_id="monika",
                       turn_id=f"t{n}", write_token=f"w{n}")
    monkeypatch.setattr(compiler_mod, "_get_base", lambda: tmp_path)
    compiler_mod.set_active_char("monika")
    compiler_mod.write_conversation_summary("monika", "之前聊过别的话题")

    rows = store.summary_window("monika", after_log_id=0, keep_recent=2, limit=50)

    contents = [r["content"] for r in rows]
    spam = sum(1 for c in contents if "测试" in c)
    assert spam <= 1, "near-dup spam rows collapse to their first occurrence"
    assert any("动画" in c for c in contents)
    assert any("爬山" in c for c in contents)
    # 键盘（u6）位于 keep_recent 保留的最近尾部，本就不在窗口内——不在此断言。


# ── Fix B: observed_at refresh on in-place open_loop update ───────────────


def test_update_memory_supports_observed_at(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    mid = store.upsert_memory(
        memory_type="open_loop", subject="user", predicate="pending_topic",
        content="旧措辞", character_id="monika",
    )
    store.update_memory(mid, character_id="monika",
                        content="新措辞", observed_at="2026-09-05T00:00:00+00:00")
    row = next(r for r in store.list_memories(active_only=False) if r["id"] == mid)
    assert row["observed_at"].startswith("2026-09-05")
    assert row["content"] == "新措辞"


def test_open_loop_continuity_refreshes_observed_at(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    loop_id = store.upsert_memory(
        memory_type="open_loop", subject="user", predicate="pending_topic",
        content="用户想看魔法少女小圆剧场版", character_id="jingyu",
        observed_at="2026-08-01T00:00:00+00:00",
    )
    stub = _CountingStub()
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    summary = ("[还悬着]\n用户想看魔法少女小圆的电影，还没定场次\n"
               "[现状]（无）\n[已聊透]（无）")
    sync_open_loops(store, "jingyu", summary)

    row = next(r for r in store.list_memories(active_only=False) if r["id"] == loop_id)
    assert row["content"] == "用户想看魔法少女小圆的电影，还没定场次"
    fresh = datetime.now(timezone.utc) - row_observed(row)
    assert fresh.total_seconds() < 60, "in-place update must refresh observed_at"


def row_observed(row):
    from datetime import datetime

    return datetime.fromisoformat(row["observed_at"])


# ── Fix C: cheap filters run before semantic suppression ──────────────────


def test_cooldown_candidate_is_skipped_before_embedding(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    from datetime import datetime, timezone

    cooled = store.upsert_memory(
        memory_type="open_loop", subject="user", predicate="pending_topic",
        content="冷却中的话题", character_id="monika",
        observed_at=datetime.now(timezone.utc).isoformat(),
    )
    store.mark_initiative_used("monika", cooled)  # 进入冷却
    selector = InitiativeMemorySelector(store, cooldown_seconds=3600)
    stub = _CountingStub()
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    picked = selector.select("monika", recent_texts=["冷却中的话题刚才聊过"])

    assert picked is None
    assert stub.calls == 1, (
        "only the recent-text batch is embedded — the cooldown-filtered "
        "candidate must not pay for per-candidate embeddings"
    )


from app.runtime.initiative_memory import InitiativeMemorySelector  # noqa: E402


# ── Fix F: prototype vector cache location ────────────────────────────────


def test_prototype_cache_lives_in_cache_dir_not_config(tmp_path, monkeypatch):
    config = tmp_path / "corpus.json"
    config.write_text(json.dumps({
        "prototypes": {"playful": ["哈哈笑死我了"]}
    }, ensure_ascii=False), encoding="utf-8")
    cache_dir = tmp_path / "cache"
    stub = _CountingStub()
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    clf = PrototypeClassifier(config, cache_dir=cache_dir)
    assert clf.classify("哈哈笑死我了") is not None

    assert (cache_dir / "corpus.vectors.json").exists()
    assert not (tmp_path / "corpus.vectors.json").exists(), (
        "cache must not pollute the config directory"
    )
