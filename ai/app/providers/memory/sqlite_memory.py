"""SQLite-backed MemoryInterface implementation.

Wraps app.memory.store.MemoryStore, app.memory.ticker.MemoryTicker, and
app.memory.compiler to provide persistent memory for the Runtime pipeline.
Manages its own background ticker lifecycle — Runtime only calls start()/shutdown().
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from app.interfaces.memory import MemoryInterface

logger = logging.getLogger("sqlite-memory")


class SQLiteMemory(MemoryInterface):
    """MemoryInterface backed by SQLite (MemoryStore) + ticker + compiler.

    Stores conversation turns to the logs table and retrieves structured
    memories plus non-overlapping compiled/rolling context.
    Falls back to in-memory list if SQLite init fails.

    Lifecycle:
        start() — opens the store, starts MemoryTicker, sets active character
        shutdown() — stops the ticker and memory store
    """

    def __init__(self, store: Any = None):
        self._store: Any = store
        self._ticker: Any = None
        self._fallback: list[dict] = []
        self._fallback_reason = ""
        self._character_registry: Any = None
        self._llm_adapter: Any = None
        if store is None:
            try:
                from app.memory.store import MemoryStore
                self._store = MemoryStore()
            except Exception as exc:
                logger.warning("SQLiteMemory init failed, using in-memory fallback: %s", exc)
                self._store = None
                self._fallback_reason = str(exc)

    def diagnostics(self) -> dict[str, Any]:
        """Expose whether memory is durable instead of hiding fallback mode."""
        if self._store is None:
            return {
                "status": "degraded",
                "persistent": False,
                "mode": "memory_fallback",
                "reason": self._fallback_reason or "SQLite store unavailable",
            }
        return {
            "status": "ready",
            "persistent": True,
            "mode": "sqlite",
            "reason": "",
        }

    def start(self, character_registry: Any = None, llm_provider: Any = None) -> None:
        """Initialize MemoryStore + MemoryTicker + character compiler context.

        Called once by Runtime after all providers are resolved.
        Parameters:
            character_registry: Character registry with active_id, on_activate.
            llm_provider: LLM interface provider (used to extract sync adapter
                          for the background ticker thread).
        """
        self._character_registry = character_registry
        from app.memory import (
            set_compiler_llm,
            set_active_char,
        )

        # Ensure memory store is initialized
        if self._store is not None and hasattr(self._store, "start"):
            self._store.start()

        # Get sync LLM adapter for the ticker
        llm_adapter = self._get_ticker_adapter(llm_provider)
        self._llm_adapter = llm_adapter
        if llm_adapter is not None:
            set_compiler_llm(llm_adapter)

        # Create and start the ticker
        from app.memory.ticker import MemoryTicker
        self._ticker = MemoryTicker(
            llm_adapter,
            character_ids_getter=(
                character_registry.list_ids
                if character_registry is not None
                and hasattr(character_registry, "list_ids")
                else None
            ),
            store=self._store,
        )
        self._ticker.start()

        # Set initial character in compiler
        if character_registry is not None:
            cid = getattr(character_registry, "active_id", None)
            all_ids = character_registry.list_ids()
            if self._store is not None:
                # Claim the empty-scope legacy pool once for the active
                # character, but backfill legacy facts for EVERY character -
                # otherwise non-active characters' facts stay permanently
                # invisible now that retrieve no longer reads the facts table.
                for char_id in all_ids:
                    if char_id:
                        self._store.backfill_legacy_facts(character_id=char_id)
                if cid:
                    self._store.claim_legacy_scope(cid)
            if cid:
                set_active_char(cid)
                self.activate_character(cid)
            self._ticker.recover(all_ids)

    def shutdown(self) -> None:
        """Stop ticker and memory store gracefully."""
        if self._ticker is not None:
            self._ticker.stop(wait=False)
            self._ticker = None
        if self._store is not None and hasattr(self._store, "stop"):
            self._store.stop(wait=False)

    def notify_turn(self, character_id: str = "") -> None:
        """Forward turn notification to the ticker (if running)."""
        if self._ticker is not None:
            self._ticker.notify_turn(character_id)

    def on_session_end(self, character_id: str = "") -> None:
        """Final memory extraction for a session that is closing.

        Best-effort and non-blocking: the ticker runs it in a background
        thread and it no-ops when there are no unprocessed turns. Callers are
        history creation/loading and WebSocket disconnect.
        """
        if self._ticker is not None:
            self._ticker.on_session_end(character_id)

    def activate_character(self, character_id: str) -> None:
        """Update compiler context and regenerate off the caller thread."""
        from app.memory.compiler import set_active_char

        set_active_char(character_id)
        if self._ticker is not None:
            self._ticker.regenerate(character_id)

    @staticmethod
    def _get_ticker_adapter(llm_provider: Any) -> Any:
        """Extract or create a sync LLM adapter for the background ticker thread.

        The ticker runs in a daemon thread and needs a synchronous adapter with
        generate_text(). Priority:
          1. Reuse the LLM provider's internal sync adapter if available
          2. Create a standalone OpenAILLMAdapter if API key is configured
          3. Return None (ticker skips LLM-dependent work)
        """
        # Try to extract sync adapter from the LLM provider
        if llm_provider is not None:
            adapter = getattr(llm_provider, "_adapter", None)
            if adapter is not None and hasattr(adapter, "generate_text"):
                return adapter

        # Fallback: create standalone adapter from env config
        api_key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY")
        if api_key:
            try:
                from app.models.http_adapters import OpenAILLMAdapter
                return OpenAILLMAdapter()
            except Exception:
                return None
        return None

    async def store(self, event_type: str, data: dict) -> None:
        if self._store is not None:
            if event_type == "conversation_turn":
                user_text = data.get("user", "")
                assistant_text = data.get("assistant", "")
                if user_text or assistant_text:
                    reply = {
                        "reply_text": assistant_text,
                        "intent": (
                            "initiative"
                            if data.get("origin") == "initiative"
                            else data.get("intent", "conversation")
                        ),
                    }
                    from app.memory.compiler import get_active_char_id
                    char_id = data.get("character_id", get_active_char_id() or "default")
                    committed = self._store.log_turn(
                        user_text,
                        reply,
                        character_id=char_id,
                        turn_id=str(data.get("turn_id", "")),
                        write_token=str(data.get("write_token", "")),
                        history_uid=str(data.get("history_uid", "")),
                        metadata={"visual": data.get("visual", {})},
                    )
                    if not committed:
                        data["idempotent_replay"] = True
                        return
                    character = data.get("character")
                    if character is not None and user_text:
                        from app.runtime.character_learning import learn_from_turn
                        character_self = data.get("character_self")
                        data["learned_memories"] = learn_from_turn(
                            character,
                            user_text,
                            self._store,
                            character_self=character_self,
                        )
                        # Direct provider callers have no Runtime transaction;
                        # Runtime callers pass CharacterSelf and commit once.
                        if character_self is None:
                            self._store.save_character_state(
                                character.id, character.dynamic_state()
                            )
        else:
            self._fallback.append({"event_type": event_type, "data": data})

    async def retrieve(
        self, query: str, limit: int = 10, *,
        character_id: str = "", event_type: str = "",
        input_origin: str = "user",
    ) -> list[dict]:
        results: list[dict] = []

        if self._store is not None:
            # 0. Structured hybrid memories (semantic/lexical/importance/recency)
            structured = self._store.search_memories(
                query, character_id=character_id, limit=max(3, limit // 2)
            )
            for memory in structured:
                results.append({
                    "type": memory.get("memory_type", "memory"),
                    "data": {
                        "content": memory.get("content", ""),
                        "score": memory.get("score", 0),
                        "reasons": memory.get("reasons", []),
                    },
                    "source": "hybrid",
                })
            # Raw logs are intentionally not injected here: the exact recent
            # tail already comes from Conversation, and older history is
            # represented by the rolling summary.  This prevents the same turn
            # entering the prompt as verbatim + search hit + summary.

            # Compiled memory context (if available).
            # Cap at 4000: memory.md is a 4-section file (facts/today/week/
            # longterm); the old 1500-char cap cut off the 长期情况 section
            # before it ever reached the LLM.
            from app.memory.compiler import get_prompt_compiled_memory
            compiled = get_prompt_compiled_memory(character_id)
            if compiled:
                results.append({
                    "type": "compiled",
                    "data": {"content": compiled[:4000]},
                    "source": "compiler",
                })

            # Rolling conversation summary (per-character, appended LAST so
            #    the results[0] type contract is unchanged).
            from app.memory.compiler import get_conversation_summary
            summary = get_conversation_summary(character_id)
            if summary:
                results.append({
                    "type": "conversation_summary",
                    "data": {"content": summary[:800]},
                    "source": "rolling_summary",
                })
            else:
                # Rolling summary not generated yet (fresh session / right
                # after restart): fall back to a bounded raw-log recall so
                # recent context is not lost before the first extraction cycle.
                for l in self._store.search_logs(
                    query, limit=5, character_id=character_id
                ):
                    results.append({
                        "type": "log",
                        "data": {"content": l.get("content", ""), "role": l.get("role", "")},
                        "source": "sqlite",
                    })
        else:
            # Fallback: return recent entries from in-memory list
            for entry in self._fallback[-limit:]:
                results.append({
                    "type": "memory",
                    "data": entry.get("data", {}),
                    "source": "fallback",
                })

        return results

    def restore_character(self, character: Any) -> None:
        if self._store is not None and character is not None:
            character.restore_dynamic_state(
                self._store.load_character_state(getattr(character, "id", ""))
            )

    async def consolidate(self) -> None:
        if self._store is not None:
            # FTS rebuild is a blocking write; keep it off the voice-loop
            # event loop thread (same pattern as forget's extract-before-delete).
            await asyncio.to_thread(self._store.rebuild_index)

    async def summarize(self, since: str) -> str:
        from app.memory.compiler import get_compiled_memory
        compiled = get_compiled_memory()
        if compiled:
            return compiled[:2000]
        if self._fallback:
            return f"{len(self._fallback)} events in memory."
        return "No compiled memory available."

    async def forget(self, before: str) -> int:
        if self._store is None:
            return 0
        try:
            total = 0
            # Run the salvage LLM call off the event loop so the voice loop
            # never blocks on a 20s extraction timeout.
            await asyncio.to_thread(self._extract_before_delete, before)
            total += self._store.delete_logs_before(before)
            total += self._store.delete_facts_before(before)
            return total
        except Exception:
            return 0

    def _extract_before_delete(self, before: str) -> None:
        """Extract durable facts from logs about to be deleted (extract-before-destroy).

        Runs only when an LLM adapter is available; never touches the logs table
        itself, so the extractor's own activity cannot re-enter recent_turns.
        Salvaged facts are attributed to each log row's OWN character, never to
        the currently active one, so cross-character forgets stay correct.
        """
        if not self._llm_adapter or self._store is None:
            return
        try:
            from app.memory.extractor import extract_from_turns
            turns = self._store.logs_before(before, limit=40)
            if not turns:
                return
            by_char: dict[str, list] = {}
            for t in turns:
                cid = str(t.get("character_id", "")) or ""
                by_char.setdefault(cid, []).append(t)
            for cid, group in by_char.items():
                extract_from_turns(
                    group, self._llm_adapter, character_id=cid, store=self._store
                )
        except Exception:
            logger.exception("extract-before-delete failed")
