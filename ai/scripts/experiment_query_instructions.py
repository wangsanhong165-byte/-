"""Instruction-variant experiment for the query embedding (zero-risk A/B).

The Qwen3-Embedding model is instruction-aware: the query-side task
instruction steers the query vector. Documents are instruction-free, so
swapping instruction variants does NOT touch the stored vectors — each
variant only re-embeds the eval queries, making the whole experiment a
fast in-process sweep.

Measured per variant:
  - occupation case cosine to its target (the standing known-gap metric)
  - all other related query→doc anchors (regression check)
  - unrelated query→doc distribution (noise floor shift)

Read-only against the DB.
"""

from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

from app.memory import embedder as embedder_module  # noqa: E402
from app.memory.embedder import get_embedder  # noqa: E402
from app.memory.store import memory_store  # noqa: E402

VARIANTS = {
    "baseline": (
        "Given a user chat message, retrieve the most relevant stored "
        "memories about the user"
    ),
    "profile": (
        "Retrieve user profile facts such as occupation, hobbies, habits "
        "and preferences about the user"
    ),
    "attributes": (
        "Retrieve stored facts describing the user's attributes, occupation "
        "and personal characteristics"
    ),
    "life-recall": (
        "Retrieve relevant memories about the user's life, interests and "
        "past conversations"
    ),
    "short-generic": "Find relevant user memories",
    "chinese": "检索与这条用户消息最相关的用户记忆事实（职业、爱好、习惯等）",
}


def main() -> int:
    embedder = get_embedder()
    if embedder is None:
        print("embedding channel unavailable")
        return 1

    fixtures = json.loads(
        (BASE_DIR / "tests" / "fixtures" / "memory_eval.json").read_text(encoding="utf-8")
    )
    rows = memory_store.list_memories(active_only=True, limit=500)
    docs = {row["id"]: (row["content"], embedder.embed_document(row["content"]))
            for row in rows}

    def cos(a, b):
        return sum(x * y for x, y in zip(a, b))

    import random

    rng = random.Random(42)

    results: dict[str, dict] = {}
    for name, instruction in VARIANTS.items():
        embedder_module._QUERY_TASK = instruction
        related: dict[str, float] = {}
        unrelated: list[float] = []
        for case in fixtures["cases"]:
            needles = tuple(case.get("expect_any", []))
            qv = embedder.embed_query(case["query"])
            targets = [
                (rid, vec) for rid, (text, vec) in docs.items()
                if any(needle in text for needle in needles)
            ]
            non_targets = [
                (rid, vec) for rid, (text, vec) in docs.items()
                if not any(needle in text for needle in needles)
            ]
            if qv is None:
                continue
            if targets:
                related[case["id"]] = max(cos(qv, vec) for _, vec in targets)
            sample = rng.sample(non_targets, min(12, len(non_targets)))
            for _, vec in sample:
                unrelated.append(cos(qv, vec))
        unrelated.sort()
        uq_p99 = unrelated[int(len(unrelated) * 0.99)]
        results[name] = {
            "occupation": related.get("occupation"),
            "related_min_excl_occ": min(
                s for cid, s in related.items() if cid != "occupation"
            ),
            "related_max": max(related.values()),
            "uq_p99": uq_p99,
            "uq_max": unrelated[-1],
            "related": related,
        }

    print(f"{'variant':16s} {'occ':>6s} {'rel-min':>8s} {'rel-max':>8s} "
          f"{'uq-p99':>7s} {'uq-max':>7s} {'sep-occ':>8s}")
    base = results["baseline"]
    for name, r in results.items():
        sep = r["occupation"] - r["uq_p99"]
        print(f"{name:16s} {r['occupation']:>6.3f} {r['related_min_excl_occ']:>8.3f} "
              f"{r['related_max']:>8.3f} {r['uq_p99']:>7.3f} {r['uq_max']:>7.3f} "
              f"{sep:>+8.3f}")

    print("\n== occupation 余弦逐变体（主判据：抬过无关 p99≈噪声带） ==")
    for name, r in results.items():
        print(f"  {name:16s} {r['occupation']:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
