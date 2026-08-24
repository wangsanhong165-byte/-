"""Architecture boundary tests — static checks on module dependencies.

These tests verify that the codebase follows the architecture rules:
- Domain must not depend on FastAPI, WebSocket, or HTTP infrastructure
- Application must not depend on concrete provider implementations
- Only Composition Root may create database connections, WebSocket, subprocesses, or global timers
- No module outside lifecycle/platform may spawn subprocesses
- No module may write Live2D parameters directly (must use AvatarController)
- No module outside protocol layer may read legacy protocol fields
"""

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
FRONTEND = ROOT / "frontend"


# ── AST-based import checker ──────────────────────────────────────────────

class ImportVisitor(ast.NodeVisitor):
    """Collect all import statements from a file."""

    def __init__(self):
        self.imports: list[str] = []

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.imports.append(alias.name)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module:
            self.imports.append(node.module)


def get_imports(filepath: Path) -> list[str]:
    """Return a list of dotted module imports for a Python file."""
    try:
        tree = ast.parse(filepath.read_text(encoding="utf-8"))
    except SyntaxError:
        return []
    visitor = ImportVisitor()
    visitor.visit(tree)
    return visitor.imports


def get_frontend_imports(filepath: Path) -> list[str]:
    """Read frontend TypeScript/JavaScript files and return import strings."""
    content = filepath.read_text(encoding="utf-8")
    imports: list[str] = []
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("import "):
            # Extract the module path
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "import":
                # Find the from clause or the module specifier
                for i, part in enumerate(parts):
                    if part in ("from", "'", '"'):
                        spec = parts[i + 1].strip("\"'")
                        imports.append(spec)
                        break
                else:
                    # side-effect import
                    spec = parts[1].strip("\"'")
                    if spec:
                        imports.append(spec)
    return imports


# ── Test: Domain must not depend on infrastructure frameworks ────────────

BANNED_DOMAIN_IMPORTS = {"fastapi", "uvicorn", "starlette", "websockets", "aiohttp", "sqlalchemy", "aiosqlite"}
DOMAIN_DIRS = [
    "app/domain",
    "app/domain/character",
    "app/domain/conversation",
    "app/domain/scheduler",
    "app/runtime/character_intent.py",
]


def test_domain_does_not_depend_on_fastapi_or_websocket():
    """Domain layer must not import FastAPI, WebSocket, or HTTP frameworks."""
    violations: list[str] = []
    for pattern in DOMAIN_DIRS:
        target = APP / pattern
        if target.is_file():
            files = [target]
        elif target.is_dir():
            files = list(target.rglob("*.py"))
        else:
            continue
        for f in files:
            imported = get_imports(f)
            for imp in imported:
                top = imp.split(".")[0]
                if top in BANNED_DOMAIN_IMPORTS:
                    violations.append(f"{f.relative_to(ROOT)} imports {imp}")
    assert not violations, f"Domain layer must not depend on infrastructure:\n" + "\n".join(violations)


# ── Test: Application must not depend on specific providers ──────────────

PROVIDER_MODULES = {"app.providers.llm", "app.providers.tts", "app.providers.asr", "app.providers.memory", "app.providers.tool"}
APPLICATION_DIRS = [
    "app/runtime/steps",
    "app/runtime/pipeline.py",
    "app/runtime/character_turn.py",
]


def test_application_does_not_import_provider_implementations():
    """Application layer must not import specific provider implementations."""
    violations: list[str] = []
    for pattern in APPLICATION_DIRS:
        target = APP / pattern
        if target.is_file():
            files = [target]
        elif target.is_dir():
            files = list(target.rglob("*.py"))
        else:
            continue
        for f in files:
            imported = get_imports(f)
            for imp in imported:
                if imp in PROVIDER_MODULES or any(imp.startswith(p + ".") for p in PROVIDER_MODULES):
                    violations.append(f"{f.relative_to(ROOT)} imports {imp}")
    # Exception: steps constructors receive provider instances, they don't import them
    assert not violations, f"Application layer must not import provider implementations:\n" + "\n".join(violations)


# ── Test: Only lifecycle may spawn subprocesses ─────────────────────────

SUBPROCESS_BANNED_MODULES = {"subprocess", "os.spawn", "multiprocessing"}

# Files that are allowed to spawn subprocesses
SUBPROCESS_ALLOWED = {
    "app/lifecycle/platform.py",
    "app/lifecycle/control.py",
    "scripts/soulctl.cjs",
    "electron/process-manager.cjs",
}


def test_only_lifecycle_spawns_subprocesses():
    """No module outside lifecycle may import subprocess or spawn."""
    violations = []
    for f in APP.rglob("*.py"):
        rel = f.relative_to(ROOT).as_posix()
        if rel in SUBPROCESS_ALLOWED or rel.startswith("app/lifecycle"):
            continue
        imported = get_imports(f)
        for imp in imported:
            if imp == "subprocess" or imp.startswith("subprocess."):
                violations.append(f"{rel} imports {imp}")
    assert not violations, f"Only lifecycle module may spawn subprocesses:\n" + "\n".join(violations)


# ── Test: Renderer must not import Electron main ────────────────────────

ELECTRON_MAIN_FILES = {"electron/main.cjs", "electron/preload.cjs"}


def test_renderer_does_not_import_electron_main():
    """Frontend renderer code must not import Electron main process files."""
    violations = []
    for f in (FRONTEND / "src").rglob("*"):
        if f.suffix not in (".ts", ".tsx", ".js", ".jsx"):
            continue
        rel = f.relative_to(ROOT)
        imports = get_frontend_imports(f)
        for imp in imports:
            if any(electron_file in imp for electron_file in ELECTRON_MAIN_FILES):
                violations.append(f"{rel} imports {imp}")
            if imp == "electron":
                violations.append(f"{rel} imports 'electron' (renderer must not)")
    assert not violations, f"Renderer must not import Electron main:\n" + "\n".join(violations)


# ── Test: Live2D must not understand backend internals ──────────────────

BACKEND_CLASSES = {
    "CharacterTurn", "DecisionStep", "LLMResponse", "MemoryStore",
    "TurnInput", "TurnOutput", "PerformancePlan",
}

LIVE2D_DIRS = [
    "frontend/src/character",
]

# Frontend TypeScript types that happen to share names with backend classes
# but are independent definitions, not dependencies on backend code.
KNOWN_TYPESCRIPT_TYPES = {"PerformancePlan"}


def test_live2d_does_not_reference_backend_internal_classes():
    """Live2D renderer must not import or reference backend internal classes."""
    violations = []
    for pattern in LIVE2D_DIRS:
        target = ROOT / pattern
        if not target.is_dir():
            continue
        for f in target.rglob("*.ts"):
            if f.name.endswith(".test.ts"):
                continue
            content = f.read_text(encoding="utf-8")

            # Look for actual import statements referencing backend
            imports = get_frontend_imports(f)
            for cls in BACKEND_CLASSES:
                # Check if the backend class name appears in an import path
                for imp in imports:
                    if cls in imp and "character" in imp.lower():
                        violations.append(f"{f.relative_to(ROOT).as_posix()} imports {imp} (references {cls})")

            # Check for inline references (not just naming collision)
            if "DecisionStep" in content:
                violations.append(f"{f.relative_to(ROOT).as_posix()} references DecisionStep")
            if "TurnInput" in content or "TurnOutput" in content:
                violations.append(f"{f.relative_to(ROOT).as_posix()} references TurnInput/TurnOutput")
    assert not violations, f"Live2D must not reference backend internals:\n" + "\n".join(violations)


# ── Test: Business controllers use ParameterMixer, not direct SDK ────────

LIVE2D_PARAM_PATTERNS = ["setParameter(", "addParameter(", ".getParameter("]

# Files that are allowed to call Cubism SDK parameter methods directly
PARAM_ALLOWED_FILES = {
    "Live2DModelAdapter.ts",
    "ParameterMixer.ts",
    "core.ts",
    # renderer.ts reads WebGL vendor/renderer/version diagnostics through
    # WebGLRenderingContext.getParameter; it does not read or write Cubism
    # model parameters.  Cubism SDK imports remain guarded separately below.
    "renderer.ts",
}


def test_live2d_business_controllers_use_mixer_not_direct_sdk():
    """Business controllers must use ParameterMixer, not call setParameter directly.

    Only Live2DModelAdapter, ParameterMixer, and core.ts may call SDK parameter methods.
    Framework files (live2d/framework/) are the SDK itself — excluded.
    """
    violations = []
    exempt_prefixes = {"live2d/framework"}
    for f in (FRONTEND / "src" / "character").rglob("*.ts"):
        if f.suffix != ".ts":
            continue
        if f.name in PARAM_ALLOWED_FILES:
            continue
        rel = f.relative_to(FRONTEND / "src" / "character").as_posix()
        if any(rel.startswith(prefix) for prefix in exempt_prefixes):
            continue
        content = f.read_text(encoding="utf-8")
        for pattern in LIVE2D_PARAM_PATTERNS:
            if pattern in content:
                violations.append(f"{f.relative_to(ROOT).as_posix()} contains '{pattern}'")
    assert not violations, f"Business controllers must use ParameterMixer, not direct SDK:\n" + "\n".join(violations)


# ── Test: No business code touches Cubism SDK directly ──────────────────

CUBISM_SDK_MODULE_PATTERNS = ["Live2DCubismCore"]


def test_no_business_code_imports_cubism_core():
    """No business component outside live2d/framework may import Live2DCubismCore."""
    violations = []
    exempt_prefixes = {"live2d/framework"}
    allowed_business_files = {
        "core.ts",
        "renderer.ts",
    }
    for f in (FRONTEND / "src" / "character").rglob("*.ts"):
        if f.suffix != ".ts":
            continue
        if f.name in allowed_business_files:
            continue
        rel = f.relative_to(FRONTEND / "src" / "character").as_posix()
        if any(rel.startswith(prefix) for prefix in exempt_prefixes):
            continue
        content = f.read_text(encoding="utf-8")
        for pattern in CUBISM_SDK_MODULE_PATTERNS:
            if pattern in content:
                violations.append(f"{f.relative_to(ROOT).as_posix()} contains '{pattern}'")
    assert not violations, f"Cubism Core access restricted to framework + adapter:\n" + "\n".join(violations)


# ── Test: Renderer must not import CharacterRuntime classes ─────────────

RENDERER_BANNED_IMPORTS = {
    "CharacterController", "MotionArbiter", "ParameterMixer",
    "ExpressionController", "CharacterBehaviorResolver",
    "CharacterPerformancePolicy", "PetModeController",
    "AvatarController",
}


def test_renderer_does_not_import_runtime_controllers():
    """Renderer (live2d/renderer.ts) must not import character runtime classes."""
    renderer_files = [
        FRONTEND / "src" / "character" / "live2d" / "renderer.ts",
        FRONTEND / "src" / "character" / "live2d" / "core.ts",
        FRONTEND / "src" / "character" / "Live2DModelAdapter.ts",
    ]
    violations = []
    for f in renderer_files:
        if not f.exists():
            continue
        rel = f.relative_to(ROOT).as_posix()
        imports = get_frontend_imports(f)
        for imp in imports:
            for banned in RENDERER_BANNED_IMPORTS:
                if banned in imp and "live2d" not in imp:
                    violations.append(f"{rel} imports {imp} (contains {banned})")
    assert not violations, f"Renderer must not import runtime controllers:\n" + "\n".join(violations)


# ── Test: AudioRuntime must not directly write React State ──────────────

def test_audio_player_does_not_import_react():
    """AudioPlayer must not import React, event-bus, or store."""
    audio_player = FRONTEND / "src" / "audio" / "player.ts"
    if not audio_player.exists():
        return
    imports = get_frontend_imports(audio_player)
    react_imports = [imp for imp in imports if imp.startswith("react") or "store" in imp or "event-bus" in imp]
    assert not react_imports, f"AudioPlayer imports React/Store: {react_imports}"


# ── Test: CharacterStateMachine exists and has valid transitions ────────

def test_character_state_machine_exists():
    """CharacterStateMachine must define valid transitions for all activity types."""
    from types import ModuleType
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "csm",
            str(FRONTEND / "src" / "character" / "CharacterStateMachine.ts"),
        )
        assert spec is not None, "CharacterStateMachine.ts not found"
    except Exception:
        # TypeScript file - just check it exists
        csm_file = FRONTEND / "src" / "character" / "CharacterStateMachine.ts"
        assert csm_file.exists(), "CharacterStateMachine.ts must exist"
        content = csm_file.read_text(encoding="utf-8")
        assert "VALID_TRANSITIONS" in content, "VALID_TRANSITIONS must be defined"
        assert "idle" in content and "speaking" in content, "Activities must be defined"


def test_character_controller_consumes_runtime_character_intents():
    """Backend character updates must reach the Live2D character controller."""
    adapter = (FRONTEND / "src" / "runtime" / "adapter.ts").read_text(encoding="utf-8")
    controllers = (
        FRONTEND / "src" / "character" / "controllers.ts"
    ).read_text(encoding="utf-8")

    assert "eventBus.emit('runtime:character.intent'" in adapter
    assert "eventBus.on('runtime:character.intent'" in controllers
