"""P1 extraction-dimension tests: the fact-extraction prompt teaches the LLM
new profile dimensions (sleep schedule, personality traits, sensitive topics,
mood triggers) and maps them onto existing memory types. The pipeline itself
is unchanged; these tests pin the prompt contract and the end-to-end storage
behavior with the new dimensions.
"""

import json

from app.memory.extractor import extract_facts
from app.memory.prompts import system_fact_extraction
from app.memory.store import MemoryStore


class _MockLLM:
    def __init__(self, response: str):
        self._response = response

    def generate_text(self, **kwargs):
        return self._response


def test_extraction_prompt_teaches_new_dimensions():
    prompt = system_fact_extraction()
    # New dimensions are named in the profile rule.
    for keyword in ("作息习惯", "性格特质", "雷区话题", "情绪触发点"):
        assert keyword in prompt
    # Dimension → type mapping guidance exists.
    assert "sensitive_topic" in prompt
    assert "sleep_schedule" in prompt
    assert "宁缺毋滥" in prompt
    # Legacy contract from the original prompt must stay intact.
    assert "open_loop" in prompt
    assert "不要提取 open_loop" in prompt
    assert "fact、preference、recent_state、episode、relationship" in prompt
    assert ", open_loop" not in prompt


def test_new_dimension_facts_persist_with_expected_types(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    llm = _MockLLM(json.dumps([
        {"fact": "用户习惯深夜活跃，常在凌晨两点后还在聊天", "type": "fact",
         "subject": "user", "predicate": "sleep_schedule",
         "stable_key": "fact:user:sleep_schedule",
         "confidence": 0.75, "importance": 0.6, "tags": ["作息"]},
        {"fact": "用户不想被提起工作失误的往事", "type": "preference",
         "subject": "user", "predicate": "sensitive_topic",
         "stable_key": "preference:user:sensitive_topic",
         "confidence": 0.8, "importance": 0.85, "tags": ["雷区"]},
        {"fact": "用户是个急性子，等不及长解释", "type": "fact",
         "subject": "user", "predicate": "personality_trait",
         "stable_key": "fact:user:personality_trait",
         "confidence": 0.8, "importance": 0.7, "tags": ["性格"]},
    ], ensure_ascii=False))

    stored = extract_facts("摘要：用户凌晨两点还在聊天，提到不想聊工作失误，说话很急。",
                           llm, character_id="monika", store=store)

    assert len(stored) == 3
    rows = {row["stable_key"]: row for row in
            store.list_memories(character_id="monika")}
    # Sleep schedule survives as a fact (no recent_state keywords inside).
    assert rows["fact:user:sleep_schedule"]["memory_type"] == "fact"
    # Sensitive topic survives as a preference (high importance by design).
    assert rows["preference:user:sensitive_topic"]["memory_type"] == "preference"
    assert rows["preference:user:sensitive_topic"]["importance"] == 0.85
    # Personality trait survives as a fact.
    assert rows["fact:user:personality_trait"]["memory_type"] == "fact"


def test_low_confidence_new_dimension_facts_are_dropped(tmp_path):
    """宁缺毋滥 backstop: lifecycle drops candidates below confidence 0.55."""
    store = MemoryStore(base_dir=tmp_path)
    llm = _MockLLM(json.dumps([
        {"fact": "用户可能大概也许是个夜猫子", "type": "fact",
         "subject": "user", "predicate": "sleep_schedule",
         "stable_key": "fact:user:sleep_schedule",
         "confidence": 0.4, "importance": 0.5, "tags": []},
    ], ensure_ascii=False))

    stored = extract_facts("摘要内容", llm, character_id="monika", store=store)

    assert stored == []
    assert store.list_memories(character_id="monika") == []
