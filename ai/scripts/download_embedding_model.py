"""Download the local embedding model for the memory vector channel.

Primary source: ModelScope (domestic CDN, direct connection, no proxy needed).
Downloads the Qwen3-Embedding-0.6B INT8 ONNX (single file, ~585 MiB) plus its
tokenizer. The memory system runs fine without these files — the vector
channel simply stays disabled until they exist.

Rollback: the previous bge-small files (bge-small-zh-v1.5-int8.onnx /
tokenizer.json) are left untouched; switching back is an env change
(MEMORY_EMBEDDING_MODEL / MEMORY_EMBEDDING_TOKENIZER).
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
TARGET_DIR = BASE_DIR / "models" / "embedding"

_REPO = "onnx-community/Qwen3-Embedding-0.6B-ONNX"
_FILES = {
    # repo path -> (target name, expected bytes for verification)
    "onnx/model_int8.onnx": ("qwen3-emb-0.6b-int8.onnx", 613_527_539),
    "tokenizer.json": ("tokenizer_qwen3.json", 11_423_705),
    "config.json": ("config_qwen3.json", 0),
}


def _url(repo_path: str) -> str:
    return f"https://modelscope.cn/models/{_REPO}/resolve/master/{repo_path}"


def download(url: str, target: Path, expected_size: int) -> None:
    if target.exists() and target.stat().st_size == expected_size:
        print(f"[skip] {target.name} already present ({target.stat().st_size} bytes)")
        return
    if target.exists():
        print(f"[warn] {target.name} exists with wrong size "
              f"({target.stat().st_size} != {expected_size}) — re-downloading")
    print(f"[get ] {url}")
    request = urllib.request.Request(
        url, headers={"User-Agent": "soullink-memory/1.0"}
    )
    tmp = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(request, timeout=180) as response, tmp.open("wb") as sink:
        total = 0
        while chunk := response.read(1 << 20):
            sink.write(chunk)
            total += len(chunk)
            if total % (16 << 20) < (1 << 20):
                print(f"\r       {total / 1e6:.1f} MB", end="", flush=True)
    print()
    actual = tmp.stat().st_size
    if expected_size and abs(actual - expected_size) > 1024:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"size mismatch for {target.name}: {actual} != {expected_size}")
    tmp.replace(target)
    print(f"[done] {target.name} ({actual} bytes)")


def main() -> int:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    for repo_path, (name, expected) in _FILES.items():
        target = TARGET_DIR / name
        try:
            download(_url(repo_path), target, expected)
        except Exception as exc:
            print(f"[fail] {name}: {exc}", file=sys.stderr)
            print("备选：pip install modelscope 后运行 "
                  f"modelscope download --model {_REPO} {repo_path} --local_dir {TARGET_DIR}",
                  file=sys.stderr)
            return 1
    print(f"Model ready under {TARGET_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
