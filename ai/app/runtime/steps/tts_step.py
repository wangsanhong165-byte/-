"""TTSStep — synthesize speech from reply text.

Gracefully handles unavailable TTS service — logs and continues
without crashing the pipeline.
"""

import logging
from pathlib import Path

from app.runtime.pipeline import Step
from app.runtime.character_turn import CharacterTurn
from app.interfaces.tts import TTSInterface

logger = logging.getLogger("tts_step")
_PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _character_asset(character_id: str, value: object) -> str:
    """Resolve a character-card asset without allowing it to escape its pack."""
    relative = str(value or "").strip()
    if not relative:
        return ""
    character_dir = (_PROJECT_ROOT / "config" / "characters" / character_id).resolve()
    target = (character_dir / relative).resolve()
    try:
        target.relative_to(character_dir)
    except ValueError:
        return ""
    return str(target)


def _resolve_voice(voice_id: object) -> dict | None:
    """Resolve a system-level voice pack, returning {} when absent."""
    value = str(voice_id or "").strip()
    if not value:
        return None
    try:
        from app.character.voices import VoiceRegistry
        return VoiceRegistry(_PROJECT_ROOT).resolve(value)
    except (KeyError, ValueError, OSError):
        return None


def _extract_voice_kwargs(ctx: CharacterTurn) -> dict:
    """Extract TTS voice parameters from the character card."""
    character = ctx.character
    if character is None:
        return {}

    card = character.raw_card if hasattr(character, "raw_card") else {}
    if not isinstance(card, dict):
        return {}

    tts_cfg = card.get("tts", {})
    kwargs: dict = {}

    engine = tts_cfg.get("engine", "")
    if engine:
        kwargs["engine"] = engine

    voice = tts_cfg.get("voice", "")
    if voice:
        kwargs["voice"] = voice

    reply_language = card.get("reply_language") or tts_cfg.get("text_lang")
    if reply_language:
        kwargs["text_lang"] = reply_language

    prompt_language = tts_cfg.get("prompt_lang", "")
    if prompt_language:
        kwargs["prompt_lang"] = prompt_language

    prompt_text = tts_cfg.get("prompt_text", "")
    if prompt_text:
        kwargs["prompt_text"] = prompt_text

    # A system-level voice pack reference takes precedence over assets
    # embedded in the character directory.
    resolved_voice = _resolve_voice(tts_cfg.get("voice_id", ""))
    if resolved_voice:
        if resolved_voice.get("prompt_lang"):
            kwargs["prompt_lang"] = resolved_voice["prompt_lang"]
        if resolved_voice.get("prompt_text"):
            kwargs["prompt_text"] = resolved_voice["prompt_text"]
        if resolved_voice.get("ref_audio"):
            kwargs["ref_audio_path"] = resolved_voice["ref_audio"]
        if resolved_voice.get("gpt_weights"):
            kwargs["gpt_weights"] = resolved_voice["gpt_weights"]
        if resolved_voice.get("sovits_weights"):
            kwargs["sovits_weights"] = resolved_voice["sovits_weights"]
        if not kwargs.get("voice") and resolved_voice.get("name"):
            kwargs["voice"] = resolved_voice["name"]
        return kwargs

    ref_audio = tts_cfg.get("ref_audio", {})
    if isinstance(ref_audio, dict):
        emotion = ctx.emotion or "neutral"
        ref_path = ref_audio.get(emotion) or ref_audio.get("neutral")
        if ref_path:
            resolved = _character_asset(str(getattr(character, "id", "")), ref_path)
            if resolved:
                kwargs["ref_audio_path"] = resolved

    custom_model = tts_cfg.get("custom_model", {})
    if isinstance(custom_model, dict):
        t2s = _character_asset(
            str(getattr(character, "id", "")), custom_model.get("t2s")
        )
        vits = _character_asset(
            str(getattr(character, "id", "")), custom_model.get("vits")
        )
        if t2s:
            kwargs["gpt_weights"] = t2s
        if vits:
            kwargs["sovits_weights"] = vits

    return kwargs


def _wav_duration_ms(data: bytes) -> int:
    """Real duration of synthesized WAV bytes, for segment-timeline anchoring."""
    try:
        import io
        import wave

        with wave.open(io.BytesIO(data), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
            if rate <= 0:
                return 0
            return int(round(frames / rate * 1000))
    except Exception:
        return 0


class TTSStep(Step):
    """Synthesize speech from the reply text with character voice config.

    Multi-segment replies are synthesized per segment so each expression
    change lands on its own audio clip: the emitter plays the clips in order
    and the frontend aligns each segment cue to its clip's real start.
    """

    def __init__(self, tts_provider: TTSInterface):
        self.tts = tts_provider

    async def run(self, ctx: CharacterTurn) -> None:
        if not ctx.reply_text:
            return
        voice_kwargs = _extract_voice_kwargs(ctx)

        seg_texts = [
            str(segment.get("text", "")).strip()
            for segment in ctx.segments
            if isinstance(segment, dict) and str(segment.get("text", "")).strip()
        ]
        try:
            if len(seg_texts) >= 2:
                await self._run_segmented(ctx, seg_texts, voice_kwargs)
            else:
                audio = await self.tts.synthesize(ctx.reply_text, **voice_kwargs)
                if audio:
                    ctx.audio = audio
        except Exception as exc:
            logger.warning("TTS unavailable (%s), continuing without audio", exc)
            ctx.audio = b""
            ctx.warnings.append(f"tts.failed:{exc}")

    async def _run_segmented(self, ctx: CharacterTurn, seg_texts: list[str], voice_kwargs: dict) -> None:
        """Synthesize each semantic segment separately and record real durations."""
        clips: list[bytes] = []
        for text in seg_texts:
            clip = await self.tts.synthesize(text, **voice_kwargs)
            if clip:
                clips.append(clip)
        if not clips:
            return
        # A partially-synthesized reply (some clips failed) is worse than one
        # clean clip: any failure falls back to whole-reply synthesis.
        if len(clips) != len(seg_texts):
            logger.warning(
                "Segmented TTS incomplete (%d/%d), falling back to single clip",
                len(clips), len(seg_texts),
            )
            ctx.audio = await self.tts.synthesize(ctx.reply_text, **voice_kwargs) or b""
            return

        ctx.audio_segments = clips
        ctx.audio = b"".join(clips)
        # Anchor each segment's cue to its clip's measured length. The frontend
        # prefers explicit durationMs over its character-count estimate.
        spoken = [seg for seg in ctx.segments if isinstance(seg, dict) and str(seg.get("text", "")).strip()]
        for seg, clip in zip(spoken, clips):
            duration = _wav_duration_ms(clip)
            if duration > 0:
                seg["durationMs"] = duration
