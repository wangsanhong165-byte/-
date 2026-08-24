"""Proactive switch + idle gate read from persisted settings."""

from types import SimpleNamespace
from unittest.mock import Mock

from app.runtime.management import RuntimeManager
from app.runtime.runtime import CharacterRuntime


def _rt():
    # Build an instance WITHOUT running __init__ (no service startup).
    return CharacterRuntime.__new__(CharacterRuntime)


def test_load_proactive_settings_defaults(tmp_path):
    proactive, idle = _rt()._load_proactive_settings(tmp_path / "missing.json")
    assert proactive is True
    assert idle is None


def test_load_proactive_settings_reads_values(tmp_path):
    settings = tmp_path / "settings.json"
    settings.write_text(
        '{"proactive": false, "proactiveIdleTime": 180}', encoding="utf-8"
    )
    proactive, idle = _rt()._load_proactive_settings(settings)
    assert proactive is False
    assert idle == 180.0


def test_load_proactive_settings_ignores_small_idle(tmp_path):
    settings = tmp_path / "settings.json"
    settings.write_text(
        '{"proactive": true, "proactiveIdleTime": 5}', encoding="utf-8"
    )
    proactive, idle = _rt()._load_proactive_settings(settings)
    assert proactive is True
    assert idle is None  # <10s is treated as "not configured"


def test_load_proactive_settings_tolerates_malformed(tmp_path):
    settings = tmp_path / "settings.json"
    settings.write_text("not json", encoding="utf-8")
    proactive, idle = _rt()._load_proactive_settings(settings)
    assert proactive is True
    assert idle is None


def test_enabling_proactive_starts_async_drain_without_prior_user_turn():
    checker = SimpleNamespace(start=Mock(), stop=Mock())
    runtime = SimpleNamespace(
        initiative_checker=checker,
        screen_watcher=None,
        _start_initiative_drain=Mock(),
    )
    manager = RuntimeManager.__new__(RuntimeManager)
    manager._runtime = runtime

    manager.set_proactive(True)

    checker.start.assert_called_once_with()
    runtime._start_initiative_drain.assert_called_once_with()
