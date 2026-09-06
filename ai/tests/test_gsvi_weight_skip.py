"""GSVI weight pushes must skip when the engine already runs the same weights.

GSVI loads the voice pack named in its tts_infer.yaml at process start. The
TTS service then pushes the character's voice pack via set_gpt_weights /
set_sovits_weights on the first synthesis — historically reloading the exact
same files, doubling startup time and creating the commit-memory spike that
starved ASR's preload (os error 1455).
"""

from __future__ import annotations

import pytest

from app.modules.tts.engines import gsvi_v2


@pytest.fixture(autouse=True)
def _reset_cache(monkeypatch):
    monkeypatch.setattr(gsvi_v2, "_last_gpt_weights", "")
    monkeypatch.setattr(gsvi_v2, "_last_sovits_weights", "")


def _seed_startup_weights(monkeypatch, gpt: str, sovits: str) -> None:
    monkeypatch.setattr(
        gsvi_v2, "_gsvi_startup_weights", lambda: {"gpt": gpt, "sovits": sovits}
    )


def test_skips_push_when_requested_weights_match_gsvi_startup(monkeypatch):
    gpt = r"C:\ai\config\voices\alims\Aemeath-e15.ckpt"
    sovits = r"C:\ai\config\voices\alims\Aemeath_e8_s272.pth"
    # Startup weights come back already normalized by _gsvi_startup_weights.
    _seed_startup_weights(monkeypatch, gpt.lower(), sovits.lower())

    def _fail(*_args, **_kwargs):
        raise AssertionError("set_weights HTTP call must not happen")

    monkeypatch.setattr(gsvi_v2._local_session, "get", _fail)

    gsvi_v2._set_model_weights("http://127.0.0.1:19205", gpt, sovits)

    assert gsvi_v2._last_gpt_weights == gpt
    assert gsvi_v2._last_sovits_weights == sovits


def test_pushes_when_requested_weights_differ_from_startup(monkeypatch):
    _seed_startup_weights(
        monkeypatch,
        r"c:\ai\config\voices\other\other-e1.ckpt",
        r"c:\ai\config\voices\other\other_s1.pth",
    )
    calls: list[str] = []

    class _Response:
        status_code = 200
        text = ""

    def _fake_get(url, params=None, timeout=None):
        calls.append(url)
        return _Response()

    monkeypatch.setattr(gsvi_v2._local_session, "get", _fake_get)

    gpt = r"C:\ai\config\voices\alims\Aemeath-e15.ckpt"
    sovits = r"C:\ai\config\voices\alims\Aemeath_e8_s272.pth"
    gsvi_v2._set_model_weights("http://127.0.0.1:19205", gpt, sovits)

    assert len(calls) == 2
    assert any("set_gpt_weights" in c for c in calls)
    assert any("set_sovits_weights" in c for c in calls)
    assert gsvi_v2._last_gpt_weights == gpt


def test_pushes_when_startup_weights_unknown(monkeypatch):
    # Missing/unreadable tts_infer.yaml must fall back to always-push.
    _seed_startup_weights(monkeypatch, "", "")
    calls: list[str] = []

    class _Response:
        status_code = 200
        text = ""

    def _fake_get(url, params=None, timeout=None):
        calls.append(url)
        return _Response()

    monkeypatch.setattr(gsvi_v2._local_session, "get", _fake_get)

    gpt = r"C:\ai\config\voices\alims\Aemeath-e15.ckpt"
    sovits = r"C:\ai\config\voices\alims\Aemeath_e8_s272.pth"
    gsvi_v2._set_model_weights("http://127.0.0.1:19205", gpt, sovits)

    assert len(calls) == 2
