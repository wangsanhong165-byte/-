from __future__ import annotations

import gc
import os
import tempfile
from pathlib import Path


_TEST_RUNTIME_DIR: tempfile.TemporaryDirectory[str] | None = None


def pytest_configure(config) -> None:
    """Keep all runtime persistence produced by tests out of live databases."""
    global _TEST_RUNTIME_DIR
    _TEST_RUNTIME_DIR = tempfile.TemporaryDirectory(prefix="soullink-pytest-")
    runtime_temp = Path(_TEST_RUNTIME_DIR.name)
    os.environ["SOULLINK_TURN_TRACE_DB"] = str(
        runtime_temp / "runtime" / "turns.db"
    )
    os.environ["MEMORY_DB_PATH"] = str(
        runtime_temp / "memory" / "memory.db"
    )
    # LLM provider profiles hold secrets; tests must never read the live file.
    os.environ["LLM_PROVIDERS_PATH"] = str(
        runtime_temp / "config" / "llm_providers.json"
    )
    # The rerank channel is a real GPU model — unit tests must stay
    # deterministic and model-free; rerank logic is covered by
    # tests/test_prototype_rerank.py with injected fakes.
    os.environ.setdefault("RERANKER_ENABLED", "0")


def pytest_unconfigure(config) -> None:
    """Close test SQLite stores before removing their isolated data."""
    global _TEST_RUNTIME_DIR
    try:
        from app.memory.store import MemoryStore

        for candidate in gc.get_objects():
            if isinstance(candidate, MemoryStore):
                candidate.stop()
        gc.collect()
    except (ImportError, RuntimeError):
        pass
    if _TEST_RUNTIME_DIR is not None:
        _TEST_RUNTIME_DIR.cleanup()
        _TEST_RUNTIME_DIR = None
