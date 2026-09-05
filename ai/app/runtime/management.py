"""Runtime Management — auxiliary operations owned by the Runtime.

All history CRUD, pinned memories, character switching, and prompt
reloading logic lives here. The Transport layer calls into this module
through thin dispatchers — it never duplicates this logic.

This is the single source of truth for management operations used by the
typed Transport handler and the HTTP management endpoints.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import tempfile
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from app.runtime.turn_recorder import latest_visual_outcome
from typing import Any

from app.runtime.runtime import runtime as default_runtime
from app.runtime.prompt_config import PromptConfigStore
from app.runtime.prompt_overrides import PromptOverrideStore
from app.character.catalog import CharacterCatalog
from app.character.lifecycle import CharacterLifecycle
from app.character.voices import VoiceRegistry
from app.memory.compiler import delete_character_compiled_data

logger = logging.getLogger("runtime.management")


class RuntimeManager:
    """Manages auxiliary operations on behalf of CharacterRuntime.

    Provides a clean API shared by typed Transport and HTTP endpoints.
    All state is file-backed (persisted across server restarts).
    """

    def __init__(self, base_dir: Path | None = None, runtime=None):
        self._runtime = runtime or default_runtime
        self._base_dir = base_dir or Path(__file__).resolve().parent.parent.parent

        # History state
        self._histories_dir = self._base_dir / "data" / "memory" / "histories"
        self._history_index: dict[str, dict] = {}
        self._current_history_uid: str = ""
        self._history_lock = threading.RLock()

        # Pinned memories
        self._pinned_cache: str = ""
        self._pinned_path: Path | None = None
        self._prompt_overrides = PromptOverrideStore(self._base_dir / "data" / "prompts")
        self._prompt_configs = PromptConfigStore(self._base_dir / "data" / "prompts")
        self._character_catalog = CharacterCatalog(self._base_dir)
        self._voices = VoiceRegistry(self._base_dir)

        self._ensure_dirs()
        self._character_lifecycle = CharacterLifecycle(
            catalog=self._character_catalog,
            runtime=self._runtime,
            active_character_id=self.get_character_id,
            switch_character=self.switch_character,
            prompt_configs=self._prompt_configs,
            prompt_overrides=self._prompt_overrides,
            memory_store=self._memory_store,
            delete_histories=self._delete_character_histories,
            delete_compiled_data=delete_character_compiled_data,
            pending_cleanup_path=(
                self._base_dir / "data" / "runtime"
                / "pending-character-cleanup.json"
            ),
        )
        cleanup_retry = self._character_lifecycle.retry_pending_cleanups()
        if cleanup_retry["pending"]:
            logger.warning(
                "[CharacterCatalog] Pending cleanup remains for: %s",
                ", ".join(cleanup_retry["pending"]),
            )

    # ── Initialization ──────────────────────────────────────────────

    def _ensure_dirs(self) -> None:
        """Ensure data directories for histories exist."""
        with self._history_lock:
            self._histories_dir.mkdir(parents=True, exist_ok=True)
            index_path = self._histories_dir / "index.json"
            if index_path.exists():
                try:
                    loaded = json.loads(index_path.read_text("utf-8"))
                    self._history_index = loaded if isinstance(loaded, dict) else {}
                except Exception:
                    self._history_index = {}
            else:
                self._history_index = {}

            active_character = self.get_character_id()
            claimed_legacy = False
            for info in self._history_index.values():
                if isinstance(info, dict) and not info.get("character_id"):
                    info["character_id"] = active_character
                    claimed_legacy = True
            recovered = self._reconcile_history_index()
            if not index_path.exists() or recovered or claimed_legacy:
                try:
                    self._save_index()
                except OSError:
                    # Keep startup usable if another process temporarily holds
                    # the index. The next initialization will retry recovery.
                    logger.exception("Failed to persist recovered history index")

    def get_character_id(self) -> str:
        """Get the active character ID from the runtime."""
        try:
            info = self._runtime.get_character_info()
            card = info.get("card", {})
            return card.get("id", "monika")
        except Exception:
            return "monika"

    def ensure_pinned(self) -> Path:
        """Ensure pinned.md path exists for current character. Returns the path."""
        if self._pinned_path is not None:
            return self._pinned_path
        cid = self.get_character_id()
        path = self._base_dir / "config" / "characters" / cid / "pinned.md"
        self._pinned_path = path
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
        self._pinned_cache = path.read_text("utf-8").strip()
        return path

    def reinit_per_character(self) -> None:
        """Re-initialize per-character state (called after character switch)."""
        self._pinned_path = None
        self._pinned_cache = ""
        self.ensure_pinned()
        self._current_history_uid = ""
        self._ensure_dirs()

    # ── History operations ──────────────────────────────────────────

    def _reconcile_history_index(self) -> bool:
        """Recover valid history files that are missing from the index."""
        changed = False
        for path in self._histories_dir.glob("hist_*.json"):
            uid = path.stem
            if uid in self._history_index:
                continue
            try:
                messages = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError, TypeError):
                continue
            if not isinstance(messages, list):
                continue

            latest_message = ""
            latest_timestamp = ""
            for message in messages:
                if not isinstance(message, dict):
                    continue
                content = message.get("content")
                if isinstance(content, str) and content.strip():
                    if message.get("role") == "user" or not latest_message:
                        latest_message = content
                timestamp = message.get("timestamp")
                if isinstance(timestamp, str) and timestamp:
                    latest_timestamp = timestamp

            if not latest_timestamp:
                try:
                    latest_timestamp = datetime.fromtimestamp(
                        path.stat().st_mtime, tz=timezone.utc
                    ).isoformat()
                except OSError:
                    continue

            self._history_index[uid] = {
                "timestamp": latest_timestamp,
                "latest_message": latest_message or None,
                "character_id": self.get_character_id(),
            }
            changed = True
            logger.warning("Recovered history index entry from %s", path.name)
        return changed

    def _save_index(self) -> None:
        """Persist history index to disk."""
        index_path = self._histories_dir / "index.json"
        temp_path: Path | None = None

        with self._history_lock:
            payload = json.dumps(self._history_index, ensure_ascii=False)
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w",
                    encoding="utf-8",
                    dir=self._histories_dir,
                    prefix=".index-",
                    suffix=".tmp",
                    delete=False,
                ) as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                    temp_path = Path(handle.name)

                for attempt in range(3):
                    try:
                        os.replace(temp_path, index_path)
                        return
                    except OSError as exc:
                        # Windows can briefly reject a replace while another
                        # reader has the index open. Retry only those transient
                        # file-sharing errors and preserve the old index until
                        # the replacement succeeds.
                        if exc.errno not in (errno.EACCES, errno.EPERM, errno.EINVAL):
                            raise
                        if attempt == 2:
                            raise
                        time.sleep(0.05 * (attempt + 1))
            finally:
                if temp_path is not None:
                    try:
                        temp_path.unlink(missing_ok=True)
                    except OSError:
                        logger.warning("Failed to clean temporary history index: %s", temp_path)

    def _load_messages(self, uid: str) -> list[dict]:
        """Load messages from SQLite, falling back to pre-V3 JSON."""
        store = self._memory_store()
        if store is not None:
            messages = store.history_messages(
                uid, character_id=self.get_character_id()
            )
            if messages:
                return messages
        path = self._histories_dir / f"{uid}.json"
        if not path.exists():
            return []
        info = self._history_index.get(uid, {})
        if str(info.get("character_id", "")) != self.get_character_id():
            return []
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:
            return []

    def current_history_uid(self, *, create: bool = False) -> str:
        if not self._current_history_uid and create:
            self.create_history()
        return self._current_history_uid

    def _finalize_session_memory(self) -> None:
        """Best-effort final memory extraction for the session that is closing.

        Runs in a background thread (ticker) and no-ops when there are no
        unprocessed turns. Called before a new history is created or a
        different history is loaded, so short sessions still get their
        pending turns summarized and facts extracted.
        """
        try:
            memory = getattr(self._runtime, "providers", {}).get("memory")
            if memory is not None and hasattr(memory, "on_session_end"):
                memory.on_session_end(self.get_character_id())
        except Exception:
            logger.warning("Session-end memory extraction failed", exc_info=True)

    def get_history_list(self) -> list[dict]:
        """Return histories sorted by timestamp desc."""
        with self._history_lock:
            result = []
            for uid, info in self._history_index.items():
                if str(info.get("character_id", "")) != self.get_character_id():
                    continue
                result.append({
                    "uid": uid,
                    "latest_message": info.get("latest_message"),
                    "timestamp": info.get("timestamp", ""),
                })
        result.sort(key=lambda x: x["timestamp"], reverse=True)
        return result

    def load_history(self, history_uid: str) -> dict:
        """Load a history by UID and restore conversation state. Returns messages."""
        info = self._history_index.get(history_uid)
        if info is not None and str(info.get("character_id", "")) != self.get_character_id():
            raise KeyError(f"history not found for active character: {history_uid}")
        if self._current_history_uid and self._current_history_uid != history_uid:
            self._finalize_session_memory()
        self._current_history_uid = history_uid
        messages = self._load_messages(history_uid)

        # Restore conversation in runtime
        try:
            conv = getattr(self._runtime, "conversation", None)
            if conv is not None:
                if hasattr(conv, "clear"):
                    conv.clear()
                for m in messages:
                    role = m.get("role", "")
                    content = m.get("content", "")
                    if role in ("user", "assistant") and content:
                        metadata = m.get("metadata")
                        conv.add_turn(
                            role,
                            content,
                            **metadata if isinstance(metadata, dict) else {},
                        )
        except Exception as e:
            logger.warning("Failed to restore conversation: %s", e)

        return {"history_uid": history_uid, "messages": messages}

    def create_history(self) -> dict:
        """Create a new history UID and return it."""
        if self._current_history_uid:
            self._finalize_session_memory()
        uid = f"hist_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()
        with self._history_lock:
            self._current_history_uid = uid
            self._history_index[uid] = {
                "timestamp": now,
                "latest_message": None,
                "character_id": self.get_character_id(),
            }
            self._save_index()

        # Clear runtime conversation
        try:
            conv = getattr(self._runtime, "conversation", None)
            if conv is not None and hasattr(conv, "clear"):
                conv.clear()
        except Exception:
            pass

        return {"history_uid": uid}

    def delete_history(self, history_uid: str) -> dict:
        """Delete a history by UID. Returns success status."""
        info = self._history_index.get(history_uid)
        if info is not None and str(info.get("character_id", "")) != self.get_character_id():
            raise KeyError(f"history not found for active character: {history_uid}")
        path = self._histories_dir / f"{history_uid}.json"
        file_contents: bytes | None = None
        if info is not None and path.exists():
            file_contents = path.read_bytes()
            path.unlink()

        with self._history_lock:
            store = self._memory_store()
            deleted_rows = 0
            if store is not None:
                deleted_rows = store.delete_history(
                    history_uid, character_id=self.get_character_id()
                )
            existed = history_uid in self._history_index or deleted_rows > 0
            previous_info = self._history_index.get(history_uid)
            self._history_index.pop(history_uid, None)
            try:
                self._save_index()
            except Exception:
                # Do not leave a deleted JSON file or an in-memory index
                # behind when the atomic index replacement fails.
                if previous_info is not None:
                    self._history_index[history_uid] = previous_info
                if file_contents is not None and not path.exists():
                    path.write_bytes(file_contents)
                raise

            if self._current_history_uid == history_uid:
                self._current_history_uid = ""

        return {"success": existed, "history_uid": history_uid}

    def save_to_current_history(self, user_text: str, assistant_text: str) -> None:
        """Removed in V3: turns are committed once by MemorySaveStep."""
        raise RuntimeError("history writes must go through MemorySaveStep")

    def record_turn_metadata(self, history_uid: str, user_text: str) -> None:
        """Update the lightweight history index without duplicating messages."""
        ts = datetime.now(timezone.utc).isoformat()
        preview = (user_text[:80] + "...") if len(user_text) > 80 else user_text
        with self._history_lock:
            self._history_index[history_uid] = {
                "timestamp": ts,
                "latest_message": preview,
                "character_id": self.get_character_id(),
            }
            self._save_index()

    def _delete_character_histories(self, character_id: str) -> int:
        """Delete legacy JSON/index history metadata owned by one character."""
        with self._history_lock:
            owned = [
                uid for uid, info in self._history_index.items()
                if isinstance(info, dict)
                and str(info.get("character_id", "")) == character_id
            ]
            previous_entries = {
                uid: deepcopy(self._history_index[uid]) for uid in owned
            }
            file_contents = {
                uid: path.read_bytes()
                for uid in owned
                if (path := self._histories_dir / f"{uid}.json").is_file()
            }
            try:
                for uid in owned:
                    (self._histories_dir / f"{uid}.json").unlink(missing_ok=True)
                    self._history_index.pop(uid, None)
                if owned:
                    self._save_index()
            except Exception:
                self._history_index.update(previous_entries)
                for uid, content in file_contents.items():
                    path = self._histories_dir / f"{uid}.json"
                    if not path.exists():
                        path.write_bytes(content)
                raise
            if self._current_history_uid in owned:
                self._current_history_uid = ""
        return len(owned)

    # ── Pinned memories ─────────────────────────────────────────────

    def get_pinned(self) -> str:
        """Return the current pinned memories content."""
        self.ensure_pinned()
        return self._pinned_cache

    def set_pinned(self, content: str) -> str:
        """Update pinned memories content. Returns the new content."""
        path = self.ensure_pinned()
        self._pinned_cache = content
        path.write_text(content, encoding="utf-8")
        logger.info("[Pinned] Updated (%d chars)", len(content))
        return content

    # ── Prompt overrides ─────────────────────────────────────────────

    def get_prompt_override(self) -> dict[str, str]:
        """Return the current character's user-owned prompt addition."""
        character_id = self.get_character_id()
        return {
            "character_id": character_id,
            "content": self._prompt_overrides.get(character_id),
        }

    def set_prompt_override(self, content: str) -> dict[str, str]:
        """Persist the current character's user-owned prompt addition."""
        character_id = self.get_character_id()
        normalized = self._prompt_overrides.set(character_id, content)
        logger.info("[PromptOverride] Updated for %s (%d chars)", character_id, len(normalized))
        return {"character_id": character_id, "content": normalized}

    def get_prompt_config(self, character_id: str = "") -> dict[str, Any]:
        """Return the complete editable prompt policy for one character."""
        requested_id = str(character_id or self.get_character_id())
        rules = self._prompt_configs.get(requested_id)
        previews = self._last_prompt_source_contents(requested_id, rules)
        defaults = self._static_prompt_source_defaults(requested_id)
        sources = []
        for definition in self._prompt_configs.definitions():
            source_id = str(definition["id"])
            sources.append({
                **definition,
                **rules[source_id],
                "default_content": defaults.get(source_id, ""),
                "last_content": previews.get(source_id, ""),
            })
        return {
            "character_id": requested_id,
            "sources": sources,
            "addition": self._prompt_overrides.get(requested_id),
        }

    def set_prompt_config(
        self,
        character_id: str,
        sources: dict[str, Any],
        addition: str,
    ) -> dict[str, Any]:
        """Persist one character's source policy and free-form addition."""
        requested_id = str(character_id or self.get_character_id())
        normalized_addition = str(addition).replace("\r\n", "\n").strip()
        if len(normalized_addition) > self._prompt_overrides.MAX_CHARS:
            raise ValueError(
                f"prompt override exceeds {self._prompt_overrides.MAX_CHARS} characters"
            )
        self._prompt_configs.set(requested_id, sources)
        self._prompt_overrides.set(requested_id, normalized_addition)
        logger.info("[PromptConfig] Updated for %s", requested_id)
        return self.get_prompt_config(requested_id)

    def get_prompt_view(self, character_id: str = "") -> dict[str, Any]:
        """Return the latest message list actually submitted to the LLM."""
        requested_id = str(character_id or self.get_character_id())
        # Validate the explicit ID before exposing file-backed data.
        self._prompt_configs.get(requested_id)
        snapshot = getattr(self._runtime, "_last_prompt_snapshot", None)
        if not isinstance(snapshot, dict):
            snapshot = {}
        snapshot_character_id = str(snapshot.get("character_id", ""))
        if snapshot_character_id and snapshot_character_id != requested_id:
            snapshot = {}
        messages = snapshot.get("messages", [])
        if not isinstance(messages, list):
            messages = []
        budget = snapshot.get("context_budget", {})
        if not isinstance(budget, dict):
            budget = {}
        decorated_messages = self._decorate_prompt_messages(
            requested_id, messages, snapshot.get("source_ids", [])
        )
        return {
            "available": bool(decorated_messages),
            "character_id": requested_id,
            "snapshot_character_id": str(snapshot.get("character_id", "")),
            "turn_id": str(snapshot.get("turn_id", "")),
            "created_at": float(snapshot.get("created_at", 0) or 0),
            "messages": decorated_messages,
            "context_budget": deepcopy(budget),
            "override": self._prompt_overrides.get(requested_id),
        }

    def _decorate_prompt_messages(
        self,
        character_id: str,
        messages: list[Any],
        source_ids: list[Any] | None = None,
    ) -> list[dict[str, Any]]:
        rules = self._prompt_configs.get(character_id)
        replacements = {
            entry["content"]: source_id
            for source_id, entry in rules.items()
            if entry.get("mode") == "replace" and entry.get("content")
        }
        decorated: list[dict[str, Any]] = []
        explicit_sources = list(source_ids or [])
        for index, raw_message in enumerate(messages):
            if not isinstance(raw_message, dict):
                continue
            message = deepcopy(raw_message)
            role = str(message.get("role", ""))
            content = str(message.get("content", ""))
            explicit_source = (
                str(explicit_sources[index]) if index < len(explicit_sources) else ""
            )
            if explicit_source:
                message["source_id"] = explicit_source
            elif role == "system":
                message["source_id"] = (
                    replacements.get(content)
                    or self._source_id_from_content(content)
                    or "system"
                )
            elif role == "user":
                message["source_id"] = "user_input"
            elif role == "assistant":
                message["source_id"] = "assistant_history"
            elif role == "tool":
                message["source_id"] = "tool_result"
            decorated.append(message)
        return decorated

    def _last_prompt_source_contents(
        self,
        character_id: str,
        rules: dict[str, dict[str, str]],
    ) -> dict[str, str]:
        snapshot = getattr(self._runtime, "_last_prompt_snapshot", None)
        if not isinstance(snapshot, dict) or str(snapshot.get("character_id", "")) != character_id:
            return {}
        messages = snapshot.get("messages", [])
        if not isinstance(messages, list):
            return {}

        replacements = {
            entry["content"]: source_id
            for source_id, entry in rules.items()
            if entry.get("mode") == "replace" and entry.get("content")
        }
        previews: dict[str, str] = {}
        source_ids = snapshot.get("source_ids", [])
        if not isinstance(source_ids, list):
            source_ids = []
        for index, message in enumerate(messages):
            if not isinstance(message, dict) or message.get("role") != "system":
                continue
            content = str(message.get("content", ""))
            source_id = (
                (str(source_ids[index]) if index < len(source_ids) else "")
                or replacements.get(content)
                or self._source_id_from_content(content)
            )
            if source_id and source_id not in previews:
                previews[source_id] = content
        return previews

    def _static_prompt_source_defaults(self, character_id: str) -> dict[str, str]:
        """Build static defaults through the real planner, independent of snapshots."""
        character = getattr(
            getattr(self._runtime, "_character_step", None),
            "character",
            None,
        )
        if character is None or str(getattr(character, "id", "")) != character_id:
            return {}

        class _EmptyOverrideStore:
            @staticmethod
            def get(_character_id: str) -> str:
                return ""

        class _DefaultOnlyConfigStore:
            @staticmethod
            def resolve(
                _character_id: str,
                _source_id: str,
                default_content: str,
            ) -> str:
                return default_content

        from app.runtime.character_turn import CharacterTurn, TurnInput
        from app.runtime.prompt_compiler import PromptCompiler

        turn = CharacterTurn(input=TurnInput(text="__prompt_preview__"))
        turn.character = character
        plan = PromptCompiler(
            prompt_store=_EmptyOverrideStore(),
            prompt_config_store=_DefaultOnlyConfigStore(),
        ).compile(turn, getattr(self._runtime, "character_self", None))

        defaults: dict[str, str] = {}
        static_sources = {"language", "persona", "output_protocol"}
        for index, message in enumerate(plan.messages):
            if not isinstance(message, dict) or message.get("role") != "system":
                continue
            content = str(message.get("content", ""))
            source_id = str(plan.sources[index]) if index < len(plan.sources) else ""
            if source_id in static_sources and source_id not in defaults:
                defaults[source_id] = content
        return defaults

    @staticmethod
    def _source_id_from_content(content: str) -> str:
        prefixes = (
            ("LANGUAGE LOCK:", "language"),
            ("[当前时间]", "temporal"),
            ("Compiled memory context:", "memory_summary"),
            ("Relevant past context:", "relevant_memory"),
            ("Current emotion:", "emotion"),
            ("[Dynamic learned user and relationship state]", "character_state"),
            ("[Output Instructions]", "output_protocol"),
        )
        stripped = content.lstrip()
        for prefix, source_id in prefixes:
            if stripped.startswith(prefix):
                return source_id
        if stripped.startswith("Additional project instructions for this character:"):
            return "addition"
        return "persona"

    def _memory_store(self):
        provider = getattr(self._runtime, "providers", {}).get("memory")
        return getattr(provider, "_store", None)

    def get_memories(self, include_inactive: bool = False, limit: int = 200) -> list[dict]:
        store = self._memory_store()
        if store is None:
            return []
        return store.list_memories(
            character_id=self.get_character_id(),
            active_only=not include_inactive,
            limit=max(1, min(500, int(limit))),
        )

    def get_character_self_view(self) -> dict:
        from app.runtime.user_views import build_character_self_view

        aggregate = getattr(self._runtime, "character_self", None)
        state = aggregate.snapshot() if aggregate is not None else {}
        return build_character_self_view(state)

    def get_memory_view(
        self, *, query: str = "", category: str = "all", limit: int = 200
    ) -> dict:
        from app.runtime.user_views import build_memory_view

        memories = self.get_memories(False, limit)
        # Expired rows are soft-deleted (active=0), so they need the inactive
        # scan — but only lifecycle-expired rows, never user-forgotten ones.
        expired_rows = [
            row for row in self.get_memories(True, limit)
            if str(row.get("state", "")) == "expired"
        ]
        rows = memories + expired_rows

        query_text = str(query or "").strip()
        if query_text and str(category or "all") != "expired":
            # 语义搜索：向量通道排序（搜"熬夜"能找到"深夜聊天"）。已过期
            # 分类不走语义路径——过期行不在检索结果里，走子串过滤即可。
            store = self._memory_store()
            if store is not None:
                try:
                    ranked = store.search_memories(
                        query_text,
                        character_id=self.get_character_id(),
                        limit=max(5, min(50, limit)),
                    )
                    rank = {int(row["id"]): row["score"] for row in ranked}
                    rows = [
                        row for row in rows if int(row.get("id", 0)) in rank
                    ]
                    rows.sort(
                        key=lambda row: rank.get(int(row.get("id", 0)), 0.0),
                        reverse=True,
                    )
                    query_text = ""  # ranking replaces substring filtering
                except Exception:
                    query_text = str(query)  # fall back to substring

        return build_memory_view(
            rows,
            query=query_text,
            category=str(category or "all"),
        )

    def semantic_classify(self, texts: list[str], context: str = "") -> dict:
        """Generic semantic ranking service for cross-layer consumers.

        Ranks candidate texts against a context string with the local
        embedding engine (performance-layer idle residue, E2 motion corpus,
        any future consumer). Read-only; degrades to {"available": False}
        when the vector channel is off.
        """
        from app.memory.embedder import get_embedder

        embedder = get_embedder()
        if embedder is None:
            return {"available": False, "ranking": []}
        clean_texts = [str(text or "").strip() for text in (texts or [])]
        clean_texts = [text for text in clean_texts if text][:50]
        if not clean_texts:
            return {"available": True, "ranking": []}
        context_vec = embedder.embed_query(str(context or "")) if str(context or "").strip() else None
        scored = []
        for text in clean_texts:
            vec = embedder.embed_document(text)
            if not vec:
                continue
            score = (
                round(sum(x * y for x, y in zip(context_vec, vec)), 4)
                if context_vec else 0.0
            )
            scored.append({"text": text, "score": score})
        scored.sort(key=lambda item: item["score"], reverse=True)
        return {"available": True, "ranking": scored}

    def classify_residue(self, recent_texts: list[str]) -> dict:
        """Match recent conversation turns against the residue corpus and
        return the nearest context label with its idle-behavior profile hint
        (config/conversation_residue_prototypes.json). Failure returns
        {"matched": False} — the performance layer keeps its current behavior.
        """
        from app.memory.prototypes import PrototypeClassifier

        config_path = (
            Path(__file__).resolve().parents[1] / "config"
            / "conversation_residue_prototypes.json"
        )
        if not config_path.exists():
            return {"matched": False, "error": "residue corpus missing"}
        # 向量缓存放 data/memory（与情绪原型一致）——不污染 config/ 目录。
        classifier = PrototypeClassifier(
            config_path,
            cache_dir=Path(__file__).resolve().parents[1] / "data" / "memory",
        )
        joined = " ".join(str(text or "") for text in (recent_texts or []) if text)
        if not joined.strip():
            return {"matched": False, "error": "no recent turns"}
        match = classifier.classify(joined[:800])
        if match is None:
            return {"matched": False}
        label, score = match
        profile = {}
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
            profile = data.get("idle_profiles", {}).get(label, {})
        except (OSError, json.JSONDecodeError):
            profile = {}
        # The corpus nests profiles per label; fall back to the inline map.
        if not profile:
            try:
                data = json.loads(config_path.read_text(encoding="utf-8"))
                entry = (data.get("prototypes") or {}).get(label)
                if isinstance(entry, dict):
                    profile = entry.get("idle_profile", {})
            except (OSError, json.JSONDecodeError):
                profile = {}
        return {"matched": True, "label": label, "score": round(score, 4), "idle_profile": profile}

    def get_compiled_memory_view(self) -> dict:
        """Return the active character's compiled memory (the LLM-facing summary)."""
        from app.memory.compiler import get_compiled_memory

        character_id = self.get_character_id()
        info = self._runtime.get_character_info()
        name = str(info.get("name") or character_id)
        try:
            memory_md = get_compiled_memory(character_id)
        except Exception:
            memory_md = ""
        compiled_at = 0.0
        try:
            from app.memory.compiler import _char_dir

            path = _char_dir(character_id) / "memory.md"
            if path.exists():
                compiled_at = path.stat().st_mtime
        except Exception:
            compiled_at = 0.0
        return {
            "characterId": character_id,
            "characterName": name,
            "memoryMd": memory_md,
            "compiledAt": compiled_at,
        }

    def regenerate_compiled_memory(self) -> dict:
        """Queue an offline recompile of the active character's memory.md."""
        from app.memory.compiler import get_active_char_id

        character_id = self.get_character_id() or get_active_char_id()
        provider = getattr(self._runtime, "providers", {}).get("memory")
        ticker = getattr(provider, "_ticker", None)
        if ticker is None:
            return {"queued": False, "error": "memory ticker unavailable"}
        ticker.regenerate(character_id)
        return {"queued": True, "characterId": character_id}

    def update_memory_view(self, memory_ref: str, params: dict) -> dict:
        from app.runtime.user_views import build_memory_view, parse_memory_ref

        try:
            memory_id = parse_memory_ref(memory_ref)
        except ValueError as exc:
            return {"error": str(exc)}
        update_params: dict[str, Any] = {}
        if "content" in params:
            update_params["content"] = params["content"]
        if "pinned" in params:
            update_params["importance"] = 1.0 if params["pinned"] else 0.5
        result = self.update_memory(memory_id, update_params)
        if "error" in result:
            return result
        return {"item": build_memory_view([result["memory"]])["items"][0]}

    def forget_memory_view(self, memory_ref: str) -> dict:
        from app.runtime.user_views import parse_memory_ref

        try:
            memory_id = parse_memory_ref(memory_ref)
        except ValueError as exc:
            return {"error": str(exc)}
        result = self.forget_memory(memory_id)
        return {"forgotten": bool(result.get("forgotten")), "ref": memory_ref}

    def get_voice_status_view(self) -> dict:
        from app.runtime.user_views import build_voice_status_view

        return build_voice_status_view(
            self._runtime, self._runtime.get_character_info()
        )

    async def get_capability_view(self) -> dict:
        from app.runtime.user_views import build_capability_view
        from app.runtime.turn_recorder import get_turn_recorder

        recent_use: dict[str, str] = {}
        turn_recorder = get_turn_recorder()
        for summary in turn_recorder.list_turns(limit=100):
            detail = turn_recorder.get_turn(summary["turnId"]) or {}
            for tool in detail.get("tools", []):
                name = str(tool.get("tool", ""))
                if name and name not in recent_use:
                    recent_use[name] = summary["createdAt"]
        return build_capability_view(
            await self.get_tools(),
            recent_use=recent_use,
        )

    def get_turns(self, limit: int = 100) -> list[dict]:
        from app.runtime.turn_recorder import get_turn_recorder

        return get_turn_recorder().list_turns(limit=limit)

    def get_turn_detail(self, turn_id: str) -> dict:
        from app.runtime.turn_recorder import get_turn_recorder

        detail = get_turn_recorder().get_turn(turn_id)
        return {"turn": detail} if detail else {"error": "turn not found"}

    def get_runtime_diagnostics(self) -> dict:
        from app.runtime.state_store import state_store

        providers = getattr(self._runtime, "providers", {})
        active_turn = getattr(self._runtime, "_active_turn", None)
        provider_statuses = []
        for name, provider in sorted(providers.items()):
            status = "ready" if provider is not None else "unavailable"
            detail = ""
            diagnostics = getattr(provider, "diagnostics", None)
            provider_diagnostics: dict = {}
            if callable(diagnostics):
                try:
                    provider_diagnostics = diagnostics()
                    status = str(provider_diagnostics.get("status", status))
                    detail = str(provider_diagnostics.get("reason", ""))
                except Exception as exc:
                    status = "degraded"
                    detail = f"diagnostics failed: {exc}"
            provider_status = {
                "name": name,
                "status": status,
                "adapter": type(provider).__name__ if provider is not None else "",
            }
            if callable(diagnostics):
                for key in (
                    "engine", "model", "base_url", "api_key_configured",
                    "visionEnabled", "visualPolicy", "compression",
                ):
                    if key in provider_diagnostics:
                        provider_status[key] = provider_diagnostics[key]
            if detail:
                provider_status["detail"] = detail
            provider_statuses.append(provider_status)
        recent_visual = latest_visual_outcome()
        return {
            "readOnly": True,
            "runtime": {
                "idle": bool(getattr(self._runtime, "_runtime_idle", True)),
                "turnCount": int(state_store.get("turn_count", 0)),
                "characterId": self.get_character_id(),
                "activeTurn": (
                    {
                        "turnId": active_turn.turn_id,
                        "phase": active_turn.phase.value,
                        "origin": active_turn.input_origin,
                        "createdAt": datetime.fromtimestamp(
                            active_turn.created_at, timezone.utc
                        ).isoformat(),
                    }
                    if active_turn is not None else None
                ),
            },
            "providers": provider_statuses,
            "visual": recent_visual,
            "retention": {"turnDays": 30, "maximumTurns": 500},
        }

    def update_memory(self, memory_id: int, params: dict) -> dict:
        store = self._memory_store()
        if store is None:
            return {"error": "memory store unavailable"}
        item = store.update_memory(
            memory_id,
            character_id=self.get_character_id(),
            content=params.get("content"),
            importance=params.get("importance"),
            confidence=params.get("confidence"),
        )
        return {"memory": item} if item else {"error": "memory not found"}

    def forget_memory(self, memory_id: int) -> dict:
        store = self._memory_store()
        if store is None:
            return {"error": "memory store unavailable"}
        forgotten = store.forget_memory(
            memory_id, character_id=self.get_character_id()
        )
        return {"forgotten": forgotten, "memory_id": memory_id}

    def get_system_metrics(self) -> dict:
        store = self._memory_store()
        if store is None:
            return {"usage": {"totals": {}, "recent": []}, "memory": {}}
        active = store.list_memories(
            character_id=self.get_character_id(), active_only=True, limit=500
        )
        return {
            "usage": store.usage_summary(self.get_character_id()),
            "memory": {
                "active_count": len(active),
                "by_type": {
                    kind: sum(1 for item in active if item["memory_type"] == kind)
                    for kind in sorted({item["memory_type"] for item in active})
                },
            },
        }

    async def get_tools(self) -> list[dict]:
        provider = getattr(self._runtime, "providers", {}).get("tool")
        if provider is None:
            return []
        from app.runtime.tool_settings import tool_settings
        schemas = await provider.list_tools()
        return [{
            "name": schema.get("function", {}).get("name", ""),
            "description": schema.get("function", {}).get("description", ""),
            "risk": schema.get("risk", "confirm"),
            "enabled": tool_settings.is_enabled(
                schema.get("function", {}).get("name", "")
            ),
            "allowed_in_initiative": bool(schema.get("allowed_in_initiative", False)),
        } for schema in schemas]

    def set_tool_enabled(self, name: str, enabled: bool) -> dict:
        from app.runtime.tool_settings import tool_settings
        if not name.strip():
            return {"error": "tool name is required"}
        tool_settings.set_enabled(name.strip(), enabled)
        return {"name": name.strip(), "enabled": bool(enabled)}

    # ── Character switching ─────────────────────────────────────────

    def get_character_catalog(self) -> dict[str, Any]:
        return {
            "active_character_id": self.get_character_id(),
            "characters": self._character_catalog.list(),
        }

    def get_character_detail(self, character_id: str) -> dict[str, Any]:
        """Return one character's safe editing projection and prompt status."""
        detail = self._character_catalog.get(character_id)
        return {"character": self._decorate_character_detail(detail)}

    def update_character(
        self,
        character_id: str,
        changes: dict[str, Any],
    ) -> dict[str, Any]:
        """Persist an editable character patch and reload the active role."""
        target = str(character_id or "").strip().lower()
        updated, runtime_reloaded = self._character_lifecycle.update(target, changes)

        decorated = self._decorate_character_detail(updated)
        logger.info("[CharacterCatalog] Updated character: %s", target)
        return {
            "character": decorated,
            "active_character_id": self.get_character_id(),
            "runtime_reloaded": runtime_reloaded,
        }

    def _decorate_character_detail(
        self,
        detail: dict[str, Any],
    ) -> dict[str, Any]:
        character_id = str(detail.get("id", ""))
        prompt_rules = self._prompt_configs.get(character_id)
        persona_rule = prompt_rules.get("persona", {})
        return {
            **detail,
            "persona_override_active": persona_rule.get("mode") == "replace",
        }

    def create_character(self, specification: dict[str, Any]) -> dict[str, Any]:
        character = self._character_lifecycle.create(specification)
        logger.info("[CharacterCatalog] Imported complete pack: %s", character["id"])
        return {"character": character}

    def delete_character(self, character_id: str) -> dict[str, Any]:
        """Delete one role and all role-owned prompt/memory state.

        Shared Live2D models and voices are intentionally retained.
        """
        target = str(character_id or "").strip().lower()
        result = self._character_lifecycle.delete(target)
        logger.info("[CharacterCatalog] Deleted character: %s", target)
        return result

    def get_voice_catalog(self) -> dict[str, Any]:
        return {"voices": self._voices.list()}

    def add_voice(self, specification: dict[str, Any]) -> dict[str, Any]:
        voice = self._voices.add(specification)
        logger.info("[VoiceRegistry] Registered voice pack: %s", voice["id"])
        return {"voice": voice}

    def get_model_catalog(self) -> dict[str, Any]:
        models = []
        models_dir = self._base_dir / "models" / "live2d-models"
        if models_dir.is_dir():
            for directory in sorted(models_dir.iterdir()):
                if not directory.is_dir():
                    continue
                model_json = next(directory.glob("*.model3.json"), None)
                models.append({
                    "id": directory.name,
                    "has_model3": model_json is not None,
                    "profile": (
                        self._base_dir / "config" / "avatar_profiles"
                        / f"{directory.name}.json"
                    ).is_file(),
                })
        return {"models": models}

    def register_model(self, model_id: str) -> dict[str, Any]:
        model = self._character_catalog.register_model(str(model_id or ""))
        logger.info("[CharacterCatalog] Registered model: %s", model["id"])
        return {"model": model}

    def switch_character(self, character_id: str) -> dict:
        """Switch the active character. Returns result dict."""
        if not character_id.strip():
            return {"error": "switch_character requires character_id"}

        try:
            result = self._runtime.switch_character(character_id)
            if "error" in result:
                logger.error("[Switch] Failed: %s", result["error"])
                return result

            info = self._runtime.get_character_info()
            char_name = info.get("name", "AI")

            # Re-init per-character state
            self.reinit_per_character()

            # Persist the active character so the next startup loads it.
            try:
                self._character_catalog.persist_default(character_id)
            except Exception as exc:
                logger.warning("[Switch] Failed to persist default character: %s", exc)

            # Reload prompts
            try:
                from app.prompts.loader import reload_cache as _reload_cache
                _reload_cache()
            except Exception:
                pass

            logger.info("[Switch] Character switched to: %s", char_name)

            return {
                "character_id": character_id,
                "character_name": char_name,
            }

        except Exception as e:
            logger.error("[Switch] Error: %s", e)
            return {"error": str(e)}

    def reload_prompts(self) -> None:
        """Reload prompt templates from disk."""
        try:
            from app.prompts.loader import reload_cache as _reload_cache
            _reload_cache()
            logger.info("[Prompts] Cache cleared")
        except Exception as e:
            logger.warning("[Prompts] Reload failed: %s", e)

    # ── Proactive system ─────────────────────────────────────────────

    def set_proactive(self, enabled: bool) -> None:
        """Enable or disable the proactive initiative system."""
        try:
            ic = getattr(self._runtime, "initiative_checker", None)
            if ic is not None:
                if enabled:
                    ic.start()
                    # Runtime is commonly constructed before uvicorn owns an
                    # asyncio loop, so its initial drain scheduling is a no-op.
                    # The frontend's enable command runs on the live loop and is
                    # the first reliable point to start the queue consumer.  The
                    # Runtime helper is idempotent when a drain is already alive.
                    self._runtime._start_initiative_drain()
                else:
                    ic.stop()
                logger.info("[Proactive] %s", "enabled" if enabled else "disabled")
            sw = getattr(self._runtime, "screen_watcher", None)
            if sw is not None:
                if enabled:
                    sw.start()
                elif not getattr(self._runtime, "_screen_vision_enabled", False):
                    # Screen vision may be the other reason the watcher runs.
                    sw.stop()
        except Exception as e:
            logger.error("[Proactive] Error: %s", e)

    def set_proactive_idle(self, seconds: int) -> None:
        """Set the idle threshold before AI proactively speaks (seconds)."""
        try:
            ic = getattr(self._runtime, "initiative_checker", None)
            if ic is not None:
                ic.idle_threshold = max(15, min(3600, seconds))
                logger.info("[Proactive] Idle threshold set to %ds", ic.idle_threshold)
        except Exception as e:
            logger.error("[Proactive] Error setting idle threshold: %s", e)

    def set_screen_vision(self, enabled: bool) -> None:
        """Enable or disable screen-frame grounding for proactive turns.

        Also drives the watcher lifecycle so the settings toggle actually
        produces frames: turn the watcher on with screen vision, and stop it on
        disable only when the proactive system does not still need it.
        """
        try:
            runtime = self._runtime
            if hasattr(runtime, "_screen_vision_enabled"):
                runtime._screen_vision_enabled = bool(enabled)
            watcher = getattr(runtime, "screen_watcher", None)
            if watcher is not None:
                if enabled:
                    watcher.start()
                elif not self._proactive_wants_watcher():
                    watcher.stop()
            logger.info("[ScreenVision] %s", "enabled" if enabled else "disabled")
        except Exception as e:
            logger.error("[ScreenVision] Error: %s", e)

    def _proactive_wants_watcher(self) -> bool:
        """The watcher also feeds proactive context, so it must keep running
        while the initiative system is active even when screen vision is off."""
        checker = getattr(self._runtime, "initiative_checker", None)
        return bool(getattr(checker, "_running", False))

    def set_vision_source(self, source: str, enabled: bool) -> None:
        """Enable or disable a visual source for user turns.

        Valid sources: ``voice_screen`` (attach a desktop frame to voice turns)
        and ``text_screen`` (attach a desktop frame to text turns). Camera
        sources (``voice_camera``/``text_camera``) are accepted for protocol
        compatibility but intentionally ignored — the frontend owns camera
        capture and upload end to end, and the old backend flags for them were
        write-only state that three code paths computed three different ways.
        """
        if source in {"voice_camera", "text_camera"}:
            logger.info("[VisionSource] %s ignored (frontend-owned)", source)
            return
        key = {
            "voice_screen": "_voice_screen_enabled",
            "text_screen": "_text_screen_enabled",
        }.get(source)
        if not key:
            logger.error("[VisionSource] Unknown source: %s", source)
            return
        try:
            runtime = self._runtime
            if hasattr(runtime, key):
                setattr(runtime, key, bool(enabled))
            logger.info("[VisionSource] %s=%s", source, "on" if enabled else "off")
        except Exception as e:
            logger.error("[VisionSource] Error: %s", e)


# Module-level singleton for convenience
_manager: RuntimeManager | None = None


def get_manager() -> RuntimeManager:
    """Get or create the shared RuntimeManager instance."""
    global _manager
    if _manager is None:
        _manager = RuntimeManager()
    return _manager
