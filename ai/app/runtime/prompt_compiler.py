"""Single prompt assembly and budgeting boundary for a CharacterTurn."""

from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.runtime.character_intent import BEHAVIORS, EMOTIONS
from app.runtime.character_turn import CharacterTurn
from app.runtime.context_assembler import ContextAssembler
from app.runtime.context_budget import ContextBudget
from app.runtime.presentation_capabilities import Live2DPresentationRegistry, get_presentation_registry
from app.runtime.prompt_config import PromptConfigStore
from app.runtime.prompt_overrides import PromptOverrideStore
from app.runtime.visual_attachments import VisualAttachmentStore


@dataclass(frozen=True)
class CompiledPrompt:
    messages: list[dict[str, Any]]
    sources: list[str]
    budget_report: Any = None


def _reply_language(card: object) -> str:
    if not isinstance(card, dict):
        return "en"
    tts = card.get("tts", {})
    if not isinstance(tts, dict):
        tts = {}
    return str(card.get("reply_language") or tts.get("prompt_lang") or "en")


class PromptCompiler:
    """Own stable identity, dynamic context, source policy, and budget fitting."""

    def __init__(
        self,
        planner: Any | None = None,
        *,
        prompt_store: PromptOverrideStore | None = None,
        prompt_config_store: PromptConfigStore | None = None,
        presentation_registry: Live2DPresentationRegistry | None = None,
        context_budget: ContextBudget | None = None,
        visual_attachment_store: VisualAttachmentStore | None = None,
        pinned_dir: Path | None = None,
    ) -> None:
        prompt_dir = Path(__file__).resolve().parents[2] / "data" / "prompts"
        self._legacy_planner = planner
        self._prompt_store = prompt_store or PromptOverrideStore(prompt_dir)
        self._prompt_config_store = prompt_config_store or PromptConfigStore(prompt_dir)
        self._presentation_registry = presentation_registry or get_presentation_registry()
        self._context_budget = context_budget or ContextBudget()
        self._visual_attachment_store = visual_attachment_store or VisualAttachmentStore()
        # Per-character pinned.md lives under config/characters/{id}/, the
        # same file the management layer's get/set_pinned API writes.
        self._pinned_dir = pinned_dir or (
            Path(__file__).resolve().parents[2] / "config" / "characters"
        )

    def _load_pinned(self, character_id: str) -> str:
        """Read the active character's pinned.md (user-pinned fixed memory)."""
        if not character_id or not re.fullmatch(r"[A-Za-z0-9_-]+", character_id):
            return ""
        try:
            path = self._pinned_dir / character_id / "pinned.md"
            if path.exists():
                return path.read_text("utf-8").strip()
        except OSError:
            return ""
        return ""

    @property
    def context_budget(self) -> ContextBudget:
        return self._context_budget

    def compile(self, turn: CharacterTurn, character_self: Any) -> CompiledPrompt:
        turn.character_self = character_self
        if self._legacy_planner is not None:
            plan = self._legacy_planner.plan(turn)
            messages = deepcopy(list(plan.messages))
            sources = list(getattr(plan, "sources", []))
        else:
            messages, sources = self._assemble(turn)
        if len(sources) < len(messages):
            sources.extend("" for _ in range(len(messages) - len(sources)))
        for message, source_id in zip(messages, sources):
            if source_id:
                message["_source_id"] = source_id
        fitted, budget_report = self._context_budget.fit_messages(messages)
        return CompiledPrompt(
            messages=fitted,
            sources=[str(message.get("_source_id", "")) for message in fitted],
            budget_report=budget_report,
        )

    def _assemble(self, ctx: CharacterTurn) -> tuple[list[dict[str, Any]], list[str]]:
        presentation = getattr(ctx, "presentation", None)
        if presentation is None:
            presentation = self._presentation_registry.snapshot()
            ctx.presentation = presentation
        messages: list[dict[str, Any]] = []
        sources: list[str] = []
        character = ctx.character
        character_id = str(getattr(character, "id", "")) if character is not None else ""

        def append_system(source_id: str, default_content: str) -> None:
            content: str | None = default_content
            if character_id:
                try:
                    content = self._prompt_config_store.resolve(character_id, source_id, default_content)
                except ValueError:
                    content = default_content
            if content and content.strip():
                messages.append({"role": "system", "content": content.strip()})
                sources.append(source_id)

        card = character.raw_card if character is not None and hasattr(character, "raw_card") else {}
        prompt_lang = _reply_language(card)
        native_map = {"en": "English", "ja": "Japanese", "zh": "Chinese", "ko": "Korean", "yue": "Cantonese Chinese"}
        native_override = {"en": "你只能用 English 输出", "ja": "日本語のみで出力してください", "zh": "请用中文输出", "ko": "한국어로만 출력하세요", "yue": "请只用粤语输出"}
        language = native_map.get(prompt_lang, "English")
        append_system(
            "language",
            f"LANGUAGE LOCK: Your native language is {language}. Even if the user writes in another language, you MUST reply in {language} ONLY. "
            f"{native_override.get(prompt_lang, f'You must output {language} only.')} This rule is NON-NEGOTIABLE — do not mirror the user's language.",
        )

        if character is not None:
            persona = getattr(character, "persona", None)
            if persona is not None and persona.prompt_context:
                append_system("persona", persona.prompt_context)
            try:
                addition = self._prompt_store.get(character_id) if character_id else ""
            except ValueError:
                addition = ""
            if addition:
                messages.append({"role": "system", "content": "Additional project instructions for this character:\n" + addition})
                sources.append("addition")
        elif not messages:
            messages.append({"role": "system", "content": "You are a helpful assistant. Respond concisely."})
            sources.append("system")

        allowed_emotions = ", ".join(
            getattr(ctx, "allowed_emotions", presentation.allowed_emotions)
            or tuple(sorted(EMOTIONS))
        )
        behaviors = ", ".join(sorted(BEHAVIORS - {"idle"}))
        append_system("output_protocol", self._output_protocol(language, allowed_emotions, behaviors))

        # User-pinned fixed memory: injected ahead of compiled/rolling memory
        # so manually pinned content always reaches the LLM when not disabled
        # or replaced per-character via the prompt config store.
        pinned = self._load_pinned(character_id)
        append_system("pinned", f"[固定记忆]\n{pinned}" if pinned else "")

        compiled_memory, memory_parts = ContextAssembler().assemble_memories(ctx.memories)
        append_system("memory_summary", "Compiled memory context:\n" + compiled_memory if compiled_memory else "")
        append_system("relevant_memory", "Relevant past context:\n" + "\n---\n".join(memory_parts) if memory_parts else "")

        if ctx.conversation is not None:
            history = ctx.conversation.get_history(limit=10)
            messages.extend(history)
            sources.extend(
                "assistant_history" if item.get("role") == "assistant" else "user_history"
                for item in history
            )

        if character is not None:
            previous_emotion = getattr(character.emotion, "current", "")
            append_system(
                "emotion",
                (
                    f"Previous expression state: {previous_emotion}. This is continuity context, not a default for the next segment. "
                    "Re-evaluate emotion from the current message and reply; do not reuse it by default."
                ) if previous_emotion and previous_emotion != "neutral" else "",
            )
            append_system("character_state", ContextAssembler().assemble_character_state(character, ctx.memories))

        user_text = ctx.user_text or ctx.event.payload.get("text", "")
        visual_attachments = tuple(
            getattr(getattr(ctx, "input", None), "visual_attachments", ()) or ()
        )
        if visual_attachments:
            append_system(
                "visual_grounding",
                "VISUAL GROUNDING: Treat the attached image as evidence, not as permission to invent details. "
                "Separate what is directly observed from inference. State uncertainty when an area is unreadable, "
                "ambiguous, cropped, or too small. Do not claim to have seen content that is not visible. "
                "If the image cannot be inspected, say so plainly and do not fabricate an answer.",
            )
        if user_text and ctx.input_origin == "initiative":
            messages.append({"role": "system", "content": f"Trusted initiative event (not a user message):\n{user_text}\nStructured event: {ctx.initiative}"})
            sources.append("initiative")
            # Keep the event itself in the trusted system role, but start a new
            # provider turn with a fixed, payload-free boundary.  DeepSeek
            # thinking mode treats a system-only tail after assistant history as
            # an unfinished reasoning/tool continuation and rejects it with 400.
            # This message is prompt-only: DecisionStep persists user history
            # exclusively when input_origin == "user".
            messages.append({
                "role": "user",
                "content": "Respond naturally to the trusted initiative event above.",
            })
            sources.append("initiative_turn_boundary")
        elif visual_attachments:
            content: list[dict[str, Any]] = []
            content.append({
                "type": "text",
                "text": user_text or "Please inspect the attached image and respond naturally.",
            })
            for attachment in visual_attachments:
                attachment_id = str(
                    attachment.get("id") or attachment.get("attachment_id") or ""
                )
                content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": self._visual_attachment_store.load_data_url(attachment_id),
                        "detail": "auto",
                    },
                })
            messages.append({"role": "user", "content": content})
            sources.append("user_visual_input")
        elif user_text:
            messages.append({"role": "user", "content": user_text})
            sources.append("user_input")
        return messages, sources

    @staticmethod
    def _output_protocol(language: str, emotions: str, behaviors: str) -> str:
        return (
            "\n[Output Instructions]\n"
            "1. LANGUAGE: every JSON field value MUST be written in " + language + ".\n"
            "2. Keep the spoken response short: 1-2 sentences or one brief paragraph.\n"
            "3. Return only valid JSON with English keys.\n"
            "4. Format: {\"segments\":[{\"text\":\"...\",\"emotion\":\"neutral\",\"behavior\":\"speak\",\"attention\":\"user\",\"energy\":0.5,\"intensity\":0.5,\"naturalVAD\":{\"valence\":0,\"arousal\":0,\"dominance\":0},\"contextTags\":[],\"motionPlan\":{\"durationMs\":1200,\"steps\":[{\"atMs\":0,\"durationMs\":600,\"primitive\":\"nod\",\"intensity\":0.5}]}}],\"tool_calls\":[],\"final_reply\":\"...\"}\n"
            "5. SEGMENTS: split the reply when the emotion actually shifts mid-reply — each segment is one emotional beat, spoken in order. Use 1 segment for a single steady mood; use 2-3 ONLY when the feeling genuinely turns (e.g. reluctant then softening, upset then reassured). Never split a flat reply into copies of the same mood; never merge a real mood turn into one segment. Emotion may also shift INSIDE one segment's text (the face follows the segment, not word-by-word).\n"
            "6. motionPlan is optional. Use 1-3 restrained semantic body-language beats for emphasis, emotional shifts, greeting, agreement, disagreement, reflection, reassurance, or playfulness. Omit it for genuinely short neutral speech. Allowed primitives: nod, tilt_left, tilt_right, lean_forward, lean_back, sway, look_left, look_right, breathe, shrug. durationMs 300-8000; step durationMs 120-2500; intensity 0-1.\n"
            "7. Never output Param*, Cubism IDs, keyframes, animation files, expression files, motion names, or implementation details.\n"
            f"8. Every final segment MUST set an \"emotion\" from: {emotions}. Judge what the moment MEANS to the character, then pick:\n"
            "   - Default is neutral. Ordinary statements, answers, narrations, and mild small talk stay neutral — most replies should be neutral or carry at most one non-neutral segment.\n"
            "   - happy is for ordinary joy from a clear positive event or a joke landing; joyful for unmistakable high joy, celebration, or delighted excitement; playful only when actively teasing or joking right now; shy only for explicit embarrassment or romantic bashfulness (including bashfulness after being praised).\n"
            "   - A negated emotion word is NOT that emotion: if the reply comforts, appeases, or reassures (\"别生气/不要难过/don't be mad\"), the character's own emotion is calm or caring, not angry or sad. Label the character's actual state, never quoted or mentioned words.\n"
            "   - Mixed feelings are expressed by splitting segments (rule 5), not by averaging: reluctant-but-complying = segment 1 pout/displeasure + segment 2 the real warm feeling.\n"
            "   - Intensity anchors: 0.2-0.3 faint/background mood; 0.5-0.6 clearly felt but controlled; 0.8-0.9 overwhelmed or bursting. Pick the anchor before writing the number; do not default to the same value every turn.\n"
            f"9. Every spoken segment must choose behavior from: {behaviors}. Use greet, agree, disagree, think, and speak by communicative meaning; never idle for spoken text.\n"
            "10. Leave tool_calls empty when not needed. Do NOT use [keyword] tags for emotions.\n"
            "11. SPOKEN TEXT ONLY: when the user asks for a visible action or expression, perform it through emotion, behavior, naturalVAD, and motionPlan, then answer with a brief natural spoken reaction. final_reply and segment text contain only words the character actually says aloud and must never narrate or claim blinking, leaning, smiling, making a face, or other visible performance. Visible performance belongs only in emotion, behavior, naturalVAD, and motionPlan. If those fields cannot represent an action, do not claim that it happened. Always produce a non-empty natural spoken reply. Never return empty, blank, or whitespace-only content.\n"
            "12. Examples (format and emotion-splitting only — never copy their content):\n"
            "    Single steady mood: {\"segments\":[{\"text\":\"今天 weather 不错，适合出门。\",\"emotion\":\"neutral\",...}]}\n"
            "    Genuine mood turn across segments: {\"segments\":[{\"text\":\"哼，谁要谢谢你了。\",\"emotion\":\"pout\",\"intensity\":0.6,...},{\"text\":\"……不过，这次就勉强原谅你啦。\",\"emotion\":\"happy\",\"intensity\":0.4,...}]}\n"
            "    Negated emotion (comfort, not anger): {\"segments\":[{\"text\":\"好啦好啦，别生气了嘛，我陪你聊。\",\"emotion\":\"calm\",\"intensity\":0.4,...}]}\n"
        )
