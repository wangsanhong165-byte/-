"""Run the memory retrieval regression set against the live memory database.

Read-only by design: cases are scored with score_memory over list_memories()
output (never search_memories) so running the eval does not bump
access_count/last_retrieved_at and skew future retrieval.

Usage:  python scripts/run_memory_eval.py [--fixtures tests/fixtures/memory_eval.json]
Exit code 0 when every case passes.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

from app.memory.retrieval import score_memory  # noqa: E402
from app.memory.store import memory_store  # noqa: E402

_EVIDENCE = {"direct_match", "semantic_overlap", "tag_match", "vector_match"}


def _vector_channel(query: str, rows: list[dict]) -> None:
    """Attach the vector channel read-only (embed query, decode row blobs)."""
    from app.memory.embedder import get_embedder

    embedder = get_embedder()
    if embedder is None:
        return
    query_vector = embedder.embed_query(query)
    if query_vector is None:
        return
    from app.memory.store import _decode_vector, _renormalized_cosine

    for row in rows:
        row["vector_enabled"] = True
        row["vector_score"] = _renormalized_cosine(
            query_vector, _decode_vector(row.get("embedding"))
        ) or 0.0


def _ranked(query: str, character_id: str, top_k: int) -> list[dict]:
    now = time.time()
    ranked = []
    for item in memory_store.list_memories(
        character_id=character_id, active_only=True, limit=250
    ):
        from datetime import datetime

        for field, key in (("created_at", "created_ts"), ("updated_at", "updated_ts")):
            try:
                item[key] = datetime.fromisoformat(
                    str(item.get(field, ""))
                ).timestamp()
            except (ValueError, TypeError):
                item[key] = 0.0
        _vector_channel(query, [item])
        score, reasons = score_memory(query, item, now=now)
        # Mirror the store: 0.24 score bar exempts pinned-level rows.
        if (
            score < 0.24
            and float(item.get("importance", 0.5) or 0.5) < 0.9
        ):
            continue
        if not (_EVIDENCE & set(reasons)) and float(
            item.get("importance", 0.5) or 0.5
        ) < 0.9:
            continue
        item["score"] = score
        ranked.append(item)
    ranked.sort(key=lambda row: row["score"], reverse=True)
    return ranked[:top_k]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--fixtures",
        default=str(BASE_DIR / "tests" / "fixtures" / "memory_eval.json"),
    )
    args = parser.parse_args()

    suite = json.loads(Path(args.fixtures).read_text(encoding="utf-8"))
    by_category: dict[str, list[bool]] = defaultdict(list)
    known_gaps: list[str] = []
    failures = []
    for case in suite["cases"]:
        ranked = _ranked(
            case["query"], case.get("character_id", ""), int(case.get("top_k", 3))
        )
        contents = [str(row.get("content", "")) for row in ranked]
        passed: bool
        if case.get("expect_empty"):
            passed = not contents
        elif case.get("expect_only_pinned"):
            # Pinned (importance>=0.9) rows surface on every query by design;
            # abstention holds when NOTHING unpinned leaks into the slots.
            passed = all(
                float(row.get("importance", 0.5) or 0.5) >= 0.9 for row in ranked
            )
        elif case.get("expect_absent"):
            passed = not any(
                needle in content
                for needle in case["expect_absent"]
                for content in contents
            )
        else:
            passed = any(
                needle in content
                for needle in case.get("expect_any", [])
                for content in contents
            )
        if case.get("known_limitation"):
            # Documented residual gaps (e.g. legacy rows without paraphrase
            # keys, CJK lexical ambiguity): reported, never silently counted
            # as green.
            known_gaps.append(case["id"])
            mark = "GAP " if passed else "GAP!"
            by_category.setdefault("known_gap", []).append(passed)
        else:
            mark = "PASS" if passed else "FAIL"
            by_category[case.get("category", "uncategorized")].append(passed)
            if not passed:
                failures.append(case["id"])
        print(f"[{mark}] {case['id']} ({case.get('category')})")
        if not passed:
            for content in contents:
                print(f"       got: {content[:80]}")

    print("\n== category accuracy ==")
    total_pass = total = 0
    for category, results in sorted(by_category.items()):
        print(f"{category}: {sum(results)}/{len(results)}")
        if category != "known_gap":
            total_pass += sum(results)
            total += len(results)
    print(f"TOTAL (excluding known gaps): {total_pass}/{total}")
    if known_gaps:
        print("known gaps (documented, not blocking):", ", ".join(known_gaps))
    if failures:
        print("failed cases:", ", ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
