# Domain Model Stabilization Report

> **Status**: Ratified — all domain models are stable
> **Date**: 2026-06-29
> **Constitution ref**: §5

---

## 1. `LLMResponse` — STABLE

**File**: `app/interfaces/llm.py`
**Type**: `@dataclass`
**Fields**: `reply`, `segments`, `tool_calls`, `messages`, `error`

**Stabilization history**:
- Phase 5.5 eliminated the double-encoded JSON protocol
- `reply` is always plain text (extracted `final_reply` or raw content)
- `segments` are per-sentence dicts with `text`, `tone`, `gesture` keys
- `tool_calls` is a `list[ToolCall]` — structured objects, not raw dicts
- `messages` is the full conversation history (used by DecisionStep's tool-calling loop)
- `error` is provider-level error string (empty on success)

**Consumers**: `DecisionStep`, `OpenAILLMProvider._normalize()`, `bridge/runtime_handler.py`

---

## 2. `ToolCall` — STABLE

**File**: `app/interfaces/llm.py`
**Type**: `@dataclass`
**Fields**: `name`, `args`

**Stabilization history**:
- Extracted from anonymous dicts to typed dataclass in Phase 5.5
- `name` is the tool name string
- `args` is the tool arguments dict

**Consumers**: `DecisionStep` (tool-calling loop), `OpenAILLMProvider._normalize()`

---

## 3. `Event` — STABLE

**File**: `app/runtime/event.py`
**Type**: `@dataclass`
**Fields**: `type`, `payload`, `source`, `timestamp`, `id`

**Canonical types**:
- `EventType.TEXT_RECEIVED` — text input
- `EventType.SPEECH_RECEIVED` — voice input
- `EventType.VISUAL_RECEIVED` — validated image input
- `EventType.INITIATIVE_TRIGGERED` — proactive speech
- `EventType.TOOL_FINISHED` — tool execution complete
- `EventType.SESSION_RESUMED` — session recovery

**Consumers**: `CompanionRuntime.dispatch()`, `RuntimeWebSocketHandler`, Pipeline Steps

---

## 4. `Context` — STABLE

**File**: `app/runtime/context.py`
**Type**: `@dataclass`
**Fields**: `event`, `state`, `user_text`, `reply_text`, `segments`, `emotion`, `emotion_intensity`, `audio`, `error`, `status_message`, `status_callback`

**Stabilization history**:
- Canonical pipeline data carrier — every Step reads/writes this
- `state` is a generic dict for Step-specific data (character, memories, tool_calls, tool_results, conversation)
- `reply_text` is guaranteed to be plain text after Phase 5.5
- `segments` populated by DecisionStep from LLM response
- `audio` populated by TTSStep from TTS provider
- `status_message`: human-readable progress string set during pipeline execution
- `status_callback`: optional async callable for streaming status updates (e.g., tool call progress)

**Consumers**: All 8 Pipeline Steps, `RuntimeWebSocketHandler`, `CompanionRuntime.dispatch()`

---

## 5. `Character` — STABLE

**File**: `app/domain/character/character.py`
**Type**: class (aggregate root)
**Fields**: `id`, `persona`, `emotion`, `relationship`, `mood`, `goals`, `preferences`, `raw_card`

**Sub-models**:

| Model | File | Purpose |
|-------|------|---------|
| `Persona` | `app/domain/character/persona.py` | Character card accessors (name, setting, tone_words, sprites, TTS refs) |
| `EmotionState` | `app/domain/character/emotion.py` | 31+ valid emotions (10 core + 21 Monika-specific) with intensity tracking |
| `RelationshipTracker` | `app/domain/character/relationship.py` | Affinity tracking |
| `MoodTrend` | `app/domain/character/mood.py` | Mood trend analysis |
| `GoalTracker` | `app/domain/character/goal.py` | Character goals |
| `PreferenceTracker` | `app/domain/character/preference.py` | User preference tracking |

**Consumers**: `CharacterStep` (injects into context), `EmotionStep` (mutates emotion), `DefaultPlanner`/`PromptStrategy` (reads persona), `DecisionStep` (reads tone_words, prompt_lang)

---

## 6. `Conversation` — STABLE

**File**: `app/domain/conversation/conversation.py`
**Type**: class
**Fields**: `_turns: list[Turn]`, `_max_turns: int`

| Method | Purpose |
|--------|---------|
| `add_turn(role, content, **metadata)` | Append a turn with optional metadata (auto-truncates to max_turns) |
| `get_history(limit)` | Return message dicts for LLM consumption |
| `clear()` | Reset conversation |
| `turn_count` | Total turns counter |
| `last_turn` | Most recent Turn or None |

**Consumers**: `CompanionRuntime` (injects into context), `DefaultPlanner`/`PromptStrategy` (reads history), `DecisionStep` (adds turns)

---

## 7. `EmotionState` — STABLE

**File**: `app/domain/character/emotion.py`
**Type**: class

**Valid emotions** (31+, expanded from 10 core):
`neutral`, `happy`, `sad`, `angry`, `surprised`, `worried`, `shy`, `gentle`, `serious`, `jealous`,
`playful`, `explaining`, `smile`, `cheerful`, `cold`, `stern`, `emphasizing`, `happy_closed`,
`laughing`, `awkward_smile`, `awkward`, `nervous`, `shocked`, `sigh`, `giving_up`, `warm_smile`,
`friendly`, `curious`, `cold_stare`, `meek`, `soft_smile`, `blank`, `thinking`, `lightly_surprised`,
`confused`, `blissful`, `joyful`, `awkward_grin`, `embarrassed`, `startled`, `panicked`

| Method | Purpose |
|--------|---------|
| `set(emotion, intensity)` | Change emotion (records transition in history) |
| `current` | Current emotion name |
| `intensity` | 0.0–1.0 |
| `history` | List of emotion transitions (from → to → intensity) |
| `to_dict()` | Serialize to dict |

**Consumers**: `CharacterStep` (reads initial), `EmotionStep` (keyword-based fallback)

---

## 8. `StateStore` — STABLE

**File**: `app/core/state_store.py`
**Type**: class (singleton)

| Method | Purpose |
|--------|---------|
| `get(key, default)` | Thread-safe read |
| `set(key, value)` | Thread-safe write |
| `update(**changes)` | Thread-safe multi-write |
| `snapshot()` | Thread-safe full copy |

**Common keys**: `activity`, `attention`, `emotion`, `context`, `turn_count`, `runtime_initialized`

**Consumers**: Global — used by Runtime, Services, Core, Input modules

---

## Summary

| Domain Model | File | Type | Stability | Consumers |
|-------------|------|------|-----------|-----------|
| `LLMResponse` | `app/interfaces/llm.py` | dataclass | ✅ Stable | DecisionStep, bridge |
| `ToolCall` | `app/interfaces/llm.py` | dataclass | ✅ Stable | DecisionStep |
| `Event` | `app/runtime/event.py` | dataclass | ✅ Stable | Runtime.dispatch, bridge |
| `Context` | `app/runtime/context.py` | dataclass | ✅ Stable | All Steps, bridge |
| `Character` | `app/domain/character/character.py` | aggregate | ✅ Stable | Steps, Planner |
| `Conversation` | `app/domain/conversation/conversation.py` | class | ✅ Stable | Runtime, Steps, Planner |
| `EmotionState` | `app/domain/character/emotion.py` | class | ✅ Stable | CharacterStep, EmotionStep |
| `StateStore` | `app/core/state_store.py` | singleton | ✅ Stable | Global |

All domain models are stable and suitable for freezing. No structural changes are anticipated.
