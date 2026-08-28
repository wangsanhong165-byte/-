"""CharacterRuntime — the single owner and entry point for all turns.

Usage:
    from app.runtime.runtime import runtime
    from app.runtime.character_turn import TurnInput

    turn = await runtime.handle_turn(TurnInput(text="hello"))
"""

from __future__ import annotations

import asyncio
import json
import os
import logging
import time
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.core.initiative_queue import initiative_queue
from app.core.intent import compute_candidates, decide_action
from app.core.state import state_store as core_state_store
from app.runtime.character_turn import (
    CharacterTurn,
    TurnInput,
    TurnOrigin,
    TurnPhase,
)
from app.runtime.initiative import InitiativeCandidate, InitiativeQueue
from app.runtime.pipeline import Pipeline
from app.runtime.prompts import build_initiative_prompt
from app.runtime.state_store import state_store

logger = logging.getLogger("character_runtime")


class CharacterRuntime:
    """Central runtime. Holds a Pipeline and dispatches Events through it.

    Subclasses can override PROVIDER_BINDINGS to change which interfaces
    are resolved, or override _build_pipeline_steps() to change the
    pipeline step composition — all without modifying Runtime internals.
    """

    def __init__(self):
        self.pipeline = Pipeline()
        self.providers: dict = {}
        self.conversation = None  # set during _setup_pipeline
        self.initiative_checker = None  # InitiativeChecker, set during _setup_pipeline
        self.screen_watcher = None      # ScreenWatcher, set during _setup_pipeline
        self._character_registry = None
        self._conversations_by_character: dict[str, Any] = {}
        self._initiative_cooldown: float = 120.0
        self._last_initiative_time: float = 0.0
        self._initiative_queue = InitiativeQueue()
        self._turn_lock = None
        self._runtime_idle = True
        self._user_input_active = False
        self._screen_vision_enabled = True
        self._voice_camera_enabled = True
        self._voice_screen_enabled = True
        self._text_camera_enabled = False
        self._text_screen_enabled = False
        self._active_turn: CharacterTurn | None = None
        self._last_prompt_snapshot: dict[str, Any] | None = None
        self._initiative_task: Any = None  # asyncio Task for draining
        self._proactive_handlers: list[Callable[[CharacterTurn], Awaitable[None]]] = []
        self._initiative_memory_selector = None
        self._setup_pipeline()

    def _setup_pipeline(self):
        """Register default Steps and wire providers.

        Subclasses can override _get_provider_bindings() or
        _build_pipeline_steps() to customize without touching Runtime.
        """
        from app.providers.factory import ProviderFactory

        # Resolve providers from bindings
        for iface, key in self._get_provider_bindings():
            try:
                self.providers[key] = ProviderFactory.create(iface)
            except ValueError:
                self.providers[key] = self._fallback_provider(key.capitalize())

        # Build pipeline steps from factory
        from app.domain.character import Character
        from app.domain.conversation import Conversation

        character = self._load_character()
        from app.domain.character_self import CharacterSelf
        # Restore persisted dynamic state BEFORE constructing CharacterSelf so
        # the initial snapshot (and first-turn diff) reflects real state.
        memory_provider = self.providers.get("memory")
        if memory_provider is not None and hasattr(memory_provider, "restore_character"):
            memory_provider.restore_character(character)
        self.character_self = CharacterSelf(character)
        self.conversation = Conversation()
        self._conversations_by_character[character.id] = self.conversation
        core_state_store.set("character", character)

        for step in self._build_pipeline_steps(self.providers, character):
            if step is not None:
                if step.__class__.__name__ == "CharacterStep":
                    self._character_step = step
                self.pipeline.add(step)

        # Save to state store
        state_store.set("runtime_initialized", True)

        # Wire telemetry observer (logs events, doesn't block pipeline)
        from app.telemetry import TurnTelemetry

        def _log_telemetry(event):
            logger.debug("[Telemetry] %s | turn=%s | stage=%s | status=%s | %.1fms",
                         event.session_id, event.turn_id, event.stage,
                         event.status, event.duration_ms or 0)

        self.pipeline.set_telemetry_observer(_log_telemetry)

        # ── Background services ─────────────────────────────────────
        self._init_memory_ticker()
        self._init_initiative_system()
        self._init_screen_watcher()

    def _get_provider_bindings(self) -> list[tuple[type, str]]:
        """Return (InterfaceClass, provider_key) pairs for provider resolution.

        Override in subclass to add/remove capabilities. Each entry is
        resolved via ProviderFactory.create(InterfaceClass) and stored
        in self.providers under the given key name.
        """
        from app.interfaces.llm import LLMInterface
        from app.interfaces.tts import TTSInterface
        from app.interfaces.asr import ASRInterface
        from app.interfaces.memory import MemoryInterface
        from app.interfaces.tool import ToolInterface

        return [
            (LLMInterface, "llm"),
            (MemoryInterface, "memory"),
            (ToolInterface, "tool"),
            (TTSInterface, "tts"),
            (ASRInterface, "asr"),
        ]

    def _build_pipeline_steps(self, providers: dict, character: Any) -> list:
        """Return the ordered list of Pipeline steps.

        Override in subclass to recompose the pipeline (add/remove/reorder
        steps). Each element should be a Step instance or None (skipped).
        """
        from app.runtime.steps import (
            ASRStep, MemoryRetrieveStep, MemorySaveStep, CharacterStep,
            EmotionStep, DecisionStep, TTSStep, Live2DStep,
        )

        return [
            ASRStep(providers["asr"]),
            CharacterStep(character),
            MemoryRetrieveStep(providers["memory"]),
            DecisionStep(providers["llm"], tool_provider=providers["tool"]),
            EmotionStep(),
            TTSStep(providers["tts"]),
            Live2DStep(),
            MemorySaveStep(providers["memory"]),
        ]

    def switch_character(self, character_id: str) -> dict:
        """Switch the active character at runtime.

        Returns dict with keys: character_id, name, error (if failed).
        Bridge uses this instead of directly accessing CharacterRegistry.
        """
        from app.domain.character import Character

        try:
            if not self._runtime_idle:
                return {"character_id": character_id, "error": "runtime is processing a turn"}
            reg = self._character_registry
            if reg is None:
                from app.character.registry import CharacterRegistry
                reg = CharacterRegistry()
                self._character_registry = reg
            else:
                reg.refresh()
            card = reg.get(character_id)
            new_character = Character(card)
            memory_provider = self.providers.get("memory")
            if memory_provider is not None and hasattr(memory_provider, "restore_character"):
                memory_provider.restore_character(new_character)
            from app.domain.character_self import CharacterSelf
            new_character_self = CharacterSelf(new_character)
            from app.domain.conversation import Conversation
            new_conversation = self._conversations_by_character.get(character_id)
            if new_conversation is None:
                new_conversation = Conversation()

            # Commit only after every fallible load/restore step has succeeded.
            reg.activate(character_id)
            self.character_self = new_character_self
            self.conversation = new_conversation
            self._conversations_by_character[character_id] = new_conversation
            if hasattr(self, "_character_step"):
                self._character_step.set_character(new_character)
            core_state_store.set("character", new_character)
            self._last_prompt_snapshot = None
            name_map = card.get("name", {})
            name = (
                name_map.get("zh") or name_map.get("en") or card.get("id", "AI")
                if isinstance(name_map, dict)
                else str(name_map or card.get("id", "AI"))
            )
            if memory_provider is not None and hasattr(memory_provider, "activate_character"):
                memory_provider.activate_character(character_id)
            return {"character_id": character_id, "name": name}
        except Exception as exc:
            return {"character_id": character_id, "error": str(exc)}

    def get_character_info(self) -> dict:
        """Return current character info for the bridge.

        Returns dict with keys: character_id, name, card.
        """
        if self._character_registry is None:
            return {"character_id": "default", "name": "Assistant", "card": {}}
        cid = self._character_registry.active_id or ""
        card = self._character_registry.active or {}
        name_map = card.get("name", {})
        name = (
            name_map.get("zh") or name_map.get("en") or card.get("id", "AI")
            if isinstance(name_map, dict)
            else str(name_map or card.get("id", "AI"))
        )
        return {"character_id": cid, "name": name, "card": card}

    def _load_character(self) -> Character:
        """Load the active character from config."""
        from app.character.registry import CharacterRegistry
        from app.domain.character import Character

        try:
            self._character_registry = CharacterRegistry()
            card = self._character_registry.active
            return Character(card)
        except Exception:
            self._character_registry = None
            # Fallback: minimal character
            return Character({
                "id": "default",
                "name": {"zh": "助手", "en": "Assistant"},
                "system_prompt": "You are a helpful assistant.",
            })

    def _init_memory_ticker(self):
        """Initialize the memory provider's background tasks.

        Delegates entirely to the Memory provider's start() method, which
        manages MemoryStore startup, MemoryTicker lifecycle, and compiler
        setup internally.
        """
        memory_provider = self.providers.get("memory")
        if memory_provider is not None and hasattr(memory_provider, "start"):
            memory_provider.start(
                character_registry=self._character_registry,
                llm_provider=self.providers.get("llm"),
            )

    def _init_initiative_system(self):
        """Initialize InitiativeChecker — background proactive speech monitor.

        The checker runs in a daemon thread and only produces events.
        Dispatch happens via an asyncio Task on the main event loop,
        avoiding the thread/event-loop mismatch that broke initiative
        in earlier versions.
        """
        from app.services.initiative_checker import InitiativeChecker

        proactive, idle_cfg = self._load_proactive_settings()
        idle_sec = float(os.environ.get("INITIATIVE_IDLE_SEC", "300"))
        if idle_cfg is not None:
            idle_sec = idle_cfg
        check_sec = float(os.environ.get("INITIATIVE_CHECK_SEC", "15"))

        self.initiative_checker = InitiativeChecker(
            interval=check_sec,
            idle_threshold=idle_sec,
            character_getter=lambda: getattr(
                getattr(self, "_character_step", None), "character", None
            ),
        )
        self.initiative_checker.on_initiative = self._on_initiative
        # Gate startup on the persisted Proactive switch: if the user disabled
        # it, the checker stays stopped until the frontend re-enables it
        # (set_proactive(false) -> stop; true -> start).
        if proactive:
            self.initiative_checker.start()
        # Also start the initiative buffer expiry thread
        from app.core.initiative_buffer import initiative_buffer
        initiative_buffer.start_expiry()
        # Start the asyncio drain loop
        self._initiative_task = self._start_initiative_drain()

    def _load_proactive_settings(self, path: Path | None = None) -> tuple[bool, float | None]:
        """Read the persisted Proactive switch + idle seconds.

        Returns (proactive, idle_seconds_or_None). Defaults keep the current
        behavior (proactive enabled, idle from env) when settings.json is
        missing or malformed.
        """
        proactive = True
        idle: float | None = None
        try:
            path = path or (Path(__file__).resolve().parents[2] / "data" / "settings.json")
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8"))
                proactive = bool(data.get("proactive", True))
                raw_idle = data.get("proactiveIdleTime")
                if isinstance(raw_idle, (int, float)) and raw_idle >= 10:
                    idle = float(raw_idle)
        except (OSError, json.JSONDecodeError):
            pass
        return proactive, idle

    def register_proactive_handler(
        self, handler: Callable[[CharacterTurn], Awaitable[None]]
    ) -> None:
        """Register an async handler that receives proactive LLM responses.

        Called when the runtime generates a proactive reply (via InitiativeChecker).
        Handlers typically send the response to a WebSocket client.
        """
        self._proactive_handlers.append(handler)

    def unregister_proactive_handler(
        self, handler: Callable[[CharacterTurn], Awaitable[None]]
    ) -> None:
        """Remove a previously registered proactive handler."""
        if handler in self._proactive_handlers:
            self._proactive_handlers.remove(handler)

    def set_user_input_active(self, active: bool) -> None:
        """Block proactive dispatch while the user is recording or listening."""
        self._user_input_active = bool(active)
        if active and self.initiative_checker is not None:
            self.initiative_checker.touch()

    def _start_initiative_drain(self):
        """Schedule the initiative drain loop on the current event loop.

        Called during __init__ and also lazily retried on first handle_turn()
        in case the event loop wasn't running at import time.
        """
        import asyncio
        try:
            loop = asyncio.get_running_loop()
            # Don't create duplicate tasks
            if self._initiative_task is not None and not self._initiative_task.done():
                return self._initiative_task
            task = loop.create_task(self._drain_initiatives())
            self._initiative_task = task
            return task
        except RuntimeError:
            return None

    async def _drain_initiatives(self):
        """Periodically drain pending initiative prompts into typed turns.

        Runs as a background asyncio Task on the main event loop, so
        handle_turn() has a proper event loop context.
        """
        import asyncio
        while True:
            await asyncio.sleep(0.5)
            candidate = self._initiative_queue.pop_next(
                runtime_idle=self._runtime_idle and not self._user_input_active
            )
            if candidate is None:
                continue
            try:
                await self._dispatch_initiative(candidate)
            except Exception:
                logger.exception("Initiative turn failed")

    def _on_initiative(self, events: list) -> None:
        """Called by InitiativeChecker (in a daemon thread).

        Computes the initiative prompt and pushes it to a thread-safe
        list. The actual dispatch happens on the main event loop via
        _drain_initiatives() — no asyncio.run() in threads.
        """
        import time

        if self.providers.get("llm") is None:
            return

        # Cooldown check: prevent spamming from rapid screen_change events
        elapsed_since_last = time.time() - self._last_initiative_time
        if elapsed_since_last < self._initiative_cooldown and self._last_initiative_time > 0:
            return

        # Step 1: compute initiative candidates from live state
        idle = time.time() - self.initiative_checker._last_interaction
        ctx = core_state_store.snapshot()
        char = getattr(getattr(self, "_character_step", None), "character", None)
        if char is None:
            char = ctx.get("character") or core_state_store.get("character")
        mood_state = getattr(char, "mood", None)
        mood_data = mood_state.to_dict() if hasattr(mood_state, "to_dict") else {}
        mood_score = max(0.0, min(100.0, 50.0 + 50.0 * float(mood_data.get("valence", 0.0))))
        candidates = compute_candidates(
            idle, mood_score,
            activity=ctx.get("activity", ""),
            events=events,
            character_mood=str(getattr(getattr(char, "mood", None), "current", "")),
        )

        # Step 2: decide whether to speak
        candidate = decide_action(candidates)
        self._last_initiative_time = time.time()
        if candidate is None:
            return

        # Enrich the proactive topic with durable memory when one is valuable.
        memory_provider = self.providers.get("memory")
        store = getattr(memory_provider, "_store", None)
        char_id = getattr(char, "id", "") if char is not None else ""
        memory_topic = None
        if store is not None:
            from app.runtime.initiative_memory import InitiativeMemorySelector
            if self._initiative_memory_selector is None:
                self._initiative_memory_selector = InitiativeMemorySelector(store)
            memory_topic = self._initiative_memory_selector.select(char_id)
        if memory_topic:
            candidate = dict(candidate)
            candidate["topic"] = memory_topic["topic"]
            candidate["memory_reason"] = memory_topic["reason"]
            candidate["memory_id"] = memory_topic["memory_id"]

        # Step 3: use the same explicit reply language as normal turns.  A
        # character may expose translated display names without wanting to
        # speak those languages, so inferring this from persona.name is wrong.
        char = ctx.get("character") or core_state_store.get("character")
        char_lang = "zh"
        if char is not None:
            card = getattr(char, "raw_card", {})
            if isinstance(card, dict):
                configured_language = str(card.get("reply_language", "")).strip().lower()
                if configured_language:
                    char_lang = configured_language

        # Step 3b: get recent conversation summary for context
        recent_summary = ""
        if self.conversation is not None:
            history = self.conversation.get_history(limit=4)
            turns = []
            for msg in history:
                role = msg.get("role", "")
                content = msg.get("content", "")
                if role and content and role != "system":
                    label = "User" if role == "user" else "You"
                    turns.append(f"{label}: {content[:200]}")
            if turns:
                recent_summary = "\n".join(turns[-4:])

        # Step 4: build structured initiative prompt from intent
        prompt = build_initiative_prompt(
            candidate["type"], candidate["topic"],
            activity=ctx.get("activity", ""),
            app_name=ctx.get("context", ""),
            language=char_lang,
            recent_conversation=recent_summary,
        )

        initiative = {
            "intent": candidate["type"],
            "topic": candidate["topic"],
            "source_type": candidate.get("source_type", ""),
            "source_payload": candidate.get("source_payload", {}),
            "urgency": candidate.get("score", 0),
            "memory_reason": candidate.get("memory_reason", ""),
            "memory_id": candidate.get("memory_id"),
        }

        # Carry a freshly captured screen frame (if any) into the proactive
        # turn so Aurora can ground its initiative in what is on the desktop.
        if self._screen_vision_enabled:
            screen_frame = self._first_screen_frame(events)
            if screen_frame is not None:
                initiative["visual_attachment"] = screen_frame

        self._initiative_queue.enqueue(
            InitiativeCandidate.create(
                source="initiative_checker",
                topic=str(candidate["topic"]),
                priority=float(candidate.get("score", 0)),
                freshness=1.0,
                ttl_seconds=max(30.0, self._initiative_cooldown),
                payload={"prompt": prompt, "initiative": initiative},
            )
        )

    @staticmethod
    def _first_screen_frame(events: list) -> dict | None:
        """Return the first valid screen_watcher visual attachment in events."""
        for event in events:
            payload = getattr(event, "payload", None)
            if not isinstance(payload, dict):
                continue
            frame = payload.get("visual_attachment")
            if isinstance(frame, dict) and frame.get("id"):
                return frame
        return None

    async def _dispatch_initiative(self, pending: InitiativeCandidate) -> None:
        """Create and dispatch an INITIATIVE_TRIGGERED event."""
        prompt = str(pending.payload.get("prompt", pending.topic))
        initiative = dict(pending.payload.get("initiative", {}))

        visual_attachments: tuple[dict, ...] = ()
        screen_frame = initiative.get("visual_attachment")
        if isinstance(screen_frame, dict) and screen_frame.get("id"):
            try:
                from app.runtime.visual_attachments import VisualAttachmentStore

                resolved = VisualAttachmentStore().resolve(
                    str(screen_frame["id"])
                ).to_public_dict()
                visual_attachments = (resolved,)
            except Exception:
                # The frame may have expired or been cleaned up; still speak.
                visual_attachments = ()

        turn = await self.handle_turn(
            TurnInput(
                text=prompt,
                origin=TurnOrigin.INITIATIVE,
                visual_attachments=visual_attachments,
                metadata={"initiative": initiative},
            )
        )

        if not turn.error and turn.reply_text:
            initiative = turn.initiative
            memory_id = initiative.get("memory_id")
            if memory_id is not None:
                memory_provider = self.providers.get("memory")
                store = getattr(memory_provider, "_store", None)
                character = turn.character
                if store is not None and character is not None:
                    store.mark_initiative_used(character.id, memory_id)

            # Track only successful speech in the initiative buffer.  Failed
            # proactive attempts must remain observable but must not pollute
            # conversational closure or durable memory policy.
            from app.core.initiative_buffer import initiative_buffer
            initiative_buffer.push(turn.reply_text[:80], turn.reply_text)

        # Push both success and failure through the same typed lifecycle.  The
        # transport emitter turns failed turns into turn.failed/runtime.idle;
        # silently returning here previously left the UI looking unresponsive.
        for handler in self._proactive_handlers:
            try:
                await handler(turn)
            except Exception:
                logger.exception("Proactive response handler failed")

    def _init_screen_watcher(self):
        """Initialize ScreenWatcher — background active window monitor.

        Captures foreground window changes and pushes events to the
        initiative queue for the checker to process.
        """
        from app.services.screen_watcher import ScreenWatcher

        self.screen_watcher = ScreenWatcher(interval=5.0)

        def on_screen_change(old: dict, new: dict) -> None:
            app = new.get("app", "").lower()
            # Auto-infer activity from app
            activity = ScreenWatcher._APP_ACTIVITY_MAP.get(app, "idle")
            core_state_store.update(activity=activity, context=app)
            visual_attachment = new.get("visual_attachment")
            # Push to initiative queue
            initiative_queue.push(
                "screen_change",
                {"from_app": old.get("app", ""), "to_app": new.get("app", ""),
                 "from_title": old.get("title", ""), "to_title": new.get("title", ""),
                 "inferred_activity": activity,
                 "visual_attachment": visual_attachment},
                priority=2,
            )

        self.screen_watcher.on_context_change = on_screen_change
        self.screen_watcher.start()

    def shutdown(self):
        """Gracefully shut down background tasks (memory, initiative, screen, etc.)."""
        # Memory provider shuts down its own ticker + store
        memory_provider = self.providers.get("memory")
        if memory_provider is not None and hasattr(memory_provider, "shutdown"):
            memory_provider.shutdown()
        # Initiative + screen services
        if self.initiative_checker is not None:
            self.initiative_checker.stop()
            self.initiative_checker = None
        if self._initiative_task is not None:
            self._initiative_task.cancel()
            self._initiative_task = None
        if self.screen_watcher is not None:
            self.screen_watcher.stop()
            self.screen_watcher = None
        from app.core.initiative_buffer import initiative_buffer
        initiative_buffer.stop_expiry()

    @staticmethod
    def _fallback_provider(name: str):
        """Return a minimal fallback when no provider is registered."""
        from app.interfaces.llm import LLMResponse

        class _Fallback:
            async def generate(self, *a, **kw): return LLMResponse()
            async def generate_stream(self, *a, **kw): yield ""
            async def synthesize(self, *a, **kw): return b""
            async def speak(self, *a, **kw): return ""
            async def transcribe(self, *a, **kw): return ""
            async def store(self, *a, **kw): pass
            async def retrieve(self, *a, **kw): return []
            async def consolidate(self, *a, **kw): pass
            async def summarize(self, *a, **kw): return ""
            async def forget(self, *a, **kw): return 0
            async def execute(self, *a, **kw): return ""
            async def list_tools(self, *a, **kw): return []
            async def set_expression(self, *a, **kw): pass
        return _Fallback()

    async def handle_turn(
        self,
        turn_input: TurnInput,
        status_callback=None,
        confirmation_callback=None,
    ) -> CharacterTurn:
        """Run one typed character turn through the complete pipeline.

        Args:
            turn_input: Typed user, speech, tool, system, or initiative input.
            status_callback: Optional async callable called with status strings
                             during pipeline execution (e.g., tool calls).

        Returns the completed or failed CharacterTurn.
        """
        started_at = time.perf_counter()
        import asyncio
        if self._turn_lock is None:
            self._turn_lock = asyncio.Lock()
        async with self._turn_lock:
            self._runtime_idle = False
            try:
                return await self._handle_turn_locked(
                    turn_input,
                    status_callback=status_callback,
                    confirmation_callback=confirmation_callback,
                    started_at=started_at,
                )
            finally:
                self._runtime_idle = True
                self._active_turn = None

    async def _handle_turn_locked(
        self,
        turn_input: TurnInput,
        *,
        status_callback,
        confirmation_callback,
        started_at: float,
    ) -> CharacterTurn:
        """Execute a turn while the runtime ownership lock is held."""
        # Ensure drain loop is running (retry after import-time failure
        # when no event loop was available).
        if self._initiative_task is None or self._initiative_task.done():
            self._start_initiative_drain()

        from app.telemetry import TurnTelemetry, get_session_id

        turn = CharacterTurn(
            input=turn_input,
            turn_id=turn_input.turn_id or uuid.uuid4().hex,
            status_callback=status_callback,
            confirmation_callback=confirmation_callback,
            session_id=turn_input.session_id or get_session_id(),
            telemetry=TurnTelemetry(
                session_id=turn_input.session_id or get_session_id(),
                turn_id="",
                parent_span_id="",
            ),
        )
        # Ensure telemetry turn_id matches the CharacterTurn turn_id
        if turn.telemetry:
            turn.telemetry.turn_id = turn.turn_id
            turn.telemetry.record("turn.started", metadata={"origin": turn.input_origin})
        self._active_turn = turn
        turn.transition_to(TurnPhase.PROCESSING)

        if turn_input.origin is TurnOrigin.USER:
            if self.initiative_checker is not None:
                self.initiative_checker.touch()

        turn.conversation = self.conversation
        turn.character_self = self.character_self
        self.character_self.begin_turn()

        # Track turn count in state store
        turn_count = state_store.get("turn_count", 0)
        state_store.set("turn_count", turn_count + 1)
        turn.turn_count = turn_count + 1

        try:
            turn = await self.pipeline.run(turn)
        except asyncio.CancelledError:
            self.character_self.rollback_turn()
            raise
        except Exception:
            self.character_self.rollback_turn()
            raise

        if turn.prompt_messages:
            self._last_prompt_snapshot = {
                "turn_id": turn.turn_id,
                "created_at": turn.created_at,
                "character_id": str(getattr(turn.character, "id", "")),
                "messages": deepcopy(turn.prompt_messages),
                "source_ids": list(turn.prompt_sources),
                "context_budget": deepcopy(turn.context_budget),
            }

        # Notify memory provider for background processing (ticker, etc.)
        memory_provider = self.providers.get("memory")
        usage = turn.llm_usage
        store = getattr(memory_provider, "_store", None)
        character = turn.character
        if usage and store is not None and hasattr(store, "record_usage"):
            try:
                store.record_usage(
                    getattr(character, "id", ""),
                    usage,
                    turn.context_budget,
                )
            except Exception:
                logger.exception("Usage ledger persistence failed")
                turn.warnings.append("usage_ledger_save_failed")
        if memory_provider is not None and not turn.error and hasattr(memory_provider, "notify_turn"):
            try:
                memory_provider.notify_turn(getattr(character, "id", ""))
            except Exception:
                logger.exception("Memory background notification failed")
                turn.warnings.append("memory_notification_failed")

        if not turn.error:
            try:
                committed_state = self.character_self.commit_turn(
                    turn.user_text or turn.event.payload.get("display_text", ""),
                    learned=turn.learned_memories,
                )
            except Exception:
                self.character_self.rollback_turn()
                raise
            if store is not None and hasattr(store, "save_character_state"):
                try:
                    store.save_character_state(
                        getattr(character, "id", ""),
                        committed_state,
                    )
                except Exception:
                    logger.exception("Character state persistence failed")
                    turn.warnings.append("character_state_save_failed")
            turn.transition_to(TurnPhase.COMPLETED)
            if turn.telemetry:
                turn.telemetry.record("turn.completed", duration_ms=turn.metrics.get("e2e_latency_ms"))
        else:
            self.character_self.rollback_turn()
            if turn.telemetry:
                turn.telemetry.record("turn.failed", error_code=turn.error.code if turn.error else "unknown", metadata={"message": str(turn.error) if turn.error else ""})
        turn.metrics["e2e_latency_ms"] = (time.perf_counter() - started_at) * 1000
        try:
            from app.runtime.turn_recorder import get_turn_recorder
            get_turn_recorder().record(turn)
        except Exception:
            logger.exception("Turn trace persistence failed")
        return turn


# Module-level singleton
runtime = CharacterRuntime()
