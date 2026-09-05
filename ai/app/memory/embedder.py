"""Local embedding for semantic memory recall — Qwen3-Embedding-0.6B (INT8 ONNX).

Engine notes (official model card, verified):
- Decoder-only Qwen3 backbone; embedding = last-token hidden state, L2-normalized
  (NOT CLS pooling like the previous bge engine).
- Retrieval queries carry a task instruction (`Instruct: {task}\nQuery: {text}`,
  +1-5% quality); documents never do. Comparisons that are document-vs-document
  (clustering, dedup) stay symmetric in the document space.
- Native 1024 dims with MRL: truncate to the first N dims + re-normalize for
  cheaper vectors.
- Single-sequence encoding (no padding), so the last hidden state is the last
  real token; truncation cap defaults to 1024 tokens (env
  `MEMORY_EMBEDDING_MAX_TOKENS`) — enough for long log rows and whole
  summaries without silent truncation. CPU ceiling for single-doc encoding
  is ~2-4K tokens (quadratic attention memory); the model's 32K spec is a
  GPU + flash-attention capability, not a CPU unlock.

Fully optional: when the model files are missing or onnxruntime is not
installed, get_embedder() returns None and every consumer degrades to the
lexical + tags channel.

Files (scripts/download_embedding_model.py fetches them from ModelScope):
  models/embedding/qwen3-emb-0.6b-int8.onnx   (~585 MiB)
  models/embedding/tokenizer_qwen3.json       (~11 MiB)

Rollback to the previous bge engine = point MEMORY_EMBEDDING_MODEL /
MEMORY_EMBEDDING_TOKENIZER back at the old files (kept in place).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("memory.embedder")

_QUERY_TASK = (
    "Given a user chat message, retrieve the most relevant stored memories "
    "about the user"
)
_BGE_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


def _max_tokens() -> int:
    """Truncation cap. 1024 covers the longest current consumers (1000-char
    log rows, 800-char summaries) without silent truncation; CPU single-doc
    encoding stays practical up to ~2-4K (quadratic attention above that)."""
    try:
        return max(128, int(os.environ.get("MEMORY_EMBEDDING_MAX_TOKENS", "1024")))
    except (TypeError, ValueError):
        return 1024

_instance: Optional["LocalEmbedder"] = None


def model_dir(base_dir: Path | None = None) -> Path:
    if base_dir is not None:
        return Path(base_dir) / "models" / "embedding"
    return Path(__file__).resolve().parents[2] / "models" / "embedding"


def _model_filename() -> str:
    return os.environ.get("MEMORY_EMBEDDING_MODEL", "qwen3-emb-0.6b-int8.onnx")


def _tokenizer_filename() -> str:
    return os.environ.get("MEMORY_EMBEDDING_TOKENIZER", "tokenizer_qwen3.json")


class LocalEmbedder:
    """Lazy ONNX session; per-engine pooling, L2-normalized embeddings.

    Pooling is engine-specific and selected by model filename:
      - qwen3-* → last-token (decoder backbone, official last_token_pool)
      - bge-*   → CLS (BERT backbone, per bge's 1_Pooling config)
    """

    def __init__(self, base_dir: Path | None = None):
        directory = model_dir(base_dir)
        self._model_path = directory / _model_filename()
        self._tokenizer_path = directory / _tokenizer_filename()
        self._failed = False
        self._session: Any = None
        self._tokenizer: Any = None
        self._input_names: tuple[str, ...] = ()
        self._past_inputs: tuple[str, ...] = ()
        self._output_name: Optional[str] = None
        self._kv_shape: Optional[tuple[int, ...]] = None
        self._dim: Optional[int] = None
        self._use_cls_pooling = "bge" in _model_filename().lower()

    def available(self) -> bool:
        if self._session is not None:
            return True
        if self._failed:
            return False
        if not self._model_path.exists() or not self._tokenizer_path.exists():
            return False
        try:
            import onnxruntime  # noqa: F401
            import tokenizers  # noqa: F401
        except ImportError:
            self._failed = True
            logger.info("Embedding deps unavailable — vector channel disabled")
            return False
        return True

    def _ensure_loaded(self) -> bool:
        if self._session is not None:
            return True
        if not self.available():
            return False
        try:
            import onnxruntime
            from tokenizers import Tokenizer

            options = onnxruntime.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            self._session = onnxruntime.InferenceSession(
                str(self._model_path),
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
            tokenizer = Tokenizer.from_file(str(self._tokenizer_path))
            tokenizer.enable_truncation(max_length=_max_tokens())
            tokenizer.no_padding()
            self._tokenizer = tokenizer
            self._input_names = tuple(item.name for item in self._session.get_inputs())
            self._output_name = next(
                (o.name for o in self._session.get_outputs()
                 if o.name == "last_hidden_state"),
                self._session.get_outputs()[0].name,
            )
            self._past_inputs = tuple(
                item.name for item in self._session.get_inputs()
                if item.name.startswith("past_key_values.")
            )
            self._kv_shape = self._kv_cache_shape()
        except Exception:
            self._failed = True
            logger.exception("Embedding model failed to load — vector channel disabled")
            return False
        return True

    def _kv_cache_shape(self) -> Optional[tuple[int, ...]]:
        """Shape of one empty past-KV tensor, e.g. (1, 8, 0, 128) for Qwen3-0.6B.

        Read from config_qwen3.json (num_key_value_heads / head_dim); the
        sequence dim is 0 (empty past — full prompt encoding in one pass).
        """
        config_path = self._model_path.parent / "config_qwen3.json"
        heads, head_dim = 8, 128
        try:
            import json

            config = json.loads(config_path.read_text(encoding="utf-8"))
            heads = int(config.get("num_key_value_heads", heads))
            head_dim = int(config.get("head_dim", head_dim))
        except (OSError, ValueError, TypeError):
            pass
        return (1, heads, 0, head_dim)

    def _encode(self, text: str) -> Optional[list[float]]:
        if not text.strip() or not self._ensure_loaded():
            return None
        encoded = self._tokenizer.encode(text, add_special_tokens=True)
        ids = list(encoded.ids)
        if not ids:
            return None
        mask = [1] * len(ids)
        feed: dict[str, Any] = {}
        if "input_ids" in self._input_names:
            feed["input_ids"] = [ids]
        if "attention_mask" in self._input_names:
            feed["attention_mask"] = [mask]
        if "position_ids" in self._input_names:
            feed["position_ids"] = [list(range(len(ids)))]
        if "token_type_ids" in self._input_names:
            # BERT-style engines (bge rollback path) require segment ids.
            feed["token_type_ids"] = [[0] * len(ids)]
        if "input_ids" not in feed:
            return None
        if self._past_inputs:
            # KV-cache decoder graph: an empty past (seq dim 0) turns it into
            # a single full-sequence prompt pass (transformers.js same flow).
            import numpy as np

            empty = np.zeros(self._kv_shape, dtype=np.float32)
            for name in self._past_inputs:
                feed[name] = empty
        output = self._session.run([self._output_name], feed)[0]
        if self._use_cls_pooling:
            vector = output[0][0]   # CLS token (BERT/bge family)
        else:
            vector = output[0][-1]  # last token (decoder/Qwen3 family)
        norm = sum(float(v) * float(v) for v in vector) ** 0.5
        if norm <= 0:
            return None
        normalized = [float(v) / norm for v in vector]
        if self._dim is None:
            self._dim = len(normalized)
        return normalized

    def expected_dim(self) -> Optional[int]:
        """Output dimension; loads the model if needed. None when unavailable."""
        if self._dim is not None:
            return self._dim
        if not self._ensure_loaded():
            return None
        probe = self._encode("dimension probe")
        return self._dim

    def truncate_dim(self, vector: list[float], dim: int) -> Optional[list[float]]:
        """MRL: keep the first `dim` components, re-normalize."""
        if not vector or dim <= 0 or len(vector) < dim:
            return None
        sliced = vector[:dim]
        norm = sum(v * v for v in sliced) ** 0.5
        if norm <= 0:
            return None
        return [v / norm for v in sliced]

    def embed_query(self, text: str) -> Optional[list[float]]:
        # 按引擎使用各自官方最优查询格式：bge-zh → 中文检索前缀；
        # Qwen3 → 英文 Instruct 任务描述（官方卡 +1-5%）。
        if self._use_cls_pooling:
            return self._encode(f"{_BGE_QUERY_PREFIX}{text.strip()}")
        return self._encode(f"Instruct: {_QUERY_TASK}\nQuery:{text.strip()}")

    def embed_document(self, text: str) -> Optional[list[float]]:
        return self._encode(text.strip())


def get_embedder() -> Optional[LocalEmbedder]:
    """Process-wide embedder or None when the vector channel is unavailable."""
    global _instance
    if _instance is None:
        _instance = LocalEmbedder()
    try:
        return _instance if _instance.available() else None
    except Exception:
        return None


def set_embedder(embedder: Optional[LocalEmbedder]) -> None:
    """Test seam: inject a stub or force-reset the singleton."""
    global _instance
    _instance = embedder
