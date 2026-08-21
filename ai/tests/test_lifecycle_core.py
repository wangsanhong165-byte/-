import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.lifecycle.manifest import ManifestError, ServiceManifest
from app.lifecycle.registry import ProcessIdentity, ProcessRegistry
from app.lifecycle.orchestrator import LifecycleError, LifecycleOrchestrator
from app.lifecycle.protocol import AvailabilityLevel, EventStream


def test_manifest_orders_dependencies_and_applies_overrides(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "engine": {"port": 1, "command": {"module": "engine"}, "profiles": ["backend"]},
        "adapter": {
            "port": 2,
            "command": {"module": "adapter"},
            "depends_on": ["engine"],
            "profiles": ["backend"],
        },
    }), encoding="utf-8")
    manifest = ServiceManifest.load(path, env={"ADAPTER_PORT": "42"})
    assert [service.name for service in manifest.for_profile("backend")] == ["engine", "adapter"]
    assert manifest.get("adapter").port == 42


def test_manifest_rejects_dependency_cycles(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "a": {"port": 1, "command": {"module": "a"}, "depends_on": ["b"]},
        "b": {"port": 2, "command": {"module": "b"}, "depends_on": ["a"]},
    }), encoding="utf-8")
    with pytest.raises(ManifestError, match="cycle"):
        ServiceManifest.load(path)


def test_registry_rejects_reused_pid_identity(tmp_path: Path):
    registry = ProcessRegistry(tmp_path / "processes.json")
    expected = ProcessIdentity(10, 100.0, "python", ("-m", "app.modules.llm.api"), 9102)
    registry.put("llm", expected)
    reused = ProcessIdentity(10, 200.0, "other.exe", ("unrelated",), 9102)
    assert not registry.matches("llm", reused)


def test_registry_serializes_concurrent_writers_without_losing_entries(tmp_path: Path):
    path = tmp_path / "processes.json"
    registries = [ProcessRegistry(path), ProcessRegistry(path)]

    def write(index: int):
        identity = ProcessIdentity(
            1000 + index,
            float(index),
            "python.exe",
            ("python", "-m", f"service{index}"),
            10000 + index,
        )
        registries[index % 2].put(f"service{index}", identity, f"owner{index}")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(write, range(40)))

    stored = dict(ProcessRegistry(path).items())
    assert set(stored) == {f"service{index}" for index in range(40)}


def test_status_prunes_registry_entry_after_the_process_has_exited(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "bridge": {
            "port": 9528,
            "command": {"module": "bridge"},
            "profiles": ["backend"],
        }
    }), encoding="utf-8")
    registry = ProcessRegistry(tmp_path / "pids.json")
    registry.put(
        "bridge",
        ProcessIdentity(99, 1.0, "python.exe", ("python", "-m", "bridge"), 9528),
    )

    class Platform:
        def port_owner(self, _port):
            return None

        def identity(self, _pid, _port):
            return None

    orchestrator = LifecycleOrchestrator(
        tmp_path,
        ServiceManifest.load(path),
        registry=registry,
        platform=Platform(),
    )

    orchestrator.status()

    assert registry.get("bridge") is None


def test_orchestrator_does_not_kill_unknown_port_owner(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "bridge": {"port": 9528, "command": {"module": "bridge"}, "profiles": ["backend"]}
    }), encoding="utf-8")

    class Platform:
        terminated = []
        def port_owner(self, _port): return 99
        def identity(self, pid, port):
            return ProcessIdentity(pid, 1.0, "external.exe", ("external",), port)
        def terminate_tree(self, identity):
            self.terminated.append(identity)
            return True

    platform = Platform()
    orchestrator = LifecycleOrchestrator(
        tmp_path, ServiceManifest.load(path),
        registry=ProcessRegistry(tmp_path / "pids.json"), platform=platform,
    )
    with pytest.raises(LifecycleError, match="external or unverified"):
        orchestrator.start("backend")
    assert platform.terminated == []


def test_manifest_exposes_dynamic_capabilities_and_service_python(tmp_path: Path):
    default_python = tmp_path / "runtime-python.exe"
    voice_python = tmp_path / "voice-python.exe"
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "_meta": {
            "capabilities": {
                "text": {
                    "display_name": "文本交流",
                    "minimum_level": "TEXT_READY",
                    "required_services": ["bridge"],
                },
                "voice": {
                    "display_name": "语音交流",
                    "minimum_level": "VOICE_READY",
                    "required_services": ["voice"],
                    "degraded_without": ["voice"],
                },
            }
        },
        "bridge": {
            "display_name": "角色连接",
            "category": "text",
            "port": 10001,
            "command": {"module": "bridge"},
            "profiles": ["backend"],
        },
        "voice": {
            "display_name": "语音合成",
            "category": "voice",
            "port": 10002,
            "command": {"module": "voice"},
            "profiles": ["backend"],
        },
    }), encoding="utf-8")
    manifest = ServiceManifest.load(
        path,
        runtime_config={
            "python": {
                "default": str(default_python),
                "services": {"voice": str(voice_python)},
            }
        },
    )

    assert manifest.get("bridge").display_name == "角色连接"
    assert manifest.get("bridge").argv(tmp_path)[0] == str(default_python)
    assert manifest.get("voice").argv(tmp_path)[0] == str(voice_python)
    assert manifest.capabilities["text"].display_name == "文本交流"


def test_orchestrator_expands_service_python_directory_in_environment(tmp_path: Path):
    voice_python = tmp_path / "voice-runtime" / "python.exe"
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "voice": {
            "port": 10002,
            "command": {"module": "voice"},
            "profiles": ["backend"],
            "env": {"PATH": "{python_dir};{PATH}"},
        },
    }), encoding="utf-8")

    class Process:
        pid = 100

        def poll(self):
            return None

    class Platform:
        spawned_env = None

        def port_owner(self, _port):
            return None

        def spawn(self, _argv, _cwd, env, _log):
            self.spawned_env = env
            return Process()

        def identity(self, pid, port):
            return ProcessIdentity(
                pid,
                1.0,
                str(voice_python),
                (str(voice_python), "-m", "voice"),
                port,
            )

    class Probe:
        def wait(self, _service, _process):
            return True

    platform = Platform()
    orchestrator = LifecycleOrchestrator(
        tmp_path,
        ServiceManifest.load(
            path,
            runtime_config={"python": {"services": {"voice": str(voice_python)}}},
        ),
        registry=ProcessRegistry(tmp_path / "pids.json"),
        platform=platform,
        probe=Probe(),
    )

    orchestrator.start("backend")

    assert platform.spawned_env is not None
    assert platform.spawned_env["PATH"].split(";", 1)[0] == str(voice_python.parent)


def test_availability_levels_allow_text_while_voice_is_warming(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "_meta": {
            "capabilities": {
                "text": {
                    "display_name": "文本交流",
                    "minimum_level": "TEXT_READY",
                    "required_services": ["bridge"],
                },
                "voice": {
                    "display_name": "语音交流",
                    "minimum_level": "VOICE_READY",
                    "required_services": ["voice"],
                },
            }
        },
        "bridge": {"port": 10001, "command": {"module": "bridge"}},
        "voice": {"port": 10002, "command": {"module": "voice"}},
    }), encoding="utf-8")
    manifest = ServiceManifest.load(path)

    assert manifest.availability({"bridge": "ready", "voice": "warming"}) == AvailabilityLevel.TEXT_READY
    assert manifest.availability({"bridge": "ready", "voice": "ready"}) == AvailabilityLevel.FULL_READY


def test_failed_required_service_never_counts_as_ready(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "_meta": {
            "capabilities": {
                "text": {
                    "minimum_level": "TEXT_READY",
                    "required_services": ["bridge"],
                },
                "voice": {
                    "minimum_level": "VOICE_READY",
                    "required_services": ["voice"],
                },
            }
        },
        "bridge": {"port": 10001, "command": {"module": "bridge"}},
        "voice": {"port": 10002, "command": {"module": "voice"}},
    }), encoding="utf-8")
    manifest = ServiceManifest.load(path)

    assert manifest.availability({"bridge": "failed", "voice": "ready"}) == AvailabilityLevel.VOICE_READY
    assert manifest.availability({"bridge": "ready", "voice": "failed"}) == AvailabilityLevel.TEXT_READY
    assert manifest.availability({"bridge": "failed", "voice": "failed"}) == AvailabilityLevel.BLOCKED


def test_event_stream_assigns_protocol_identity_and_monotonic_sequence():
    stream = EventStream("launch-1", "owner-1")
    first = stream.event("service_state", service_id="bridge", attempt=1)
    second = stream.event("availability", availability="TEXT_READY")

    assert first["schema_version"] == 1
    assert first["launch_id"] == "launch-1"
    assert first["owner_id"] == "owner-1"
    assert first["event_id"] != second["event_id"]
    assert [first["sequence"], second["sequence"]] == [1, 2]
    assert first["recoverable"] is True
    assert "recommended_action" in first


def test_orchestrator_status_rechecks_processes_after_a_child_exits(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "_meta": {
            "capabilities": {
                "text": {
                    "minimum_level": "TEXT_READY",
                    "required_services": ["bridge"],
                },
            },
        },
        "bridge": {
            "port": 9528,
            "health": "/health",
            "command": {"module": "bridge"},
            "profiles": ["backend"],
        },
    }), encoding="utf-8")
    identity = ProcessIdentity(99, 1.0, "python.exe", ("python", "-m", "bridge"), 9528)

    class Platform:
        owner = 99

        def port_owner(self, _port):
            return self.owner

        def identity(self, pid, _port):
            return identity if pid == identity.pid else None

    class Probe:
        def ready(self, _service):
            return True

    registry = ProcessRegistry(tmp_path / "pids.json")
    registry.put("bridge", identity)
    platform = Platform()
    orchestrator = LifecycleOrchestrator(
        tmp_path,
        ServiceManifest.load(path),
        registry=registry,
        platform=platform,
        probe=Probe(),
    )

    assert orchestrator.status()["availability"] == "TEXT_READY"
    platform.owner = None
    second = orchestrator.status()

    assert second["availability"] == "BLOCKED"
    assert second["services"][0]["status"] == "stopped"


def test_orchestrator_capability_is_failed_when_a_required_service_failed(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "_meta": {
            "capabilities": {
                "text": {
                    "minimum_level": "TEXT_READY",
                    "required_services": ["bridge"],
                },
            },
        },
        "bridge": {
            "port": 9528,
            "health": "/health",
            "command": {"module": "bridge"},
            "profiles": ["backend"],
        },
    }), encoding="utf-8")
    orchestrator = LifecycleOrchestrator(tmp_path, ServiceManifest.load(path))
    orchestrator._failed_services.add("bridge")

    status = orchestrator.status()

    assert status["availability"] == "BLOCKED"
    assert status["capabilities"] == [{
        "id": "text",
        "display_name": "text",
        "minimum_level": "TEXT_READY",
        "state": "failed",
    }]


def test_start_repairs_missing_voice_services_from_text_ready_state(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "_meta": {
            "capabilities": {
                "text": {
                    "minimum_level": "TEXT_READY",
                    "required_services": ["bridge"],
                },
                "voice": {
                    "minimum_level": "VOICE_READY",
                    "required_services": ["voice"],
                },
            },
        },
        "bridge": {
            "port": 9528,
            "health": "/health",
            "command": {"module": "bridge"},
            "profiles": ["backend"],
        },
        "voice": {
            "port": 9105,
            "health": "/health",
            "command": {"module": "voice"},
            "profiles": ["backend"],
        },
    }), encoding="utf-8")
    bridge_identity = ProcessIdentity(
        99, 1.0, "python.exe", ("python", "-m", "bridge"), 9528
    )

    class Process:
        pid = 100

        def poll(self):
            return None

    class Platform:
        def __init__(self):
            self.owners = {9528: 99}
            self.spawned_pids = set()
            self.spawn_count = 0

        def port_owner(self, port):
            return self.owners.get(port)

        def identity(self, pid, port):
            if pid == bridge_identity.pid and port == bridge_identity.port:
                return bridge_identity
            if pid in self.spawned_pids:
                self.owners[port] = pid
                return ProcessIdentity(
                    pid, 2.0, "python.exe", ("python", "-m", "voice"), port
                )
            return None

        def spawn(self, _argv, _cwd, _env, _log):
            self.spawn_count += 1
            process = Process()
            self.spawned_pids.add(process.pid)
            return process

    class Probe:
        def ready(self, _service):
            return True

        def wait(self, _service, _process):
            return True

    registry = ProcessRegistry(tmp_path / "pids.json")
    registry.put("bridge", bridge_identity)
    platform = Platform()
    orchestrator = LifecycleOrchestrator(
        tmp_path,
        ServiceManifest.load(path),
        registry=registry,
        platform=platform,
        probe=Probe(),
    )
    orchestrator.launch_id = "existing-launch"
    orchestrator.started = ["bridge"]

    result = orchestrator.start("backend")

    assert platform.spawn_count == 1
    assert result["availability"] == "FULL_READY"
    assert orchestrator.started == ["bridge", "voice"]


def test_start_does_not_continue_to_bridge_when_voice_dependency_fails(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "tts": {
            "port": 10001,
            "health": "/health",
            "readiness": True,
            "command": {"module": "tts"},
            "profiles": ["backend"],
            "failure_policy": "isolate",
        },
        "asr": {
            "port": 10002,
            "health": "/health",
            "readiness": True,
            "command": {"module": "asr"},
            "depends_on": ["tts"],
            "profiles": ["backend"],
            "failure_policy": "isolate",
        },
        "bridge": {
            "port": 10003,
            "command": {"module": "bridge"},
            "depends_on": ["asr"],
            "profiles": ["backend"],
        },
    }), encoding="utf-8")

    class Process:
        def __init__(self, pid):
            self.pid = pid

        def poll(self):
            return None

    class Platform:
        def __init__(self):
            self.spawned = []
            self.terminated = []

        def port_owner(self, _port):
            return None

        def identity(self, pid, port):
            return ProcessIdentity(pid, 1.0, "python.exe", ("python",), port)

        def spawn(self, argv, _cwd, _env, _log):
            process = Process(100 + len(self.spawned))
            self.spawned.append(argv)
            return process

        def terminate_tree(self, _identity):
            self.terminated.append(_identity.pid)
            return True

    class Probe:
        def wait(self, service, _process):
            return service.name != "tts"

        def ready(self, _service):
            return False

    platform = Platform()
    orchestrator = LifecycleOrchestrator(
        tmp_path,
        ServiceManifest.load(path),
        registry=ProcessRegistry(tmp_path / "pids.json"),
        platform=platform,
        probe=Probe(),
    )

    with pytest.raises(LifecycleError, match="dependency asr is not ready"):
        orchestrator.start("backend")

    assert [argv[-1] for argv in platform.spawned] == ["tts"]
    assert platform.terminated == [100]
    assert orchestrator.started == []
    assert orchestrator.registry.get("tts") is None


def test_start_fails_fast_when_windows_reserves_a_service_port(tmp_path: Path):
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "llm": {
            "host": "127.0.0.1",
            "port": 19102,
            "command": {"module": "llm"},
            "profiles": ["backend"],
        },
    }), encoding="utf-8")

    class Platform:
        def port_owner(self, _port):
            return None

        def bind_error(self, _host, _port):
            return PermissionError(10013, "port is excluded by Windows")

    orchestrator = LifecycleOrchestrator(
        tmp_path,
        ServiceManifest.load(path),
        registry=ProcessRegistry(tmp_path / "pids.json"),
        platform=Platform(),
    )

    with pytest.raises(LifecycleError, match="cannot bind 127.0.0.1:19102"):
        orchestrator.start("backend")
