"""High-level character intent contract. Never contains renderer or Cubism data."""
from dataclasses import asdict, dataclass
from collections.abc import Iterable
from typing import Any

from app.runtime.semantic_performance import normalize_motion_plan

EMOTIONS = {
    "neutral", "calm", "happy", "joyful", "playful", "love", "shy",
    "embarrassed", "surprised", "confused", "worried", "sad", "cry",
    "angry", "pout", "blank", "cheerful", "smile", "laughing",
    "dizzy", "sleepy", "crying", "blushing",
}
BEHAVIORS = {"greet", "listen", "think", "speak", "agree", "disagree", "laugh", "idle", "comfort", "wave", "nod", "tilt", "shrug"}
ATTENTIONS = {"user", "screen", "away", "neutral"}

# 2026-09-05 protocol slimming: naturalVAD is no longer an LLM output field.
# The commander states WHAT she feels (emotion); the affect dimensions are
# derived locally from this static table so downstream consumers (VAD posture,
# FACS face, energy gain) keep their inputs unchanged.
EMOTION_VAD: dict[str, dict[str, float]] = {
    "neutral": {"valence": 0.0, "arousal": 0.0, "dominance": 0.0},
    "calm": {"valence": 0.35, "arousal": -0.45, "dominance": 0.25},
    "blank": {"valence": 0.0, "arousal": -0.3, "dominance": 0.0},
    "happy": {"valence": 0.6, "arousal": 0.35, "dominance": 0.25},
    "joyful": {"valence": 0.8, "arousal": 0.75, "dominance": 0.35},
    "cheerful": {"valence": 0.75, "arousal": 0.6, "dominance": 0.3},
    "smile": {"valence": 0.5, "arousal": 0.2, "dominance": 0.2},
    "laughing": {"valence": 0.8, "arousal": 0.8, "dominance": 0.3},
    "playful": {"valence": 0.65, "arousal": 0.5, "dominance": 0.35},
    "love": {"valence": 0.7, "arousal": 0.25, "dominance": 0.1},
    "shy": {"valence": 0.25, "arousal": -0.25, "dominance": -0.4},
    "embarrassed": {"valence": 0.1, "arousal": 0.2, "dominance": -0.45},
    "blushing": {"valence": 0.25, "arousal": 0.1, "dominance": -0.4},
    "surprised": {"valence": 0.2, "arousal": 0.75, "dominance": -0.15},
    "confused": {"valence": -0.15, "arousal": 0.25, "dominance": -0.3},
    "dizzy": {"valence": -0.1, "arousal": 0.3, "dominance": -0.4},
    "worried": {"valence": -0.4, "arousal": 0.3, "dominance": -0.25},
    "sad": {"valence": -0.6, "arousal": -0.45, "dominance": -0.3},
    "cry": {"valence": -0.7, "arousal": 0.1, "dominance": -0.35},
    "crying": {"valence": -0.7, "arousal": 0.1, "dominance": -0.35},
    "angry": {"valence": -0.55, "arousal": 0.7, "dominance": 0.25},
    "pout": {"valence": -0.3, "arousal": 0.05, "dominance": -0.35},
    "sleepy": {"valence": 0.05, "arousal": -0.6, "dominance": -0.1},
}
@dataclass(frozen=True)
class CharacterIntent:
    emotion: str = "neutral"
    behavior: str = ""
    intensity: float = 0.5
    attention: str = "user"
    energy: float = 0.5
    duration_ms: int | None = None
    natural_vad: dict[str, float] | None = None
    context_tags: tuple[str, ...] = ()
    motion_plan: dict[str, Any] | None = None
    # 2026-09-05 dual-emotion: the surface emotion the words project plus the
    # (optional) true feeling that leaks through — 口是心非. Same emotion
    # vocabulary, validated against allowed_emotions, None when sincere.
    leak: str | None = None

    @classmethod
    def from_llm_segment(
        cls,
        segment: dict[str, Any] | None,
        intensity: float = 0.5,
        *,
        allowed_emotions: Iterable[str] | None = None,
    ) -> "CharacterIntent":
        segment = segment if isinstance(segment, dict) else {}
        emotion = str(segment.get("emotion", "neutral")).lower()
        behavior = str(segment.get("behavior", "")).lower()
        attention = str(segment.get("attention", "user")).lower()
        raw_intensity = cls._bounded_float(segment.get("intensity", intensity), intensity)
        raw_energy = cls._bounded_float(segment.get("energy", raw_intensity), raw_intensity)
        duration = segment.get("durationMs")
        raw_tags = segment.get("contextTags", segment.get("context_tags", ()))
        tags = tuple(dict.fromkeys(
            tag.strip().lower() for tag in raw_tags
            if isinstance(tag, str) and tag.strip()
        ))[:8] if isinstance(raw_tags, (list, tuple)) else ()
        accepted_emotions = cls._accepted_emotions(allowed_emotions)
        resolved_emotion = emotion if emotion in accepted_emotions else "neutral"
        natural_vad = dict(EMOTION_VAD.get(resolved_emotion, EMOTION_VAD["neutral"]))
        raw_leak = str(segment.get("leak", "") or "").lower()
        leak = raw_leak if raw_leak in accepted_emotions and raw_leak != resolved_emotion else None
        return cls(
            emotion=resolved_emotion,
            behavior=behavior if behavior in BEHAVIORS else "",
            intensity=raw_intensity,
            attention=attention if attention in ATTENTIONS else "user",
            energy=raw_energy,
            duration_ms=int(duration) if isinstance(duration, (int, float)) and not isinstance(duration, bool) and 0 < duration <= 10000 else None,
            natural_vad=natural_vad,
            context_tags=tags,
            leak=leak,
            # motion_plan intentionally NOT parsed from LLM segments (2026-09-05
            # protocol slimming): choreography timing belongs to the local
            # director. response_validator still strips any motionPlan the
            # model emits out of habit.
        )

    @staticmethod
    def _accepted_emotions(allowed_emotions: Iterable[str] | None) -> set[str]:
        if allowed_emotions is None:
            return set(EMOTIONS)
        accepted = {
            str(value).strip().lower()
            for value in allowed_emotions
            if str(value).strip().lower() in EMOTIONS
        }
        accepted.add("neutral")
        return accepted

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def _natural_vad(value: Any) -> dict[str, float] | None:
        if not isinstance(value, dict):
            return None
        result: dict[str, float] = {}
        for key in ("valence", "arousal", "dominance"):
            try:
                result[key] = max(-1.0, min(1.0, float(value.get(key, 0))))
            except (TypeError, ValueError):
                result[key] = 0.0
        return result

    @staticmethod
    def _motion_plan(value: Any) -> dict[str, Any] | None:
        return normalize_motion_plan(value).plan

    @staticmethod
    def _bounded_float(value: Any, fallback: float) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = fallback
        if number != number or number in {float("inf"), float("-inf")}:
            number = fallback
        return max(0.0, min(1.0, number))
