"""Weekly reflection — synthesize insights + relationship style from memory.

Generative-Agents-style reflection, localized for a single companion:
the LLM reads the durable fact base, recent shared experiences and the
rolling summary, then produces

  (a) 2-3 higher-level ``insight`` memories about the user — syntheses the
      raw facts do not state on their own, and
  (b) 0-2 ``relationship_style`` memories — how to interact with *this*
      user (the evolvable layer of the two-layer persona; the card stays
      immutable).

Guardrails:
- Proposal → verification: a second call drops insights the evidence does
  not support, before anything is stored.
- Near-duplicate insights are skipped via vector similarity against existing
  insight rows.
- At most _MAX_ACTIVE_STYLES style memories per character; the weakest is
  retired when the cap is exceeded (soft delete, user-visible in the UI).
- Cadence: at most once per REFLECTION_INTERVAL_DAYS per character (stamp
  file next to the compiled memory) and only with enough material.
- Everything runs on the daily batch — off the voice loop.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.memory.compiler import (
    _char_dir,
    get_conversation_summary,
)
from app.memory.store import memory_store

logger = logging.getLogger("memory.reflection")

REFLECTION_INTERVAL_DAYS = 7
_MIN_MATERIAL = 5
_MAX_ACTIVE_STYLES = 3
_INSIGHT_DUP_COSINE = 0.82  # raw cosine vs an existing insight (Qwen3-0.6B calibrated 2026-09-05:
# doc unrelated bulk max 0.878, rewording anchors 0.695-0.866)
_MAX_INSIGHTS = 3
_MAX_STYLES = 2


def _stamp_path(character_id: str) -> Path:
    return _char_dir(character_id) / ".last_reflection"


def _write_stamp(character_id: str) -> None:
    _stamp_path(character_id).write_text(
        datetime.now().date().isoformat(), encoding="utf-8"
    )


def _read_stamp(character_id: str) -> str:
    try:
        return _stamp_path(character_id).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def reflection_due(store: Any, character_id: str) -> bool:
    """Due when the weekly stamp is stale AND there is enough material."""
    if not character_id:
        return False
    stamp = _read_stamp(character_id)
    if stamp:
        try:
            last = datetime.fromisoformat(stamp).date()
            if datetime.now().date() - last < timedelta(days=REFLECTION_INTERVAL_DAYS):
                return False
        except ValueError:
            pass
    material = 0
    for memory_type in ("fact", "episode", "preference"):
        material += len(store.list_memories(
            character_id=character_id, memory_type=memory_type,
            active_only=True, limit=50,
        ))
    return material >= _MIN_MATERIAL


def _call_llm(system: str, user: str, llm_adapter: Any, timeout: int = 60) -> str:
    from app.utils.temporal import time_anchor

    # Thinking models spend the token budget on reasoning before the answer —
    # a small cap yields finish_reason=length with EMPTY content, so the
    # budget is generous and one empty response is retried once.
    for _ in range(2):
        raw = llm_adapter.generate_text(
            system=time_anchor() + "\n\n" + system,
            user=user,
            temperature=0.3,
            max_tokens=2000,
            timeout=timeout,
        )
        if raw and raw.strip():
            return raw
    return ""


def _material_text(store: Any, character_id: str, character_name: str) -> str:
    parts: list[str] = []
    facts = store.list_memories(
        character_id=character_id, memory_type="fact",
        active_only=True, limit=10,
    )
    episodes = store.list_memories(
        character_id=character_id, memory_type="episode",
        active_only=True, limit=5,
    )
    preferences = store.list_memories(
        character_id=character_id, memory_type="preference",
        active_only=True, limit=10,
    )
    if facts:
        parts.append("[已知事实]\n" + "\n".join(
            f"- {row['content']}" for row in facts
        ))
    if preferences:
        parts.append("[已知偏好]\n" + "\n".join(
            f"- {row['content']}" for row in preferences
        ))
    if episodes:
        parts.append("[共同经历]\n" + "\n".join(
            f"- {row['content']}" for row in episodes
        ))
    summary = get_conversation_summary(character_id)
    if summary:
        parts.append("[近期对话摘要]\n" + summary[:600])
    if character_name:
        parts.insert(0, f"角色名：{character_name}")
    return "\n\n".join(parts)


_REFLECT_SYSTEM = """你是角色自己的反思器。{name_clause}根据下方素材（已知事实、偏好、共同经历、近期摘要），产出两类结论：

1. "insights"：2-3 条关于用户的更高层洞察——不是复述素材，而是从素材归纳出的用户还不自知或没说透的模式（例如受挫时的真实需求、行为背后的动机）。必须能从素材中找到支撑。
2. "styles"：0-2 条与这个用户相处的风格观察——什么样的互动方式对他有效/无效（例如"他会接住撒娇，说教时他会走神"）。这是你自己的相处方式，不是对用户的评价。

纪律：
- 只从素材归纳，不虚构；宁缺毋滥。
- 洞察与素材中的事实不能是同一句话的改写。
- 每条 30 字以内。

输出严格 JSON，不要 markdown：{{"insights": [{{"text": "...", "importance": 0.7, "tags": ["tag"]}}], "styles": [{{"text": "..."}}]}}"""


_VERIFY_SYSTEM = """你是洞察复核器。对每条"洞察"独立判断：素材是否足以支撑它？洞察是否只是复述了某条素材？复述的、素材不足的、虚构的都判 false。
输出严格 JSON 数组，不要 markdown：[{{"index": 0, "supported": true}}, ...]"""


def _signature(text: str) -> str:
    return re.sub(r"[\W_]+", "", text.lower())[:48] or "reflection"


def reflect(
    llm_adapter: Any,
    store: Any,
    character_id: str,
    character_name: str = "",
) -> dict:
    """One reflection pass. Returns stats; never raises to the caller."""
    stats = {"insights_stored": 0, "styles_stored": 0, "duplicates": 0, "dropped": 0}
    material = _material_text(store, character_id, character_name)
    if len(material) < 60:
        return stats

    name_clause = f"你是{character_name}。" if character_name else "你是角色的内心。"
    try:
        raw = _call_llm(
            _REFLECT_SYSTEM.format(name_clause=name_clause),
            material,
            llm_adapter,
        )
    except Exception:
        logger.exception("Reflection call failed for %s", character_id)
        return stats
    parsed = _parse_json_object(raw)
    if not isinstance(parsed, dict):
        return stats
    insights = [
        item for item in (parsed.get("insights") or [])
        if isinstance(item, dict) and len(str(item.get("text", "")).strip()) >= 8
    ][:_MAX_INSIGHTS]
    styles = [
        str(item.get("text", "")).strip()
        for item in (parsed.get("styles") or [])
        if isinstance(item, dict) and len(str(item.get("text", "")).strip()) >= 8
    ][:_MAX_STYLES]
    if not insights and not styles:
        return stats

    # Verification pass: drop insights the material does not support.
    if insights:
        try:
            evidence = material[:1200]
            raw = _call_llm(
                _VERIFY_SYSTEM,
                "[素材]\n" + evidence + "\n\n[洞察]\n" + "\n".join(
                    f"{index}. {item['text']}" for index, item in enumerate(insights)
                ),
                llm_adapter,
            )
            verdicts = _parse_json_object(raw)
            supported = {
                int(item["index"])
                for item in (verdicts if isinstance(verdicts, list) else [])
                if isinstance(item, dict) and item.get("supported") is True
                and str(item.get("index", "")).lstrip("-").isdigit()
            }
            kept = [
                item for index, item in enumerate(insights)
                if index in supported
            ]
            stats["dropped"] = len(insights) - len(kept)
            insights = kept
        except Exception:
            logger.exception("Reflection verify failed for %s", character_id)
            # Fail open: keep proposals when the verifier itself is down.

    # Near-duplicate suppression against existing insights (vector check).
    from app.memory.embedder import get_embedder
    from app.memory.store import _decode_vector

    try:
        embedder = get_embedder()
    except Exception:
        embedder = None
    existing = store.list_memories(
        character_id=character_id, memory_type="insight",
        active_only=True, limit=50,
    )
    existing_vectors = {
        row["id"]: _decode_vector(row.get("embedding")) for row in existing
    }
    for item in insights:
        text = str(item["text"]).strip()
        is_duplicate = False
        if embedder is not None:
            vector = embedder.embed_document(text)
            if vector:
                for old_vec in existing_vectors.values():
                    if not old_vec:
                        continue
                    raw_cosine = sum(a * b for a, b in zip(vector, old_vec))
                    if raw_cosine >= _INSIGHT_DUP_COSINE:
                        is_duplicate = True
                        break
        if is_duplicate:
            stats["duplicates"] += 1
            continue
        store.upsert_memory(
            memory_type="insight", subject="user", predicate="insight",
            content=text, character_id=character_id,
            importance=max(0.6, min(0.9, float(item.get("importance", 0.7) or 0.7))),
            confidence=0.7,
            stable_key=f"insight:user:{_signature(text)}",
            tags=[str(t) for t in (item.get("tags") or [])][:5],
            observed_at=datetime.now(timezone.utc).isoformat(),
        )
        stats["insights_stored"] += 1

    for text in styles:
        store.upsert_memory(
            memory_type="relationship_style", subject="character",
            predicate="interaction_style",
            content=text, character_id=character_id,
            importance=0.7, confidence=0.7,
            stable_key=f"relationship_style:character:{_signature(text)}",
            observed_at=datetime.now(timezone.utc).isoformat(),
        )
        stats["styles_stored"] += 1
    _enforce_style_cap(store, character_id)

    _write_stamp(character_id)
    return stats


def _parse_json_object(raw: str) -> Any:
    if not raw:
        return None
    raw = raw.strip()
    if raw.startswith("```"):
        raw = "\n".join(
            line for line in raw.split("\n") if not line.strip().startswith("```")
        )
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except (json.JSONDecodeError, TypeError):
                return None
        return None


def _enforce_style_cap(store: Any, character_id: str) -> int:
    """Keep at most _MAX_ACTIVE_STYLES active style memories (weakest retires)."""
    styles = store.list_memories(
        character_id=character_id, memory_type="relationship_style",
        active_only=True, limit=20,
    )
    retired = 0
    for row in styles[_MAX_ACTIVE_STYLES:]:
        if store.forget_memory(row["id"], character_id=character_id):
            retired += 1
    return retired


def reflect_if_due(
    llm_adapter: Any,
    store: Any,
    character_id: str,
    character_name: str = "",
) -> dict | None:
    """Reflection gated by the weekly stamp + material threshold."""
    if not llm_adapter or not reflection_due(store, character_id):
        return None
    stats = reflect(llm_adapter, store, character_id, character_name)
    logger.info("Reflection for %s: %s", character_id, stats)
    return stats
