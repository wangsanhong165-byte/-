"""CharacterTurn to typed V3 domain-event emission."""

from __future__ import annotations

import base64

from app.runtime.character_turn import CharacterTurn, TurnInput
from app.runtime.character_intent import CharacterIntent
from app.runtime.semantic_performance import normalize_motion_plan
from app.transport.domain_event import DomainEvent


class TransportEmitter:
    """Emit one ordered V3 lifecycle without WebSocket or session concerns."""

    @staticmethod
    def _event(
        turn: CharacterTurn,
        event_type: str,
        payload: dict,
    ) -> DomainEvent:
        return DomainEvent.create(
            event_type,
            payload,
            turn_id=turn.turn_id,
        )

    def start_input(self, turn_input: TurnInput) -> list[DomainEvent]:
        events = [
            DomainEvent.create("turn.started", {
                "origin": turn_input.origin.value,
                "inputMode": "audio" if turn_input.audio else (
                    "initiative" if turn_input.origin.value == "initiative" else "text"
                ),
            }, turn_id=turn_input.turn_id),
        ]
        if turn_input.audio:
            events.append(DomainEvent.create(
                "asr.started",
                {"language": None},
                turn_id=turn_input.turn_id,
            ))
        return events

    def start(self, turn: CharacterTurn) -> list[DomainEvent]:
        events = [
            self._event(turn, "turn.started", {
                "origin": turn.input_origin,
                "inputMode": "audio" if turn.input.audio else (
                    "initiative" if turn.input_origin == "initiative" else "text"
                ),
            }),
        ]
        if turn.input.audio:
            events.append(self._event(turn, "asr.started", {"language": None}))
        return events

    @staticmethod
    def _intent_segments(turn: CharacterTurn) -> list[dict]:
        """Project LLM segments to safe semantic fields for the avatar timeline."""
        allowed = {
            "text", "emotion", "behavior", "attention", "energy", "intensity",
            "durationMs", "naturalVAD", "contextTags", "motionPlan",
        }
        result: list[dict] = []
        for raw in turn.segments:
            if not isinstance(raw, dict):
                continue
            intent = CharacterIntent.from_llm_segment(
                raw,
                allowed_emotions=turn.allowed_emotions,
            )
            segment = {key: raw[key] for key in allowed if key in raw and key != "motionPlan"}
            segment["text"] = str(raw.get("text", ""))
            segment["emotion"] = intent.emotion
            segment["behavior"] = intent.behavior
            segment["attention"] = intent.attention
            segment["energy"] = intent.energy
            segment["intensity"] = intent.intensity
            segment["contextTags"] = list(intent.context_tags)
            if intent.duration_ms is not None:
                segment["durationMs"] = intent.duration_ms
            else:
                segment.pop("durationMs", None)
            if intent.natural_vad is not None:
                segment["naturalVAD"] = intent.natural_vad
            else:
                segment.pop("naturalVAD", None)
            if intent.motion_plan is not None:
                segment["motionPlan"] = intent.motion_plan
            if segment:
                result.append(segment)
        return result

    def emit_completion(self, turn: CharacterTurn) -> list[DomainEvent]:
        if turn.error:
            events: list[DomainEvent] = []
            if turn.error.code.startswith("asr."):
                events.append(self._event(turn, "asr.failed", {
                    "code": turn.error.code,
                    "message": turn.error.message,
                }))
            events.extend([
                self._event(turn, "turn.failed", {
                    "code": turn.error.code,
                    "message": turn.error.message,
                }),
                DomainEvent.create(
                    "runtime.status",
                    {"state": "idle", "message": ""},
                ),
            ])
            return events

        events: list[DomainEvent] = []
        if turn.input.audio:
            events.append(self._event(turn, "asr.result", {
                "text": turn.user_text,
                "confidence": None,
                "language": None,
            }))

        for index, audit in enumerate(turn.tool_audit):
            tool = str(audit.get("tool", "unknown"))
            request_id = f"{turn.turn_id}:tool:{index}"
            events.append(self._event(turn, "tool.started", {
                "requestId": request_id,
                "tool": tool,
            }))
            if audit.get("status") == "ok":
                events.append(self._event(turn, "tool.result", {
                    "requestId": request_id,
                    "tool": tool,
                    "result": dict(audit),
                }))
            else:
                status = str(audit.get("status", "failed"))
                events.append(self._event(turn, "tool.failed", {
                    "requestId": request_id,
                    "tool": tool,
                    "code": f"tool.{status}",
                    "message": str(audit.get("message", status)),
                }))

        events.extend([
            self._event(turn, "assistant.text.started", {}),
            self._event(turn, "assistant.text.completed", {
                "text": turn.reply_text,
                "reasoning": turn.reasoning or "",
                "segments": [
                    {
                        "text": str(segment.get("text", "")),
                        "emotion": str(segment.get("emotion", "neutral")),
                        "behavior": str(segment.get("behavior", "")),
                    }
                    for segment in turn.segments
                ],
            }),
        ])

        # Stage semantic performance after the complete subtitle is visible but
        # before audio can decode.  The frontend keeps this intent dormant until
        # the real AudioBufferSource starts, so expression, body language,
        # lip-sync and speech share the same playback clock.
        plan = turn.output.performance
        safe_plan = CharacterIntent.from_llm_segment(
            {
                "emotion": plan.emotion,
                "behavior": plan.behavior,
                "intensity": plan.intensity,
                "attention": plan.attention,
                "energy": plan.energy,
                "durationMs": plan.duration_ms,
                "naturalVAD": plan.natural_vad,
                "contextTags": plan.context_tags,
                "motionPlan": plan.motion_plan,
            },
            allowed_emotions=turn.allowed_emotions,
        )
        events.append(self._event(turn, "character.intent", {
            "emotion": safe_plan.emotion,
            "behavior": safe_plan.behavior,
            "intensity": safe_plan.intensity,
            "attention": safe_plan.attention,
            "energy": safe_plan.energy,
            "durationMs": safe_plan.duration_ms,
            "naturalVAD": safe_plan.natural_vad,
            "contextTags": list(safe_plan.context_tags),
            "motionPlan": normalize_motion_plan(safe_plan.motion_plan).plan,
            "segments": self._intent_segments(turn),
        }))

        if turn.audio:
            events.extend([
                self._event(turn, "tts.started", {
                    "format": "wav",
                    "audioSequence": 0,
                }),
                self._event(turn, "tts.audio", {
                    "data": base64.b64encode(turn.audio).decode("ascii"),
                    "format": "wav",
                    "audioSequence": 0,
                    "volumes": [],
                }),
                self._event(turn, "tts.completed", {"reason": "complete"}),
            ])
        else:
            tts_failure = next(
                (
                    warning.partition(":")[2]
                    for warning in turn.warnings
                    if warning.startswith("tts.failed:")
                ),
                "",
            )
            if tts_failure:
                events.append(self._event(turn, "tts.failed", {
                    "code": "tts.unavailable",
                    "message": tts_failure,
                }))

        events.extend([
            self._event(turn, "turn.completed", {"reason": "complete"}),
            DomainEvent.create(
                "runtime.status",
                {"state": "idle", "message": ""},
            ),
        ])
        return events

    def emit(self, turn: CharacterTurn) -> list[DomainEvent]:
        return [*self.start(turn), *self.emit_completion(turn)]
