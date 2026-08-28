"""Daily-batch startup catch-up tests.

The daily batch (week + longterm + facts + merge + prune) used to fire only
when the app stayed running across a date change, so an evening-only usage
pattern never compiled the week/longterm layers. These tests pin the new
contract: start() queues a catch-up batch when today's stamp is missing, a
completed batch writes the stamp, and a same-day restart is a no-op.
"""

import datetime as dt

import pytest

from app.memory.store import MemoryStore
from app.memory import compiler as compiler_mod
from app.memory import ticker as ticker_mod


class _MockLLM:
    def __init__(self, response=""):
        self._response = response
        self.calls = 0

    def generate_text(self, **kwargs):
        self.calls += 1
        return self._response


@pytest.fixture
def tmp_compiler(tmp_path, monkeypatch):
    """Point compiler._get_base at tmp_path so files never touch the repo."""
    monkeypatch.setattr(compiler_mod, "_get_base", lambda: tmp_path)
    return tmp_path


_UNSET = object()


def _make_ticker(tmp_path, monkeypatch, *, llm_response="周摘要内容",
                 ticker_llm=_UNSET, chars=("monika",)):
    store = MemoryStore(base_dir=tmp_path)
    monkeypatch.setattr(compiler_mod, "memory_store", store)
    compiler_llm = _MockLLM(llm_response)
    monkeypatch.setattr(compiler_mod, "_llm_adapter_global", compiler_llm)
    ticker = ticker_mod.MemoryTicker(
        llm_adapter=_MockLLM("") if ticker_llm is _UNSET else ticker_llm,
        character_ids_getter=lambda: list(chars),
        store=store,
    )
    return ticker, store, compiler_llm


def test_startup_catchup_runs_daily_batch_and_writes_stamp(
    tmp_compiler, monkeypatch,
):
    ticker, store, compiler_llm = _make_ticker(tmp_compiler, monkeypatch)
    store.log_turn("用户聊了咖啡", {"reply_text": "好"}, character_id="monika",
                   turn_id="t1", write_token="w1")

    ticker.start()
    ticker.stop(wait=True)

    compiled = tmp_compiler / "data" / "memory" / "compiled"
    stamp = (compiled / ".last_daily").read_text("utf-8").strip()
    assert stamp == dt.date.today().isoformat()
    week = (compiled / "monika" / "week.md").read_text("utf-8")
    assert week == "周摘要内容"
    assert (compiled / "monika" / "longterm.md").exists()
    assert compiler_llm.calls >= 2  # week + longterm at minimum


def test_same_day_restart_skips_catchup(tmp_compiler, monkeypatch):
    ticker, store, compiler_llm = _make_ticker(
        tmp_compiler, monkeypatch, llm_response="must-not-be-called"
    )
    store.log_turn("用户聊了咖啡", {"reply_text": "好"}, character_id="monika",
                   turn_id="t1", write_token="w1")
    compiled = tmp_compiler / "data" / "memory" / "compiled"
    compiled.mkdir(parents=True)
    (compiled / ".last_daily").write_text(
        dt.date.today().isoformat(), "utf-8"
    )

    ticker.start()
    ticker.stop(wait=True)

    assert compiler_llm.calls == 0
    # No compiled section was regenerated for any character.
    assert not (compiled / "monika").exists()


def test_catchup_skipped_without_llm_adapter(tmp_compiler, monkeypatch):
    ticker, store, compiler_llm = _make_ticker(
        tmp_compiler, monkeypatch,
        llm_response="must-not-be-called", ticker_llm=None,
    )
    store.log_turn("用户聊了咖啡", {"reply_text": "好"}, character_id="monika",
                   turn_id="t1", write_token="w1")

    ticker.start()
    ticker.stop(wait=True)

    assert compiler_llm.calls == 0
    compiled = tmp_compiler / "data" / "memory" / "compiled"
    assert not (compiled / ".last_daily").exists()


def test_date_change_triggers_daily_batch(tmp_compiler, monkeypatch):
    ticker, _store, _llm = _make_ticker(tmp_compiler, monkeypatch)
    calls: list[int] = []
    monkeypatch.setattr(ticker, "_on_daily", lambda: calls.append(1))

    # Simulate an app that stayed up across local midnight.
    ticker._last_date = dt.date.today() - dt.timedelta(days=1)
    ticker._check_date_change()
    ticker.stop(wait=True)

    assert ticker._last_date == dt.date.today()
    assert calls == [1]
