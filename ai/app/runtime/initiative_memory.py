"""Select high-value memory topics for proactive conversation."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

# A candidate topic whose content sits this close to a recent conversation
# turn is considered "just discussed" and suppressed (Qwen3-0.6B calibrated:
# unrelated bulk p95 ≈ 0.572, just-discussed pairs land 0.6+).
RECENT_DISCUSSION_COSINE = 0.60
# Topics last observed longer ago than this window are allowed back even when
# semantically similar to recent turns — old threads may be revisited.
RECENT_DISCUSSION_WINDOW_DAYS = 14


class InitiativeMemorySelector:
    def __init__(self, store: Any, cooldown_seconds: float = 21600):
        self.store = store
        self.cooldown_seconds = cooldown_seconds

    def _is_expired(self, memory: dict) -> bool:
        """Belt-and-braces validity check on top of active_only filtering."""
        raw = str(memory.get("expires_at") or "").strip()
        if not raw:
            return False
        try:
            expiry = datetime.fromisoformat(raw)
        except (ValueError, TypeError):
            return False
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        return expiry <= datetime.now(timezone.utc)

    def _recently_discussed(
        self,
        topic: str,
        observed_at: str,
        recent_vectors: list[tuple[list[float], Any]],
    ) -> bool:
        """True when the topic is semantically near a recent turn.

        Only applies to topics observed inside the freshness window — older
        threads are allowed back. Embedding failures degrade to no suppression.
        """
        observed = str(observed_at or "").strip()
        if not observed:
            return False
        try:
            seen = datetime.fromisoformat(observed)
        except (ValueError, TypeError):
            return False
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - seen > timedelta(
            days=RECENT_DISCUSSION_WINDOW_DAYS
        ):
            return False
        try:
            from app.memory.embedder import get_embedder

            embedder = get_embedder()
            if embedder is None:
                return False
            topic_vec = embedder.embed_document(topic)
            if not topic_vec:
                return False
        except Exception:
            return False
        for vec, _ in recent_vectors:
            dot = sum(a * b for a, b in zip(topic_vec, vec))
            if dot >= RECENT_DISCUSSION_COSINE:
                return True
        return False

    def select(
        self, character_id: str, recent_texts: list[str] | None = None
    ) -> dict | None:
        now = time.time()
        priority = (
            ("open_loop", "unfinished_topic"),
            ("recent_state", "recent_user_state"),
            ("episode", "shared_experience"),
            ("preference", "known_preference"),
        )
        # Semantic freshness needs vectors of the recent turns; built once per
        # call, reused across all candidate topics.
        recent_vectors: list[tuple[list[float], Any]] = []
        if recent_texts:
            try:
                from app.memory.embedder import get_embedder

                embedder = get_embedder()
                if embedder is not None:
                    for text in recent_texts[:8]:
                        vec = embedder.embed_document(text)
                        if vec:
                            recent_vectors.append((vec, text))
            except Exception:
                recent_vectors = []

        for memory_type, reason in priority:
            memories = self.store.list_memories(
                character_id=character_id, memory_type=memory_type,
                active_only=True, limit=10,
            )
            for memory in memories:
                if self._is_expired(memory):
                    continue
                # 廉价过滤先行（冷却/置信度），语义抑制（每候选一次嵌入）
                # 只对幸存者执行——把每轮检查的嵌入次数压到最少。
                if now - self.store.initiative_last_used(
                    character_id, memory.get("id")
                ) < self.cooldown_seconds:
                    continue
                if float(memory.get("confidence", 0)) < 0.65:
                    continue
                if recent_vectors and self._recently_discussed(
                    str(memory.get("content", "")),
                    str(memory.get("observed_at", "")),
                    recent_vectors,
                ):
                    continue
                return {
                    "topic": memory.get("content", ""),
                    "reason": reason,
                    "memory_id": memory.get("id"),
                    "importance": memory.get("importance", 0.5),
                    "observed_at": memory.get("observed_at", ""),
                }
        return None
