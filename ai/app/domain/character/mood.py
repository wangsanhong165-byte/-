"""Character mood — long-term emotional trends."""

import time
from typing import Any


class MoodTrend:
    """Long-term mood trend for the character.

    Unlike EmotionState (immediate reaction to events), MoodTrend tracks
    a slower-moving baseline that shifts gradually based on accumulated
    emotional history. Mood influences reply style, initiative likelihood,
    and expression defaults.
    """

    VALID_MOODS = frozenset({
        "neutral", "bright", "melancholy", "energetic",
        "tired", "playful", "affectionate",
    })

    # Ordered list of moods from negative to positive valence
    _MOOD_SCALE = [
        "melancholy", "tired", "neutral", "playful", "bright",
    ]
    # Emotion → mood-valence shift. The immediate EmotionState accepts 40+
    # LLM emotion words; every HIGH-FREQUENCY one must land here or the long
    # mood freezes: delta 0 falls into the tiny decay branch and a stream of
    # joyful segments never moves the baseline off neutral (the gap this
    # table fill fixes — shirone's prompt_emotions were almost all holes).
    # Scale matches the original entries: ±0.1 felt, ±0.2 clear, ±0.3 strong,
    # ±0.4 overwhelming.
    _EMOTION_TO_MOOD_SHIFT = {
        # strong positive
        "joyful": 0.3, "cheerful": 0.25, "laughing": 0.3, "happy": 0.3,
        "blissful": 0.3, "love": 0.3, "playful": 0.2,
        # mild positive
        "smile": 0.2, "warm_smile": 0.2, "soft_smile": 0.15, "friendly": 0.15,
        "gentle": 0.1, "curious": 0.1, "surprised": 0.2,
        "lightly_surprised": 0.1, "shocked": 0.15, "startled": 0.1,
        "awkward_smile": 0.1, "awkward_grin": 0.1, "blushing": 0.15,
        "happy_closed": 0.15,
        # mild negative / deflating
        "shy": -0.1, "embarrassed": -0.1, "awkward": -0.1, "nervous": -0.15,
        "meek": -0.1, "pout": -0.15, "sigh": -0.15, "giving_up": -0.2,
        # strong negative
        "sad": -0.3, "cry": -0.35, "crying": -0.35, "worried": -0.2,
        "angry": -0.3, "jealous": -0.4, "panicked": -0.3,
        "cold": -0.15, "cold_stare": -0.2, "stern": -0.15, "serious": -0.1,
        # near-neutral: no shift, just decay
        "calm": 0.0, "neutral": 0.0, "blank": 0.0, "thinking": 0.0,
        "explaining": 0.0, "emphasizing": 0.0, "sleepy": -0.1,
        "dizzy": 0.0, "confused": -0.05,
    }

    def __init__(self, initial: str = "neutral"):
        self._current = initial if initial in self.VALID_MOODS else "neutral"
        self._valence: float = 0.0  # -1.0 to 1.0 cumulative
        self._history: list[dict[str, Any]] = []

    @property
    def current(self) -> str:
        return self._current

    def restore(self, valence: float, history: list | None = None, current: str | None = None) -> None:
        """Rehydrate persisted state — the single sanctioned write path for
        loading a saved mood. Clamps valence into its ±1.0 band; loading code
        poking _valence/_history directly bypassed the clamp. A persisted
        label (e.g. a manually `set` mood, whose valence may not match its
        band) wins over the valence-derived label."""
        self._valence = max(-1.0, min(1.0, float(valence)))
        self._history = list(history or [])[-20:]
        if current is not None and current in self.VALID_MOODS:
            self._current = current
        else:
            self._current = self._valence_to_mood()

    def set(self, mood: str, triggered_by: str = "") -> None:
        """Directly set the mood."""
        if mood not in self.VALID_MOODS:
            mood = "neutral"
        self._current = mood
        self._history.append({
            "mood": mood,
            "triggered_by": triggered_by or "manual",
            "valence": self._valence,
            "timestamp": time.time(),
        })

    def _valence_to_mood(self) -> str:
        """Map cumulative valence to a mood label."""
        if self._valence > 0.5:
            return "bright"
        if self._valence > 0.2:
            return "playful"
        if self._valence < -0.5:
            return "melancholy"
        if self._valence < -0.2:
            return "tired"
        return "neutral"

    def shift_from_emotion(self, emotion_name: str) -> None:
        """Apply the single canonical emotion-to-mood transition."""
        delta = self._EMOTION_TO_MOOD_SHIFT.get(emotion_name, 0.0)
        if delta == 0.0:
            self.decay(rate=0.02)
            return
        # Per-shift gain 0.25 (was 0.15): a 10-segment strongly-joyful reply
        # moves valence ~0.75 — one good conversation CAN cross a mood band
        # (bright), while drifting back still takes many neutral turns. This
        # is what "long-term trend" was documented to do; at 0.15 the mood
        # was effectively immobile.
        self._valence = max(-1.0, min(1.0, self._valence + delta * 0.25))
        new_mood = self._valence_to_mood()
        if new_mood != self._current:
            self._current = new_mood
            self._history.append({
                "mood": new_mood,
                "triggered_by": f"emotion_shift:{emotion_name}",
                "valence": self._valence,
                "timestamp": time.time(),
            })
            self._history = self._history[-20:]

    def decay(self, rate: float = 0.01) -> None:
        """Slowly drift character mood toward neutral."""
        if self._valence > 0:
            self._valence = max(0.0, self._valence - rate)
        elif self._valence < 0:
            self._valence = min(0.0, self._valence + rate)
        self._current = self._valence_to_mood()

    def to_dict(self) -> dict:
        return {
            "current": self._current,
            "valence": self._valence,
            "history": self._history[-20:],
        }
