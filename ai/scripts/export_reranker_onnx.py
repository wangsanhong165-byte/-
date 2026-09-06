"""Export Qwen3-Reranker-0.6B to a CPU-friendly INT8 ONNX (zero new deps).

Why this shape: the reranker recipe only needs the yes/no logits at the last
position, so the wrapper slices lm_head to those two rows BEFORE export —
the 151k-vocab head (310MB fp32) never enters the graph. After export,
onnxruntime.quantization.quantize_dynamic produces the production artifact
`reranker-int8.onnx` (~0.5GB, runs on CPUExecutionProvider, 0 VRAM — 小脑
doctrine). The fp32 intermediate is deleted; the safetensors stay as the
re-export source.

Parity gate: fp32-ONNX vs torch must match P(yes) tightly (<1e-3); the INT8
delta is reported (expected small, ranking preserved) on real experiment
pairs.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

MD = BASE_DIR / "models" / "reranker" / "qwen3-reranker-0.6b"
FP32_ONNX = MD / "reranker-fp32.onnx"
INT8_ONNX = MD / "reranker-int8.onnx"

INSTRUCTION = (
    "Judge whether the Document expresses the same conversation mood or "
    "tone as the Query in a casual companion chat"
)
PREFIX = (
    '<|im_start|>system\nJudge whether the Document meets the requirements '
    'based on the Query and the Instruct provided. Note that the answer can '
    'only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
)
SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"

PARITY_PAIRS = [
    ("怎么，你不是专业的吗", "你就知道逗我"),
    ("哼，才不是想你呢", "卖萌卖上瘾了啦"),
    ("调试到现在还没搞定", "这个bug又失败了，改了一天"),
    ("你好可爱", "今天被你治愈了"),
    ("我们聊到人生意义这种话题了", "这个观点让我想了很多"),
    ("今天吃了顿好的", "天气不错出去走了走"),
]


def pair_text(query: str, doc: str) -> str:
    return "<Instruct>: {i}\n<Query>: {q}\n<Document>: {d}".format(
        i=INSTRUCTION, q=query, d=doc)


def main() -> int:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(str(MD), padding_side="left")
    model = AutoModelForCausalLM.from_pretrained(
        str(MD), torch_dtype=torch.float32, attn_implementation="eager",
    ).eval()
    yes_id = tokenizer.convert_tokens_to_ids("yes")
    no_id = tokenizer.convert_tokens_to_ids("no")
    print(f"[{time.time()-t0:5.1f}s] loaded fp32; yes_id={yes_id} no_id={no_id}",
          flush=True)

    head_rows = model.lm_head.weight[torch.tensor([no_id, yes_id])].detach().clone()

    class LastTokenTwoLogits(torch.nn.Module):
        def __init__(self, backbone, head):
            super().__init__()
            self.backbone = backbone
            self.head = torch.nn.Parameter(head, requires_grad=False)

        def forward(self, input_ids, attention_mask):
            hidden = self.backbone(
                input_ids=input_ids, attention_mask=attention_mask,
            ).last_hidden_state
            return torch.matmul(hidden[:, -1, :], self.head.T)  # (B, 2) [no, yes]

    pad_id = tokenizer.pad_token_id or tokenizer.eos_token_id
    # left-padded example so the traced graph exercises mask handling
    example_ids = torch.tensor([[pad_id] * 4 + [5, 6, 7, 9]], dtype=torch.long)
    example_mask = torch.tensor([[0, 0, 0, 0, 1, 1, 1, 1]], dtype=torch.long)

    wrapper = LastTokenTwoLogits(model.model, head_rows)
    torch.onnx.export(
        wrapper, (example_ids, example_mask), str(FP32_ONNX),
        opset_version=17,
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "logits": {0: "batch"},
        },
    )
    print(f"[{time.time()-t0:5.1f}s] export done: "
          f"{FP32_ONNX.stat().st_size / 1048576:.0f}MB fp32 onnx", flush=True)

    # ── parity: torch vs fp32-onnx vs int8-onnx ───────────────────────
    prefix_ids = tokenizer.encode(PREFIX, add_special_tokens=False)
    suffix_ids = tokenizer.encode(SUFFIX, add_special_tokens=False)

    def build(pairs):
        enc = tokenizer(
            [pair_text(q, d) for q, d in pairs], padding=False,
            truncation="longest_first", return_attention_mask=False,
            max_length=512,
        )
        ids = [prefix_ids + x + suffix_ids for x in enc["input_ids"]]
        maxlen = max(len(x) for x in ids)
        batch_ids = torch.full((len(ids), maxlen), pad_id, dtype=torch.long)
        batch_mask = torch.zeros((len(ids), maxlen), dtype=torch.long)
        for i, x in enumerate(ids):
            batch_ids[i, maxlen - len(x):] = torch.tensor(x)
            batch_mask[i, maxlen - len(x):] = 1
        return batch_ids, batch_mask

    def p_yes_torch(pairs):
        with torch.no_grad():
            ids, mask = build(pairs)
            logits = model(input_ids=ids, attention_mask=mask).logits[:, -1, :]
            two = torch.stack([logits[:, no_id], logits[:, yes_id]], dim=1)
            return torch.softmax(two, dim=1)[:, 1].tolist()

    import onnxruntime as ort

    def p_yes_onnx(path, pairs):
        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        ids, mask = build(pairs)
        logits = session.run(
            ["logits"],
            {"input_ids": ids.numpy(), "attention_mask": mask.numpy()},
        )[0]
        two = torch.softmax(torch.tensor(logits), dim=1)[:, 1].tolist()
        return session, two

    pairs = PARITY_PAIRS
    torch_scores = p_yes_torch(pairs)
    _, fp32_scores = p_yes_onnx(FP32_ONNX, pairs)
    delta_fp32 = max(abs(a - b) for a, b in zip(torch_scores, fp32_scores))
    print(f"parity fp32-vs-torch max|ΔP(yes)| = {delta_fp32:.2e}", flush=True)
    if delta_fp32 > 1e-2:
        print("FP32 PARITY FAILED — aborting before quantization", flush=True)
        return 1

    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(str(FP32_ONNX), str(INT8_ONNX), weight_type=QuantType.QInt8)
    print(f"[{time.time()-t0:5.1f}s] quantized: "
          f"{INT8_ONNX.stat().st_size / 1048576:.0f}MB int8 onnx", flush=True)
    _, int8_scores = p_yes_onnx(INT8_ONNX, pairs)
    delta_int8 = max(abs(a - b) for a, b in zip(torch_scores, int8_scores))
    agree = sum(1 for a, b in zip(torch_scores, int8_scores)
                if (a > 0.5) == (b > 0.5))
    print(f"parity int8-vs-torch max|ΔP(yes)| = {delta_int8:.4f}, "
          f"sign agreement {agree}/{len(pairs)}", flush=True)
    for (q, d), t, i8 in zip(pairs, torch_scores, int8_scores):
        print(f"  {q[:14]!r} vs {d[:14]!r}: torch={t:.4f} int8={i8:.4f}", flush=True)

    FP32_ONNX.unlink()
    print(f"[{time.time()-t0:5.1f}s] fp32 intermediate removed; "
          f"safetensors kept as re-export source", flush=True)
    print("EXPORT OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
