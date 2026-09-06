"""Experiment: cross-encoder reranker vs cosine for PrototypeClassifier corpora.

Question being measured (2026-09-06): the residue/emotion prototype channels
abstain on hard texts because bi-encoder cosine cannot separate adjacent
classes (measured: playful 0.504 vs stress 0.501 on a real tail — margin
0.003 against a 0.05 gate). Does a cross-encoder (Qwen3-Reranker-0.6B) widen
the top1-top2 separation enough to make the vote decisive?

Method:
- Set A: corpus leave-one-out — every corpus sentence scored against the
  full corpus minus itself (its own label's other sentences stay in).
- Set B: 20 real conversation tails from data/runtime/turns.db, hand-labeled
  2026-09-06 against the residue corpus semantics (playful-heavy — that IS
  the production distribution).
- Set C (ambiguous): real tails with no confident label; report what each
  method would do (abstain / pick something defensible).
- Baseline: production embedder (Qwen3-Embedding-0.6B INT8, CPU) cosine,
  per-label max — exactly PrototypeClassifier.rank().
- Challenger: Qwen3-Reranker-0.6B P(yes) per (text, sentence) pair,
  per-label max; GPU bf16 for bulk, CPU fp32 latency probe for production
  cost estimation.

Read-only except script-side caches; never touches the DB.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

CORPUS_PATH = BASE_DIR / "config" / "conversation_residue_prototypes.json"
MODEL_DIR = BASE_DIR / "models" / "reranker" / "qwen3-reranker-0.6b"
MAX_LENGTH = 512
BATCH = 32

INSTRUCTION = (
    "Judge whether the Document expresses the same conversation mood or "
    "tone as the Query in a casual companion chat"
)

# Hand-labeled 2026-09-06 from data/runtime/turns.db (recent 40 turns),
# labels aligned to the residue corpus semantics.
REAL_SAMPLES = [
    ("怎么，你不是专业的吗", "playful_residue"),
    ("先把你四肢切掉", "playful_residue"),
    ("你通过了考验，主人施展了魔法，你恢复如初", "playful_residue"),
    ("真骚呢", "playful_residue"),
    ("我是说你可爱给我翻肚皮", "playful_residue"),
    ("你记错了吧现在几点了你再看看?", "playful_residue"),
    ("我说的是你，电子幽灵", "playful_residue"),
    ("你shy吗", "playful_residue"),
    ("你输了", "playful_residue"),
    ("哈哈哈哈笑死我了，我刚看到一只狗追自己的尾巴转了三十圈，最后晕倒在地上一动不动！", "playful_residue"),
    ("跟你说个特别好笑的事！我家猫今天追自己尾巴转了十分钟，转晕了直接摔进纸箱里，笑死我了哈哈哈", "playful_residue"),
    ("吓死我了！刚才电脑突然蓝屏了，我还以为文件全没了！", "stress_residue"),
    ("怎么这么多bug？", "stress_residue"),
    ("你别生气了嘛，我错啦，原谅我好不好？", "tender_residue"),
    ("你要开心一点开心点才可爱o", "tender_residue"),
    ("唉你说的对真可爱", "tender_residue"),
    ("你好可爱", "tender_residue"),
    ("不错，刚才你看我桌面了吗", "calm_daily_residue"),
    ("你最喜欢吃什么呀？我跟你说我做红烧肉特别好吃", "calm_daily_residue"),
    ("因为我换壁纸了", "calm_daily_residue"),
]

AMBIGUOUS_SAMPLES = [
    "好難過。",
    "真的吗",
    "你猜",
    "谁说的",
    "哭哭好，",
    "比較的困難。",
]


def load_corpus() -> list[tuple[str, str]]:
    data = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    labeled: list[tuple[str, str]] = []
    for label, entry in data["prototypes"].items():
        for sentence in entry["sentences"]:
            labeled.append((label, str(sentence).strip()))
    return labeled


def per_label_scores(labeled, score_of, query, exclude=None):
    """score_of: dict or callable sentence->float; per-label max, optionally excluding one."""
    def val(sentence):
        return score_of[sentence] if isinstance(score_of, dict) else score_of(sentence)
    scores: dict[str, float] = {}
    for label, sentence in labeled:
        if exclude is not None and sentence == exclude:
            continue
        scores[label] = max(scores.get(label, float("-inf")), val(sentence))
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return ranked


def main() -> int:
    labeled = load_corpus()
    print(f"corpus: {len(set(l for l, _ in labeled))} labels, {len(labeled)} sentences")

    # ── baseline: production cosine embedder ──────────────────────────
    from app.memory.embedder import get_embedder

    embedder = get_embedder()
    if embedder is None:
        print("embedding channel unavailable — cannot run baseline")
        return 1
    sent_vecs = [(lab, s, embedder.embed_document(s)) for lab, s in labeled]
    sent_vecs = [(lab, s, v) for lab, s, v in sent_vecs if v]

    def cosine_scorer(query):
        qv = embedder.embed_document(query)
        return {s: sum(x * y for x, y in zip(qv, v)) for _, s, v in sent_vecs}

    # ── challenger: cross-encoder ─────────────────────────────────────
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(MODEL_DIR), padding_side="left")
    model = AutoModelForCausalLM.from_pretrained(
        str(MODEL_DIR), torch_dtype=torch.bfloat16,
    ).to("cuda").eval()
    token_true_id = tokenizer.convert_tokens_to_ids("yes")
    token_false_id = tokenizer.convert_tokens_to_ids("no")
    prefix = (
        "<|im_start|>system\nJudge whether the Document meets the requirements "
        'based on the Query and the Instruct provided. Note that the answer can '
        'only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
    )
    suffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    prefix_tokens = tokenizer.encode(prefix, add_special_tokens=False)
    suffix_tokens = tokenizer.encode(suffix, add_special_tokens=False)

    def score_batch(pairs: list[tuple[str, str]]) -> list[float]:
        texts = [
            "<Instruct>: {i}\n<Query>: {q}\n<Document>: {d}".format(
                i=INSTRUCTION, q=q, d=d)
            for q, d in pairs
        ]
        enc = tokenizer(
            texts, padding=False, truncation="longest_first",
            return_attention_mask=False, max_length=MAX_LENGTH,
        )
        for i, ids in enumerate(enc["input_ids"]):
            enc["input_ids"][i] = prefix_tokens + ids + suffix_tokens
        scores: list[float] = []
        for start in range(0, len(texts), BATCH):
            chunk_ids = enc["input_ids"][start:start + BATCH]
            batch = tokenizer.pad(
                [{"input_ids": ids} for ids in chunk_ids],
                padding=True, return_tensors="pt", max_length=MAX_LENGTH,
            )
            batch = {k: v.to(next(model.parameters()).device) for k, v in batch.items()}
            with torch.no_grad():
                logits = model(**batch).logits[:, -1, :]
            pair_scores = torch.stack(
                [logits[:, token_false_id], logits[:, token_true_id]], dim=1)
            log_probs = torch.nn.functional.log_softmax(pair_scores, dim=1)
            scores.extend(log_probs[:, 1].exp().tolist())
        return scores

    # score every (query, sentence) pair once, cache for both methods' shapes
    all_queries: list[str] = []
    for _, s in labeled:
        all_queries.append(s)
    all_queries.extend(t for t, _ in REAL_SAMPLES)
    all_queries.extend(AMBIGUOUS_SAMPLES)

    pair_map: dict[tuple[str, str], float] = {}
    t0 = time.time()
    batch: list[tuple[str, str]] = []
    for q in all_queries:
        for _, s in labeled:
            batch.append((q, s))
    for start in range(0, len(batch), BATCH):
        chunk = batch[start:start + BATCH]
        for (q, s), sc in zip(chunk, score_batch(chunk)):
            pair_map[(q, s)] = sc
    elapsed = time.time() - t0
    print(f"\nreranker: {len(batch)} pairs in {elapsed:.1f}s "
          f"({len(batch) / elapsed:.0f} pairs/s, GPU bf16)")
    print(f"GPU peak: {torch.cuda.max_memory_allocated() / 1048576:.0f} MiB")

    def rerank_scorer(query):
        return {s: pair_map[(query, s)] for _, s in labeled}

    # ── Set A: corpus leave-one-out ───────────────────────────────────
    case_a_items = [(s, lab, s) for lab, s in labeled]
    case_a_items += [(t, g, None) for t, g in REAL_SAMPLES]

    def run_eval(title, scorer_fn):
        stats = {"corpus": {"correct": 0, "n": 0, "margins": []},
                 "real": {"correct": 0, "n": 0, "margins": []}}
        wrong, top_scores = [], []
        for text, gold, exclude in case_a_items:
            subset = "corpus" if exclude is not None else "real"
            ranked = per_label_scores(labeled, scorer_fn(text), text, exclude)
            top_label, top_score = ranked[0]
            margin = top_score - (ranked[1][1] if len(ranked) > 1 else 0)
            top_scores.append(top_score)
            stats[subset]["n"] += 1
            if top_label == gold:
                stats[subset]["correct"] += 1
                stats[subset]["margins"].append(margin)
            else:
                wrong.append((subset, text[:24], gold, top_label,
                              round(margin, 4)))
        print(f"\n== {title} ==")
        for subset in ("corpus", "real"):
            s = stats[subset]
            m = s["margins"]
            line = (f"  {subset}: {s['correct']}/{s['n']}")
            if m:
                line += (f" | correct-margin min={min(m):.4f} "
                         f"median={statistics.median(m):.4f}")
            print(line)
        print(f"  top1 absolute: min={min(top_scores):.4f} "
              f"median={statistics.median(top_scores):.4f}")
        for w in wrong:
            print(f"  WRONG[{w[0]}]: {w[1]} gold={w[2]} got={w[3]} margin={w[4]}")
        return stats

    cos_stats = run_eval("A+B cosine (baseline)", cosine_scorer)
    rer_stats = run_eval("A+B reranker (challenger)", rerank_scorer)

    # ── Set C: ambiguous — what would each method do ──────────────────
    print("\n== C: ambiguous real tails ==")
    for text in AMBIGUOUS_SAMPLES:
        cr = per_label_scores(labeled, cosine_scorer(text), text)
        rr = per_label_scores(labeled, rerank_scorer(text), text)
        print(f"  {text!r:20} cosine: {cr[0][0]}({cr[0][1]:.3f}) vs {cr[1][0]}({cr[1][1]:.3f})"
              f"  |  rerank: {rr[0][0]}({rr[0][1]:.3f}) vs {rr[1][0]}({rr[1][1]:.3f})")

    # ── CPU fp32 latency probe (production cost estimate) ─────────────
    print("\n== CPU fp32 latency probe ==")
    model.to("cpu", torch.float32)
    probe = [(REAL_SAMPLES[0][0], s) for _, s in labeled[:8]]
    _ = score_batch(probe[:2])  # warmup
    t0 = time.time()
    _ = score_batch(probe)
    dt = (time.time() - t0) / len(probe)
    print(f"  CPU fp32: {dt * 1000:.0f} ms/pair ({len(probe)} pairs, "
          f"~{dt * 20:.1f}s per 20-candidate query)")

    print("\nsummary:")
    for name, st in (("cosine", cos_stats), ("reranker", rer_stats)):
        c = st["corpus"]
        m = c["margins"]
        print(f"  {name}: corpus LOO {c['correct']}/{c['n']}, "
              f"correct-margin median "
              f"{statistics.median(m) if m else float('nan'):.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
