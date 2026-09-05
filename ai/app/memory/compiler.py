"""Memory compiler — four-section compilation pipeline.

Sections (same as openhanako v3):
  - today:    current day summary (3-5 coarse events, ≤300 chars)
  - week:     past 7-day sliding window (broad themes)
  - longterm: folded long-term context (≤600 tokens)
  - facts:    stable user profile (≤300 tokens)

Assembles into memory.md (≤2000 tokens) for PromptBuilder to read.

Plan B design:
- Facts (shared): stored in global SQLite, character-independent
- Compiled memory (per-character): stored in memory/compiled/{char_id}/
- On character switch: regenerate compiled memory from shared facts
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any, Optional

from app.memory.store import memory_store
from app.memory.prompts import (
    system_compile_today,
    system_compile_week,
    system_compile_longterm,
    system_compile_facts,
)

_BASE_DIR: Optional[Path] = None
_llm_adapter_global: Any = None
_current_char_id: str = ""
logger = logging.getLogger("memory.compiler")


def _get_base() -> Path:
    global _BASE_DIR
    if _BASE_DIR is None:
        _BASE_DIR = Path(__file__).resolve().parents[2]
    return _BASE_DIR


def _char_dir(char_id: str) -> Path:
    """Per-character compiled directory."""
    d = _get_base() / "data" / "memory" / "compiled" / (char_id or "default")
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_compiled_memory(char_id: str = "") -> str:
    """Read assembled memory.md for given character. Falls back to current."""
    cid = char_id or _current_char_id or "default"
    path = _char_dir(cid) / "memory.md"
    if path.exists():
        return path.read_text("utf-8").strip()
    return ""


def write_conversation_summary(
    char_id: str, summary: str, *, through_log_id: int = 0
) -> None:
    """Atomically persist a rolling conversation summary per character.

    temp + os.replace so the voice-loop reader (retrieve) never observes a
    partially-written file.
    """
    path = _char_dir(char_id) / "conversation_summary.md"
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(summary, "utf-8")
    os.replace(tmp, path)
    metadata_path = _char_dir(char_id) / "conversation_summary.json"
    metadata_tmp = metadata_path.with_name(metadata_path.name + ".tmp")
    metadata_tmp.write_text(
        json.dumps({"through_log_id": int(through_log_id)}, ensure_ascii=False),
        "utf-8",
    )
    os.replace(metadata_tmp, metadata_path)


def get_conversation_summary(char_id: str = "") -> str:
    """Read the rolling conversation summary for a character."""
    cid = char_id or _current_char_id or "default"
    path = _char_dir(cid) / "conversation_summary.md"
    if path.exists():
        return path.read_text("utf-8").strip()
    return ""


def get_conversation_summary_record(char_id: str = "") -> dict[str, Any]:
    cid = char_id or _current_char_id or "default"
    content = get_conversation_summary(cid)
    through_log_id = 0
    try:
        metadata = json.loads(
            (_char_dir(cid) / "conversation_summary.json").read_text("utf-8")
        )
        through_log_id = int(metadata.get("through_log_id", 0))
    except (FileNotFoundError, json.JSONDecodeError, TypeError, ValueError, OSError):
        pass
    return {"content": content, "through_log_id": through_log_id}


def clear_conversation_summary(char_id: str = "") -> None:
    """Remove a stale rolling summary so it is no longer injected."""
    cid = char_id or _current_char_id or "default"
    path = _char_dir(cid) / "conversation_summary.md"
    path.unlink(missing_ok=True)
    (_char_dir(cid) / "conversation_summary.json").unlink(missing_ok=True)


# ── helpers ──────────────────────────────────────────────────────────

def _fingerprint(content: str) -> str:
    return hashlib.md5(content.encode()).hexdigest()


def _check_cache(char_id: str, name: str, data: str) -> bool:
    dirpath = _char_dir(char_id)
    fp_path = dirpath / f"{name}.fp"
    md_path = dirpath / f"{name}.md"
    fp = _fingerprint(data)
    if fp_path.exists() and md_path.exists():
        try:
            return fp_path.read_text("utf-8").strip() == fp
        except OSError:
            return False
    return False


def _write_cache(char_id: str, name: str, data: str, content: str):
    dirpath = _char_dir(char_id)
    fp = _fingerprint(data)
    (dirpath / f"{name}.fp").write_text(fp, "utf-8")
    (dirpath / f"{name}.md").write_text(content, "utf-8")


def _read_section(char_id: str, name: str) -> str:
    path = _char_dir(char_id) / f"{name}.md"
    if path.exists():
        return path.read_text("utf-8").strip()
    return ""


def get_prompt_compiled_memory(char_id: str = "") -> str:
    """Return durable context only, excluding recent today/week material.

    Recent exact turns are supplied by Conversation and the middle window by
    conversation_summary, so prompt injection only needs facts + long-term
    state here.
    """
    cid = char_id or _current_char_id or "default"
    parts = []
    facts = _read_section(cid, "facts")
    longterm = _read_section(cid, "longterm")
    if facts:
        parts.append("## Important facts\n\n" + facts)
    if longterm:
        parts.append("## Long-term context\n\n" + longterm)
    if parts:
        return "\n\n".join(parts)
    # Compatibility for compiler output created before per-section files.
    return get_compiled_memory(cid)


def _clear_section(char_id: str, name: str) -> None:
    directory = _char_dir(char_id)
    for suffix in (".md", ".fp"):
        (directory / f"{name}{suffix}").unlink(missing_ok=True)


def delete_character_compiled_data(char_id: str) -> bool:
    """Delete only the selected character's generated memory files."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", str(char_id or "")):
        raise ValueError("invalid character id")
    path = _get_base() / "data" / "memory" / "compiled" / char_id
    if not path.exists():
        return False
    shutil.rmtree(path)
    return True


def _char_name_from_id(char_id: str) -> str:
    """Read character display name from its character.json."""
    try:
        path = _get_base() / "config" / "characters" / char_id / "character.json"
        if path.exists():
            import json
            card = json.loads(path.read_text("utf-8"))
            name = card.get("name", {})
            return name.get("zh", name.get("ja", char_id))
    except Exception:
        pass
    return char_id


def _call_llm(system: str, user: str, timeout: int = 15) -> str:
    global _llm_adapter_global
    if not _llm_adapter_global:
        return ""
    from app.utils.temporal import time_anchor

    return _llm_adapter_global.generate_text(
        system=time_anchor() + "\n\n" + system,
        user=user,
        temperature=0.3,
        max_tokens=1024,
        timeout=timeout,
    )


def set_llm_adapter(adapter: Any):
    global _llm_adapter_global
    _llm_adapter_global = adapter


def get_active_char_id() -> str:
    return _current_char_id or "default"


def set_active_char(char_id: str):
    """Set active character. Does NOT trigger compilation (caller decides)."""
    global _current_char_id
    _current_char_id = char_id


# ── compilation functions ────────────────────────────────────────────

def today_digest(char_id: str = "") -> str:
    """Compile today's log into a brief summary for given character."""
    cid = char_id or _current_char_id or "default"
    char_name = _char_name_from_id(cid)

    import datetime as _dt
    turns = memory_store.recent_turns(50, character_id=cid)
    if not turns:
        _clear_section(cid, "today")
        return ""

    # created_at is stored in UTC; compare against the LOCAL day boundary so a
    # UTC+8 user's morning turns still count as "today".
    local_midnight_ts = _dt.datetime.now().replace(
        hour=0, minute=0, second=0, microsecond=0
    ).timestamp()
    today_turns = []
    for t in turns:
        try:
            ts = _dt.datetime.fromisoformat(str(t.get("created_at", ""))).timestamp()
        except (ValueError, TypeError):
            ts = 0.0
        if ts >= local_midnight_ts:
            today_turns.append(t)
    if not today_turns:
        _clear_section(cid, "today")
        return ""

    lines = []
    for t in today_turns:
        role = t.get("role", "")
        content = str(t.get("content", "")).strip()
        if content:
            label = "用户" if role == "user" else (char_name or "AI")
            lines.append(f"{label}: {content}")
    text = "\n".join(lines)

    if _check_cache(cid, "today", text):
        return _read_section(cid, "today")

    result = _call_llm(system_compile_today(char_name), text)
    if result:
        _write_cache(cid, "today", text, result)
    return result or ""


def week_digest(char_id: str = "") -> str:
    """Compile past week's context for given character."""
    cid = char_id or _current_char_id or "default"
    char_name = _char_name_from_id(cid)
    existing_week = _read_section(cid, "week")

    turns = memory_store.recent_turns(200, character_id=cid)
    if not turns:
        _clear_section(cid, "week")
        return ""

    parts = []
    if existing_week:
        parts.append(f"[已有本周记录]\n{existing_week}")
    lines = []
    for t in turns[-100:]:
        role = t.get("role", "")
        content = str(t.get("content", "")).strip()
        if content:
            label = "用户" if role == "user" else (char_name or "AI")
            lines.append(f"{label}: {content}")
    if lines:
        parts.append("[最近对话]\n" + "\n".join(lines))
    text = "\n\n".join(parts)
    cache_source = "\n".join(lines)

    if _check_cache(cid, "week", cache_source):
        return _read_section(cid, "week")

    result = _call_llm(system_compile_week(char_name), text, timeout=20)
    if result:
        _write_cache(cid, "week", cache_source, result)
    return result or ""


def longterm_digest(char_id: str = "", week_summary: str = "") -> str:
    """Fold existing long-term context with weekly summary for given character."""
    cid = char_id or _current_char_id or "default"
    existing_longterm = _read_section(cid, "longterm")

    parts = []
    if existing_longterm:
        parts.append(f"[已有长期上下文]\n{existing_longterm}")
    if week_summary:
        parts.append(f"[本周概要]\n{week_summary}")
    if not parts:
        return ""

    text = "\n\n".join(parts)
    cache_source = week_summary.strip()

    if _check_cache(cid, "longterm", cache_source):
        return _read_section(cid, "longterm")

    result = _call_llm(system_compile_longterm(), text, timeout=20)
    if result:
        _write_cache(cid, "longterm", cache_source, result)
    return result or ""


def facts_digest(char_id: str = "") -> str:
    """Compile stored facts + insights into a stable user profile summary."""
    cid = char_id or _current_char_id or "default"

    facts = memory_store.list_memories(
        character_id=cid, memory_type="fact", active_only=True, limit=30
    )
    # Insights are the reflection layer's syntheses — they belong with facts
    # in the always-relevant profile section, ranked below raw facts.
    insights = memory_store.list_memories(
        character_id=cid, memory_type="insight", active_only=True, limit=10
    )
    facts = sorted(
        facts + insights,
        key=lambda row: (row["memory_type"] != "fact", -float(row.get("importance", 0.5) or 0.5)),
    )
    if not facts:
        _clear_section(cid, "facts")
        return ""

    lines = [f"- {f['content']}" for f in facts[:30]]
    text = "\n".join(lines)

    if _check_cache(cid, "facts", text):
        return _read_section(cid, "facts")

    result = _call_llm(system_compile_facts(), text, timeout=20)
    if result:
        _write_cache(cid, "facts", text, result)
    return result or ""


def assemble(char_id: str = ""):
    """Read all four sections for given character and write memory.md."""
    cid = char_id or _current_char_id or "default"

    today = _read_section(cid, "today") or "（暂无）"
    week = _read_section(cid, "week") or "（暂无）"
    longterm = _read_section(cid, "longterm") or "（暂无）"
    facts = _read_section(cid, "facts") or "（暂无）"

    content = (
        "## 重要事实\n\n" + facts +
        "\n\n## 今天\n\n" + today +
        "\n\n## 本周早些时候\n\n" + week +
        "\n\n## 长期情况\n\n" + longterm + "\n"
    )
    path = _char_dir(cid) / "memory.md"
    path.write_text(content, "utf-8")


def compile_and_assemble(char_id: str = ""):
    """Run all four compilations then assemble. Call once per day."""
    cid = char_id or _current_char_id or "default"

    new_week = week_digest(cid)
    longterm_digest(cid, new_week)
    facts_digest(cid)
    today_digest(cid)

    assemble(cid)


def compile_today_and_assemble(char_id: str = ""):
    """Compile today's digest then assemble. Call after rolling summary."""
    cid = char_id or _current_char_id or "default"
    today = today_digest(cid)
    # today_digest may have removed a stale section; always rewrite memory.md
    # so the assembled compatibility file reflects that deletion immediately.
    assemble(cid)
    return today


# ── character switch support ─────────────────────────────────────────

def regenerate_for_character(char_id: str):
    """Regenerate all compiled memory for a target character from shared facts.
    
    Called when switching personas. Does NOT re-extract facts (they're shared).
    Re-compiles today/week/longterm/facts from the shared fact store.
    """
    logger.info("Regenerating compiled memory for character %s", char_id)
    facts_digest(char_id)
    today = today_digest(char_id)
    assemble(char_id)
    logger.info("Compiled memory regenerated for character %s", char_id)
    return True
