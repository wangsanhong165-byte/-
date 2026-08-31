"""v1 Voice Agent --one-click launcher with input state machine.

Usage:
    python run.py              # Continuous VAD voice mode
    python run.py --no-vad     # Single-turn (fixed duration)
    python run.py --text       # Text-only chat mode
    python run.py --web        # Start backend Bridge + Web UI
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
import io
import requests

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

# --- Force UTF-8 for all I/O (fix garbled text on Windows) ---
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from app.lifecycle.control import send_request
from app.core.config import DEFAULT_ENV_PATH, load_env_file


_lifecycle_started = False


def env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return v.strip().lower() in {"1", "true", "yes", "on"} if v else default


def start_lifecycle() -> None:
    global _lifecycle_started
    subprocess.run(
        ["cmd.exe", "/c", str(BASE_DIR / "soulctl.cmd"), "start"],
        cwd=BASE_DIR,
        check=True,
    )
    _lifecycle_started = True


def wait_lifecycle() -> dict | None:
    try:
        response = send_request(BASE_DIR, {
            "schema_version": 1,
            "command": "status",
            "request_id": "run-py-status",
        })
        result = response.get("result", {})
        if response.get("ok") and result.get("availability") == "FULL_READY":
            return result
        return None
    except (OSError, ValueError):
        return None


def stop_lifecycle() -> None:
    if not _lifecycle_started:
        return
    subprocess.run(
        ["cmd.exe", "/c", str(BASE_DIR / "soulctl.cmd"), "stop"],
        cwd=BASE_DIR,
        check=False,
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="v1 Voice Agent")
    p.add_argument("--env-file", default=str(DEFAULT_ENV_PATH))
    p.add_argument("--seconds", type=float, default=5.0)
    p.add_argument("--sample-rate", type=int, default=16000)
    p.add_argument("--language", default=None)
    p.add_argument("--no-tts", action="store_true")
    p.add_argument("--no-vad", action="store_true", help="Single-turn mode")
    p.add_argument("--persona", default=None)
    p.add_argument("--text", action="store_true", help="Text-only chat mode (no audio)")
    p.add_argument("--audio-path", default="")
    p.add_argument("--runtime", action="store_true",
                   help=argparse.SUPPRESS)  # deprecated — Runtime is now the default
    p.add_argument("--web", action="store_true",
                   help="Start bridge server and web UI instead of CLI mode")
    return p.parse_args()


def _runtime_main(args: argparse.Namespace) -> int:
    """Run using CharacterRuntime."""
    import asyncio

    import numpy as np
    import soundfile as sf

    from app.input.manager import InputManager
    from app.runtime.character_turn import TurnInput
    from app.runtime.runtime import CharacterRuntime

    rt = CharacterRuntime()

    def _sync_turn(turn_input: TurnInput):
        """Synchronous wrapper around rt.handle_turn()."""
        return asyncio.run(rt.handle_turn(turn_input))

    try:
        if args.text:
            # ── Text REPL ────────────────────────────────────────────
            print("\n[Runtime] Text mode — type 'exit' to quit\n")
            while True:
                try:
                    user_text = input("> ").strip()
                except (EOFError, KeyboardInterrupt):
                    print()
                    break
                if not user_text:
                    continue
                if user_text.lower() in ("exit", "quit", "/exit", "/quit"):
                    break

                ctx = _sync_turn(TurnInput(text=user_text))

                if ctx.error:
                    print(f"[Error] {ctx.error}")
                elif ctx.reply_text:
                    print(f"\n{ctx.reply_text}\n")
            return 0

        if args.no_vad:
            # ── Single-turn audio ────────────────────────────────────
            import sounddevice as sd
            from pathlib import Path

            path = Path(args.audio_path) if args.audio_path else \
                Path(__file__).resolve().parent / "data" / "recordings" / "single.wav"

            if not args.audio_path:
                print(f"Recording {args.seconds}s...")
                audio = sd.rec(int(args.seconds * args.sample_rate),
                               samplerate=args.sample_rate, channels=1, dtype="float32")
                sd.wait()
                path.parent.mkdir(parents=True, exist_ok=True)
                sf.write(str(path), audio, args.sample_rate)

            audio_data, sr = sf.read(str(path), dtype="float32")
            audio_bytes = audio_data.tobytes()

            ctx = _sync_turn(
                TurnInput(audio=audio_bytes, sample_rate=int(sr))
            )

            if ctx.error:
                print(f"[Error] {ctx.error}")
            else:
                print(f"User: {ctx.user_text}")
                print(f"Assistant: {ctx.reply_text}")
            return 0

        # ── Continuous VAD mode ────────────────────────────────────
        manager = InputManager()
        manager.start()
        print("\n[Runtime] Continuous mode — listening... (Ctrl+C to stop)\n")

        try:
            while True:
                result = manager.poll()
                if result["type"] == "stop":
                    break
                if result["type"] == "speech":
                    audio_path = result["audio_path"]
                    audio_data, sr = sf.read(audio_path, dtype="float32")
                    audio_bytes = audio_data.tobytes()

                    ctx = _sync_turn(
                        TurnInput(audio=audio_bytes, sample_rate=int(sr))
                    )

                    if ctx.error:
                        print(f"[Error] {ctx.error}")
                    elif ctx.reply_text:
                        print(f"\nAssistant: {ctx.reply_text}\n")
        except KeyboardInterrupt:
            print()
        finally:
            manager.stop()

        return 0
    finally:
        rt.shutdown()


def main() -> int:
    args = parse_args()

    dotenv_path = Path(args.env_file)
    if dotenv_path.exists():
        load_env_file(dotenv_path)
    args.persona = args.persona or os.environ.get("ACTIVE_CHARACTER")

    # Persona
    if args.persona:
        try:
            persona_id = args.persona
            char_path = BASE_DIR / "config" / "characters" / persona_id / "character.json"
            with open(char_path, "r", encoding="utf-8") as f:
                char_card = json.load(f)
            persona_text = char_card.get("character_setting") or char_card.get("system_prompt", "")
            if persona_text:
                os.environ["LLM_STREAM_SYSTEM_PROMPT"] = persona_text
                os.environ["LLM_SYSTEM_PROMPT"] = persona_text

            tts_cfg = char_card.get("tts", {})
            if tts_cfg.get("voice"):
                os.environ["GSVI_VOICE"] = tts_cfg["voice"]
            if tts_cfg.get("ref_audio"):
                ref_audio = tts_cfg["ref_audio"]
                if isinstance(ref_audio, dict):
                    first_key = next(iter(ref_audio))
                    ref_audio = ref_audio[first_key]
                os.environ["GSVI_REF_AUDIO"] = str(BASE_DIR / "config" / "characters" / persona_id / ref_audio)
            if tts_cfg.get("prompt_lang"):
                os.environ["GSVI_PROMPT_LANG"] = tts_cfg["prompt_lang"]
            if tts_cfg.get("prompt_text"):
                os.environ["GSVI_PROMPT_TEXT"] = tts_cfg["prompt_text"]
            os.environ.setdefault("GSVI_EMOTION", "默认")
            # ---- Pass custom model weight paths (relative to GSVI dir) ----
            custom_model = tts_cfg.get("custom_model", {})
            if custom_model.get("t2s"):
                t2s_name = Path(custom_model["t2s"]).name
                os.environ["GSVI_GPT_WEIGHTS"] = f"GPT_weights_v2Pro/{persona_id}/{t2s_name}"
            if custom_model.get("vits"):
                vits_name = Path(custom_model["vits"]).name
                os.environ["GSVI_SOVITS_WEIGHTS"] = f"SoVITS_weights_v2Pro/{persona_id}/{vits_name}"

            print(f"[persona] Loaded: {persona_id} ({len(persona_text)} chars)")
            print(f"[persona]   engine={tts_cfg.get('engine','')}  voice={tts_cfg.get('voice','')}")
            print(f"[persona]   prompt_lang={tts_cfg.get('prompt_lang','')}  prompt_text={tts_cfg.get('prompt_text','')[:60]}...")
            ref = tts_cfg.get('ref_audio', {})
            print(f"[persona]   ref_audio={ref}")
        except Exception as exc:
            print(f"[persona] Load failed: {exc}")

    print("\nStarting services...")
    start_lifecycle()
    try:
        print("\nWaiting for services...")
        lifecycle_status = wait_lifecycle()
        if not lifecycle_status:
            return 1

        # ---- Web UI mode (bridge server) ----
        if args.web:
            bridge = next(
                service for service in lifecycle_status.get("services", [])
                if service.get("id") == "bridge"
            )
            bridge_url = f"http://{bridge['host']}:{bridge['port']}"
            print(f"\nLive2D Bridge ready on {bridge_url} ...")
            import webbrowser
            webbrowser.open(bridge_url)
            print(f"\n=== Monika Live2D ready! {bridge_url} ===")
            print("    Press Ctrl+C to stop\n")
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                print("\nShutting down...")
            return 0

        # ---- CharacterRuntime ----
        return _runtime_main(args)
    finally:
        print("Shutting down...")
        stop_lifecycle()
        print("All services stopped.")


if __name__ == "__main__":
    raise SystemExit(main())


