from types import SimpleNamespace

from app.providers.memory.sqlite_memory import SQLiteMemory
from app.runtime.management import RuntimeManager


def test_sqlite_memory_fallback_is_reported_as_degraded(monkeypatch, tmp_path):
    import app.memory.store as store_module

    class BrokenStore:
        def __init__(self):
            raise OSError("database path is unavailable")

    monkeypatch.setattr(store_module, "MemoryStore", BrokenStore)
    memory = SQLiteMemory()

    assert memory.diagnostics() == {
        "status": "degraded",
        "persistent": False,
        "mode": "memory_fallback",
        "reason": "database path is unavailable",
        "compression": "disabled",
    }

    runtime = SimpleNamespace(
        providers={"memory": memory},
        _runtime_idle=True,
        _active_turn=None,
        get_character_info=lambda: {"card": {"id": "shirone"}},
    )
    diagnostics = RuntimeManager(base_dir=tmp_path, runtime=runtime).get_runtime_diagnostics()

    assert diagnostics["providers"] == [{
        "name": "memory",
        "status": "degraded",
        "adapter": "SQLiteMemory",
        "detail": "database path is unavailable",
        "compression": "disabled",
    }]
