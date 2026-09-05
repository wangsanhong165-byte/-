"""Two-stage conflict arbitration for newly extracted memories.

Stage 1 (propose): each new fact is paired against semantically related
existing memories — same predicate, or strong vector overlap under a
different predicate — and the LLM proposes which old rows the new fact makes
obsolete (contradicted, updated, or superseded).
Stage 2 (verify): every proposal is re-checked in a separate call; a
retirement only applies when the verifier confirms it. All retirement is soft
(forget_memory), so a wrong verdict is reversible by later re-confirmation.

Scope notes:
- Runs on the offline extraction cadence, never on the voice loop.
- The deterministic same-predicate supersession in store.upsert_memory stays:
  the arbitrator only handles semantic conflicts that survive under
  *different* stable keys/predicates (the LLM rewords predicates freely).
- Low-confidence new facts (< 0.7) are never eligible to retire anything.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger("memory.arbitrator")

_ARBITRATION_MAX_CANDIDATES = 3
_MIN_CONFIDENCE_TO_SUPERSEDE = 0.7
_MIN_VECTOR_EVIDENCE = 0.35  # renormalized cosine (raw ~0.61 under the Qwen3-0.6B mapping)
_ARBITRABLE_TYPES = ("fact", "preference", "recent_state", "episode")


def _parse_json(text: str, fallback: Any) -> Any:
    if not text:
        return fallback
    text = text.strip()
    if text.startswith("```"):
        text = "\n".join(
            line for line in text.split("\n") if not line.strip().startswith("```")
        )
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\[.*\]|\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except (json.JSONDecodeError, TypeError):
                return fallback
        return fallback


def _call_llm(system: str, user: str, llm_adapter: Any, timeout: int = 60) -> str:
    from app.utils.temporal import time_anchor

    # Thinking models need headroom (see reflection._call_llm); empty
    # responses (finish_reason=length) are retried once.
    for _ in range(2):
        raw = llm_adapter.generate_text(
            system=time_anchor() + "\n\n" + system,
            user=user,
            temperature=0.2,
            max_tokens=1600,
            timeout=timeout,
        )
        if raw and raw.strip():
            return raw
    return ""


def _candidate_pairs(
    store: Any, character_id: str, new_rows: list[dict]
) -> list[tuple[dict, list[dict]]]:
    """Pair each eligible new row with its related active memories."""
    from app.memory.embedder import get_embedder
    from app.memory.store import _decode_vector, _renormalized_cosine

    try:
        embedder = get_embedder()
    except Exception:
        embedder = None
    old_rows = store.list_memories(
        character_id=character_id, active_only=True, limit=250
    )
    old_vectors = {
        row["id"]: _decode_vector(row.get("embedding"))
        for row in old_rows
    }
    new_vectors: dict[int, list[float]] = {}
    if embedder is not None:
        for row in new_rows:
            try:
                vector = embedder.embed_document(row["content"])
            except Exception:
                vector = None
            if vector:
                new_vectors[row["id"]] = vector

    pairs: list[tuple[dict, list[dict]]] = []
    for row in new_rows:
        if float(row.get("confidence", 0) or 0) < _MIN_CONFIDENCE_TO_SUPERSEDE:
            continue
        new_vec = new_vectors.get(row["id"])
        candidates: dict[int, dict] = {}
        for old in old_rows:
            if old["id"] == row["id"]:
                continue
            if old["stable_key"] == row["stable_key"]:
                continue  # deterministic supersession owns identical keys
            if old["memory_type"] not in _ARBITRABLE_TYPES:
                continue
            if old["predicate"] and old["predicate"] == row["predicate"]:
                candidates[old["id"]] = old
                continue
            if new_vec is not None:
                score = _renormalized_cosine(new_vec, old_vectors.get(old["id"]))
                if score is not None and score >= _MIN_VECTOR_EVIDENCE:
                    candidates[old["id"]] = old
        if not candidates:
            continue
        ordered = sorted(
            candidates.values(),
            key=lambda m: -float(m.get("importance", 0.5) or 0.5),
        )
        pairs.append((row, ordered[:_ARBITRATION_MAX_CANDIDATES]))
    return pairs


_PROPOSE_SYSTEM = """你是记忆冲突裁决器。给出若干"新记忆"，以及每条新记忆相关的"旧记忆"。逐条判断新记忆是否使某条旧记忆过时：内容矛盾、信息被更新、状态被取代。
判定纪律：
- 只有明确的矛盾/取代才裁决；互补信息、同一事实的不同措辞、一次性情绪状态 vs 长期习惯，都不算冲突。
- 拿不准就不裁决。
输出严格的 JSON 数组，不要 markdown：[{"new": <新记忆编号>, "supersede": [<旧记忆编号>], "reason": "一句话"}]；没有任何冲突就输出 []"""


def _format_pairs(pairs: list[tuple[dict, list[dict]]]) -> str:
    blocks = []
    for new_row, olds in pairs:
        lines = [f"新记忆 #{new_row['id']} [{new_row['memory_type']}] {new_row['content']}"]
        for old in olds:
            lines.append(
                f"  旧记忆 #{old['id']} [{old['memory_type']}] {old['content']}"
                f"（记录于 {str(old.get('observed_at') or old.get('created_at', ''))[:10]}）"
            )
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


_VERIFY_SYSTEM = """你是记忆裁决复核器。对每一组"新事实是否使旧记忆过时"独立复核。只确认明确的取代或矛盾；措辞不同、互补、时间状态与长期习惯并存都不算过时。
输出严格的 JSON 数组，不要 markdown：[{"supersede": <旧记忆编号>, "obsolete": true/false}]"""


def arbitrate_new_facts(
    llm_adapter: Any,
    store: Any,
    character_id: str,
    new_rows: list[dict],
) -> dict:
    """Propose → verify → softly retire obsolete memories. Returns stats."""
    stats = {"pairs": 0, "proposed": 0, "confirmed": 0, "rejected": 0}
    if not llm_adapter or not character_id or not new_rows:
        return stats
    pairs = _candidate_pairs(store, character_id, new_rows)
    stats["pairs"] = len(pairs)
    if not pairs:
        return stats

    try:
        raw = _call_llm(_PROPOSE_SYSTEM, _format_pairs(pairs), llm_adapter)
    except Exception:
        logger.exception("Arbitration propose call failed for %s", character_id)
        return stats
    proposals = _parse_json(raw, [])
    if not isinstance(proposals, list):
        return stats

    pending: list[dict] = []
    for proposal in proposals:
        if not isinstance(proposal, dict):
            continue
        targets = proposal.get("supersede") or []
        if not isinstance(targets, list):
            continue
        for target in targets:
            try:
                old_id = int(target)
            except (TypeError, ValueError):
                continue
            old_row = next(
                (old for _, olds in pairs for old in olds if old["id"] == old_id),
                None,
            )
            if old_row is None:
                continue  # never retire a row that was not a candidate
            new_id = proposal.get("new")
            new_row = next(
                (row for row, _ in pairs if row["id"] == new_id), None
            )
            if new_row is None:
                continue
            pending.append({
                "old_id": old_id,
                "new_id": new_id,
                "old_content": old_row["content"],
                "new_content": new_row["content"],
            })
    stats["proposed"] = len(pending)
    if not pending:
        return stats

    verify_lines = [
        f"新事实：{item['new_content']}\n旧记忆 #{item['old_id']}：{item['old_content']}"
        for item in pending
    ]
    try:
        raw = _call_llm(_VERIFY_SYSTEM, "\n\n".join(verify_lines), llm_adapter)
    except Exception:
        logger.exception("Arbitration verify call failed for %s", character_id)
        return stats
    verdicts = _parse_json(raw, [])
    confirmed = {
        int(item["supersede"])
        for item in (verdicts if isinstance(verdicts, list) else [])
        if isinstance(item, dict)
        and item.get("obsolete") is True
        and str(item.get("supersede", "")).lstrip("-").isdigit()
    }
    for item in pending:
        if item["old_id"] in confirmed:
            if store.forget_memory(item["old_id"], character_id=character_id):
                stats["confirmed"] += 1
                logger.info(
                    "Arbitration retired memory #%s for %s", item["old_id"], character_id
                )
            else:
                stats["rejected"] += 1
        else:
            stats["rejected"] += 1
    return stats
