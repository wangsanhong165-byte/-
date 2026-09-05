"""Memory ticker — turn-based memory scheduler.

Trigger mechanism (openhanako v3 inspired, adapted for single-agent):
  - Every N turns: rolling summary + compile_today + assemble
  - Date change: daily batch (week + longterm + facts + assemble)
  - Startup: recover any unprocessed turns

All operations run as fire-and-forget background tasks.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
import functools
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional, Callable

from app.memory.store import memory_store
from app.memory.extractor import run_extraction_pipeline
from app.memory.reviewer import review_turn
from app.memory.compiler import (
    compile_today_and_assemble,
    compile_and_assemble,
    set_llm_adapter,
    write_conversation_summary,
    clear_conversation_summary,
)

_TURNS_PER_SUMMARY = 10
_REVIEW_INTERVAL = 3
_REVIEW_MIN_INTERVAL_SEC = 20
_DAILY_CHECK_SECONDS = 3600  # check every hour for date change
logger = logging.getLogger("memory.ticker")


def _daily_stamp_path() -> Path:
    """Stamp file recording when the daily batch last completed (local date)."""
    # Imported lazily so tests that monkeypatch compiler._get_base are honored.
    from app.memory.compiler import _get_base
    return _get_base() / "data" / "memory" / "compiled" / ".last_daily"


def _read_daily_stamp() -> str:
    try:
        return _daily_stamp_path().read_text("utf-8").strip()
    except OSError:
        return ""


def _write_daily_stamp() -> None:
    path = _daily_stamp_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(datetime.now().date().isoformat(), "utf-8")
        os.replace(tmp, path)
    except OSError:
        logger.exception("Failed to persist daily batch stamp")


class MemoryTicker:
    """Turn-based memory scheduler (fire-and-forget background tasks)."""

    def __init__(
        self,
        llm_adapter: Any = None,
        character_ids_getter: Callable[[], list[str]] | None = None,
        store: Any = None,
    ):
        self._llm_adapter = llm_adapter
        self._turn_counts: dict[str, int] = {}
        # Local date, matching today_digest's local-midnight semantics; a UTC
        # day boundary (08:00 for UTC+8) would never roll over for an
        # evening-only usage pattern.
        self._last_date = datetime.now().date()
        self._last_extraction_time: dict[str, float] = {}
        self._last_review_time: dict[str, float] = {}
        self._character_ids_getter = character_ids_getter or (lambda: [])
        self._store = store or memory_store
        self._background_running = False  # one worker; distinct triggers are queued
        self._background_pending: OrderedDict[tuple, Callable] = OrderedDict()
        self._background_worker: Optional[threading.Thread] = None
        self._stopped = False
        self._timer: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def set_llm_adapter(self, adapter: Any):
        self._llm_adapter = adapter
        set_llm_adapter(adapter)

    # ── public API ────────────────────────────────────────────────

    def notify_turn(self, character_id: str = ""):
        """Called after each completed turn."""
        if self._stopped:
            return
        if not self._llm_adapter:
            return

        char_id = str(character_id or self._get_char_id()).strip()
        if not char_id:
            return
        with self._lock:
            count = self._turn_counts.get(char_id, 0) + 1
            self._turn_counts[char_id] = count

        # Check date change
        self._check_date_change()

        # Every few turns: fine-grained self-review of the latest turn.
        # Skip the turns the full extraction covers (re-extracted there).
        if count % _REVIEW_INTERVAL == 0 and count % _TURNS_PER_SUMMARY != 0:
            self._run_background(self._bound("_on_review", self._on_review, char_id))

        # Every N turns: run extraction + compile_today
        if count % _TURNS_PER_SUMMARY == 0:
            self._run_background(
                self._bound("_on_turn_threshold", self._on_turn_threshold, char_id)
            )

    def regenerate(self, character_id: str) -> None:
        """Regenerate one character's compiled files without blocking switch."""
        char_id = str(character_id or "").strip()
        if not char_id:
            return
        from app.memory.compiler import regenerate_for_character
        self._run_background(
            self._bound("regenerate_for_character", regenerate_for_character, char_id)
        )

    def start(self):
        """Start the daily check timer and catch up a missed daily batch."""
        self._stopped = False
        self._catchup_daily()
        self._daily_check()

    def stop(self, wait: bool = False):
        """Stop the ticker."""
        self._stopped = True
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        with self._lock:
            self._background_pending.clear()
            worker = self._background_worker
        if wait and worker is not None and worker is not threading.current_thread():
            worker.join(timeout=5)

    # ── background tasks ──────────────────────────────────────────

    def _run_background(self, fn: Callable):
        """Run a task in a background thread (fire-and-forget).

        Only one background LLM task runs at a time. Duplicate triggers for
        the same operation and character are coalesced, while distinct work is
        queued instead of being silently lost during another LLM call.
        """
        key = self._background_key(fn)
        with self._lock:
            if self._stopped:
                return
            if self._background_running:
                self._background_pending[key] = fn
                return
            self._background_running = True

        def _guarded():
            current: Callable | None = fn
            while current is not None:
                try:
                    current()
                except Exception:
                    logger.exception(
                        "Background memory task failed: %s",
                        getattr(current, "__name__", type(current).__name__),
                    )
                with self._lock:
                    if self._stopped:
                        self._background_pending.clear()
                    if self._background_pending:
                        _, current = self._background_pending.popitem(last=False)
                    else:
                        current = None
                        self._background_running = False
                        self._background_worker = None

        t = threading.Thread(target=_guarded, daemon=True)
        with self._lock:
            self._background_worker = t
        t.start()

    @staticmethod
    def _background_key(fn: Callable) -> tuple:
        args = getattr(fn, "args", ())
        return (
            getattr(fn, "__name__", type(fn).__name__),
            tuple(repr(arg) for arg in args),
        )

    @staticmethod
    def _bound(name: str, fn: Callable, *args) -> Callable:
        task = functools.partial(fn, *args)
        task.__name__ = name
        return task

    def _on_review(self, character_id: str = ""):
        """Fine-grained post-turn self-review of the latest turn."""
        now = time.time()
        char_id = str(character_id or self._get_char_id()).strip()
        with self._lock:
            last = self._last_review_time.get(char_id, 0.0)
            if now - last < _REVIEW_MIN_INTERVAL_SEC:
                return
            self._last_review_time[char_id] = now
        review_turn(
            self._llm_adapter,
            character_id=char_id,
            character_name=self._get_char_name(char_id),
            store=self._store,
        )

    def _on_turn_threshold(self, character_id: str = ""):
        """Every N turns: decay memories + extract facts + persist summary."""
        now = time.time()
        char_id = str(character_id or self._get_char_id()).strip()
        with self._lock:
            last = self._last_extraction_time.get(char_id, 0.0)
            if now - last < 30:
                return
            self._last_extraction_time[char_id] = now
        self._run_extraction_cycle(char_id)

    def on_session_end(self, character_id: str = ""):
        """Final memory extraction when a session closes.

        Triggered on WebSocket disconnect, a new conversation (create_history),
        or loading a different history. Runs the same idempotent extraction
        cycle as the turn threshold but without the 30s gate, so a short
        session that ended right after a threshold still gets its pending turns
        summarized. No-op when there are no unprocessed turns (summary_window
        finds nothing after through_log_id).
        """
        if self._stopped or not self._llm_adapter:
            return
        char_id = str(character_id or self._get_char_id()).strip()
        if not char_id:
            return
        self._run_background(
            self._bound("_on_session_end", self._on_session_end, char_id)
        )

    def _on_session_end(self, character_id: str = ""):
        char_id = str(character_id or self._get_char_id()).strip()
        if not char_id:
            return
        self._run_extraction_cycle(char_id)

    def _run_extraction_cycle(self, char_id: str) -> None:
        """One decay + extraction + summary + compile pass for a character."""
        # Capture the character ONCE up front: a switch during the LLM call
        # must not write one character's summary into another's file.
        char_name = self._get_char_name(char_id)

        # A1 decay runs here (background thread), not on the voice-loop path.
        self._store.decay_memories(character_id=char_id)
        # Ephemeral states (recent_state) past their validity window expire
        # on the same offline cadence — never on the voice loop.
        self._store.expire_memories(character_id=char_id)
        # Vector backfill for rows written before the embedding channel was
        # available; a no-op when the local model is absent.
        try:
            self._store.backfill_embeddings(character_id=char_id, limit=50)
        except Exception:
            logger.exception("Embedding backfill failed for %s", char_id)

        stats = run_extraction_pipeline(
            self._llm_adapter, character_name=char_name, character_id=char_id,
            store=self._store,
        )
        summary = stats.get("summary", "")
        summary_changed = not stats.get("summary_unchanged", False)
        if summary:
            if summary_changed:
                write_conversation_summary(
                    char_id,
                    summary,
                    through_log_id=int(stats.get("through_log_id", 0) or 0),
                )
        else:
            clear_conversation_summary(char_id)
        if stats.get("facts_stored", 0) > 0 or (summary and summary_changed):
            compile_today_and_assemble(char_id)

    # ── daily job ─────────────────────────────────────────────────

    def _catchup_daily(self):
        """Queue the daily batch when it has not run yet today (local date).

        The in-run date-change trigger only fires when the app stays up across
        midnight; a start-stop usage pattern would otherwise never compile the
        week/longterm layers. A completed batch writes a date stamp, so the
        same-day startup costs nothing until the next day; fingerprint caches
        also make a redundant pass nearly LLM-free.
        """
        if self._stopped or not self._llm_adapter:
            return
        today = datetime.now().date().isoformat()
        if _read_daily_stamp() == today:
            return
        self._run_background(self._on_daily)

    def _check_date_change(self):
        """Check if the date has changed. If so, run daily batch."""
        today = datetime.now().date()
        if today != self._last_date:
            self._last_date = today
            self._run_background(self._on_daily)

    def _on_daily(self):
        """Daily batch: compile week + longterm + facts + assemble."""
        retention_days = max(30, int(os.environ.get("MEMORY_LOG_RETENTION_DAYS", "180")))
        cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
        for character_id in dict.fromkeys(self._character_ids_getter()):
            if character_id:
                self._store.decay_memories(character_id=character_id)
                self._store.expire_memories(character_id=character_id)
                compile_and_assemble(character_id)
                # LLM merge of near-duplicate memories (only when there are
                # enough to be worth it; no-ops otherwise).
                try:
                    from app.memory.merger import merge_memories
                    merge_memories(self._llm_adapter, self._store, character_id=character_id)
                except Exception:
                    logger.exception("Memory merge failed for %s", character_id)
                # Weekly reflection (insights + relationship style): gated by
                # its own stamp, offline, never on the voice loop.
                try:
                    from app.memory.reflection import reflect_if_due
                    reflect_if_due(
                        self._llm_adapter, self._store, character_id,
                        character_name=self._get_char_name(character_id),
                    )
                except Exception:
                    logger.exception("Reflection failed for %s", character_id)
                self._store.prune_character_history(character_id, cutoff)
                self._store.delete_memories_before(
                    cutoff, character_id=character_id
                )
        # Written only after the loop finishes, so a batch that crashes midway
        # stays "not run today" and the next startup retries it (sections
        # already compiled hit their fingerprint caches for free).
        _write_daily_stamp()

    def _daily_check(self):
        """Periodic timer to catch date changes during idle periods."""
        if self._stopped:
            return

        self._check_date_change()

        self._timer = threading.Timer(_DAILY_CHECK_SECONDS, self._daily_check)
        self._timer.daemon = True
        self._timer.start()

    # ── recovery ──────────────────────────────────────────────────

    def _get_char_name(self, character_id: str = "") -> str:
        """Get active character display name for prompt generation."""
        try:
            from app.memory.compiler import get_active_char_id, _char_name_from_id
            cid = character_id or get_active_char_id()
            return _char_name_from_id(cid)
        except Exception:
            return ""

    @staticmethod
    def _get_char_id() -> str:
        try:
            from app.memory.compiler import get_active_char_id
            return get_active_char_id()
        except Exception:
            return ""

    def recover(self, character_ids: list[str] | None = None):
        """Startup recovery: estimate unprocessed turns."""
        if not self._llm_adapter:
            return
        ids = character_ids or list(self._character_ids_getter())
        for character_id in dict.fromkeys(ids):
            turns = self._store.recent_turns(
                _TURNS_PER_SUMMARY, character_id=character_id
            )
            completed_turns = len(turns) // 2
            if completed_turns >= _TURNS_PER_SUMMARY // 2:
                with self._lock:
                    self._turn_counts[character_id] = completed_turns
                self._run_background(self._bound(
                    "_on_turn_threshold", self._on_turn_threshold, character_id
                ))

