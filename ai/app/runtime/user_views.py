"""Stable, user-facing projections of internal runtime data."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


_MOODS = {
    "bright": "明亮",
    "playful": "轻快",
    "melancholy": "有些低落",
    "tired": "有些疲惫",
    "neutral": "平静",
}
_EMOTIONS = {
    "gentle": "温和",
    "happy": "愉快",
    "sad": "低落",
    "serious": "认真",
    "worried": "担心",
    "surprised": "惊讶",
    "neutral": "平静",
}


def _short_text(value: Any, *, limit: int = 240) -> str:
    text = str(value or "").strip()
    return text[:limit]


def _text_list(value: Any, *, limit: int = 6) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [_short_text(item) for item in value if _short_text(item)][:limit]


def build_character_self_view(state: dict[str, Any]) -> dict[str, Any]:
    """Project CharacterSelf state without exposing storage or reasoning fields."""
    mood = state.get("mood") if isinstance(state.get("mood"), dict) else {}
    emotion = state.get("emotion") if isinstance(state.get("emotion"), dict) else {}
    focus = _text_list(
        state.get("focus")
        or state.get("recent_focus")
        or state.get("recentFocus")
    )
    goals = _text_list(
        state.get("goals")
        or state.get("persistent_goals")
        or state.get("persistentGoals")
    )
    changes = _text_list(
        state.get("recent_changes")
        or state.get("recentChanges")
    )
    mood_text = _MOODS.get(str(mood.get("current", "neutral")), "平静")
    emotion_text = _EMOTIONS.get(
        str(emotion.get("current", "neutral")),
        _short_text(emotion.get("current")) or "平静",
    )
    focus_text = f"，注意力在{focus[0]}上" if focus else ""
    raw_goals = state.get("goals")
    if not goals and isinstance(raw_goals, dict):
        goals = [
            _short_text(item.get("description"))
            for item in raw_goals.get("active", [])
            if isinstance(item, dict) and _short_text(item.get("description"))
        ][:6]
    if not changes and isinstance(mood.get("history"), list):
        changes = [
            f"最近的心境变得{_MOODS.get(str(item.get('mood')), '更细腻')}"
            for item in mood["history"][-3:]
            if isinstance(item, dict)
        ]
    relationship = _short_text(
        state.get("relationship_summary") or state.get("relationshipSummary")
    )
    raw_relationship = state.get("relationship")
    if not relationship and isinstance(raw_relationship, dict):
        interactions = raw_relationship.get("interaction_count", {})
        if isinstance(interactions, dict) and any(
            int(value or 0) > 0 for value in interactions.values()
        ):
            relationship = "你们已经有持续的交流，她会结合共同经历理解这段对话。"
    last_interaction_at = state.get("last_interaction_at", 0)
    try:
        last_interaction_at = float(last_interaction_at or 0)
    except (TypeError, ValueError):
        last_interaction_at = 0
    return {
        "currentState": f"现在心情{mood_text}，表达{emotion_text}{focus_text}。",
        "recentFocus": focus,
        "persistentGoals": goals,
        "recentChanges": changes,
        "lastInteraction": _short_text(state.get("last_interaction")),
        "lastInteractionAt": last_interaction_at,
        "interactionCount": int(state.get("interaction_count", 0) or 0),
        **({"relationshipSummary": relationship} if relationship else {}),
    }


def _memory_category(item: dict[str, Any]) -> str:
    kind = str(item.get("memory_type", "")).lower()
    subject = str(item.get("subject", "")).lower()
    if kind in {"goal", "open_loop"}:
        return "goals"
    if kind in {"preference", "habit"}:
        return "preferences"
    if subject == "character" or kind in {"character", "self"}:
        return "character"
    if kind in {"experience", "episode", "conversation"}:
        return "shared"
    return "about_user"


def _memory_status(item: dict[str, Any]) -> str:
    """active / stale / expired — matches the store's lifecycle vocabulary."""
    state = str(item.get("state", "active"))
    expires_at = str(item.get("expires_at") or "").strip()
    if state == "expired":
        return "expired"
    if expires_at:
        try:
            expiry = datetime.fromisoformat(expires_at)
        except (ValueError, TypeError):
            expiry = None
        if expiry is not None:
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            if expiry <= datetime.now(timezone.utc):
                return "expired"
    if state == "stale":
        return "stale"
    return "active"


def build_memory_view(
    memories: list[dict[str, Any]],
    *,
    query: str = "",
    category: str = "all",
) -> dict[str, Any]:
    """Return searchable memory summaries with opaque edit references."""
    normalized_query = query.strip().casefold()
    items = []
    for item in memories:
        summary = _short_text(item.get("content"))
        item_category = _memory_category(item)
        pinned = bool(item.get("pinned", False)) or float(
            item.get("importance", 0.0) or 0.0
        ) >= 0.85
        status = _memory_status(item)
        # User-forgotten rows (active=0, not lifecycle-expired) never render,
        # regardless of what the caller passed in.
        if int(item.get("active", 1) or 0) == 0 and status != "expired":
            continue
        if normalized_query and normalized_query not in summary.casefold():
            continue
        if category == "expired":
            if status != "expired":
                continue
        elif status == "expired":
            # Expired states surface only in the dedicated 已过期 view so
            # stale snapshots never masquerade as current facts.
            continue
        if category == "pinned" and not pinned:
            continue
        if category not in {"", "all", "pinned", "expired"} and item_category != category:
            continue
        items.append({
            "ref": f"memory:{int(item.get('id', 0))}",
            "category": item_category,
            "summary": summary,
            "status": status,
            "observedAt": _short_text(item.get("observed_at")),
            "expiresAt": _short_text(item.get("expires_at")),
            "updatedAt": _short_text(item.get("updated_at")),
            "formedAt": _short_text(item.get("created_at")),
            "lastUsedAt": _short_text(item.get("updated_at")),
            "formationReason": {
                "preference": "从你表达的偏好中形成",
                "habit": "从持续出现的习惯中形成",
                "goal": "从需要持续关注的目标中形成",
                "open_loop": "从尚未完成的事情中形成",
                "recent_state": "从你当时的状态中形成",
                "insight": "她从你们的相处中自己归纳得出",
                "relationship_style": "从你们的长期相处中演化而来",
                "experience": "从你们共同经历的对话中形成",
            }.get(str(item.get("memory_type", "")), "从相关对话中形成"),
            "pinned": pinned,
            "editable": True,
        })
    return {
        "query": query,
        "selectedCategory": category or "all",
        "categories": [
            {"id": "all", "label": "全部"},
            {"id": "about_user", "label": "关于你"},
            {"id": "shared", "label": "共同经历"},
            {"id": "character", "label": "角色自身"},
            {"id": "preferences", "label": "偏好习惯"},
            {"id": "goals", "label": "持续目标"},
            {"id": "pinned", "label": "已置顶"},
            {"id": "expired", "label": "已过期"},
        ],
        "items": items,
    }


def build_voice_status_view(
    runtime: Any, character_info: dict[str, Any] | None = None
) -> dict[str, Any]:
    providers = getattr(runtime, "providers", {})
    asr = providers.get("asr")
    tts = providers.get("tts")
    card = (character_info or {}).get("card", {})
    voice_name = (
        card.get("tts", {}).get("voice", "")
        if isinstance(card, dict) and isinstance(card.get("tts"), dict)
        else ""
    )
    if not voice_name:
        voice_name = str((character_info or {}).get("name", "角色声音"))

    def status(provider: Any) -> str:
        return "unavailable" if provider is None else "ready"

    return {
        "microphone": {"status": status(asr), "label": "麦克风"},
        "voice": {
            "status": status(tts),
            "label": "角色声音",
            "name": voice_name,
        },
        "outputDevice": {"status": "system_default", "label": "默认输出设备"},
        "interruptible": True,
    }


def build_capability_view(
    tools: list[dict[str, Any]],
    *,
    recent_use: dict[str, str] | None = None,
) -> dict[str, Any]:
    recent_use = recent_use or {}
    items = []
    for tool in tools:
        name = _short_text(tool.get("name"), limit=80)
        risk = str(tool.get("risk", "confirm"))
        items.append({
            "name": name,
            "description": _short_text(tool.get("description")),
            "status": "available" if tool.get("enabled", True) else "disabled",
            "permission": "automatic" if risk == "read_only" else "ask",
            "recentlyUsedAt": recent_use.get(name),
            "allowedProactively": bool(tool.get("allowed_in_initiative", False)),
        })
    return {"items": items}


def parse_memory_ref(value: str) -> int:
    prefix, separator, raw = str(value).partition(":")
    if prefix != "memory" or not separator or not raw.isdigit():
        raise ValueError("invalid memory reference")
    return int(raw)
