"""Memory extractor — rolling summary + fact extraction.

Background pipeline. Character-agnostic: accepts character_name parameter
so the same pipeline works for any persona.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

from app.memory.store import memory_store
from app.memory.prompts import (
    system_rolling_summary,
    system_fact_extraction,
)

logger = logging.getLogger("memory.extractor")

_TURNS_PER_SUMMARY = 10
_RECENT_PROMPT_MESSAGES = 10

# 小脑①：窗口内绝大多数回合彼此近重复（测试刷屏特征）时跳过事实提取。
# 摘要仍会生成——重要情感由摘要兜底（已确认取舍）。失败开放（嵌入不可用
# 或判断不了时照常提取）。
LOW_INFO_DUP_COSINE = 0.85
LOW_INFO_RATIO = 0.8
# 小脑②：新旧摘要余弦过线视为"改写但无新信息"，跳过事实提取+仲裁
# （摘要文件仍由 ticker 更新）。
SUMMARY_UNCHANGED_COSINE = 0.95
# 小脑④：open_loop 语义连续性——新悬置项与活跃 loop 的匹配线
# （Qwen3-0.6B 校准：doc 无关 p99=0.702，改写锚点 0.695-0.866）。
OPEN_LOOP_MATCH_COSINE = 0.72

# Deterministic open_loop extraction from the rolling summary's "[还悬着]" section.
_PENDING_SECTION = "[还悬着]"
_NEXT_SECTION_MARKERS = ("[现状]", "[已聊透]")
_OPEN_LOOP_PREDICATE = "pending_topic"
_EMPTY_PENDING_MARKERS = ("（无）", "(无)", "无", "none")


def _parse_pending_section(summary: str) -> list[str]:
    """Parse pending-topic items out of the summary's [还悬着] section.

    No LLM: the summarizer is already instructed to write 1-3 short pending
    lines under that header, so this just splits them deterministically.
    Returns at most 3 normalized items.
    """
    if not summary:
        return []
    start = summary.find(_PENDING_SECTION)
    if start == -1:
        return []
    body = summary[start + len(_PENDING_SECTION):]
    for marker in _NEXT_SECTION_MARKERS:
        idx = body.find(marker)
        if idx != -1:
            body = body[:idx]
            break
    body = body.strip()
    if not body or body.strip().strip("：:") in _EMPTY_PENDING_MARKERS:
        return []
    items: list[str] = []
    for chunk in re.split(r"[\n；;。！!？?]+", body):
        chunk = chunk.strip().lstrip("-*·• ")
        if chunk and len(chunk) >= 4:
            items.append(chunk)
    return items[:3]


def _pending_topic_key(content: str) -> str:
    """Stable dedup key for a pending topic (word-normalized content)."""
    normalized = re.sub(r"[\W_]+", "", content.lower())
    return normalized[:40] or "topic"


def _turn_label(t: dict, character_name: str) -> str:
    """One conversation line for LLM input, with a local-date prefix.

    The prefix is what lets the summarizer resolve "昨晚/凌晨" into absolute
    dates — the rolling summary otherwise has no access to a clock.
    """
    role = t.get("role", "")
    content = str(t.get("content", "")).strip()
    label = "用户" if role == "user" else (character_name or "AI")
    stamp = ""
    try:
        stamp = datetime.fromisoformat(
            str(t.get("created_at", ""))
        ).astimezone().strftime("%m月%d日 %H:%M")
    except (ValueError, TypeError):
        stamp = ""
    prefix = f"（{stamp}）" if stamp else ""
    return f"{label}{prefix}: {content}"


def is_low_information_turns(turns: list[dict]) -> bool:
    """小脑①：窗口内绝大多数回合彼此近重复时判为低信息（测试刷屏特征）。

    失败开放：嵌入通道不可用或判断不了时返回 False（照常提取）。
    """
    texts = [str(t.get("content", "")).strip() for t in turns]
    texts = [t for t in texts if len(t) >= 2]
    if len(texts) < 3:
        return False
    try:
        from app.memory.embedder import get_embedder

        embedder = get_embedder()
        if embedder is None:
            return False
        vecs = [v for v in (embedder.embed_document(t) for t in texts) if v]
    except Exception:
        return False
    if len(vecs) < 3:
        return False
    near_dup = 0
    for i, a in enumerate(vecs):
        for j, b in enumerate(vecs):
            if i != j and sum(x * y for x, y in zip(a, b)) >= LOW_INFO_DUP_COSINE:
                near_dup += 1
                break
    return near_dup / len(vecs) >= LOW_INFO_RATIO


def _summary_semantically_unchanged(previous_content: str, summary: str) -> bool:
    """小脑②：新旧摘要语义过近（LLM 改写了措辞但无新信息）→ 跳过提取。"""
    previous_content = previous_content.strip()
    if not previous_content or len(previous_content) < 10:
        return False
    try:
        from app.memory.embedder import get_embedder

        embedder = get_embedder()
        if embedder is None:
            return False
        old_vec = embedder.embed_document(previous_content)
        new_vec = embedder.embed_document(summary)
    except Exception:
        return False
    if not old_vec or not new_vec:
        return False
    return sum(x * y for x, y in zip(old_vec, new_vec)) >= SUMMARY_UNCHANGED_COSINE


def sync_open_loops(store: Any, character_id: str, summary: str) -> dict:
    """Persist pending threads as open_loop memories; close ones that resolved.

    小脑④语义连续性：新悬置项先与活跃 loop 做语义匹配——语义相同（摘要每
    10 轮重写导致的换措辞）→ 沿用原 loop 的 ID 原地更新内容（保主动冷却连
    续性，不再每 10 轮 close+open 翻新灌水）；语义无匹配才新建；无匹配的活
    跃 loop 才关闭。嵌入通道不可用时回退到旧的精确匹配行为。
    """
    stats = {"open_loops_open": 0, "open_loops_closed": 0}
    if not character_id:
        return stats
    pending = _parse_pending_section(summary)
    current = store.list_memories(
        character_id=character_id, memory_type="open_loop",
        active_only=True, limit=100,
    )

    matched_ids: set[int] = set()
    if pending:
        embedder = None
        try:
            from app.memory.embedder import get_embedder

            embedder = get_embedder()
        except Exception:
            embedder = None
        if embedder is not None:
            item_vectors = {}
            for item in pending:
                vec = embedder.embed_document(item)
                if vec:
                    item_vectors[item] = vec
            loop_vectors = {}
            for mem in current:
                vec = embedder.embed_document(str(mem.get("content", "")))
                if vec:
                    loop_vectors[mem["id"]] = (mem, vec)
            for item, item_vec in item_vectors.items():
                best_id, best_cos = None, OPEN_LOOP_MATCH_COSINE
                for mem_id, (mem, loop_vec) in loop_vectors.items():
                    if mem_id in matched_ids:
                        continue
                    score = sum(x * y for x, y in zip(item_vec, loop_vec))
                    if score >= best_cos:
                        best_id, best_cos = mem_id, score
                if best_id is not None:
                    matched_ids.add(best_id)
                    best_mem = loop_vectors[best_id][0]
                    if str(best_mem.get("content", "")).strip() != item:
                        # 原地更新保 ID（主动冷却连续性）；observed_at 同步刷新，
                        # 否则刚确认仍悬着的话题会因观测时间过期绕过主动去重。
                        store.update_memory(
                            best_id, character_id=character_id, content=item,
                            observed_at=datetime.now(timezone.utc).isoformat(),
                        )
                        logger.info(
                            "Open loop #%s updated in place (semantic continuity)",
                            best_id,
                        )
                    stats["open_loops_open"] += 1
                else:
                    store.upsert_memory(
                        memory_type="open_loop",
                        subject="user",
                        predicate=_OPEN_LOOP_PREDICATE,
                        content=item,
                        character_id=character_id,
                        importance=0.7,
                        confidence=0.8,
                        stable_key=f"open_loop:user:{_pending_topic_key(item)}",
                    )
                    stats["open_loops_open"] += 1
            # 无语义匹配的活跃 loop → 关闭
            pending_texts = set(item_vectors)
            for mem in current:
                content = str(mem.get("content", "")).strip()
                if mem["id"] not in matched_ids and content and content not in pending_texts:
                    store.forget_memory(mem["id"], character_id=character_id)
                    stats["open_loops_closed"] += 1
            return stats

    # ── legacy exact-match fallback（嵌入通道不可用时保持旧行为）────────
    for item in pending:
        store.upsert_memory(
            memory_type="open_loop",
            subject="user",
            predicate=_OPEN_LOOP_PREDICATE,
            content=item,
            character_id=character_id,
            importance=0.7,
            confidence=0.8,
            stable_key=f"open_loop:user:{_pending_topic_key(item)}",
        )
        stats["open_loops_open"] += 1
    # Close loops that are no longer pending in the current summary.
    pending_texts = {item for item in pending}
    for mem in current:
        content = str(mem.get("content", "")).strip()
        if content and content not in pending_texts:
            store.forget_memory(mem["id"], character_id=character_id)
            stats["open_loops_closed"] += 1
    return stats


def _call_llm(system: str, user: str, llm_adapter: Any, timeout: int = 15) -> str:
    if not llm_adapter:
        return ""
    from app.utils.temporal import time_anchor

    return llm_adapter.generate_text(
        system=time_anchor() + "\n\n" + system,
        user=user,
        temperature=0.3,
        max_tokens=1024,
        timeout=timeout,
    )


def run_rolling_summary(
    llm_adapter: Any,
    character_name: str = "",
    character_id: str = "",
    store: Any = None,
    return_record: bool = False,
) -> str | tuple[str, int]:
    """Summarize recent conversation turns into 2-3 sentences (per character)."""
    store = store or memory_store
    from app.memory.compiler import get_conversation_summary_record

    existing = get_conversation_summary_record(character_id)
    turns = store.summary_window(
        character_id,
        after_log_id=int(existing.get("through_log_id", 0)),
        keep_recent=_RECENT_PROMPT_MESSAGES,
        limit=_TURNS_PER_SUMMARY * 4,
    )
    if not turns and not existing.get("content"):
        turns = store.recent_turns(
            _TURNS_PER_SUMMARY * 2, character_id=character_id
        )
    if not turns or len(turns) < 3:
        preserved = str(existing.get("content", ""))
        record = (preserved, int(existing.get("through_log_id", 0)))
        return record if return_record else preserved

    lines = []
    if existing.get("content"):
        lines.append("[Previous rolling summary]\n" + str(existing["content"]))
    for t in turns:
        content = str(t.get("content", "")).strip()
        if not content:
            continue
        lines.append(_turn_label(t, character_name))

    conv_text = "\n".join(lines)
    if len(conv_text) < 20:
        empty = ("", int(existing.get("through_log_id", 0)))
        return empty if return_record else ""

    result = _call_llm(system_rolling_summary(character_name), conv_text, llm_adapter)
    if not result:
        preserved = str(existing.get("content", ""))
        record = (preserved, int(existing.get("through_log_id", 0)))
        return record if return_record else preserved
    through_log_id = int(turns[-1].get("id", existing.get("through_log_id", 0)) or 0)
    return (result, through_log_id) if return_record else result


def extract_facts(
    summary: str,
    llm_adapter: Any,
    character_id: str = "",
    store: Any = None,
    *,
    return_rows: bool = False,
) -> list[dict] | tuple[list[str], list[dict]]:
    """Split a summary into atomic facts with tags.

    With return_rows=True the second element carries the full stored rows
    (id + normalized fields) for the downstream conflict arbitrator.
    """
    store = store or memory_store
    if not summary or len(summary) < 10:
        return ([], []) if return_rows else []

    result = _call_llm(system_fact_extraction(), summary, llm_adapter, timeout=20)
    if not result:
        return []

    result = result.strip()
    if result.startswith("```"):
        lines = result.split("\n")
        result = "\n".join(l for l in lines if not l.strip().startswith("```"))

    try:
        facts = json.loads(result)
    except json.JSONDecodeError:
        import re
        match = re.search(r"\[.*?\]", result, re.DOTALL)
        if match:
            try:
                facts = json.loads(match.group(0))
            except (json.JSONDecodeError, TypeError):
                return ([], []) if return_rows else []
        else:
            return ([], []) if return_rows else []

    if not isinstance(facts, list):
        return ([], []) if return_rows else []

    structured_candidates = []
    for f in facts:
        if not isinstance(f, dict):
            continue
        content = str(f.get("fact", "")).strip()
        if not content or len(content) < 5:
            continue
        structured_candidates.append(f)

    # ``memories`` is the canonical store.  The legacy facts table is migrated
    # at startup but no longer receives a second copy of every extraction.
    from app.memory.lifecycle import normalize_candidate
    stored_contents: list[str] = []
    stored_rows: list[dict] = []
    for candidate in structured_candidates:
        item = normalize_candidate(candidate)
        if item is None:
            continue
        memory_id = store.upsert_memory(character_id=character_id, **item)
        stored_contents.append(item["content"])
        stored_rows.append({"id": memory_id, **item})
    if return_rows:
        return stored_contents, stored_rows
    return stored_contents


# Bound on turns fed to one extract-before-destroy pass (bulk deletes must not
# produce an oversized prompt).
_MAX_EXTRACT_TURNS = 20


def extract_from_turns(
    turns: list[dict],
    llm_adapter: Any,
    character_id: str = "",
    character_name: str = "",
    store: Any = None,
) -> dict:
    """Extract durable facts from an arbitrary turn list (extract-before-destroy).

    Used by forget() before old logs are deleted: capture what those turns
    revealed about the user before the rows disappear. Keeps only the most
    recent turns, so a bulk delete never builds an oversized prompt.
    """
    store = store or memory_store
    recent = list(turns)[-_MAX_EXTRACT_TURNS:]
    lines = []
    for t in recent:
        content = str(t.get("content", "")).strip()
        if content:
            lines.append(_turn_label(t, character_name or "对话"))
    conv_text = "\n".join(lines)
    if len(conv_text) < 10:
        return {"facts_stored": 0}
    stored = extract_facts(conv_text, llm_adapter, character_id=character_id, store=store)
    return {"facts_stored": len(stored)}


def run_extraction_pipeline(
    llm_adapter: Any,
    character_name: str = "",
    character_id: str = "",
    store: Any = None,
) -> dict:
    """Run one full extraction cycle: summary → facts (per character)."""
    store = store or memory_store
    stats = {"summary": "", "facts_stored": 0}

    from app.memory.compiler import get_conversation_summary_record
    previous = get_conversation_summary_record(character_id)
    summary, through_log_id = run_rolling_summary(
        llm_adapter,
        character_name,
        character_id=character_id,
        store=store,
        return_record=True,
    )
    if not summary:
        return stats

    # B1: the full summary is persisted as the rolling conversation summary;
    # no longer truncated to 100 chars (that was only a boolean gate before).
    stats["summary"] = summary
    stats["through_log_id"] = through_log_id
    if (
        previous.get("content") == summary
        and int(previous.get("through_log_id", 0)) == int(through_log_id)
    ):
        stats["summary_unchanged"] = True
        return stats

    # 小脑②：LLM 改写了摘要但语义无新信息 → 跳过事实提取+仲裁（新摘要文本
    # 仍由 ticker 持久化）。
    if _summary_semantically_unchanged(str(previous.get("content", "")), summary):
        stats["semantic_unchanged"] = True
        return stats

    # 小脑①：窗口内回合彼此近重复（测试刷屏）→ 跳过事实提取（摘要兜底）。
    try:
        window_turns = store.summary_window(
            character_id,
            after_log_id=int(previous.get("through_log_id", 0)),
            keep_recent=_RECENT_PROMPT_MESSAGES,
            limit=200,
        )
    except Exception:
        window_turns = []
    if is_low_information_turns(window_turns):
        stats["low_information_skipped"] = True
        return stats

    facts, stored_rows = extract_facts(
        summary, llm_adapter, character_id=character_id, store=store,
        return_rows=True,
    )
    stats["facts_stored"] = len(facts)
    stats["open_loops"] = sync_open_loops(store, character_id, summary)

    # Phase 2 conflict arbitration: the LLM judges semantic conflicts that
    # survive under different stable keys; deterministic supersession in the
    # store already owns identical keys. Offline path only.
    try:
        from app.memory.arbitrator import arbitrate_new_facts

        stats["arbitration"] = arbitrate_new_facts(
            llm_adapter, store, character_id, stored_rows
        )
    except Exception:
        stats["arbitration"] = {"error": "arbitration failed"}
        logger.exception("Conflict arbitration failed for %s", character_id)

    return stats
