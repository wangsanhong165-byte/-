"""Normalize extracted candidates before durable storage."""

from __future__ import annotations

from typing import Any
import re


VALID_TYPES = {
    "fact", "preference", "recent_state", "episode",
    "relationship", "open_loop", "insight", "relationship_style",
}


def normalize_candidate(raw: dict[str, Any]) -> dict | None:
    content = str(raw.get("fact") or raw.get("content") or "").strip()
    confidence = float(raw.get("confidence", 0.7) or 0.7)
    if len(content) < 5 or confidence < 0.55:
        return None
    memory_type = str(raw.get("type", "fact"))
    if memory_type not in VALID_TYPES:
        memory_type = "fact"
    if memory_type == "fact":
        if any(word in content for word in ("喜欢", "讨厌", "不喜欢", "偏好")):
            memory_type = "preference"
        elif any(word in content for word in ("最近", "正在", "目前")):
            memory_type = "recent_state"
        elif any(word in content for word in ("提醒", "下次", "别忘")):
            memory_type = "open_loop"
    predicate = str(raw.get("predicate", memory_type))
    subject = str(raw.get("subject", "user"))
    stable_key = str(raw.get("stable_key", "")).strip()
    if not stable_key:
        preference_match = re.search(
            r"(?:喜欢|不喜欢|讨厌|偏好)([^，。！？,.!?]{1,30})", content
        )
        if memory_type == "preference" and preference_match:
            topic = re.sub(r"\s+", "", preference_match.group(1))
            stable_key = f"preference:{subject}:{topic}"
        elif predicate != memory_type or raw.get("subject"):
            stable_key = f"{memory_type}:{subject}:{predicate}"
        else:
            signature = re.sub(r"[\W_]+", "", content.lower())[:48]
            stable_key = f"{memory_type}:{subject}:{signature}"
    # Semantic time + retrieval keys. The extractor is instructed to rewrite
    # relative time into absolute dates inside `content`; `observed` is when
    # the fact was seen. Unparseable values are dropped by the store.
    observed = str(raw.get("observed") or raw.get("time") or "").strip() or None
    tags = [
        str(tag).strip() for tag in (raw.get("tags") or [])
        if str(tag).strip()
    ][:8]
    paraphrases = [
        str(text).strip() for text in (raw.get("paraphrases") or [])
        if str(text).strip()
    ][:6]
    return {
        "memory_type": memory_type,
        "subject": subject,
        "predicate": predicate,
        "content": content,
        "importance": float(raw.get("importance", 0.65) or 0.65),
        "confidence": confidence,
        "stable_key": stable_key,
        "observed_at": observed,
        "tags": tags,
        "paraphrases": paraphrases,
    }


def store_candidates(store, candidates: list[dict], character_id: str = "") -> list[int]:
    stored = []
    for raw in candidates:
        item = normalize_candidate(raw)
        if item is None:
            continue
        stored.append(store.upsert_memory(character_id=character_id, **item))
    return stored
