"""Typed CharacterTurn pipeline infrastructure."""

from __future__ import annotations

from abc import ABC, abstractmethod
import time
from typing import Any

from app.runtime.character_turn import CharacterTurn


class Step(ABC):
    @abstractmethod
    async def run(self, turn: CharacterTurn) -> None:
        """Mutate runtime-owned transient fields on one CharacterTurn."""


class Pipeline:
    """Run ordered steps until completion or a structured turn failure."""

    def __init__(self):
        self._steps: list[Step] = []
        self._telemetry_observer: Any = None

    def add(self, step: Step) -> "Pipeline":
        self._steps.append(step)
        return self

    def set_telemetry_observer(self, observer: Any) -> None:
        """Set an optional callback to receive telemetry events."""
        self._telemetry_observer = observer

    async def run(self, turn: CharacterTurn) -> CharacterTurn:
        for step in self._steps:
            started_at = time.perf_counter()
            step_name = step.__class__.__name__
            span_id = getattr(turn, "telemetry", None)
            if span_id is not None:
                try:
                    span_id = turn.telemetry.start_span(f"pipeline.{step_name}")
                except Exception:
                    span_id = None
            try:
                await step.run(turn)
            except Exception as exc:
                code = str(getattr(exc, "code", "") or f"pipeline.{step_name}")
                retryable = bool(getattr(exc, "retryable", False))
                turn.fail(
                    code,
                    str(exc),
                    retryable=retryable,
                )
            finally:
                elapsed = (time.perf_counter() - started_at) * 1000
                turn.metrics[f"{step_name}_ms"] = elapsed
                if span_id is not None and turn.telemetry is not None:
                    try:
                        status = "failed" if turn.error else "ok"
                        turn.telemetry.end_span(span_id, status=status)
                    except Exception:
                        pass
            if turn.error:
                break
        # Flush telemetry to observer
        if self._telemetry_observer is not None and turn.telemetry is not None:
            try:
                turn.telemetry.emit_all(self._telemetry_observer)
            except Exception:
                pass
        return turn
