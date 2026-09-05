"""Post-turn self-review — judge the latest turn for worth-remembering facts.

Lighter-grained than the batch extractor: runs every few turns over the
latest single turn, writes only structured memories (facts/preferences),
never the conversation logs table.

Isolation rule (Hermes background_review pattern): the reviewer must NOT call
store.log_turn. If it did, its own prompt+reply would enter recent_turns and
corrupt the rolling summary (extractor) and the compiler's today/week digests.
"""

from __future__ import annotations

from typing import Any

from app.memory.store import memory_store
from app.memory.extractor import extract_facts, _turn_label

_MIN_TURN_CHARS = 10


def review_turn(
    llm_adapter: Any,
    character_id: str = "",
    character_name: str = "",
    store: Any = None,
) -> dict:
    """Review the last user+assistant turn and persist any durable facts.

    Returns {'reviewed': bool, 'stored': list[str]}.
    """
    store = store or memory_store
    turns = store.recent_turns(2, character_id=character_id)
    lines = []
    for t in turns:
        content = str(t.get("content", "")).strip()
        if content:
            lines.append(_turn_label(t, character_name or "我"))
    conv_text = "\n".join(lines)
    if len(conv_text) < _MIN_TURN_CHARS:
        return {"reviewed": False, "stored": []}
    stored = extract_facts(
        conv_text, llm_adapter, character_id=character_id, store=store
    )
    return {"reviewed": True, "stored": stored}
