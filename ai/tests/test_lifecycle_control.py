from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from multiprocessing.connection import Client
from pathlib import Path
from threading import Event, Lock, Thread
from time import sleep

from app.lifecycle.control import (
    ControlPlane,
    ControlServer,
    control_record_path,
    send_request,
    workspace_endpoint,
)


class FakeOrchestrator:
    def __init__(self):
        self.calls = []

    def start(self, profile, *, launch_id, owner_id):
        self.calls.append(("start", profile, launch_id, owner_id))
        return {"availability": "TEXT_READY", "services": []}

    def status(self):
        return {"availability": "BLOCKED", "services": []}

    def stop_launch(self, launch_id):
        self.calls.append(("stop", launch_id))
        return self.status()

    def stop_all_registered(self):
        self.calls.append(("stop_all_registered",))
        return self.status()


def test_control_plane_correlates_request_and_launch_identity():
    orchestrator = FakeOrchestrator()
    control = ControlPlane(orchestrator, token="secret")

    response = control.handle({
        "schema_version": 1,
        "token": "secret",
        "command": "start",
        "profile": "electron",
        "request_id": "request-1",
        "launch_id": "launch-1",
        "owner_id": "electron-1",
    })

    assert response["request_id"] == "request-1"
    assert response["launch_id"] == "launch-1"
    assert response["owner_id"] == "electron-1"
    assert response["ok"] is True
    assert orchestrator.calls == [("start", "electron", "launch-1", "electron-1")]


def test_control_plane_rejects_invalid_token_without_running_command():
    orchestrator = FakeOrchestrator()
    response = ControlPlane(orchestrator, token="secret").handle({
        "schema_version": 1,
        "token": "wrong",
        "command": "status",
        "request_id": "request-1",
    })

    assert response["ok"] is False
    assert response["recoverable"] is False
    assert orchestrator.calls == []


def test_workspace_endpoint_is_stable_and_does_not_expose_project_path(tmp_path: Path):
    first = workspace_endpoint(tmp_path)
    second = workspace_endpoint(tmp_path / ".")

    assert first == second
    assert str(tmp_path) not in first
    assert "soullink-lifecycle-" in first


def test_control_plane_serializes_mutating_commands():
    class ConcurrentOrchestrator(FakeOrchestrator):
        def __init__(self):
            super().__init__()
            self.active = 0
            self.maximum_active = 0
            self.lock = Lock()
            self.entered = Event()

        def start(self, profile, *, launch_id, owner_id):
            with self.lock:
                self.active += 1
                self.maximum_active = max(self.maximum_active, self.active)
            self.entered.set()
            sleep(0.05)
            with self.lock:
                self.active -= 1
            return {"availability": "FULL_READY", "services": []}

    orchestrator = ConcurrentOrchestrator()
    control = ControlPlane(orchestrator, token="secret")
    request = {
        "schema_version": 1,
        "token": "secret",
        "command": "start",
        "profile": "electron",
        "launch_id": "launch-1",
        "owner_id": "electron-1",
    }

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(control.handle, {**request, "request_id": "first"})
        orchestrator.entered.wait(timeout=1)
        second = pool.submit(control.handle, {**request, "request_id": "second"})
        assert first.result()["ok"] is True
        assert second.result()["ok"] is True

    assert orchestrator.maximum_active == 1


def test_control_server_ignores_client_disconnect_after_handling_request(tmp_path: Path):
    class Connection:
        def recv(self):
            return {
                "schema_version": 1,
                "token": "secret",
                "command": "status",
                "request_id": "request-1",
            }

        def send(self, _response):
            raise BrokenPipeError("client timed out")

        def close(self):
            pass

    server = ControlServer(tmp_path, FakeOrchestrator())
    server.token = "secret"
    server.control.token = "secret"

    server._handle_connection(Connection())


def test_control_server_stops_after_shutdown_client_disconnect(tmp_path: Path):
    class ShutdownOrchestrator(FakeOrchestrator):
        def stop_all_registered(self):
            self.calls.append(("stop_all_registered",))
            return self.status()

    class Connection:
        def recv(self):
            return {
                "schema_version": 1,
                "token": "secret",
                "command": "shutdown",
                "request_id": "shutdown-1",
            }

        def send(self, _response):
            raise BrokenPipeError("client timed out")

        def close(self):
            pass

    orchestrator = ShutdownOrchestrator()
    server = ControlServer(tmp_path, orchestrator)
    server.token = "secret"
    server.control.token = "secret"

    server._handle_connection(Connection())

    assert orchestrator.calls == [("stop_all_registered",)]
    assert server.running is False


def test_stalled_client_does_not_block_following_control_request(tmp_path: Path):
    """A half-open client must not monopolize the listener authentication path."""
    server = ControlServer(tmp_path, FakeOrchestrator())
    serve_thread = Thread(target=server.serve, daemon=True)
    serve_thread.start()
    record_path = control_record_path(tmp_path)
    for _ in range(100):
        if record_path.exists():
            break
        sleep(0.01)
    assert record_path.exists()

    # Connect without the multiprocessing authentication handshake and leave
    # the connection open. With authentication performed inside accept(), this
    # prevents the listener from accepting every later client.
    stalled = Client(server.endpoint, family="AF_PIPE" if __import__("sys").platform == "win32" else "AF_UNIX")
    completed = Event()
    result: dict = {}

    def request_status():
        try:
            result.update(send_request(tmp_path, {
                "schema_version": 1,
                "command": "status",
                "request_id": "status-after-stall",
            }))
        finally:
            completed.set()

    Thread(target=request_status, daemon=True).start()
    try:
        assert completed.wait(1), "a stalled client blocked the control listener"
        assert result["ok"] is True
    finally:
        stalled.close()


def test_control_server_survives_a_failed_accept(monkeypatch, tmp_path: Path):
    """One malformed/aborted pipe handshake must not kill the Supervisor."""
    handled = Event()

    class Connection:
        def recv(self):
            return {
                "schema_version": 1,
                "token": server.token,
                "command": "status",
                "request_id": "after-failed-accept",
            }

        def send(self, response):
            assert response["ok"] is True
            handled.set()
            server.running = False

        def close(self):
            pass

    class Listener:
        def __init__(self, *_args, **_kwargs):
            self.attempts = 0

        def accept(self):
            self.attempts += 1
            if self.attempts == 1:
                raise OSError("bad message length")
            return Connection()

        def close(self):
            pass

    monkeypatch.setattr("app.lifecycle.control.Listener", Listener)
    server = ControlServer(tmp_path, FakeOrchestrator())

    server.serve()

    assert handled.wait(1)
