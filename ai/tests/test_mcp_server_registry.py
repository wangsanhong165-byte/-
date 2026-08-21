import json
from pathlib import Path

from app.modules.mcp import server_registry as server_registry_module
from app.modules.mcp.server_registry import ServerRegistry


def test_uvx_server_uses_workspace_writable_runtime_directories(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        server_registry_module.shutil,
        "which",
        lambda name: f"{name}.exe",
    )
    config_path = tmp_path / "config" / "mcp_servers.json"
    config_path.parent.mkdir()
    config_path.write_text(
        json.dumps(
            {
                "mcp_servers": {
                    "search": {
                        "command": "uvx",
                        "args": ["example-mcp"],
                        "env": {"EXAMPLE_FLAG": "1"},
                    },
                    "python-server": {
                        "command": "python",
                        "args": ["-m", "example_mcp"],
                    },
                }
            }
        ),
        encoding="utf-8",
    )

    registry = ServerRegistry(config_path)

    search = registry.get_server("search")
    assert search is not None
    assert Path(search.env["UV_CACHE_DIR"]) == tmp_path / ".uv_cache"
    assert Path(search.env["UV_TOOL_DIR"]) == tmp_path / ".uv_tools"
    assert Path(search.env["UV_PYTHON_INSTALL_DIR"]) == tmp_path / ".uv_tools" / "python"
    assert search.env["EXAMPLE_FLAG"] == "1"

    python_server = registry.get_server("python-server")
    assert python_server is not None
    assert Path(python_server.command).name.lower() == "python.exe"
    assert python_server.env is None


def test_uvx_server_reuses_available_python_runtime(tmp_path: Path, monkeypatch):
    config_path = tmp_path / "config" / "mcp_servers.json"
    config_path.parent.mkdir()
    config_path.write_text(
        json.dumps(
            {"mcp_servers": {"search": {"command": "uvx", "args": ["example-mcp"]}}}
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        server_registry_module.shutil,
        "which",
        lambda name: "D:/conda/python.exe" if name == "python" else f"{name}.exe",
    )

    search = ServerRegistry(config_path).get_server("search")

    assert search is not None
    assert search.env["UV_PYTHON"] == "D:/conda/python.exe"


def test_registry_skips_windows_store_python_alias(tmp_path: Path, monkeypatch):
    config_path = tmp_path / "config" / "mcp_servers.json"
    config_path.parent.mkdir()
    config_path.write_text(
        json.dumps(
            {
                "mcp_servers": {
                    "time": {"command": "python", "args": ["-m", "mcp_server_time"]},
                    "search": {"command": "uvx", "args": ["example-mcp"]},
                }
            }
        ),
        encoding="utf-8",
    )

    conda_root = tmp_path / "conda"
    env_python = conda_root / "envs" / "qwen3-asr" / "python.exe"
    base_python = conda_root / "python.exe"
    env_python.parent.mkdir(parents=True)
    base_python.write_text("", encoding="ascii")
    env_python.write_text("", encoding="ascii")
    windows_store_python = tmp_path / "WindowsApps" / "python.exe"

    monkeypatch.delenv("SOULLINK_MCP_PYTHON", raising=False)
    monkeypatch.delenv("MCP_PYTHON", raising=False)
    monkeypatch.setattr(
        server_registry_module.shutil,
        "which",
        lambda name: str(windows_store_python) if name == "python" else f"{name}.exe",
    )
    monkeypatch.setattr(server_registry_module.sys, "executable", str(env_python))

    registry = ServerRegistry(config_path)

    time_server = registry.get_server("time")
    search_server = registry.get_server("search")
    assert time_server is not None
    assert search_server is not None
    assert Path(time_server.command) == base_python
    assert search_server.env["UV_PYTHON"] == str(base_python)


def test_production_search_server_uses_the_managed_python_environment():
    config_path = Path(__file__).resolve().parents[1] / "config" / "mcp_servers.json"
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    search = raw["mcp_servers"]["ddg-search"]

    assert search["command"] == "python"
    assert search["args"] == ["-m", "duckduckgo_mcp_server.server"]
    assert search["env"]["DDG_SEARCH_BACKEND"] == "auto"
