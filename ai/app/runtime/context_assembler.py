"""Bounded, deduplicated memory context for the LLM."""

from __future__ import annotations


class ContextAssembler:
    COMPILED_MEMORY_CHARS = 4000

    _SUMMARY_SECTIONS = ("[还悬着]", "[现状]", "[已聊透]")

    @staticmethod
    def _truncate_summary_sections(content: str, cap: int) -> str:
        """Keep the pending section whole; head-truncate the rest within cap.

        The rolling summary's "[还悬着]" section is what must survive a long
        conversation — truncating from the head would otherwise drop the very
        threads the character is supposed to remember to follow up on.
        """
        if len(content) <= cap:
            return content
        sections: list[str] = []
        current = ""
        for line in content.splitlines(keepends=True):
            stripped = line.strip()
            if any(
                stripped.startswith(marker)
                for marker in ContextAssembler._SUMMARY_SECTIONS
            ):
                if current:
                    sections.append(current)
                current = line
            else:
                current += line
        if current:
            sections.append(current)
        pending = next(
            (s for s in sections if s.strip().startswith("[还悬着]")), ""
        )
        others = [s for s in sections if s is not pending]
        budget = cap - len(pending)
        out = pending
        for part in others:
            if budget <= 0:
                break
            out += part[:budget]
            budget -= len(part)
        return out

    @staticmethod
    def _preferences_from_memories(memories) -> tuple[list[str], list[str]]:
        """Derive liked/disliked from the persisted memories table (single source).

        Frontend edits/forgets to preference rows are immediately reflected here;
        the PreferenceTracker in Character is only a fallback for callers that do
        not pass memories.
        """
        liked: list[str] = []
        disliked: list[str] = []
        for m in memories or []:
            if m.get("type") != "preference":
                continue
            content = str((m.get("data") or {}).get("content", "")).strip()
            if not content:
                continue
            if content.startswith("用户喜欢"):
                liked.append(content[len("用户喜欢"):].strip())
            elif content.startswith("用户不喜欢"):
                disliked.append(content[len("用户不喜欢"):].strip())
            elif "不喜欢" in content or "讨厌" in content:
                disliked.append(content)
            else:
                liked.append(content)
        return liked[:5], disliked[:3]

    @staticmethod
    def _affinity_stage(affinity: float, interactions: int = 0) -> str:
        """Map the raw affinity number onto a stage the LLM can act on.

        A bare 0.52 means nothing to a model; "熟悉" does. The 0.5 default
        with zero interactions is NOT familiarity, so a never-interacted
        character reads 初识 instead of 熟悉.
        """
        if interactions <= 0:
            return "初识"
        for threshold, label in (
            (0.85, "挚友"), (0.70, "亲密"), (0.50, "熟悉"), (0.30, "初识"),
        ):
            if affinity >= threshold:
                return label
        return "陌生"

    def assemble_character_state(self, character, memories=None) -> str:
        relationship = character.relationship.to_dict()
        affinity = relationship.get("affinity", {}).get("default", 0.5)
        interactions = int(
            relationship.get("interaction_count", {}).get("default", 0) or 0
        )
        stage = self._affinity_stage(affinity, interactions)
        goals = [g.description for g in character.goals.top(3)]
        if memories:
            liked, disliked = self._preferences_from_memories(memories)
        else:
            liked = [p.topic for p in character.preferences.top_liked(5)
                     if p.valence > 0]
            disliked = [p.topic for p in character.preferences.top_disliked(3)
                        if p.valence < 0]
        lines = [
            "[Dynamic learned user and relationship state]",
            f"- mood: {character.mood.current}",
            f"- relationship: {stage} (affinity {affinity:.2f}, "
            f"{interactions} interactions)",
        ]
        if goals:
            lines.append("- active goals: " + "; ".join(goals))
        if liked:
            lines.append("- learned likes: " + "; ".join(liked))
        if disliked:
            lines.append("- learned dislikes: " + "; ".join(disliked))
        lines.append(
            "- Use this state subtly. Never recite scores or call it system state."
        )
        return "\n".join(lines)

    def assemble_memories(
        self, memories: list[dict], *, total_chars: int = 6000
    ) -> tuple[str, list[str]]:
        compiled = ""
        relevant: list[str] = []
        seen: set[str] = set()
        used = 0
        ordered = sorted(
            enumerate(memories),
            key=lambda pair: (
                pair[1].get("type") == "compiled",
                pair[1].get("source") == "hybrid",
                float(pair[1].get("data", {}).get("score", 0) or 0),
                pair[1].get("type") == "fact",
                pair[0],
            ),
            reverse=True,
        )
        for _, memory in ordered:
            if not isinstance(memory, dict):
                continue
            kind = memory.get("type", "")
            data = memory.get("data", {})
            if kind == "compiled":
                text = str(data.get("content", ""))[:self.COMPILED_MEMORY_CHARS]
                if text and not compiled:
                    compiled = text
                    used += len(text)
                continue
            if kind == "fact":
                # Hybrid memories carry their text under "content"; the legacy
                # facts-table shape used "fact". Accept both so nothing renders
                # as an empty "[Fact]" marker.
                fact = " ".join(
                    str(data.get("content") or data.get("fact", "")).split()
                )
                text = f"[Fact] {fact}".strip()
            elif kind == "log":
                role = data.get("role", "")
                label = "User" if role == "user" else "Assistant"
                text = f"{label}: {str(data.get('content', ''))[:300]}"
            elif kind == "conversation_summary":
                # Dedicated branch: the rolling summary is longer than the
                # generic 500-char cap but still counts against the budget.
                # The "[还悬着]" pending section is preserved whole so the
                # character remembers open threads after a long conversation.
                summary = ContextAssembler._truncate_summary_sections(
                    str(data.get("content", "")), 800
                )
                text = f"[近期对话] {summary}"
            elif data.get("content"):
                label = {
                    "preference": "Preference",
                    "recent_state": "Recent state",
                    "episode": "Shared experience",
                    "relationship": "Relationship memory",
                    "open_loop": "Unfinished topic",
                    "fact": "Fact",
                }.get(kind, "Memory")
                text = f"[{label}] {str(data.get('content', ''))[:500]}"
            else:
                user, assistant = data.get("user", ""), data.get("assistant", "")
                text = f"User said: {user}\nYou said: {assistant}" if user and assistant else ""
            key = " ".join(text.lower().split())
            if not text or key in seen or used + len(text) > total_chars:
                continue
            seen.add(key)
            relevant.append(text)
            used += len(text)
        return compiled, relevant
