"""MemorySaveStep — persist conversation turns to memory after reply."""

import logging

from app.runtime.pipeline import Step
from app.runtime.character_turn import CharacterTurn
from app.interfaces.memory import MemoryInterface


class MemorySaveStep(Step):
    """Save the current conversation turn to memory storage.

    Runs after the LLM generates a reply. Stores both the user input
    and the assistant reply as a memory entry.

    Note: Conversation turn-tracking is handled by DecisionStep.
    This step only persists to the memory provider.
    """

    def __init__(self, memory: MemoryInterface):
        self.memory = memory

    async def run(self, ctx: CharacterTurn) -> None:
        # Get user text from ASR (voice) or event payload (text input)
        user_text = ctx.user_text or ctx.event.payload.get("text", "")
        if ctx.input_origin == "initiative":
            user_text = ""
        visual_attachments = tuple(getattr(ctx.input, "visual_attachments", ()) or ())
        safe_user_text = user_text or (
            f"用户发送了 {len(visual_attachments)} 张图片" if visual_attachments else ""
        )
        reply_text = ctx.reply_text or ""

        if not safe_user_text and not reply_text:
            return

        # Store the turn as a memory entry
        character = ctx.character
        memory_payload = {
            "user": safe_user_text,
            "assistant": reply_text,
            "emotion": ctx.emotion,
            "origin": ctx.input_origin,
            "initiative": ctx.event.payload.get("initiative", {}),
            "character_id": getattr(character, "id", "") if character else "",
            "character": character,
            "character_self": ctx.character_self,
            "turn_id": ctx.turn_id,
            "write_token": "conversation",
            "visual": {
                "hasVisionInput": bool(visual_attachments),
                "imageCount": len(visual_attachments),
                "mimeTypes": sorted({
                    str(item.get("mimeType", ""))
                    for item in visual_attachments
                    if item.get("mimeType")
                }),
                "imageHashes": [
                    str(item.get("sha256", ""))
                    for item in visual_attachments
                    if item.get("sha256")
                ],
            } if visual_attachments else {},
        }
        try:
            from app.runtime.management import get_manager
            memory_payload["history_uid"] = get_manager().current_history_uid(
                create=True
            )
        except Exception:
            memory_payload["history_uid"] = ""
        try:
            await self.memory.store("conversation_turn", memory_payload)
        except Exception:
            logging.getLogger("memory_step").exception(
                "Turn memory persistence failed; preserving generated reply"
            )
            ctx.warnings.append("memory_save_failed")
            return
        if memory_payload["history_uid"]:
            try:
                get_manager().record_turn_metadata(
                    memory_payload["history_uid"], safe_user_text
                )
            except Exception:
                logging.getLogger("memory_step").exception(
                    "Failed to update history metadata"
                )
        if memory_payload.get("learned_memories"):
            ctx.learned_memories = memory_payload["learned_memories"]

        # Optionally trigger consolidation every 5 turns
        turn_count = ctx.turn_count
        if turn_count > 0 and turn_count % 5 == 0:
            try:
                await self.memory.consolidate()
            except Exception:
                logging.getLogger("memory_step").exception("Memory consolidation failed")
