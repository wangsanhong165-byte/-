"""Local cross-encoder reranker — Qwen3-Reranker-0.6B (CPU, torch dynamic int8).

Precision layer behind the prototype corpora: cosine (bi-encoder) provides
cheap recall over cached vectors, this module re-scores only the shortlisted
(query, sentence) pairs so adjacent classes become separable — measured
2026-09-06: corpus leave-one-out 12/20 → 16/20, correct-margin median
0.048 → 0.331 (scripts/experiment_reranker_prototypes.py,
logs/reranker_experiment.log).

Engine notes (official model card recipe, verified):
- Pair format: system prefix + "<Instruct>: …\n<Query>: …\n<Document>: …"
  + assistant suffix; score = softmax over the "yes"/"no" token logits at
  the last position (left padding ⇒ last position is the real last token).
- Weights load fp32 then torch dynamic-int8 quantizes Linears (fbgemm):
  ~0.7GB resident, zero VRAM, no pip deps beyond the existing
  transformers/torch. Transient fp32 spike ~2.4GB on FIRST load (lazy,
  off the turn path).

Fully optional: when model files are missing, torch is unavailable, or
RERANKER_ENABLED=0, get_reranker() returns None and every consumer keeps
its pure-cosine behavior unchanged.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("memory.reranker")

_INSTRUCTION = (
    "Judge whether the Document expresses the same conversation mood or "
    "tone as the Query in a casual companion chat"
)
_SYSTEM_PREFIX = (
    "<|im_start|>system\nJudge whether the Document meets the requirements "
    'based on the Query and the Instruct provided. Note that the answer can '
    'only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
)
_ASSISTANT_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
_RETRIEVAL_INSTRUCTION = (
    "Given a user chat message, judge whether the Document is a relevant "
    "stored memory about the user"
)


def prewarm(background: bool = True, delay_seconds: float = 20.0) -> None:
    """Load the model off the hot path so the first real vote never stalls.

    Called from the bridge startup; loads take ~9-15s (GPU) / ~15-30s (CPU)
    and are pointless to pay inside a turn. Disable with RERANKER_PREWARM=0.
    """
    if os.environ.get("RERANKER_PREWARM", "1") in {"0", "false", "no"}:
        return
    if not _enabled():
        return

    def _load() -> None:
        try:
            reranker = get_reranker()
            if reranker is not None:
                reranker._ensure_loaded()
        except Exception:
            logger.exception("Reranker prewarm failed (non-fatal)")

    if background:
        import threading

        # Timer has no name kwarg (unlike Thread) — passing one raises
        # TypeError and silently kills the prewarm schedule.
        timer = threading.Timer(delay_seconds, _load)
        timer.daemon = True
        timer.name = "reranker-prewarm"
        timer.start()
    else:
        _load()


def rerank_ranking(
    query: str,
    ranked_rows: list[dict],
    *,
    text_of,
    k: int | None = None,
    instruction: str = _RETRIEVAL_INSTRUCTION,
) -> list[dict]:
    """Cross-encoder precision pass over the fused-score head of a ranking.

    Reorders the top-k rows by P(yes) relevance and annotates them with
    "rerank_score"; the tail keeps its fused order. Fail-open: any problem
    (channel off, load failure, scoring error) returns the input unchanged.
    """
    try:
        reranker = get_reranker()
    except Exception:
        return ranked_rows
    if reranker is None or not ranked_rows:
        return ranked_rows
    try:
        cap = int(os.environ.get("RERANKER_RETRIEVAL_K", str(k or 8)))
    except (TypeError, ValueError):
        cap = 8
    cap = max(2, cap)
    head = ranked_rows[:cap]
    if len(head) < 2:
        return ranked_rows
    pairs = [(query, str(text_of(row) or "")) for row in head]
    if any(not doc.strip() for _q, doc in pairs):
        return ranked_rows
    scores = reranker.score_pairs(pairs, instruction=instruction)
    if scores is None or len(scores) != len(head):
        return ranked_rows
    for row, score in zip(head, scores):
        row["rerank_score"] = round(float(score), 4)
    order = sorted(range(len(head)), key=lambda i: scores[i], reverse=True)
    return [head[i] for i in order] + list(ranked_rows[len(head):])


_BATCH = 16

_instance: Optional["LocalReranker"] = None


def model_dir(base_dir: Path | None = None) -> Path:
    if base_dir is not None:
        return Path(base_dir) / "models" / "reranker"
    return Path(__file__).resolve().parents[2] / "models" / "reranker"


def _configured_dir() -> Path:
    configured = os.environ.get("RERANKER_MODEL_DIR", "").strip()
    if configured:
        return Path(configured)
    return model_dir() / "qwen3-reranker-0.6b"


def _enabled() -> bool:
    return os.environ.get("RERANKER_ENABLED", "1") not in {"0", "false", "no"}


def get_reranker() -> Optional["LocalReranker"]:
    """Process-wide lazy singleton; None when the channel is off/missing."""
    global _instance
    if not _enabled():
        return None
    if _instance is None:
        try:
            _instance = LocalReranker(_configured_dir())
        except Exception:
            logger.exception("Reranker init failed — rerank channel disabled")
            _instance = None
    return _instance


def reset_reranker_for_tests() -> None:
    global _instance
    _instance = None


class LocalReranker:
    """Lazy torch load + dynamic int8; scores (query, document) pairs."""

    def __init__(self, directory: Path):
        self._dir = Path(directory)
        self._failed = False
        self._model: Any = None
        self._tokenizer: Any = None
        self._device = "cpu"
        self._true_id: int = -1
        self._false_id: int = -1
        self._prefix_ids: list[int] = []
        self._suffix_ids: list[int] = []
        self._load_seconds: float = 0.0

    def available(self) -> bool:
        if self._model is not None:
            return True
        if self._failed:
            return False
        if not (self._dir / "model.safetensors").exists():
            return False
        if not (self._dir / "tokenizer.json").exists():
            return False
        try:
            import torch  # noqa: F401
            import transformers  # noqa: F401
        except ImportError:
            self._failed = True
            logger.info("Reranker deps unavailable — rerank channel disabled")
            return False
        return True

    def _ensure_loaded(self) -> bool:
        if self._model is not None:
            return True
        if self._failed or not self.available():
            return False
        started = time.time()
        try:
            import torch
            from torch.ao.quantization import quantize_dynamic
            from torch.nn import Linear
            from transformers import AutoModelForCausalLM, AutoTokenizer

            threads = max(1, int(os.environ.get("RERANKER_NUM_THREADS", "4")))
            device_pref = os.environ.get("RERANKER_DEVICE", "cuda").strip().lower()
            if not device_pref.startswith("cuda"):
                torch.set_num_threads(threads)
            # Left padding is REQUIRED by the last-position-logits recipe:
            # with right padding, logits[:, -1, :] reads PAD positions for
            # shorter rows and the scores become batch-composition noise.
            tokenizer = AutoTokenizer.from_pretrained(
                str(self._dir), padding_side="left")
            on_cuda = device_pref.startswith("cuda") and torch.cuda.is_available()
            self._device = device_pref if on_cuda else "cpu"
            # fp32 on CPU / bf16 on CUDA. Measured 2026-09-06: dynamic int8
            # (full AND mlp-only) wrecks this model's yes/no calibration on
            # CPU, so quantization is opt-in only (RERANKER_QUANTIZE=1 with
            # RERANKER_QUANTIZE_TARGETS=mlp|all) — default is exact weights.
            model = AutoModelForCausalLM.from_pretrained(
                str(self._dir),
                dtype=torch.bfloat16 if on_cuda else torch.float32,
            ).to(self._device)
            model.eval()
            quantize_targets = os.environ.get("RERANKER_QUANTIZE_TARGETS", "none")
            if self._device == "cpu" \
                    and os.environ.get("RERANKER_QUANTIZE", "0") not in {"0", "false", "no"} \
                    and quantize_targets != "none":
                # Full-int8 measurably wrecks calibration (the yes/no logit
                # gap drowns in quantization noise: "被领导骂" angry 0.84 →
                # pout 0.60; 谢谢陪伴 0.99 → 0.48). The MLP carries most of
                # the weights/FLOPs — quantizing only it keeps the attention
                # stack and lm_head, and with them the score distribution.
                from torch.ao.quantization import default_dynamic_qconfig

                spec = {
                    name: default_dynamic_qconfig
                    for name, module in model.named_modules()
                    if isinstance(module, Linear) and (
                        quantize_targets == "all" or ".mlp." in name)
                }
                if spec:
                    model = quantize_dynamic(model, spec, dtype=torch.qint8)
            self._model = model
            self._tokenizer = tokenizer
            self._true_id = tokenizer.convert_tokens_to_ids("yes")
            self._false_id = tokenizer.convert_tokens_to_ids("no")
            self._prefix_ids = tokenizer.encode(_SYSTEM_PREFIX, add_special_tokens=False)
            self._suffix_ids = tokenizer.encode(_ASSISTANT_SUFFIX, add_special_tokens=False)
            self._load_seconds = time.time() - started
            logger.info("Reranker loaded (int8=%s) in %.1fs",
                        os.environ.get("RERANKER_QUANTIZE", "1") != "0",
                        self._load_seconds)
            return True
        except Exception:
            self._failed = True
            logger.exception("Reranker load failed — falling back to cosine")
            return False

    def score_pairs(
        self,
        pairs: list[tuple[str, str]],
        instruction: str = _INSTRUCTION,
        max_length: int | None = None,
    ) -> Optional[list[float]]:
        """P(yes) per (query, document) pair, or None when unavailable.

        Any inference error marks the channel failed and returns None so
        callers fall back to cosine without retry storms.
        """
        if not pairs:
            return []
        if not self._ensure_loaded():
            return None
        try:
            import torch

            cap = int(os.environ.get("RERANKER_MAX_LENGTH", str(max_length or 512)))
            texts = [
                "<Instruct>: {i}\n<Query>: {q}\n<Document>: {d}".format(
                    i=instruction, q=q, d=d)
                for q, d in pairs
            ]
            enc = self._tokenizer(
                texts, padding=False, truncation="longest_first",
                return_attention_mask=False, max_length=cap,
            )
            id_rows = [
                self._prefix_ids + row + self._suffix_ids
                for row in enc["input_ids"]
            ]
            scores: list[float] = []
            device = next(self._model.parameters()).device
            for start in range(0, len(id_rows), _BATCH):
                chunk = id_rows[start:start + _BATCH]
                batch = self._tokenizer.pad(
                    [{"input_ids": row} for row in chunk],
                    padding=True, return_tensors="pt",
                )
                batch = {k: v.to(device) for k, v in batch.items()}
                with torch.no_grad():
                    logits = self._model(**batch).logits[:, -1, :]
                stacked = torch.stack(
                    [logits[:, self._false_id], logits[:, self._true_id]], dim=1)
                log_probs = torch.nn.functional.log_softmax(stacked, dim=1)
                scores.extend(log_probs[:, 1].exp().tolist())
            if str(device).startswith("cuda"):
                # The caching allocator keeps PEAK activation blocks reserved
                # (~2.7GB measured) for the life of this long-lived process —
                # on the 8GB card that alone pushes the desktop into VRAM
                # spill. We are a low-frequency turn-level scorer: hand the
                # reserved blocks back after every scoring pass (re-cudaMalloc
                # next time is microseconds against a multi-second budget).
                torch.cuda.empty_cache()
            return scores
        except Exception:
            self._failed = True
            logger.exception("Reranker scoring failed — falling back to cosine")
            return None
