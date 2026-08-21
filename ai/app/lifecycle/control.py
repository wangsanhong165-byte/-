from __future__ import annotations

import hashlib
import json
import os
import psutil
import secrets
import sys
from multiprocessing.connection import Client, Listener
from pathlib import Path
from threading import Lock, Thread
from uuid import uuid4

from .protocol import SCHEMA_VERSION
from .diagnostics import export_diagnostics


def workspace_id(root: Path) -> str:
    normalized = os.path.normcase(str(root.resolve()))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def workspace_endpoint(root: Path) -> str:
    name = f"soullink-lifecycle-{workspace_id(root)}"
    if sys.platform == "win32":
        return rf"\\.\pipe\{name}"
    return str(Path("/tmp") / f"{name}.sock")


def control_record_path(root: Path) -> Path:
    return root / "data" / "runtime" / "lifecycle-control.json"


class ControlPlane:
    def __init__(self, orchestrator, *, token: str):
        self.orchestrator = orchestrator
        self.token = token
        self._mutation_lock = Lock()

    def handle(self, request: dict) -> dict:
        request_id = str(request.get("request_id") or uuid4().hex)
        launch_id = str(request.get("launch_id") or "")
        owner_id = str(request.get("owner_id") or "")
        base = {
            "schema_version": SCHEMA_VERSION,
            "request_id": request_id,
            "launch_id": launch_id,
            "owner_id": owner_id,
        }
        if request.get("token") != self.token:
            return {
                **base, "ok": False, "error": "unauthorized",
                "recoverable": False,
                "recommended_action": "run doctor to refresh the local control endpoint",
            }
        try:
            command = request.get("command")
            if command in {"start", "restart", "stop", "shutdown"}:
                with self._mutation_lock:
                    if command == "start":
                        result = self.orchestrator.start(
                            request.get("profile", "backend"),
                            launch_id=launch_id or uuid4().hex,
                            owner_id=owner_id or uuid4().hex,
                        )
                    elif command == "restart":
                        if self.orchestrator.launch_id:
                            self.orchestrator.stop_launch(self.orchestrator.launch_id)
                        result = self.orchestrator.start(
                            request.get("profile", "backend"),
                            launch_id=launch_id or uuid4().hex,
                            owner_id=owner_id or uuid4().hex,
                        )
                    elif command == "stop":
                        result = (
                            self.orchestrator.stop_all_registered()
                            if request.get("all")
                            else self.orchestrator.stop_launch(
                                launch_id or self.orchestrator.launch_id or ""
                            )
                        )
                    else:
                        result = self.orchestrator.stop_all_registered()
            elif command == "status":
                result = self.orchestrator.status()
            elif command == "events":
                after = int(request.get("after_sequence", 0))
                snapshot = self.orchestrator.status()
                result = {
                    "launch_id": snapshot.get("launch_id"),
                    "events": [
                        event for event in snapshot.get("events", [])
                        if int(event.get("sequence", 0)) > after
                    ],
                }
            elif command == "diagnostics":
                result = {
                    "path": str(export_diagnostics(
                        self.orchestrator.root,
                        self.orchestrator.status(),
                    ))
                }
            else:
                raise ValueError(f"unknown command: {command}")
            return {**base, "ok": True, "result": result}
        except Exception as error:
            return {
                **base, "ok": False, "error": str(error),
                "recoverable": True,
                "recommended_action": "inspect launch logs and retry",
            }


class ControlServer:
    def __init__(self, root: Path, orchestrator):
        self.root = root
        self.endpoint = workspace_endpoint(root)
        self.token = secrets.token_hex(32)
        self.control = ControlPlane(orchestrator, token=self.token)
        self.listener = None
        self.running = True

    def serve(self) -> None:
        record = control_record_path(self.root)
        record.parent.mkdir(parents=True, exist_ok=True)
        if sys.platform != "win32":
            Path(self.endpoint).unlink(missing_ok=True)
        self.listener = Listener(
            self.endpoint,
            family="AF_PIPE" if sys.platform == "win32" else "AF_UNIX",
            # Do not perform multiprocessing's challenge handshake inside
            # Listener.accept(). A client that connects and then times out can
            # otherwise monopolize the only accept loop forever. Authorization
            # is still enforced by ControlPlane using the per-run token below.
            authkey=None,
        )
        temporary = record.with_suffix(".tmp")
        try:
            create_time = psutil.Process(os.getpid()).create_time()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            create_time = None
        temporary.write_text(json.dumps({
            "schema_version": SCHEMA_VERSION,
            "endpoint": self.endpoint,
            "family": "AF_PIPE" if sys.platform == "win32" else "AF_UNIX",
            "token": self.token,
            "pid": os.getpid(),
            # Persist a positive identity so recovery can distinguish a reused
            # PID from a genuine orphan Supervisor without relying on cmdline.
            "create_time": create_time,
            "executable": sys.executable,
        }), encoding="utf-8")
        temporary.replace(record)
        try:
            while self.running:
                try:
                    connection = self.listener.accept()
                except OSError:
                    # A malformed or abandoned named-pipe handshake belongs to
                    # that client only. Keep the Supervisor available for the
                    # next valid lifecycle request instead of tearing down the
                    # whole control plane.
                    if not self.running:
                        break
                    continue
                Thread(target=self._handle_connection, args=(connection,), daemon=True).start()
        finally:
            self.listener.close()
            record.unlink(missing_ok=True)
            if sys.platform != "win32":
                Path(self.endpoint).unlink(missing_ok=True)

    def _handle_connection(self, connection) -> None:
        try:
            try:
                request = connection.recv()
            except (EOFError, OSError):
                # A client may be killed by its bounded caller between connect
                # and send. Keep that abandoned connection isolated to this
                # daemon thread; the listener must remain available.
                return
            response = self.control.handle(request)
            shutdown_requested = request.get("command") == "shutdown" and response.get("ok")
            if shutdown_requested:
                # Mark the server for exit before replying. A bounded client
                # may disconnect while shutdown is stopping child services;
                # that must not leave the Supervisor alive indefinitely.
                self.running = False
            try:
                connection.send(response)
            except (BrokenPipeError, EOFError, OSError):
                # A bounded client request may time out after the Supervisor
                # has already completed the work. The connection is no longer
                # useful, but this must not produce a noisy daemon-thread
                # traceback or destabilize the control server.
                pass
            if shutdown_requested:
                try:
                    wake = Client(
                        self.endpoint,
                        family="AF_PIPE" if sys.platform == "win32" else "AF_UNIX",
                        authkey=None,
                    )
                    wake.send({
                        "schema_version": SCHEMA_VERSION,
                        "token": self.token,
                        "command": "status",
                        "request_id": "shutdown-wakeup",
                    })
                except (BrokenPipeError, EOFError, OSError):
                    pass
                finally:
                    if "wake" in locals():
                        wake.close()
        finally:
            connection.close()


class ControlUnavailable(RuntimeError):
    """The lifecycle control record is missing, unreadable, or not yet written."""


def send_request(root: Path, request: dict) -> dict:
    try:
        record = json.loads(control_record_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        # A Supervisor writes its control record only after binding the pipe,
        # so a bounded client racing cold start may observe it as absent. Surface
        # that as a clean, retryable state instead of a raw traceback.
        raise ControlUnavailable(f"control record not ready: {exc}") from exc
    request = {**request, "token": record["token"]}
    connection = Client(
        record["endpoint"],
        family=record["family"],
        authkey=None,
    )
    try:
        connection.send(request)
        return connection.recv()
    finally:
        connection.close()
