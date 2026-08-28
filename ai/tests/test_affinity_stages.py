"""P2 affinity-stage tests: the raw affinity number is translated into a
stage label the LLM can actually act on, with a zero-interaction guard so a
fresh character never reads as 熟悉.
"""

from app.runtime.context_assembler import ContextAssembler


class _Relationship:
    def __init__(self, affinity, interactions):
        self._affinity = affinity
        self._interactions = interactions

    def to_dict(self):
        return {
            "affinity": {"default": self._affinity},
            "interaction_count": {"default": self._interactions},
        }


class _Mood:
    current = "neutral"


class _Goals:
    def top(self, n):
        return []


class _Preferences:
    def top_liked(self, n):
        return []

    def top_disliked(self, n):
        return []


class _Character:
    def __init__(self, affinity, interactions):
        self.relationship = _Relationship(affinity, interactions)
        self.mood = _Mood()
        self.goals = _Goals()
        self.preferences = _Preferences()


def test_stage_boundaries():
    stage = ContextAssembler._affinity_stage
    assert stage(0.85, 10) == "挚友"
    assert stage(0.849, 10) == "亲密"
    assert stage(0.70, 10) == "亲密"
    assert stage(0.699, 10) == "熟悉"
    assert stage(0.50, 10) == "熟悉"
    assert stage(0.499, 10) == "初识"
    assert stage(0.30, 10) == "初识"
    assert stage(0.299, 10) == "陌生"
    assert stage(0.0, 10) == "陌生"


def test_zero_interactions_reads_as_first_acquaintance():
    # The 0.5 default with no interactions is not familiarity.
    assert ContextAssembler._affinity_stage(0.5, 0) == "初识"
    assert ContextAssembler._affinity_stage(0.9, 0) == "初识"


def test_character_state_line_carries_stage_and_context():
    text = ContextAssembler().assemble_character_state(_Character(0.72, 140))
    assert "- relationship: 亲密 (affinity 0.72, 140 interactions)" in text
    # The word "affinity" stays for downstream contract tests.
    assert "affinity" in text


def test_character_state_line_uses_stage_for_new_character():
    text = ContextAssembler().assemble_character_state(_Character(0.5, 0))
    assert "初识" in text
    assert "熟悉" not in text
