"""Pure interpretation of canonical LLM responses."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.interfaces.llm import LLMResponse
from app.runtime.character_turn import CharacterTurn, PerformancePlan
from app.runtime.character_intent import CharacterIntent
from app.runtime.semantic_performance import normalize_motion_plan

def _is_renderer_key(key: Any) -> bool:
    normalized = str(key).casefold()
    return (
        normalized.startswith(("param", "cubism"))
        or normalized in {"expression", "motion", "model", "model_id"}
        or normalized.endswith((".exp3", ".model3", ".motion3"))
    )


def _segment_rank(value: Any, fallback: float = 0.5) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number or number in {float("inf"), float("-inf")}:
        return fallback
    return max(0.0, min(1.0, number))


_EXPLICIT_SHY_EVIDENCE = (
    "害羞", "羞涩", "不好意思", "脸红", "心跳", "暧昧", "表白",
    "喜欢我", "喜欢你", "爱我", "爱你",
    "bashful", "blush", "embarrass", "romantic", "shy",
)
_PLAYFUL_MARKERS = (
    "哎呀", "诶呀", "嘿嘿", "逗你", "开玩笑", "调皮", "俏皮",
    "tease", "playful", "just kidding",
)


def _adapt_semantic_emotion(segment: dict[str, Any], user_text: str) -> tuple[str, str | None]:
    """Reject a conspicuous expression when this turn provides no evidence.

    This is semantic validation, not round-robin variety: genuine bashfulness
    stays shy, while a persona's habitual coy wording cannot pin every turn to
    the same replacement-eye asset.
    """
    emotion = str(segment.get("emotion", "neutral")).casefold()
    if emotion not in {"shy", "embarrassed"}:
        return emotion, None
    text = f"{user_text}\n{segment.get('text', '')}".casefold()
    if any(marker in text for marker in _EXPLICIT_SHY_EVIDENCE):
        return emotion, None

    vad = segment.get("naturalVAD")
    vad = vad if isinstance(vad, dict) else {}
    valence = _segment_rank(vad.get("valence"), 0.0)
    arousal = _segment_rank(vad.get("arousal"), 0.35)
    if any(marker in text for marker in _PLAYFUL_MARKERS):
        adapted = "playful"
    elif valence >= 0.62:
        adapted = "smile"
    elif arousal <= 0.3:
        adapted = "calm"
    else:
        adapted = "neutral"
    return adapted, f"emotion_semantically_adapted:{emotion}->{adapted}"


@dataclass
class InterpretedResponse:
    reply_text: str
    reasoning: str
    segments: list[dict[str, Any]]
    tool_calls: list[Any]
    performance: PerformancePlan
    warnings: list[str] = field(default_factory=list)


class ResponseInterpreter:
    """Normalize an LLMResponse into renderer-independent turn output."""

    def interpret(
        self,
        response: LLMResponse,
        turn: CharacterTurn,
    ) -> InterpretedResponse:
        warnings: list[str] = []
        segments: list[dict[str, Any]] = []
        for raw in response.segments or []:
            cleaned = {
                key: value
                for key, value in dict(raw).items()
                if not _is_renderer_key(key)
            }
            if len(cleaned) != len(raw):
                warnings.append("renderer_details_removed")
            if "motionPlan" in cleaned or "motion_plan" in cleaned:
                key = "motionPlan" if "motionPlan" in cleaned else "motion_plan"
                normalized = normalize_motion_plan(cleaned.get(key))
                warnings.extend(normalized.warnings)
                cleaned.pop("motion_plan", None)
                if normalized.plan is None:
                    cleaned.pop("motionPlan", None)
                else:
                    cleaned["motionPlan"] = normalized.plan
            adapted_emotion, adaptation_warning = _adapt_semantic_emotion(
                cleaned, turn.user_text,
            )
            resolved_emotion = CharacterIntent.from_llm_segment(
                {"emotion": adapted_emotion},
                allowed_emotions=turn.allowed_emotions,
            ).emotion
            cleaned["emotion"] = resolved_emotion
            if adaptation_warning:
                warnings.append(adaptation_warning)
            if resolved_emotion != adapted_emotion:
                warnings.append(
                    f"emotion_not_supported:{adapted_emotion}->{resolved_emotion}"
                )
            segments.append(cleaned)

        dominant = max(
            enumerate(segments),
            key=lambda item: (
                _segment_rank(item[1].get("intensity", 0.5)),
                _segment_rank(item[1].get("energy", item[1].get("intensity", 0.5))),
                -item[0],
            ),
        )[1] if segments else {}
        intent = CharacterIntent.from_llm_segment(
            dominant,
            allowed_emotions=turn.allowed_emotions,
        )
        performance = PerformancePlan(
            emotion=intent.emotion,
            behavior=intent.behavior or ("speak" if response.reply else ""),
            intensity=intent.intensity,
            attention=intent.attention,
            energy=intent.energy,
            speaking=bool(response.reply),
            duration_ms=intent.duration_ms,
            natural_vad=intent.natural_vad,
            context_tags=list(intent.context_tags),
            motion_plan=intent.motion_plan,
            leak=intent.leak,
        )
        return InterpretedResponse(
            reply_text=response.reply,
            reasoning=response.reasoning,
            segments=segments,
            tool_calls=list(response.tool_calls),
            performance=performance,
            warnings=list(dict.fromkeys(warnings)),
        )
