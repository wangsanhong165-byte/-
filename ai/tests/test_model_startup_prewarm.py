"""Regression guards for eager GPU model startup."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_asr_startup_loads_the_model_not_only_the_adapter():
    api = (ROOT / "app/modules/asr/api.py").read_text(encoding="utf-8")
    engine = (ROOT / "app/modules/asr/engines/qwen.py").read_text(encoding="utf-8")

    assert "def preload(" in engine
    # 2026-09-05: startup preload runs through the backoff retry wrapper so a
    # transient commit-memory failure cannot leave the voice stack isolated.
    assert "_preload_with_retries(" in api
    assert "engine.preload()" in api
    # The ready flag is derived from the loader result, not hardcoded True —
    # a failed preload must leave /health reporting not-ready.
    assert "_engine_ready = _engine is not None" in api


def test_asr_model_load_uses_the_low_memory_safetensors_path():
    engine = (ROOT / "app/modules/asr/engines/qwen.py").read_text(encoding="utf-8")

    # The first safetensors shard is over 4 GB.  On Windows, loading it through
    # a full CPU state-dict copy can exhaust the commit limit before the model
    # is moved to the GPU (WinError 1455), leaving the whole lifecycle blocked.
    assert "low_cpu_mem_usage=True" in engine
    assert "use_safetensors=True" in engine


def test_tts_exposes_real_synthesis_warmup_and_ready_state():
    api = (ROOT / "app/modules/tts/api.py").read_text(encoding="utf-8")

    assert '@app.post("/warmup")' in api
    assert "_engine_warm = True" in api
    assert '"warm": _engine_warm' in api


def test_manifest_declares_memory_safe_gpu_service_order():
    import json
    from app.lifecycle.manifest import ServiceManifest

    manifest = json.loads((ROOT / "config/services.json").read_text(encoding="utf-8"))
    assert manifest["tts"]["depends_on"] == ["gsvi"]
    assert "warmup" in manifest["tts"]
    assert manifest["asr"]["depends_on"] == ["tts"]
    assert manifest["bridge"]["depends_on"] == ["llm"]
    assert manifest["gsvi"]["readiness"] is True
    assert manifest["gsvi"]["command"]["executable"] == "{python}"
    assert manifest["gsvi"]["env"]["PATH"].startswith("{python_dir};")
    ordered = [
        service.name
        for service in ServiceManifest.load(
            ROOT / "config/services.json",
        ).for_profile("electron")
    ]
    # Voice chain keeps its ordering, and bridge (text) follows llm without
    # waiting on voice services, so a voice failure cannot abort text chat.
    assert ordered.index("gsvi") < ordered.index("tts") < ordered.index("asr")
    assert ordered.index("llm") < ordered.index("bridge")


def test_bridge_timeout_covers_character_runtime_initialization():
    import json

    manifest = json.loads(
        (ROOT / "config/services.json").read_text(encoding="utf-8")
    )
    # A real cold start has reached 28-30 seconds while loading the character,
    # histories, memory providers and capability registry. Keep a 3x safety
    # window so normal disk/GPU contention does not turn a healthy Bridge into
    # a lifecycle rollback.
    assert manifest["bridge"]["timeout"] >= 90


def test_python_supervisor_owns_lifecycle_core():
    supervisor = (ROOT / "app/lifecycle/supervisor.py").read_text(encoding="utf-8")
    assert "LifecycleOrchestrator" in supervisor
    assert "ControlServer" in supervisor


def test_soulctl_is_the_entry_and_electron_main_owns_its_launch_shutdown():
    entry = (ROOT / "soulctl.cmd").read_text(encoding="utf-8")
    main = (ROOT / "frontend/electron/main.cjs").read_text(encoding="utf-8")

    assert "scripts\\soulctl.cjs" in entry
    assert "electron.pid" in main
    assert "taskkill" not in entry
    assert "shutdownStarted" in main


def test_process_manager_is_a_thin_supervisor_adapter():
    manager = (ROOT / "electron/process-manager.cjs").read_text(encoding="utf-8")
    assert "app.lifecycle.client" in manager
    assert "SERVICE_DEFINITIONS" not in manager
    assert "taskkill" not in manager
    assert "netstat" not in manager


def test_run_py_is_only_a_thin_lifecycle_client():
    launcher = (ROOT / "run.py").read_text(encoding="utf-8")

    assert 'get("availability") == "FULL_READY"' in launcher
    assert "procs, log_files" not in launcher
    assert "for p in procs" not in launcher
    assert "for f in log_files" not in launcher
    assert "TTS was loaded before ASR startup" not in launcher
