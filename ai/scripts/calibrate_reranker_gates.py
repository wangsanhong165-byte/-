"""Calibrate the prototype rerank gates (RERANKER_MIN_SCORE / RERANKER_MARGIN).

Scores every corpus case with the REAL reranker through the production
prototype machinery and prints:
  - top1 P(yes) and top1-top2 margin distributions (correct vs wrong),
  - a gate table (min_score × margin → decided-accuracy / coverage),
  - the gate that maximizes decided-accuracy at ≥60% coverage.

Usage:
  python scripts/calibrate_reranker_gates.py [--corpus residue|emotion|PATH]

Requires the reranker model files; read-only against corpora and DB.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))
sys.path.insert(0, str(BASE_DIR / "scripts"))

CORPUS_DIR = BASE_DIR / "config"
DEFAULTS = {
    "residue": CORPUS_DIR / "conversation_residue_prototypes.json",
    "emotion": CORPUS_DIR / "emotion_prototypes.json",
}


def load_cases(corpus_path: Path) -> list[tuple[str, str, str]]:
    """(text, gold_label, exclude_sentence) — corpus sentences leave-one-out,
    plus hand-labeled real tails when the residue corpus is selected."""
    data = json.loads(corpus_path.read_text(encoding="utf-8"))
    cases: list[tuple[str, str, str]] = []
    for label, entry in data["prototypes"].items():
        sentences = entry.get("sentences") if isinstance(entry, dict) else entry
        for sentence in sentences or []:
            text = str(sentence).strip()
            if len(text) >= 2:
                cases.append((text, str(label), text))
    if corpus_path.name.startswith("conversation_residue"):
        try:
            from experiment_reranker_prototypes import REAL_SAMPLES

            cases.extend((text, gold, "") for text, gold in REAL_SAMPLES)
        except ImportError:
            print("[warn] experiment_reranker_prototypes not importable — "
                  "corpus LOO cases only")
    return cases


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default="residue")
    args = parser.parse_args()
    corpus_arg = args.corpus
    corpus_path = (DEFAULTS.get(corpus_arg)
                   or CORPUS_DIR / corpus_arg
                   or Path(corpus_arg))
    if not corpus_path.exists():
        print(f"corpus not found: {corpus_path}")
        return 1

    from app.memory.reranker import get_reranker
    from app.memory.prototypes import PrototypeClassifier

    classifier = PrototypeClassifier(corpus_path, cache_dir=BASE_DIR / "data" / "memory")
    if not classifier._ensure_vectors():
        print("corpus vectors unavailable (embedder channel off?)")
        return 1
    reranker = get_reranker()
    if reranker is None:
        print("rerank channel unavailable (RERANKER_ENABLED / model files)")
        return 1

    labeled = classifier._labeled  # (label, sentence, vector)
    cases = load_cases(corpus_path)
    print(f"corpus: {corpus_path.name}, {len(labeled)} sentences, "
          f"{len(cases)} cases (incl. real tails when residue)")

    # Score every (case text, corpus sentence) pair once through the channel.
    all_texts = [text for text, _g, _e in cases]
    pair_scores: dict[tuple[str, str], float] = {}
    batch = []
    for text in dict.fromkeys(all_texts):
        for _label, sentence, _vec in labeled:
            batch.append((text, sentence))
    for start in range(0, len(batch), 16):
        chunk = batch[start:start + 16]
        scores = reranker.score_pairs(chunk)
        if scores is None:
            print("rerank scoring failed")
            return 1
        for pair, score in zip(chunk, scores):
            pair_scores[pair] = float(score)

    records = []
    for text, gold, exclude in cases:
        per_label: dict[str, float] = {}
        for label, sentence, _vec in labeled:
            if exclude and sentence == exclude:
                continue
            per_label[label] = max(per_label.get(label, 0.0),
                                   pair_scores[(text, sentence)])
        ranked = sorted(per_label.items(), key=lambda kv: kv[1], reverse=True)
        top_label, top_score = ranked[0]
        runner = ranked[1][1] if len(ranked) > 1 else 0.0
        records.append((top_label == gold, top_score, top_score - runner))

    correct = [r for r in records if r[0]]
    wrong = [r for r in records if not r[0]]
    print(f"\nargmax accuracy: {len(correct)}/{len(records)}")
    for name, group in (("correct", correct), ("wrong", wrong)):
        if not group:
            continue
        tops = sorted(r[1] for r in group)
        margins = sorted(r[2] for r in group)
        pick = lambda seq, q: seq[min(len(seq) - 1, int(q * len(seq)))]  # noqa: E731
        print(f"  {name:7} n={len(group)}  top1 p10/p50/p90 = "
              f"{pick(tops, 0.1):.3f}/{pick(tops, 0.5):.3f}/{pick(tops, 0.9):.3f}"
              f"  margin p10/p50/p90 = "
              f"{pick(margins, 0.1):.3f}/{pick(margins, 0.5):.3f}/{pick(margins, 0.9):.3f}")

    print("\ngate table (min_score × margin → decided-accuracy/coverage):")
    best = None
    for min_score in (0.15, 0.20, 0.22, 0.25, 0.30, 0.35, 0.40, 0.50):
        row = []
        for margin in (0.05, 0.08, 0.10, 0.15):
            decided = [r for r in records
                       if r[1] >= min_score and r[2] >= margin]
            acc = (sum(1 for r in decided if r[0]) / len(decided)) if decided else 0.0
            coverage = len(decided) / len(records)
            row.append(f"{min_score:+.2f}/{margin:.2f}: {acc:.0%}/{coverage:.0%}")
            if coverage >= 0.60 and (best is None or acc > best[0]):
                best = (acc, coverage, min_score, margin)
        print("  " + "  ".join(row))
    if best:
        print(f"\nsuggested: RERANKER_MIN_SCORE={best[2]:.2f} "
              f"RERANKER_MARGIN={best[3]:.2f} "
              f"(accuracy {best[0]:.0%} at coverage {best[1]:.0%})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
