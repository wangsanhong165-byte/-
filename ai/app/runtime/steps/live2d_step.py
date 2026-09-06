from app.runtime.pipeline import Step
from app.runtime.character_turn import CharacterTurn
from app.runtime.character_intent import CharacterIntent


class Live2DStep(Step):
    """Finalize renderer-independent presentation intent for transport.

    Normal LLM output is emitted as ``character.intent`` and consumed by the
    frontend PerformanceDirector.  Explicit ``character.control.requested``
    events use the separate AvatarController compatibility protocol.
    """

    async def run(self, ctx: CharacterTurn) -> None:
        # DecisionStep/ResponseInterpreter has already selected the dominant
        # semantic segment. Do not overwrite that plan with the final textual
        # segment: a quiet closing sentence often has no motionPlan and used to
        # erase the expressive beat chosen from an earlier sentence.
        selected = ctx.output.performance
        has_selected_plan = bool(
            selected.behavior or selected.motion_plan or selected.natural_vad
            or selected.context_tags or selected.duration_ms
        )
        if has_selected_plan:
            intent = CharacterIntent.from_llm_segment(
                {
                    "emotion": selected.emotion or ctx.emotion or "neutral",
                    "behavior": selected.behavior,
                    "intensity": selected.intensity,
                    "attention": selected.attention,
                    "energy": selected.energy,
                    "durationMs": selected.duration_ms,
                    "naturalVAD": selected.natural_vad,
                    "contextTags": selected.context_tags,
                    "motionPlan": selected.motion_plan,
                    "leak": selected.leak,
                },
                allowed_emotions=ctx.allowed_emotions,
            )
        else:
            # Compatibility for direct CharacterTurn callers that did not run
            # DecisionStep/ResponseInterpreter before this pipeline step.
            segment = ctx.segments[-1] if ctx.segments and isinstance(ctx.segments[-1], dict) else {}
            if not segment.get("emotion"):
                segment = {**segment, "emotion": ctx.emotion or "neutral"}
            if "energy" not in segment:
                segment = {**segment, "energy": selected.energy}
            intent = CharacterIntent.from_llm_segment(
                segment,
                ctx.emotion_intensity,
                allowed_emotions=ctx.allowed_emotions,
            )
        # Spoken output must retain a semantic presentation behavior even when
        # an older LLM response omits it or emits its former `idle` default.
        if ctx.reply_text and (not intent.behavior or intent.behavior == "idle"):
            intent = CharacterIntent(
                emotion=intent.emotion,
                behavior="speak",
                intensity=intent.intensity,
                attention=intent.attention,
                energy=intent.energy,
                duration_ms=intent.duration_ms,
                natural_vad=intent.natural_vad,
                context_tags=intent.context_tags,
                motion_plan=intent.motion_plan,
                leak=intent.leak,
            )
        ctx.live2d_intent = {**intent.to_dict(), "behavior": intent.behavior, "speaking": bool(ctx.audio)}
