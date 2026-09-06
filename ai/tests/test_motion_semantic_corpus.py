"""Motion semantic corpus — structural validation.

The corpus (config/motion_semantic_corpus.json) is the layer-3 data asset of
the performance system: situation descriptions + performance parameters,
produced by the live choreography loop (user line → orchestration → user
approval). It is intentionally NOT wired into the runtime yet (语料先行:
wire retrieval only after the corpus is thick enough to measure hit rates).
These tests keep the data well-formed so wiring later is mechanical.
"""
import json
import re
from pathlib import Path

import pytest

CORPUS_PATH = Path(__file__).resolve().parents[1] / "config" / "motion_semantic_corpus.json"

KNOWN_EMOTIONS = {
    "neutral", "calm", "happy", "joyful", "playful", "love", "shy",
    "embarrassed", "surprised", "confused", "worried", "sad", "cry",
    "angry", "pout", "blank", "cheerful", "smile", "laughing",
    "dizzy", "sleepy", "crying", "blushing",
}

KNOWN_PRESETS = {
    "nod", "tilt", "wave", "sway", "thinking", "greet", "react", "speak",
    "shrug", "ear_flick", "tail_sweep",
}

# Calibrated logical-axis ranges (mirrors the calibration lab's slider bounds).
POSTURE_RANGES = {
    "head.x": 30, "head.y": 16, "head.z": 14,
    "body.x": 9, "body.y": 6, "body.z": 8,
    "eye.x": 1, "eye.y": 1,
}

# Face parameter bounds: (default ±1) unless listed here.
FACE_RANGE_OVERRIDES = {
    "Param239": 30, "Param250": 30,
    "ParamEyeLOpen": 1.2, "ParamEyeROpen": 1.2,
}


@pytest.fixture(scope="module")
def corpus():
    data = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    assert isinstance(data.get("description"), str) and data["description"].strip()
    assert isinstance(data.get("entries"), dict)
    return data


def test_corpus_has_thick_enough_seed_set(corpus):
    # 语料先行的最低门槛：不足 10 条不接运行时，也别当回归基准用。
    assert len(corpus["entries"]) >= 10


def test_corpus_labels_are_snake_case_and_unique(corpus):
    for label in corpus["entries"]:
        assert re.fullmatch(r"[a-z][a-z0-9_]*", label), f"bad label: {label}"


def test_every_entry_has_enough_varied_sentences(corpus):
    for label, entry in corpus["entries"].items():
        sentences = entry.get("sentences")
        assert isinstance(sentences, list) and len(sentences) >= 4, f"{label}: too few sentences"
        cleaned = [s.strip() for s in sentences]
        assert all(cleaned), f"{label}: empty sentence"
        assert len(set(cleaned)) == len(cleaned), f"{label}: duplicate sentences"


def test_performance_fields_are_within_the_model_capability_contract(corpus):
    for label, entry in corpus["entries"].items():
        performance = entry.get("performance")
        assert isinstance(performance, dict), f"{label}: missing performance"

        assert performance.get("emotion") in KNOWN_EMOTIONS, f"{label}: bad emotion"
        leak = performance.get("leak")
        if leak is not None:
            assert leak in KNOWN_EMOTIONS, f"{label}: bad leak"
            assert leak != performance["emotion"], f"{label}: leak must differ from surface"

        energy = performance.get("energy")
        assert isinstance(energy, (int, float)) and 0 <= energy <= 1, f"{label}: bad energy"

        face = performance.get("face", {})
        for param, value in face.items():
            assert re.fullmatch(r"Param[A-Za-z0-9]+", param), f"{label}: bad face id {param}"
            bound = FACE_RANGE_OVERRIDES.get(param, 1.0)
            assert -bound <= value <= bound, f"{label}: {param}={value} out of ±{bound}"

        posture = performance.get("posture", {})
        for axis, value in posture.items():
            assert axis in POSTURE_RANGES, f"{label}: unknown posture axis {axis}"
            assert abs(value) <= POSTURE_RANGES[axis], f"{label}: {axis}={value} out of range"

        motion = performance.get("motion", {})
        assert motion.get("preset") in KNOWN_PRESETS, f"{label}: bad preset {motion.get('preset')}"
        scale = motion.get("intensityScale", 1)
        assert 0.5 <= scale <= 1.2, f"{label}: intensityScale {scale} out of 0.5-1.2"

        assert isinstance(performance.get("verified", False), bool), f"{label}: verified must be bool"
        assert isinstance(performance.get("arc", ""), str), f"{label}: arc must be a string"


def test_at_least_two_entries_are_live_verified(corpus):
    # 现场验收过的配方是语料质量的锚点：低于 2 条说明生产流程断了。
    verified = [label for label, entry in corpus["entries"].items()
                if entry.get("performance", {}).get("verified") is True]
    assert len(verified) >= 2, f"live-verified entries dropped to {verified}"


def test_unverified_entries_carry_an_arc_note(corpus):
    # 未现场验收的条目必须写明设计意图，方便抽查时逐条补验。
    for label, entry in corpus["entries"].items():
        if entry.get("performance", {}).get("verified") is not True:
            assert entry["performance"].get("arc"), f"{label}: unverified entry missing arc note"
