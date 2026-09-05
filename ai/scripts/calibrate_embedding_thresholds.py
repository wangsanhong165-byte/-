"""Measure the active embedding engine's related/unrelated cosine bands on
the real memory database, and print suggested threshold constants.

Method:
- RELATED anchors: eval queries against their known target memories
  (tests/fixtures/memory_eval.json expect_any cases) + known same-fact
  rewording groups from the real DB.
- UNRELATED bulk: doc-doc pairs excluding the known rewording groups and
  exact-duplicate pairs (those are dedup candidates, not noise).
- QUERY→DOC unrelated: eval queries against random non-target rows.

Read-only against the DB (list_memories + embedder, never search_memories).
"""

from __future__ import annotations

import itertools
import json
import random
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

from app.memory.embedder import get_embedder  # noqa: E402
from app.memory.store import memory_store  # noqa: E402

# Known same-fact rewording groups (real DB contents, verified in the audit).
DOC_DOC_GROUPS = [
    ["用户习惯深夜活跃，凌晨三四点甚至接近五点还在聊天，是典型的夜猫子作息",
     "用户深夜活跃，常在深夜与AI聊天",
     "用户深夜活跃，习惯在很晚时还持续聊天"],
    ["用户相信这个世界存在鬼，对鬼神话题持笃定态度",
     "用户Alice相信世界上有鬼",
     "用户相信世界上有鬼"],
]


def main() -> int:
    embedder = get_embedder()
    if embedder is None:
        print("embedding channel unavailable")
        return 1
    rows = memory_store.list_memories(active_only=True, limit=500)
    vectors = {}
    for row in rows:
        vec = embedder.embed_document(row["content"])
        if vec:
            vectors[row["id"]] = (row["content"], vec)
    contents = {row_id: text for row_id, (text, _) in vectors.items()}
    print(f"embedded docs: {len(vectors)}")

    def cos(a, b):
        return sum(x * y for x, y in zip(a, b))

    # ── related: eval query → target anchors ──────────────────────────
    fixtures = json.loads(
        (BASE_DIR / "tests" / "fixtures" / "memory_eval.json").read_text(encoding="utf-8")
    )
    related_qd: list[tuple[str, float]] = []
    print("\n== related query→doc anchors ==")
    for case in fixtures["cases"]:
        for needle in case.get("expect_any", []):
            targets = [
                (row_id, text) for row_id, text in contents.items() if needle in text
            ]
            if not targets:
                continue
            qv = embedder.embed_query(case["query"])
            best = max(cos(qv, vectors[row_id][1]) for row_id, _ in targets)
            related_qd.append((case["id"], best))
            print(f"  {case['id']:28s} {best:.3f}  ({targets[0][1][:24]})")

    # ── related: doc-doc rewording anchors ────────────────────────────
    related_dd: list[float] = []
    group_pair_ids: set[tuple[int, int]] = set()
    print("\n== related doc→doc anchors (rewording groups) ==")
    for group in DOC_DOC_GROUPS:
        pairs = []
        for text in group:
            match = next(((rid, v) for rid, (t, v) in vectors.items() if t == text), None)
            if match:
                pairs.append(match)
        for (id_a, vec_a), (id_b, vec_b) in itertools.combinations(pairs, 2):
            score = cos(vec_a, vec_b)
            related_dd.append(score)
            group_pair_ids.add((min(id_a, id_b), max(id_a, id_b)))
            print(f"  {score:.3f}")

    # exact duplicates (identical content, different rows)
    by_content: dict[str, list[int]] = {}
    for row_id, (text, _) in vectors.items():
        by_content.setdefault(text, []).append(row_id)
    exact_dup_pairs = {
        (min(a, b), max(a, b))
        for ids in by_content.values() if len(ids) > 1
        for a, b in itertools.combinations(ids, 2)
    }
    print(f"\nexact-duplicate pairs in active set: {len(exact_dup_pairs)}")

    # ── unrelated: doc-doc bulk excluding related/exact-dup pairs ─────
    ids = sorted(vectors)
    all_pairs = []
    for a, b in itertools.combinations(ids, 2):
        if (a, b) in group_pair_ids or (a, b) in exact_dup_pairs:
            continue
        all_pairs.append(cos(vectors[a][1], vectors[b][1]))
    all_pairs.sort()
    n = len(all_pairs)

    def pct(p):
        return all_pairs[min(n - 1, int(n * p))]

    print(f"\n== unrelated doc→doc bulk (n={n}) ==")
    print(f"  p50={pct(0.50):.3f} p90={pct(0.90):.3f} p95={pct(0.95):.3f} "
          f"p99={pct(0.99):.3f} max={all_pairs[-1]:.3f}")

    # ── unrelated: eval query → random non-target rows ────────────────
    rng = random.Random(42)
    unrelated_qd: list[float] = []
    for case in fixtures["cases"]:
        needles = tuple(case.get("expect_any", []))
        qv = embedder.embed_query(case["query"])
        non_targets = [
            (row_id, vec) for row_id, (text, vec) in vectors.items()
            if not any(needle in text for needle in needles)
        ]
        sample = rng.sample(non_targets, min(15, len(non_targets)))
        for _, vec in sample:
            unrelated_qd.append(cos(qv, vec))
    unrelated_qd.sort()
    uq_n = len(unrelated_qd)
    print(f"\n== unrelated query→doc (n={uq_n}) ==")
    print(f"  p95={unrelated_qd[int(uq_n*0.95)]:.3f} p99={unrelated_qd[int(uq_n*0.99)]:.3f} "
          f"max={unrelated_qd[-1]:.3f}")

    rel_qd = [s for cid, s in related_qd if cid != "occupation"]
    rel_dd_min = min(related_dd)
    uq_p99 = unrelated_qd[int(uq_n * 0.99)]
    dd_p99 = pct(0.99)

    floor = round(min(uq_p99 + 0.02, (unrelated_qd[-1] + min(rel_qd)) / 2), 3)
    span = round(max(0.1, 1.0 - floor), 3)
    gate_raw = round((uq_p99 + min(rel_qd)) / 2, 3)
    dd_gate = round((dd_p99 + rel_dd_min) / 2, 3)
    print("\n== suggested constants ==")
    print(f"COSINE_FLOOR        = {floor}   (q-doc unrelated p99={uq_p99:.3f}, "
          f"max={unrelated_qd[-1]:.3f}; related qd min excl occupation={min(rel_qd):.3f})")
    print(f"COSINE_SPAN         = {span}")
    print(f"VECTOR_EVIDENCE(renorm) ≈ {round((gate_raw - floor) / span, 3)}   (raw cos gate ≈ {gate_raw})")
    print(f"OPEN_LOOP_MATCH (raw cos) ≈ {dd_gate}   (doc unrelated p99={dd_p99:.3f}, dd related min={rel_dd_min:.3f})")
    print(f"MERGER_CLUSTER (raw cos)  ≈ {round(dd_gate + 0.05, 3)}")
    print(f"INSIGHT_DEDUP (raw cos)   ≈ {round(rel_dd_min - 0.02, 3)}")
    print(f"INITIATIVE_SUPPRESS (raw cos) ≈ {round(pct(0.95) + 0.03, 3)}   (above clean bulk p95)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
