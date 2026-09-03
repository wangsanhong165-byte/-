"""GSVI v2Pro engine — GPT-SoVITS v2Pro nvidia50 HTTP API.

Endpoint: POST /tts
Returns raw WAV bytes.

Loads persona-specific model weights on first use and caches them
to avoid redundant API calls on every sentence.
Auto-detects text language for text_lang parameter.
"""

from __future__ import annotations

import os
import time as _time
from pathlib import Path
from typing import Any

import requests

from app.config_manager.service_config import service_config
from app.modules.tts.base import BaseTTS
from app.modules.tts.factory import TTSFactory


# GSVI is a loopback service. Lifecycle-launched processes may inherit a
# desktop HTTP proxy, so using requests' default environment lookup can route
# 127.0.0.1 traffic through that proxy and turn a healthy local service into a
# spurious 502. Keep this transport local without changing global proxy state.
_local_session = requests.Session()
_local_session.trust_env = False

# ---- Language mapping for v2Pro API ----
_TEXT_LANG_MAP: dict[str, str] = {
    "zh": "zh", "cn": "zh", "chinese": "zh",
    "mixed": "zh", "auto": "zh", "zh_en": "zh",
    "en": "en", "english": "en",
    "ja": "ja", "jp": "ja", "japanese": "ja",
    "ko": "ko", "kr": "ko", "korean": "ko",
    "yue": "yue", "cantonese": "yue",
    "\u4e2d\u6587": "zh", "\u82f1\u6587": "en",
    "\u65e5\u6587": "ja", "\u65e5\u8bed": "ja",
    "\u97e9\u6587": "ko", "\u97e9\u8bed": "ko",
    "\u7ca4\u8bed": "yue",
}

_AI_DIR = Path(__file__).resolve().parents[4]  # c++/ai/
_GSVI_DIR = _AI_DIR / "models" / "tts" / "GPT-SoVITS-v2pro-20250604-nvidia50"

# ---- weight cache (class-level, shared across instances) ----
_last_gpt_weights: str = ""
_last_sovits_weights: str = ""


def _infer_text_lang(text: str) -> str:
    """Auto-detect text language for GSVI text_lang parameter."""
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff" or "\u3040" <= ch <= "\u30ff":
            return "zh"
        if "\uac00" <= ch <= "\ud7af":
            return "ko"
    # Check for common CJK characters
    # Default to zh if mixed, en otherwise
    return "zh" if any("\u4e00" <= c <= "\u9fff" for c in text) else "en"


def _map_lang(raw: str, mapping: dict[str, str]) -> str:
    return mapping.get(raw.strip().lower(), raw.strip().lower())


def _set_model_weights(base: str, gpt_path: str, sovits_path: str) -> None:
    """Set model weights, cached: skips if same weights already loaded."""
    global _last_gpt_weights, _last_sovits_weights

    if gpt_path and gpt_path != _last_gpt_weights:
        try:
            r = _local_session.get(f"{base}/set_gpt_weights", params={"weights_path": gpt_path}, timeout=10)
            if r.status_code == 200:
                _last_gpt_weights = gpt_path
                print(f"[GSVI-v2pro] set_gpt_weights OK: {gpt_path}")
            else:
                print(f"[GSVI-v2pro] set_gpt_weights FAIL {r.status_code}: {r.text[:200]}")
        except Exception as exc:
            print(f"[GSVI-v2pro] set_gpt_weights error: {exc}")

    if sovits_path and sovits_path != _last_sovits_weights:
        try:
            r = _local_session.get(f"{base}/set_sovits_weights", params={"weights_path": sovits_path}, timeout=10)
            if r.status_code == 200:
                _last_sovits_weights = sovits_path
                print(f"[GSVI-v2pro] set_sovits_weights OK: {sovits_path}")
            else:
                print(f"[GSVI-v2pro] set_sovits_weights FAIL {r.status_code}: {r.text[:200]}")
        except Exception as exc:
            print(f"[GSVI-v2pro] set_sovits_weights error: {exc}")


def _resolve_ref_audio(ref_audio_path: str) -> str:
    if not ref_audio_path:
        return ""
    p = Path(ref_audio_path)
    if p.is_absolute():
        return str(p)
    candidate = _GSVI_DIR / p
    if candidate.exists():
        return str(candidate)
    candidate = _AI_DIR / p
    if candidate.exists():
        return str(candidate)
    return ref_audio_path


@TTSFactory.register
class GSVIV2TTS(BaseTTS):
    engine_name = "gsvi-v2pro"

    def __init__(self, config: Any = None, **kwargs: Any) -> None:
        super().__init__()
        self._url = os.environ.get("GSVI_URL", service_config.url("gsvi")).rstrip("/")
        self._ref_audio = os.environ.get("GSVI_REF_AUDIO", "")
        self._text_lang = os.environ.get("GSVI_TEXT_LANG", "auto")
        self._prompt_lang = os.environ.get("GSVI_PROMPT_LANG", "en")
        self._speed = float(os.environ.get("GSVI_SPEED", "1.0"))
        self._timeout = float(os.environ.get("GSVI_TIMEOUT", "300"))
        self._gpt_weights = os.environ.get("GSVI_GPT_WEIGHTS", "")
        self._sovits_weights = os.environ.get("GSVI_SOVITS_WEIGHTS", "")
        if config is not None:
            from app.config_manager import GSVIV2Config
            if isinstance(config, GSVIV2Config):
                if config.url:
                    self._url = config.url.rstrip("/")
                if config.ref_audio:
                    self._ref_audio = config.ref_audio
                if config.text_lang:
                    self._text_lang = config.text_lang
                if config.prompt_lang:
                    self._prompt_lang = config.prompt_lang
                if config.speed:
                    self._speed = config.speed
                if config.timeout:
                    self._timeout = config.timeout
                if config.gpt_weights:
                    self._gpt_weights = config.gpt_weights
                if config.sovits_weights:
                    self._sovits_weights = config.sovits_weights

    def synthesize(self, text: str, **options: Any) -> bytes:
        """Call v2Pro /tts endpoint, read params from instance config + kwargs override."""
        url = self._url
        text_lang_raw = options.get("text_lang") or self._text_lang
        prompt_lang_raw = options.get("prompt_lang") or self._prompt_lang
        ref_audio_path = options.get("ref_audio_path") or self._ref_audio
        prompt_text = options.get("prompt_text") or ""
        speed = float(options.get("speed_factor") or self._speed)
        gpt_weights = options.get("gpt_weights") or self._gpt_weights
        sovits_weights = options.get("sovits_weights") or self._sovits_weights

        ref_audio_path = _resolve_ref_audio(ref_audio_path)

        # text_lang must match the DOMINANT language of the actual text being
        # synthesized. The character card's reply_language is the *intended*
        # reply language, which can disagree with what the model really
        # outputs (e.g. an EN character replying in Chinese to a Chinese user).
        # Measured: en mode reading Chinese drops whole words, zh mode reading
        # pure English also degrades; zh mode handles embedded English words
        # correctly. So always detect from content: any CJK => zh, else en.
        detected_lang = _infer_text_lang(text)

        # Set model weights (cached — skips if already loaded)
        if gpt_weights or sovits_weights:
            _set_model_weights(url, gpt_weights, sovits_weights)

        payload: dict[str, Any] = {
            "text": text,
            "text_lang": detected_lang,
            "prompt_lang": _map_lang(prompt_lang_raw, _TEXT_LANG_MAP),
            "ref_audio_path": ref_audio_path,
            "speed_factor": speed,
            "streaming_mode": False,
        }
        if prompt_text:
            payload["prompt_text"] = prompt_text
        # Emotion-shaped sampling: temperature/top_k ride through from the
        # runtime's emotion mapping (api_v2 accepts them per request).
        if options.get("temperature") is not None:
            payload["temperature"] = float(options["temperature"])
        if options.get("top_k") is not None:
            payload["top_k"] = int(options["top_k"])

        _t0 = _time.time()
        full_url = f"{url}/tts"
        text_preview = text[:80].replace(chr(10), " ")
        print(f"[GSVI-v2pro] POST {full_url} text_lang={payload['text_lang']} prompt_lang={payload['prompt_lang']} speed={payload['speed_factor']}")
        print(f'[GSVI-v2pro] text="{text_preview}"')

        try:
            r = _local_session.post(full_url, json=payload, timeout=self._timeout)
        except Exception as exc:
            print(f"[GSVI-v2pro] request error: {exc}")
            raise

        _elapsed = _time.time() - _t0
        if r.status_code == 200:
            print(f"[GSVI-v2pro] response 200 {len(r.content)} bytes in {_elapsed:.1f}s")
            return r.content
        else:
            try:
                err_detail = r.json()
            except Exception:
                err_detail = r.text[:500]
            print(f"[GSVI-v2pro] response {r.status_code} in {_elapsed:.1f}s")
            print(f"[GSVI-v2pro] error detail: {err_detail}")
            r.raise_for_status()
            return r.content  # unreachable but keeps type checker happy
