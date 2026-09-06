"""Durable character-state aggregate with explicit commit semantics."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import time
from typing import Any


@dataclass(frozen=True)
class CharacterSelfChange:
    state: dict[str, Any]


class CharacterSelf:
    """Own all durable persona-state mutations and commit semantics."""

    def __init__(self, character: Any):
        self.character = character
        self.character_id = str(getattr(character, "id", ""))
        self._state = deepcopy(character.dynamic_state())
        self._turn_baseline: dict[str, Any] | None = None

    def snapshot(self) -> dict[str, Any]:
        return deepcopy(self._state)

    def sync_from_character(self) -> None:
        """Adopt direct domain changes made by learning or other providers."""
        self._state = deepcopy(self.character.dynamic_state())

    def begin_turn(self) -> None:
        """Open one rollback boundary around all mutations in a runtime turn."""
        if self._turn_baseline is not None:
            raise RuntimeError("character turn transaction is already active")
        self._turn_baseline = self.snapshot()

    def commit_turn(
        self,
        user_text: str,
        *,
        learned: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Commit the completed turn and return its single durable snapshot."""
        previous = deepcopy(self._turn_baseline or self._state)
        self.sync_from_character()
        self.record_interaction(user_text, learned=learned, previous_state=previous)
        self._turn_baseline = None
        return self.snapshot()

    def rollback_turn(self) -> None:
        """Restore the exact pre-turn domain state after any pipeline failure."""
        if self._turn_baseline is None:
            return
        baseline = deepcopy(self._turn_baseline)
        self.character.restore_dynamic_state(baseline)
        self._state = baseline
        self._turn_baseline = None

    def stage(self, updates: dict[str, Any]) -> CharacterSelfChange:
        candidate = self.snapshot()
        candidate.update(deepcopy(updates))
        return CharacterSelfChange(state=candidate)

    def commit(self, change: CharacterSelfChange) -> None:
        self.character.restore_dynamic_state(deepcopy(change.state))
        self._state = deepcopy(change.state)

    def commit_emotion(self, emotion: str, *, intensity: float) -> None:
        """Commit immediate emotion and its slow mood effect atomically."""
        emotion_state = getattr(self.character, "emotion", None)
        valid = getattr(emotion_state, "VALID_EMOTIONS", None) if emotion_state is not None else None
        if valid and emotion not in valid:
            emotion = "neutral"
        if hasattr(self.character, "emotion") and hasattr(self.character, "mood"):
            self.character.emotion.current = emotion
            self.character.emotion.set_intensity(intensity)
            self.character.mood.shift_from_emotion(emotion)
            self.sync_from_character()
            return

        # Minimal domain doubles still use the canonical MoodTrend transition.
        from app.domain.character.mood import MoodTrend

        state = self.snapshot()
        state["emotion"] = {
            "current": emotion,
            "intensity": max(0.0, min(1.0, float(intensity))),
        }
        previous = dict(state.get("mood", {}))
        trend = MoodTrend(str(previous.get("current", "neutral")))
        trend.restore(
            valence=float(previous.get("valence", 0.0)),
            history=list(previous.get("history", []))[-20:],
        )
        trend.shift_from_emotion(emotion)
        state["mood"] = trend.to_dict()
        self.commit(CharacterSelfChange(state=state))

    def adjust_affinity(self, delta: float) -> None:
        self.character.relationship.update_affinity(delta)
        self.sync_from_character()

    def set_explicit_preference(self, topic: str, valence: float) -> None:
        self.character.preferences.set_explicit(topic, valence)
        self.sync_from_character()

    def ensure_goal(self, description: str, *, priority: int = 0) -> None:
        if not any(goal.description == description for goal in self.character.goals.active):
            self.character.goals.add(description, priority=priority)
            self.sync_from_character()

    def record_interaction(
        self,
        user_text: str,
        *,
        learned: list[dict[str, Any]] | None = None,
        previous_state: dict[str, Any] | None = None,
    ) -> None:
        """Record only observable, recent interaction context for the user view."""
        # Seed from the previously committed snapshot so the tracking fields
        # (recent_focus/recent_changes/last_interaction/interaction_count) are
        # preserved across turns; then overlay the live emotion/mood/... state,
        # which dynamic_state() alone does not contain.
        state = deepcopy(previous_state if previous_state is not None else self.snapshot())
        live = self.character.dynamic_state()
        for key in ("emotion", "mood", "relationship", "goals", "preferences"):
            if key in live:
                state[key] = live[key]
        text = " ".join(str(user_text or "").split())[:160]
        existing_focus = [
            str(item)
            for item in state.get("recent_focus", [])
            if str(item).strip()
        ]
        if text:
            current_focus = f"刚刚聊到：{text}"
            focus = [current_focus, *(
                item for item in existing_focus if item != current_focus
            )]
            state["last_interaction"] = text
        else:
            focus = existing_focus
            state["last_interaction"] = ""

        previous = previous_state or {}
        previous_emotion = str((previous.get("emotion") or {}).get("current", ""))
        current_emotion = str((state.get("emotion") or {}).get("current", ""))
        changes = [str(item) for item in state.get("recent_changes", []) if str(item).strip()]
        if previous_emotion and current_emotion and previous_emotion != current_emotion:
            changes.insert(0, f"表达从{previous_emotion}变为{current_emotion}")
        for item in learned or []:
            content = str(item.get("content", "")).strip()
            if content:
                changes.insert(0, f"记住了：{content[:120]}")

        state["recent_focus"] = focus[:6]
        state["recent_changes"] = changes[:6]
        state["last_interaction_at"] = time.time()
        state["interaction_count"] = int(state.get("interaction_count", 0) or 0) + 1
        self.commit(CharacterSelfChange(state=state))
