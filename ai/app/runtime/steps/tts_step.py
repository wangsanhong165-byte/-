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

# Emotion → v2Pro delivery-shaping defaults. GPT-SoVITS api_v2 has no emotion
# field; temperature (sampling spread) and speed_factor (pace) are the levers
# that make the same voice read calm vs agitated. A voice pack may override
# these per character via voice.json["emotion_params"].
_DEFAULT_EMOTION_PARAMS: dict[str, dict[str, float]] = {
    "angry": {"temperature": 0.9, "speed_factor": 1.05},
    "pout": {"temperature": 0.75, "speed_factor": 1.03},
    "joyful": {"temperature": 0.75, "speed_factor": 1.03},
    "happy": {"temperature": 0.7, "speed_factor": 1.0},
    "playful": {"temperature": 0.7, "speed_factor": 1.04},
    "surprised": {"temperature": 0.8, "speed_factor": 1.05},
    "sad": {"temperature": 0.3, "speed_factor": 0.92},
    "cry": {"temperature": 0.25, "speed_factor": 0.9},
    "worried": {"temperature": 0.4, "speed_factor": 0.95},
    "shy": {"temperature": 0.45, "speed_factor": 0.97},
    "embarrassed": {"temperature": 0.5, "speed_factor": 0.98},
    "calm": {"temperature": 0.35, "speed_factor": 0.97},
    "neutral": {},
}


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
        # No card: still shape delivery by the turn's emotion (built-in
        # defaults) — voice identity simply stays at engine defaults.
        kwargs: dict = {}
        _apply_emotion_params(kwargs, None, str(ctx.emotion or "neutral"))
        return kwargs

    card = character.raw_card if hasattr(character, "raw_card") else {}
    if not isinstance(card, dict):
        kwargs = {}
        _apply_emotion_params(kwargs, None, str(ctx.emotion or "neutral"))
        return kwargs

    tts_cfg = card.get("tts", {})
    kwargs: dict = {}

    engine = tts_cfg.get("engine", "")
    if engine:
        kwargs["engine"] = engine

    voice = tts_cfg.get("voice", "")
    if voice:
        kwargs["voice"] = voice

    # reply_language is the LLM's *intended* reply language; it must not be
    # forced onto the TTS engine, which should detect from the actual output
    # text (an EN character replying in Chinese to a Chinese user would
    # otherwise be read as en and drop words). Only an explicit card-level
    # tts.text_lang overrides auto-detection.
    text_lang = tts_cfg.get("text_lang", "")
    if text_lang:
        kwargs["text_lang"] = text_lang

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
        _apply_emotion_params(kwargs, resolved_voice.get("emotion_params"), str(ctx.emotion or "neutral"))
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

    _apply_emotion_params(kwargs, tts_cfg.get("emotion_params"), str(ctx.emotion or "neutral"))
    return kwargs


def _apply_emotion_params(kwargs: dict, overrides: object, emotion: str) -> None:
    """Merge emotion-shaped delivery params into synth kwargs.

    v2Pro has no emotion field; temperature/speed_factor are set from the
    turn's emotion (card/voice-pack overrides first, built-in defaults second)
    so the same voice reads calm vs agitated. Explicit kwargs already present
    win — a caller-provided speed is never clobbered.
    """
    defaults = _DEFAULT_EMOTION_PARAMS.get(emotion, {})
    overrides_map = overrides if isinstance(overrides, dict) else {}
    per_emotion = overrides_map.get(emotion)
    merged = {**defaults, **(per_emotion if isinstance(per_emotion, dict) else {})}
    for key, value in merged.items():
        if kwargs.get(key) is None:
            kwargs[key] = value


_EMOTION_PARAM_KEYS = ("temperature", "speed_factor", "top_k")


def _emotion_param_overrides(ctx: CharacterTurn) -> object:
    """The character's emotion_params table (card or voice pack), or None."""
    character = ctx.character
    if character is None:
        return None
    card = character.raw_card if hasattr(character, "raw_card") else {}
    if not isinstance(card, dict):
        return None
    tts_cfg = card.get("tts", {})
    if isinstance(tts_cfg.get("emotion_params"), dict):
        return tts_cfg["emotion_params"]
    resolved_voice = _resolve_voice(tts_cfg.get("voice_id", ""))
    if resolved_voice and isinstance(resolved_voice.get("emotion_params"), dict):
        return resolved_voice["emotion_params"]
    return None


def _kwargs_for_emotion(base: dict, overrides: object, emotion: str) -> dict:
    """A copy of base voice kwargs with delivery params for `emotion`.

    The turn-level kwargs already carry the dominant emotion's values; strip
    them so the per-segment emotion can re-apply its own (the "explicit wins"
    rule in _apply_emotion_params would otherwise keep the dominant values).
    """
    kwargs = dict(base)
    for key in _EMOTION_PARAM_KEYS:
        kwargs.pop(key, None)
    _apply_emotion_params(kwargs, overrides, emotion)
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
                await self._run_segmented(ctx, voice_kwargs)
            else:
                audio = await self.tts.synthesize(ctx.reply_text, **voice_kwargs)
                if audio:
                    ctx.audio = audio
        except Exception as exc:
            logger.warning("TTS unavailable (%s), continuing without audio", exc)
            ctx.audio = b""
            ctx.warnings.append(f"tts.failed:{exc}")

    async def _run_segmented(self, ctx: CharacterTurn, voice_kwargs: dict) -> None:
        """Synthesize each semantic segment separately and record real durations."""
        overrides = _emotion_param_overrides(ctx)
        spoken = [
            seg for seg in ctx.segments
            if isinstance(seg, dict) and str(seg.get("text", "")).strip()
        ]
        clips: list[bytes] = []
        for seg in spoken:
            # Each segment gets its own delivery: the dominant emotion shapes
            # the turn default, but a pout→happy reply must not voice the
            # happy line with pout's temperature/speed.
            clip_kwargs = _kwargs_for_emotion(voice_kwargs, overrides, str(seg.get("emotion") or ctx.emotion or "neutral"))
            clip = await self.tts.synthesize(str(seg.get("text", "")), **clip_kwargs)
            if clip:
                clips.append(clip)
        if not clips:
            # Every clip came back empty (no exception raised): retry once as a
            # single synthesis, then surface the failure instead of finishing
            # the turn silently without audio.
            logger.warning("Segmented TTS returned no audio, falling back to single clip")
            fallback = await self.tts.synthesize(ctx.reply_text, **voice_kwargs)
            if fallback:
                ctx.audio = fallback
                ctx.warnings.append("tts.segmented_empty_fallback")
                return
            ctx.audio = b""
            ctx.warnings.append("tts.failed:segmented synthesis returned empty audio")
            return
        # A partially-synthesized reply (some clips failed) is worse than one
        # clean clip: any failure falls back to whole-reply synthesis.
        if len(clips) != len(spoken):
            logger.warning(
                "Segmented TTS incomplete (%d/%d), falling back to single clip",
                len(clips), len(spoken),
            )
            ctx.audio = await self.tts.synthesize(ctx.reply_text, **voice_kwargs) or b""
            if not ctx.audio:
                ctx.warnings.append("tts.failed:fallback synthesis returned empty audio")
            return

        ctx.audio_segments = clips
        ctx.audio = b"".join(clips)
        # Anchor each segment's cue to its clip's measured length. The frontend
        # prefers explicit durationMs over its character-count estimate.
        for seg, clip in zip(spoken, clips):
            duration = _wav_duration_ms(clip)
            if duration > 0:
                seg["durationMs"] = duration
