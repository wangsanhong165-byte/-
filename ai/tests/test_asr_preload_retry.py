"""ASR engine preload must survive transient commit-memory pressure.

Windows rejects large commit allocations with os error 1455 ("page file too
small") when other services are still loading. The preload previously failed
permanently on the first exception, leaving ASR isolated until the next app
restart. These tests pin the retry contract.
"""

from __future__ import annotations

from app.modules.asr import api as asr_api


class FakeEngine:
    def __init__(self, fail_times: int):
        self.fail_times = fail_times
        self.preload_calls = 0

    def preload(self) -> None:
        self.preload_calls += 1
        if self.preload_calls <= self.fail_times:
            raise OSError(1455, "页面文件太小，无法完成操作。")


def test_preload_retries_and_succeeds_after_transient_failures():
    # Each attempt creates a fresh engine: the first two fail once, the third
    # loads cleanly — mirroring a transient commit-memory spike clearing up.
    engines = [FakeEngine(fail_times=1), FakeEngine(fail_times=1), FakeEngine(fail_times=0)]
    sleeps: list[float] = []
    created: list[FakeEngine] = []

    def create() -> FakeEngine:
        engine = engines[len(created)]
        created.append(engine)
        return engine

    engine, error = asr_api._preload_with_retries(
        create, delays=(5.0, 20.0), sleep=sleeps.append
    )

    assert error == ""
    assert engine is created[-1]
    assert [e.preload_calls for e in created] == [1, 1, 1]
    assert sleeps == [5.0, 20.0]


def test_preload_reports_error_after_exhausting_retries():
    engines = [FakeEngine(fail_times=99) for _ in range(4)]
    sleeps: list[float] = []
    created: list[FakeEngine] = []

    def create() -> FakeEngine:
        engine = engines[len(created)]
        created.append(engine)
        return engine

    engine, error = asr_api._preload_with_retries(
        create, delays=(5.0, 20.0, 45.0), sleep=sleeps.append
    )

    assert engine is None
    assert "attempt 4" in error
    assert "1455" in error
    assert sleeps == [5.0, 20.0, 45.0]
    assert [e.preload_calls for e in created] == [1, 1, 1, 1]


def test_default_retry_delays_fit_the_readiness_window():
    # services.json gives ASR a 120s readiness timeout; three load attempts
    # (~13s each) plus the delays must stay inside it.
    assert sum(asr_api._PRELOAD_RETRY_DELAYS) + 3 * 15 < 120
