"""Live2D Bridge Server — serves frontend, Live2D models, WebSocket API."""
import argparse
import asyncio
import io
import json
import logging
import os
import struct
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Response, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.responses import FileResponse

from app.config_manager.service_config import service_config
from app.runtime.visual_attachments import (
    VisualAttachmentError,
    VisualAttachmentStore,
    get_visual_limits,
)


def parse_bind_address(argv: list[str] | None = None) -> tuple[str, int]:
    parser = argparse.ArgumentParser(description="SoulLink Bridge server")
    parser.add_argument("--host", default=service_config.host("bridge"))
    parser.add_argument("--port", type=int, default=service_config.port("bridge"))
    args = parser.parse_args(argv)
    return args.host, args.port


_MAIN_BIND_ADDRESS = parse_bind_address() if __name__ == "__main__" else None
if _MAIN_BIND_ADDRESS:
    os.environ["BRIDGE_HOST"] = _MAIN_BIND_ADDRESS[0]
    os.environ["BRIDGE_PORT"] = str(_MAIN_BIND_ADDRESS[1])

# Character card state (used by switch-character)
_char_card: dict[str, Any] | None = None
_char_name: str = "Monika"

# Live2D expression config (loaded from config/live2d_models.json)
_live2d_config: dict[str, Any] | None = None
_live2d_model: str = "shirone"

# Avatar config (loaded from config/avatar.yaml)
_avatar_config: dict[str, Any] | None = None
_avatar_controller: Any = None

# UI mode tracking
_ui_mode: str = "window"  # "window" or "pet"

def _local_ui_origins() -> set[str]:
    origins: set[str] = set()
    for service_id in ("bridge", "frontend"):
        port = service_config.port(service_id)
        origins.add(f"http://127.0.0.1:{port}")
        origins.add(f"http://localhost:{port}")
    return origins


def _is_allowed_client_origin(origin: str) -> bool:
    """Reject browser cross-site WebSocket access to local management commands."""
    return not origin or origin.lower().rstrip("/") in _local_ui_origins()

# Runtime manager (lazy init)
_manager: Any = None


def _get_presentation_registry():
    from app.runtime.presentation_capabilities import get_presentation_registry

    return get_presentation_registry()

def _get_manager():
    """Get RuntimeManager singleton."""
    global _manager
    if _manager is None:
        from app.runtime.management import get_manager
        _manager = get_manager()
    return _manager


def _load_live2d_config() -> dict[str, Any]:
    """Load Live2D expression mapping from config/live2d_models.json."""
    global _live2d_config, _live2d_model
    if _live2d_config is not None:
        return _live2d_config
    registry = _get_presentation_registry()
    registry.refresh()
    snapshot = registry.snapshot()
    _live2d_config = registry.config()
    if snapshot.model:
        _live2d_model = snapshot.model
    logger.info(
        "[Live2D] Config loaded: model=%s, emotions=%d",
        _live2d_model,
        len(snapshot.allowed_emotions),
    )
    return _live2d_config or {}


def _load_avatar_profiles() -> dict[str, Any]:
    # Read fresh on every call: models are added at the system level during a
    # running session, and the attach gate consumes these profiles.
    profiles_dir = BASE_DIR / "config" / "avatar_profiles"
    profiles: dict[str, Any] = {}
    if profiles_dir.exists():
        for path in profiles_dir.glob("*.json"):
            try:
                profile = json.loads(path.read_text("utf-8"))
                profile.setdefault("sequences", ["greet"])
                if profile.get("model"):
                    profiles[profile["model"]] = profile
            except Exception as exc:
                logger.warning("[Live2D] Invalid avatar profile %s: %s", path.name, exc)
    return profiles


def _load_motion_presets() -> dict[str, Any]:
    presets: dict[str, Any] = {}
    for path in (BASE_DIR / "config" / "motions").glob("*.json"):
        try:
            preset = json.loads(path.read_text("utf-8"))
            presets[preset["name"].lower()] = preset
        except Exception as exc:
            logger.warning("[Live2D] Invalid motion preset %s: %s", path.name, exc)
    return presets


def _build_model_info() -> dict[str, Any]:
    cfg = _load_live2d_config()
    model_cfg = cfg.get(_live2d_model, {})
    capabilities = _get_presentation_registry().capabilities_for(_live2d_model)
    return {
        "name": _live2d_model,
        "url": f"/live2d-models/{_live2d_model}/{_live2d_model}.model3.json",
        "promptEmotions": list(capabilities.allowed_emotions),
        "emotionMap": model_cfg.get("emotion_map", {}),
        "behaviors": model_cfg.get("behaviors", []),
        "accessories": model_cfg.get("accessories", {}),
        "behaviorConfig": {
            name: {
                "emotionMap": value.get("emotion_map", {}),
                "behaviorMap": value.get("behavior_map", {}),
                "personality": value.get("personality", {}),
            }
            for name, value in cfg.items()
        },
        "avatarProfiles": _load_avatar_profiles(),
        "motionPresets": _load_motion_presets(),
        "avatar": _load_avatar_config(),
    }


def _load_avatar_config() -> dict[str, Any]:
    """Load avatar configuration from config/avatar.yaml."""
    global _avatar_config
    if _avatar_config is not None:
        return _avatar_config

    config_path = BASE_DIR / "config" / "avatar.yaml"
    if config_path.exists():
        try:
            import yaml
            raw = yaml.safe_load(config_path.read_text("utf-8"))
            _avatar_config = raw or {}
            logger.info("[Avatar] Config loaded: %d models", len(_avatar_config))
        except ImportError:
            logger.warning("[Avatar] PyYAML not installed, trying JSON fallback")
            try:
                import json
                # Try avatar.json as fallback
                json_path = BASE_DIR / "config" / "avatar.json"
                if json_path.exists():
                    _avatar_config = json.loads(json_path.read_text("utf-8"))
                    logger.info("[Avatar] Config loaded from JSON: %d models", len(_avatar_config or {}))
                else:
                    _avatar_config = {}
                    logger.warning("[Avatar] No avatar config found")
            except Exception as exc:
                _avatar_config = {}
                logger.error("[Avatar] Config load failed: %s", exc)
        except Exception as exc:
            _avatar_config = {}
            logger.error("[Avatar] Config load failed: %s", exc)
    else:
        _avatar_config = {}
        logger.warning("[Avatar] config/avatar.yaml not found")
    return _avatar_config or {}


def _get_avatar_controller() -> Any:
    """Get or create the singleton AvatarController."""
    global _avatar_controller
    if _avatar_controller is None:
        from app.avatar.controller import AvatarController
        _avatar_controller = AvatarController()
        cfg = _load_avatar_config()
        _avatar_controller.configure(_live2d_model, cfg)
        # Restore persisted state
        _avatar_controller.restore_state()
        logger.info("[Avatar] Controller initialized for model=%s", _live2d_model)
    return _avatar_controller


def _ensure_env():
    """Ensure .env is loaded exactly once."""
    if os.environ.get("_BRIDGE_ENV_LOADED"):
        return
    from app.core.config import DEFAULT_ENV_PATH, load_env_file
    load_env_file(DEFAULT_ENV_PATH)
    os.environ["_BRIDGE_ENV_LOADED"] = "1"


def _load_character():
    """Load the active character card through CharacterRuntime."""
    global _char_card, _char_name
    if _char_card is not None:
        return

    try:
        from app.runtime.runtime import runtime
        info = runtime.get_character_info()
        _char_card = info.get("card", {})
        _char_name = info.get("name", "AI")
        logger.info("[Character] Loaded: %s", _char_name)
    except Exception as exc:
        logger.error("[Character] Load failed: %s", exc)


# ═══════════════════════════════════════════════
# ═══════════════════════════════════════════════
#  Pinned Memories
# ═══════════════════════════════════════════════

def _init_pinned() -> None:
    """Ensure pinned.md exists for the active character. Delegates to RuntimeManager."""
    _get_manager().ensure_pinned()


def _load_pinned_memories() -> str:
    """Return pinned memories content. Delegates to RuntimeManager."""
    return _get_manager().get_pinned()


# ═══════════════════════════════════════════════
#  History Management (JSON file-based)
# ═══════════════════════════════════════════════

def _init_histories() -> None:
    """Ensure histories directory and index exist. Delegates to RuntimeManager."""
    _get_manager()._ensure_dirs()


def _get_history_list() -> list[dict]:
    """Return history list sorted by timestamp desc. Delegates to RuntimeManager."""
    return _get_manager().get_history_list()


def _load_history_messages(uid: str) -> list[dict]:
    """Load messages for a given history uid. Delegates to RuntimeManager."""
    result = _get_manager().load_history(uid)
    return result.get("messages", [])




def _float32_to_wav(samples: list[float], sample_rate: int = 16000) -> bytes:
    """Convert float32 samples (list of floats in [-1, 1]) to WAV bytes."""
    num_channels = 1
    bits_per_sample = 16
    block_align = num_channels * bits_per_sample // 8
    byte_rate = sample_rate * block_align
    data_size = len(samples) * block_align

    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))  # chunk size
    buf.write(struct.pack("<H", 1))   # PCM
    buf.write(struct.pack("<H", num_channels))
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", byte_rate))
    buf.write(struct.pack("<H", block_align))
    buf.write(struct.pack("<H", bits_per_sample))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    for sample in samples:
        buf.write(struct.pack("<h", max(-32768, min(32767, int(sample * 32767)))))
    return buf.getvalue()


# ── Logger ──────────────────────────────────────────────────────────────
logger = logging.getLogger("bridge")
logger.setLevel(logging.DEBUG)
_ch = logging.StreamHandler()
_ch.setLevel(logging.DEBUG)
_ch.setFormatter(logging.Formatter("[Bridge] %(asctime)s.%(msecs)03d %(levelname)-5s %(message)s", datefmt="%H:%M:%S"))
logger.handlers.clear()
logger.addHandler(_ch)

# ── Paths ───────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = BASE_DIR / "frontend" / "dist"
FRONTEND_PUBLIC_DIR = BASE_DIR / "frontend" / "public"
LIVE2D_DIR = BASE_DIR / "models" / "live2d-models"
BACKGROUNDS_DIR = Path(
    os.environ.get("BRIDGE_BACKGROUNDS_DIR",
                   str(BASE_DIR / "backgrounds"))
)

# ── App ─────────────────────────────────────────────────────────────────
app = FastAPI()


@app.post("/api/tool-confirmations/{request_id}")
async def resolve_tool_confirmation(request_id: str, payload: dict):
    from app.runtime.tool_confirmation import tool_confirmation_broker
    resolved = tool_confirmation_broker.resolve(
        request_id, bool(payload.get("approved", False))
    )
    return {"resolved": resolved}
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_local_ui_origins()),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Utilities ───────────────────────────────────────────────────────────
def _elapsed_s(t0: float) -> str:
    return f"{time.perf_counter() - t0:.3f}s"


# ── Pinned Memories API ─────────────────────────────────────────

class PinnedBody(BaseModel):
    content: str = ""


@app.get("/api/pinned")
async def get_pinned():
    """Return current pinned memories. Delegates to RuntimeManager."""
    content = _get_manager().get_pinned()
    return {"content": content}


@app.post("/api/pinned")
async def set_pinned(body: PinnedBody):
    """Update pinned memories. Delegates to RuntimeManager."""
    _get_manager().set_pinned(body.content)
    logger.info("[Pinned] Updated (%d chars)", len(body.content))
    return {"ok": True}


# ── History API (used by frontend settings panel) ───────────────

@app.get("/api/histories")
async def api_histories():
    """Return history list. Delegates to RuntimeManager."""
    return {"histories": _get_manager().get_history_list()}


@app.get("/api/histories/{uid}")
async def api_history_detail(uid: str):
    """Return history messages. Delegates to RuntimeManager."""
    result = _get_manager().load_history(uid)
    return {"messages": result.get("messages", [])}


# ── Model Switcher Injection ────────────────────────────────────────────
MODEL_SWITCHER_SCRIPT = None


def _get_model_switcher_script():
    """Model switcher now lives in the React settings panel (live2d.tsx).
    This function is kept as a no-op to avoid breaking the injection point
    in serve_index()."""
    return ""


# ── API Endpoints ───────────────────────────────────────────────────────

@app.post("/api/visual-attachments")
async def upload_visual_attachment(file: UploadFile = File(...)):
    """Validate and persist one ephemeral image for a later user.visual turn."""
    data = await file.read(get_visual_limits()["maxImageBytes"] + 1)
    try:
        attachment = VisualAttachmentStore().save_bytes(
            data,
            file.content_type,
            source="user_upload",
        )
    except VisualAttachmentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"attachment": attachment.to_public_dict()}


@app.get("/api/visual-policy")
async def get_visual_policy():
    """Expose the effective local visual limits to the composer."""
    from app.runtime.visual_attachments import SUPPORTED_MIME_TYPES

    return {
        **get_visual_limits(),
        "supportedMimeTypes": sorted(SUPPORTED_MIME_TYPES),
    }

@app.on_event("startup")
async def _startup():
    """Initialize background services on server start."""
    logger.info("Server starting")
    try:
        VisualAttachmentStore().cleanup()
    except Exception:
        logger.exception("Visual attachment cleanup failed")


@app.get("/health")
def health():
    ok = {
        "ok": True,
        "module": "bridge",
        "frontend": FRONTEND_DIR.exists(),
        "live2d": LIVE2D_DIR.exists(),
    }
    logger.debug("Health check: %s", ok)
    return ok


@app.get("/api/models")
async def list_models():
    if not LIVE2D_DIR.exists():
        return {"models": []}
    models = []
    for d in sorted(LIVE2D_DIR.iterdir()):
        if d.is_dir():
            model3 = d / f"{d.name}.model3.json"
            models.append({"name": d.name, "hasModel3": model3.exists()})
    return {"models": models}


# ── Set Model Endpoint ─────────────────────────────────────────────────

@app.post("/api/set-model")
async def set_model(data: dict):
    """Receive model selection from frontend before page reload."""
    global _live2d_config, _live2d_model
    name = str(data.get("model", "")).strip()
    registry = _get_presentation_registry()
    registry.refresh()
    try:
        capabilities = registry.select(name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Live2D model not found: {name}")
    _live2d_config = registry.config()
    _live2d_model = capabilities.model
    if _avatar_controller is not None:
        _avatar_controller.configure(_live2d_model, _load_avatar_config())
    logger.info("[Live2D] Model switched to: %s", name)
    return {
        "status": "ok",
        "model": _live2d_model,
        "promptEmotions": list(capabilities.allowed_emotions),
    }


@app.post("/api/set-mode")
async def set_mode(data: dict):
    """Receive UI mode from frontend."""
    global _ui_mode
    mode = data.get("mode", "")
    if mode in ("window", "pet"):
        _ui_mode = mode
        logger.info("[Mode] UI mode set to: %s", mode)
    return {"status": "ok"}


# ── Settings persistence ─────────────────────────────────────────────────

SETTINGS_FILE = BASE_DIR / "data" / "settings.json"


def _load_settings() -> dict:
    """Load persisted settings from disk, returning defaults if missing."""
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_settings(settings: dict) -> None:
    """Atomically save settings to disk."""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False), "utf-8")
    tmp.replace(SETTINGS_FILE)


@app.get("/api/model-info")
async def get_model_info():
    """Return the same Live2D runtime configuration injected into production HTML."""
    return _build_model_info()


@app.get("/api/settings")
async def get_settings():
    """Return current persisted settings."""
    return {"settings": _load_settings()}


@app.post("/api/settings")
async def save_settings(data: dict):
    """Persist frontend settings."""
    settings = data.get("settings", {})
    if isinstance(settings, dict):
        _save_settings(settings)
        logger.info("[Settings] Saved %d keys", len(settings))
    return {"status": "ok"}


# ── Root .env configuration (settings UI) ──────────────────────────────


@app.get("/api/config/env")
async def get_env_config():
    """Return root .env configuration (LLM/ASR/TTS/GSVI) for the settings UI."""
    from app.config_manager.env_store import read_env_values
    return {"config": read_env_values()}


@app.post("/api/config/env")
async def save_env_config(data: dict):
    """Persist root .env configuration written from the settings UI."""
    from app.config_manager.env_store import write_env_values
    config = write_env_values(data.get("config", {}))
    return {"status": "ok", "config": config}


# ── Canonical Runtime V3 WebSocket ─────────────────────────────────────

@app.websocket("/client-ws")
async def client_websocket_endpoint(websocket: WebSocket):
    """Serve the canonical V3 runtime protocol."""
    if not _is_allowed_client_origin(websocket.headers.get("origin", "")):
        await websocket.close(code=1008, reason="untrusted origin")
        return
    from app.transport.websocket.handler import RuntimeEventHandler
    from app.transport.session import WebSocketSession

    handler = RuntimeEventHandler(avatar_controller=_get_avatar_controller())
    session = WebSocketSession(websocket, handler.handle_event)
    handler.send_event = session.send
    handler.enable_proactive_push()
    try:
        await session.run()
    finally:
        handler.disable_proactive_push()
        # Final memory extraction for the session that just closed — best
        # effort, background, no-ops when nothing is pending.
        try:
            handler.memory_finalize()
        except Exception:
            pass

@app.get("/libs/{rest:path}")
async def serve_libs(rest: str):
    """Serve frontend library files (Cubism Core JS, etc.)."""
    for root in (FRONTEND_DIR, FRONTEND_PUBLIC_DIR):
        target = root / "libs" / rest
        if target.exists() and target.is_file():
            return FileResponse(str(target))
    logger.warning("  -> 404: /libs/%s not found", rest)
    return Response(status_code=404)

@app.get("/live2d-models/{rest:path}")
async def serve_live2d(rest: str):
    """Serve Live2D model files (model3.json, textures, moc3, etc.)."""
    logger.info("Live2D request: %s", rest)
    target = LIVE2D_DIR / rest
    if target.exists() and target.is_file():
        sz = target.stat().st_size
        logger.debug("  -> serving %s (%d bytes)", rest, sz)
        headers = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
        return FileResponse(str(target), headers=headers)
    logger.warning("  -> 404: %s not found in Live2D models", rest)
    return Response(status_code=404)


@app.get("/bg/{rest:path}")
async def serve_background(rest: str):
    target = BACKGROUNDS_DIR / rest
    if target.exists() and target.is_file():
        return FileResponse(str(target))
    return Response(status_code=404)


@app.get("/")
async def serve_index():
    from starlette.responses import HTMLResponse

    logger.info("Serving index.html")
    cache_headers = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
    index = FRONTEND_DIR / "index.html"
    if index.exists():
        logger.info("  -> found (%d bytes)", index.stat().st_size)
        content = index.read_text(encoding="utf-8")

        # Inject model config into HTML so Live2D renders immediately
        # without waiting for a WebSocket configuration event
        cfg = _load_live2d_config()
        model_cfg = cfg.get(_live2d_model, {})
        capabilities = _get_presentation_registry().capabilities_for(_live2d_model)
        emotion_map = model_cfg.get("emotion_map", {})
        behaviors = model_cfg.get("behaviors", [])
        accessories = model_cfg.get("accessories", {})
        behavior_config = {
            name: {
                "emotionMap": value.get("emotion_map", {}),
                "behaviorMap": value.get("behavior_map", {}),
                "personality": value.get("personality", {}),
            }
            for name, value in cfg.items()
        }
        model_url = f"/live2d-models/{_live2d_model}/{_live2d_model}.model3.json"

        # Inject avatar config for ALL models (not just active) so model
        # switching picks up the correct component/expression/motion definitions.
        avatar_cfg = _load_avatar_config()
        avatar_profiles = _load_avatar_profiles()
        motion_presets = _load_motion_presets()

        inject = (
            '<script>window.__INITIAL_MODEL_INFO__ = '
            + json.dumps({
                "name": _live2d_model,
                "url": model_url,
                "promptEmotions": list(capabilities.allowed_emotions),
                "emotionMap": emotion_map,
                "behaviors": behaviors,
                "accessories": accessories,
                "behaviorConfig": behavior_config,
                "avatarProfiles": avatar_profiles,
                "motionPresets": motion_presets,
                "avatar": avatar_cfg,  # full per-model config
            }, ensure_ascii=False)
            + ';</script>'
        )
        content = content.replace("</head>", inject + "</head>") if "</head>" in content else content + inject
        return HTMLResponse(content, headers=cache_headers)
    logger.error("  -> NOT FOUND at %s", index)
    return {"error": "frontend not built"}


@app.get("/{path:path}")
async def serve_static(path: str):
    """Serve frontend static assets, fallback to index.html for SPA routing."""
    logger.debug("Static request: %s", path)
    target = FRONTEND_DIR / path
    if target.exists() and target.is_file():
        logger.debug("  -> serving %s (%d bytes)", path, target.stat().st_size)
        cache_headers = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
        return FileResponse(str(target), headers=cache_headers)
    if path.startswith(".well-known/"):
        return Response(status_code=404)
    if any(ext in path for ext in (".model3.json", ".moc3", ".exp3.json", ".physics3", ".pose3", ".cdi3", ".motion3.json")):
        logger.warning("  -> 404: model file %s not found", path)
        return Response(status_code=404)
    index = FRONTEND_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return Response(status_code=404)


# ── Main ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import shutil
    import uvicorn

    host, port = _MAIN_BIND_ADDRESS or parse_bind_address([])
    logger.info("Starting uvicorn on %s:%d", host, port)
    if shutil.which("ffmpeg") is None:
        logger.warning("ffmpeg not found. Install for audio chunk/volume support:")

    logger.info("=" * 44)
    logger.info("  Bridge server starting up")
    logger.info("  Frontend: %s  (exists=%s)", FRONTEND_DIR, FRONTEND_DIR.exists())
    logger.info("  Live2D:   %s  (exists=%s)", LIVE2D_DIR, LIVE2D_DIR.exists())
    if LIVE2D_DIR.exists():
        models = sorted(d.name for d in LIVE2D_DIR.iterdir() if d.is_dir())
        logger.info("  Live2D models: %s", models)
    assets = list(FRONTEND_DIR.glob("assets/*")) if FRONTEND_DIR.exists() else []
    logger.info("  Frontend assets (%d files):", len(assets))
    for a in assets:
        logger.debug("   . %s", a.name)
    index = FRONTEND_DIR / "index.html"
    if index.exists():
        logger.info("  index.html: found (%d bytes)", index.stat().st_size)
    # Load live2d config
    cfg = _load_live2d_config()
    capabilities = _get_presentation_registry().capabilities_for(_live2d_model)
    logger.info(
        "  Live2D active model: %s (%d emotions)",
        _live2d_model,
        len(capabilities.allowed_emotions),
    )
    # Init subsystems
    _ensure_env()
    _load_character()
    _init_pinned()
    _init_histories()
    logger.info("  Pinned memories initialized")
    logger.info("  Histories: %d entries", len(_get_manager().get_history_list()))
    logger.info("=" * 44)

    uvicorn.run(app, host=host, port=port, log_level="warning")
