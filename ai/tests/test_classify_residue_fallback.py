"""classify_residue self-serve fallback — recent turns from the recorder.

The frontend fires the command with NO payload (it holds no conversation
transcript); management must classify the freshest recorder summaries.
Runs against the real residue corpus (vectors cached in data/memory, hash
current as of 2026-09-06) with the rerank channel off (conftest) — the
fallback logic, not the scorer, is what's under test.
"""

from __future__ import annotations

import pytest

from app.runtime.management import RuntimeManager
from app.runtime.turn_recorder import TurnRecorder


class _FakeRecorder:
    def __init__(self, turns: list[dict] | Exception):
        self._turns = turns

    def list_turns(self, limit: int = 100) -> list[dict]:
        if isinstance(self._turns, Exception):
            raise self._turns
        return self._turns[:limit]


@pytest.fixture()
def service(monkeypatch):
    # classify_residue touches no instance state; a bare object keeps the
    # test free of default_runtime construction.
    return object.__new__(RuntimeManager)


def test_explicit_texts_still_work(service):
    result = RuntimeManager.classify_residue(
        service, ["哈哈刚才笑死我了"])
    assert result.get("matched") is True
    assert result.get("label") == "playful_residue"


def test_empty_payload_falls_back_to_recorder(service, monkeypatch):
    recorder = _FakeRecorder([
        {"turn_id": "t2", "summary": "这个bug又失败了，改了一天"},
        {"turn_id": "t1", "summary": ""},
    ])
    monkeypatch.setattr(
        "app.runtime.turn_recorder.get_turn_recorder", lambda: recorder)
    result = RuntimeManager.classify_residue(service, None)
    assert result.get("matched") is True
    assert result.get("label") == "stress_residue"


def test_recorder_failure_degrades_to_no_match(service, monkeypatch):
    monkeypatch.setattr(
        "app.runtime.turn_recorder.get_turn_recorder",
        lambda: _FakeRecorder(RuntimeError("db gone")),
    )
    result = RuntimeManager.classify_residue(service, None)
    assert result.get("matched") is False


def test_transport_dispatcher_accepts_missing_payload(service):
    # classify_residue(None) must not raise on the dispatcher's type gate.
    result = RuntimeManager.classify_residue(service, None)
    assert isinstance(result, dict)


def test_recorder_type_is_the_real_one(service):
    # The fallback imports the process-wide recorder factory — make sure the
    # symbol management imports still exists (guards against renames).
    from app.runtime.turn_recorder import get_turn_recorder

    assert callable(get_turn_recorder)
    assert isinstance(get_turn_recorder(), TurnRecorder)
