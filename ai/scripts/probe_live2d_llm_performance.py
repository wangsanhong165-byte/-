"""Run one real LLM/TTS turn and validate visible Live2D performance.

The probe uses the same local page and WebSocket path as the user. It records
the frontend controller snapshot through intent staging, decoded audio,
lip-sync, expression and semantic torso choreography. A successful HTTP build
or a synthetic event is intentionally not accepted as evidence.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import time
from typing import Any

from playwright.sync_api import sync_playwright


BODY_PARAMETERS = ("ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:5173/")
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument(
        "--prompt",
        default=(
            "请用三句话回答：先有一点害羞地打招呼，再认真解释你今天想陪我做什么，"
            "最后自然地点头肯定。说话时情绪和身体语言要连贯，不要描述动作本身。"
        ),
    )
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--browser-executable")
    parser.add_argument("--expected-model", default="shirone")
    parser.add_argument("--device-scale-factor", type=float, default=1.0)
    return parser.parse_args()


def resolve_browser_executable(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    candidates = (
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    )
    return next((str(path) for path in candidates if path.exists()), None)


def read_snapshot(page: Any) -> dict[str, Any] | None:
    return page.evaluate(
        """() => {
          const value = globalThis.__SOULLINK_RUNTIME_SNAPSHOT__;
          if (!value) return null;
          return JSON.parse(JSON.stringify({
            at: performance.now(),
            model: value.model || '',
            activity: value.activity || '',
            expression: value.expression || {},
            motion: value.motion || {},
            director: value.director || {},
            intentAudit: value.intentAudit || {},
            lipSync: value.lipSync || {},
            values: value.resolvedParameters || {},
            frame: value.frame || {},
            devicePixelRatio,
            subtitle: document.querySelector('.stage-subtitle p')?.textContent || '',
          }));
        }"""
    )


def finite(sample: dict[str, Any], parameter: str) -> float | None:
    value = (sample.get("values") or {}).get(parameter)
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def body_span(samples: list[dict[str, Any]]) -> float:
    spans: list[float] = []
    for parameter in BODY_PARAMETERS:
        values = [value for sample in samples if (value := finite(sample, parameter)) is not None]
        if values:
            spans.append(max(values) - min(values))
    return max(spans, default=0.0)


def active_ai_motion(sample: dict[str, Any]) -> bool:
    active = (sample.get("motion") or {}).get("activeRequests") or []
    return any(
        isinstance(item, dict) and item.get("source") == "ai"
        for item in active
    )


def main() -> int:
    args = parse_args()
    samples: list[dict[str, Any]] = []
    submission_at = time.monotonic()
    speaking_first: float | None = None
    speaking_last: float | None = None
    completed_at: float | None = None

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=not args.headed,
            executable_path=resolve_browser_executable(args.browser_executable),
        )
        page = browser.new_page(
            viewport={"width": 1200, "height": 800},
            device_scale_factor=args.device_scale_factor,
        )
        page.goto(args.url, wait_until="networkidle")
        page.wait_for_selector("canvas", timeout=20_000)
        page.wait_for_function("() => Boolean(globalThis.__SOULLINK_RUNTIME_SNAPSHOT__)")
        input_box = page.get_by_label("消息")
        input_box.wait_for(state="visible", timeout=20_000)
        page.wait_for_function(
            "() => { const el = document.querySelector('[aria-label=\"消息\"]'); return el && !el.disabled; }",
            timeout=30_000,
        )
        initial = read_snapshot(page) or {}
        initial_turn = str((initial.get("intentAudit") or {}).get("turnId") or "")

        input_box.fill(args.prompt)
        page.get_by_label("发送").click()
        submission_at = time.monotonic()
        deadline = submission_at + max(20.0, args.timeout)
        last_at = -1.0
        turn_seen = False
        idle_after_speaking_since: float | None = None

        while time.monotonic() < deadline:
            sample = read_snapshot(page)
            if sample and float(sample.get("at") or 0.0) != last_at:
                sample["observedAt"] = time.monotonic() - submission_at
                samples.append(sample)
                last_at = float(sample.get("at") or 0.0)
                turn_id = str((sample.get("intentAudit") or {}).get("turnId") or "")
                turn_seen = turn_seen or bool(turn_id and turn_id != initial_turn)
                if sample.get("activity") == "speaking":
                    speaking_first = speaking_first if speaking_first is not None else sample["observedAt"]
                    speaking_last = sample["observedAt"]
                    idle_after_speaking_since = None
                elif speaking_first is not None and sample.get("activity") == "idle":
                    idle_after_speaking_since = idle_after_speaking_since or time.monotonic()
                    if time.monotonic() - idle_after_speaking_since >= 1.5:
                        completed_at = sample["observedAt"]
                        break
            page.wait_for_timeout(50)
        browser.close()

    turn_samples = [
        sample for sample in samples
        if str((sample.get("intentAudit") or {}).get("turnId") or "")
        and str((sample.get("intentAudit") or {}).get("turnId") or "") != initial_turn
    ]
    speaking = [sample for sample in turn_samples if sample.get("activity") == "speaking"]
    accepted = [
        sample for sample in turn_samples
        if ((sample.get("intentAudit") or {}).get("motion") or {}).get("accepted") is True
    ]
    expressions = {
        str((sample.get("expression") or {}).get("name") or "")
        for sample in turn_samples
        if (sample.get("expression") or {}).get("name")
    }
    mouth_values = [
        value for sample in speaking
        if (value := finite(sample, "ParamMouthOpenY")) is not None
    ]
    speaking_motion = [sample for sample in speaking if active_ai_motion(sample)]
    performance_first = next(
        (
            float(sample["observedAt"])
            for sample in turn_samples
            if active_ai_motion(sample)
        ),
        None,
    )
    premature_motion = [
        sample for sample in turn_samples
        if speaking_first is not None
        and float(sample["observedAt"]) < speaking_first - 0.15
        and active_ai_motion(sample)
    ]
    speaking_subtitles = {
        str(sample.get("subtitle") or "").strip()
        for sample in speaking
        if str(sample.get("subtitle") or "").strip()
    }
    later_motion = False
    if speaking and speaking_motion:
        start = float(speaking[0]["observedAt"])
        end = float(speaking[-1]["observedAt"])
        midpoint = start + (end - start) * 0.5
        later_motion = any(float(sample["observedAt"]) >= midpoint for sample in speaking_motion)

    metrics = {
        "model": str((samples[0] if samples else {}).get("model") or ""),
        "sampleCount": len(samples),
        "turnSampleCount": len(turn_samples),
        "speakingSampleCount": len(speaking),
        "speakingStartedAtSeconds": round(speaking_first, 3) if speaking_first is not None else None,
        "speakingEndedAtSeconds": round(speaking_last, 3) if speaking_last is not None else None,
        "performanceStartedAtSeconds": (
            round(performance_first, 3) if performance_first is not None else None
        ),
        "performanceLeadSeconds": (
            round(performance_first - speaking_first, 3)
            if performance_first is not None and speaking_first is not None
            else None
        ),
        "completedAtSeconds": round(completed_at, 3) if completed_at is not None else None,
        "expressions": sorted(expressions),
        "maximumMouthOpen": round(max(mouth_values, default=0.0), 5),
        "bodySpanDuringSpeaking": round(body_span(speaking), 5),
        "acceptedMotionSamples": len(accepted),
        "speakingMotionSamples": len(speaking_motion),
        "laterHalfMotionObserved": later_motion,
        "speakingSubtitleVersions": len(speaking_subtitles),
        "speakingSubtitleLength": max(map(len, speaking_subtitles), default=0),
        "devicePixelRatio": (
            float(samples[-1].get("devicePixelRatio") or 0.0) if samples else 0.0
        ),
        "frame": (samples[-1].get("frame") or {}) if samples else {},
    }
    checks = {
        "correctBenchmarkModel": metrics["model"] == args.expected_model,
        "realTurnIntentObserved": len(turn_samples) >= 1,
        "decodedSpeechObserved": len(speaking) >= 4,
        "performanceStartsWithSpeech": len(premature_motion) == 0,
        "wholeSubtitleStableDuringSpeech": len(speaking_subtitles) == 1,
        "lipSyncVisible": metrics["maximumMouthOpen"] >= 0.04,
        "semanticMotionAccepted": len(accepted) >= 1,
        "bodyLanguageVisible": metrics["bodySpanDuringSpeaking"] >= 0.08,
        "bodyLanguageSpansSpeech": later_motion,
        "turnCompleted": completed_at is not None,
    }
    result = {"metrics": metrics, "checks": checks, "ok": all(checks.values())}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
