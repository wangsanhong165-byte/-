"""Replay fixed CharacterTurn scenarios and calculate reproducible metrics."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any


def _repeat_rate(values: list[str]) -> float:
    if not values:
        return 0.0
    counts = Counter(value for value in values if value)
    repeated = sum(max(0, count - 1) for count in counts.values())
    return repeated / len(values)


def calculate_metrics(records: list[dict[str, Any]]) -> dict[str, float]:
    latencies = sorted(
        float(record.get("metrics", {}).get("e2e_latency_ms", 0))
        for record in records
    )
    p95_index = max(0, math.ceil(len(latencies) * 0.95) - 1) if latencies else 0
    performance = [record.get("performance", {}) for record in records]
    persona_scores = [
        float(record["persona_score"])
        for record in records
        if record.get("persona_score") is not None
    ]
    return {
        "scenario_count": float(len(records)),
        "p95_latency_ms": latencies[p95_index] if latencies else 0.0,
        "reply_exact_repeat_rate": _repeat_rate([
            str(record.get("reply_text", "")) for record in records
        ]),
        "emotion_repeat_rate": _repeat_rate([
            str(item.get("emotion", "")) for item in performance
        ]),
        "behavior_repeat_rate": _repeat_rate([
            str(item.get("behavior", "")) for item in performance
        ]),
        "persona_score": (
            sum(persona_scores) / len(persona_scores) if persona_scores else 0.0
        ),
    }


async def replay(scenarios: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from app.runtime.character_turn import TurnInput, TurnOrigin
    from app.runtime.runtime import CharacterRuntime

    runtime = CharacterRuntime()
    records = []
    try:
        for scenario in scenarios:
            origin = TurnOrigin(str(scenario.get("origin", "user")))
            turn = await runtime.handle_turn(TurnInput(
                text=str(scenario["text"]),
                origin=origin,
                metadata={
                    "initiative": dict(scenario.get("initiative", {})),
                    "event_payload": dict(scenario.get("event_payload", {})),
                },
            ))
            records.append({
                "scenario_id": scenario["id"],
                "turn_id": turn.turn_id,
                "reply_text": turn.reply_text,
                "segments": turn.segments,
                "performance": turn.live2d_intent,
                "metrics": turn.metrics,
                "warnings": turn.warnings,
                "error": (
                    {
                        "code": turn.error.code,
                        "message": turn.error.message,
                    }
                    if turn.error else None
                ),
                "persona_score": scenario.get("persona_score"),
            })
    finally:
        runtime.shutdown()
    return records


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenarios", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--metrics", required=True)
    args = parser.parse_args()

    import yaml
    scenarios = yaml.safe_load(Path(args.scenarios).read_text("utf-8"))
    if isinstance(scenarios, dict):
        scenarios = scenarios.get("scenarios", [])
    records = asyncio.run(replay(list(scenarios)))

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )
    metrics_path = Path(args.metrics)
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.write_text(
        json.dumps(calculate_metrics(records), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
