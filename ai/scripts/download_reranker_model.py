"""Fetch the Qwen3-Reranker-0.6B files into models/reranker/qwen3-reranker-0.6b/.

Mirrors scripts/download_embedding_model.py: ModelScope direct resolve,
skip-if-present, byte-size sanity. The rerank channel is fully optional —
missing files simply keep every consumer on the cosine path.
"""

from __future__ import annotations

import sys
import time
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
REPO = "Qwen/Qwen3-Reranker-0.6B"
TARGET = BASE_DIR / "models" / "reranker" / "qwen3-reranker-0.6b"

FILES = {
    "config.json": 727,
    "generation_config.json": 214,
    "tokenizer_config.json": 9706,
    "tokenizer.json": 11_422_654,
    "vocab.json": 2_776_833,
    "merges.txt": 1_671_853,
    "model.safetensors": 1_191_588_280,
}


def _url(repo_path: str) -> str:
    return f"https://modelscope.cn/models/{REPO}/resolve/master/{repo_path}"


def download(url: str, target: Path, expected_size: int) -> None:
    print(f"[get ] {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "soullink-reranker/1.0"})
    tmp = target.with_suffix(target.suffix + ".tmp")
    started = time.time()
    with urllib.request.urlopen(request, timeout=300) as response, tmp.open("wb") as sink:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            sink.write(chunk)
    actual = tmp.stat().st_size
    if actual < expected_size * 0.98:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{target.name}: {actual} bytes < expected ~{expected_size}")
    tmp.replace(target)
    print(f"[done] {target.name}: {actual / 1048576:.1f}MB in {time.time() - started:.0f}s")


def main() -> int:
    TARGET.mkdir(parents=True, exist_ok=True)
    for name, expected in FILES.items():
        target = TARGET / name
        if target.exists() and target.stat().st_size >= expected * 0.98:
            print(f"[skip] {name}")
            continue
        download(_url(name), target, expected)
    print("RERANKER MODEL READY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
