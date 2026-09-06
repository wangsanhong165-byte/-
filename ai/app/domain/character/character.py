"""Character aggregate — the identity center of the system."""

from app.domain.character.persona import Persona
from app.domain.character.emotion import EmotionState
from app.domain.character.relationship import RelationshipTracker
from app.domain.character.mood import MoodTrend
from app.domain.character.goal import GoalTracker
from app.domain.character.preference import PreferenceTracker


class Character:
    """Character aggregate — combines persona, emotion, relationship, mood, goals, and preferences.

    Every interaction is Character.respond(context), making Character the
    identity center of the system.
    """

    def __init__(self, card: dict):
        self.id = card.get("id", "")
        self.persona = Persona(card)
        self.emotion = EmotionState()
        self.relationship = RelationshipTracker()
        self.mood = MoodTrend()
        self.goals = GoalTracker()
        self.preferences = PreferenceTracker()
        self._recent_focus: list[str] = []
        self._recent_changes: list[str] = []
        self._last_interaction: str = ""
        self._last_interaction_at: float = 0.0
        self._interaction_count: int = 0
        self._raw_card = card

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "persona": {
                "name": self.persona.name,
                "setting": self.persona.setting,
            },
            "emotion": self.emotion.to_dict(),
            "relationship": self.relationship.to_dict(),
            "mood": self.mood.to_dict(),
            "goals": self.goals.to_dict(),
            "preferences": self.preferences.to_dict(),
            "recent_focus": list(self._recent_focus),
            "recent_changes": list(self._recent_changes),
            "last_interaction": self._last_interaction,
            "last_interaction_at": self._last_interaction_at,
            "interaction_count": self._interaction_count,
        }

    def dynamic_state(self) -> dict:
        return {
            "emotion": self.emotion.to_dict(),
            "relationship": self.relationship.to_dict(),
            "mood": self.mood.to_dict(),
            "goals": self.goals.to_dict(),
            "preferences": self.preferences.to_dict(),
        }

    def restore_dynamic_state(self, state: dict | None) -> None:
        if not state:
            return
        from app.domain.character.goal import Goal
        from app.domain.character.preference import Preference

        relationship = state.get("relationship", {})
        self.relationship._affinity = {
            str(k): float(v) for k, v in relationship.get("affinity", {}).items()
        }
        self.relationship._interaction_count = {
            str(k): int(v) for k, v in relationship.get("interaction_count", {}).items()
        }

        self.preferences._preferences = {}
        for topic, raw in state.get("preferences", {}).items():
            self.preferences._preferences[topic] = Preference(
                topic=str(raw.get("topic", topic)),
                valence=float(raw.get("valence", 0)),
                confidence=float(raw.get("confidence", 0.3)),
                last_updated=float(raw.get("last_updated", 0)),
            )

        goals = state.get("goals", {})
        def make_goal(raw):
            return Goal(
                id=str(raw.get("id", "")),
                description=str(raw.get("description", "")),
                priority=int(raw.get("priority", 0)),
                deadline=raw.get("deadline"),
                completed=bool(raw.get("completed", False)),
                created_at=float(raw.get("created_at", 0)),
            )
        self.goals._goals = [make_goal(raw) for raw in goals.get("active", [])]
        self.goals._completed = [make_goal(raw) for raw in goals.get("completed", [])]

        mood = state.get("mood", {})
        self.mood.restore(
            valence=float(mood.get("valence", 0)),
            history=list(mood.get("history", []))[-20:],
            current=str(mood.get("current", "")) or None,
        )

        emotion = state.get("emotion", {})
        self.emotion.current = str(emotion.get("current", "neutral"))
        self.emotion.set_intensity(float(emotion.get("intensity", 0.5)))

        self._recent_focus = [str(item) for item in state.get("recent_focus", []) if str(item).strip()][:6]
        self._recent_changes = [str(item) for item in state.get("recent_changes", []) if str(item).strip()][:6]
        self._last_interaction = str(state.get("last_interaction", ""))
        self._last_interaction_at = float(state.get("last_interaction_at", 0.0) or 0.0)
        self._interaction_count = int(state.get("interaction_count", 0) or 0)

    @property
    def raw_card(self) -> dict:
        """Access the validated raw card for provider adapters."""
        return self._raw_card
