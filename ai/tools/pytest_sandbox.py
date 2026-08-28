"""Sandbox-compatible pytest launcher.

Under the DSH/Codex file sandbox, any directory created with
``os.mkdir(path, 0o700)`` becomes unusable: later scandir/stat/mkdir/rmtree
on it fail with WinError 5. That mode is hardcoded by ``tempfile.mkdtemp``
(used by tests/conftest.py for the isolated runtime root) and by pytest's
tmp_path machinery (``_pytest/tmpdir.py``, ``_pytest/pathlib.py``), so every
test file fails at collection inside the sandbox.

Plain ``os.mkdir(path)`` (default mode) keeps directories fully usable, so
this launcher rewrites the mode before pytest starts. ``pathlib.Path.mkdir``,
``os.makedirs``, and ``tempfile.mkdtemp`` all delegate to ``os.mkdir``, so a
single patch covers all creators. In a normal Windows context the patch is a
no-op semantically; use this launcher only when pytest must run inside the
DSH/Codex sandbox.

Usage:
    python tools/pytest_sandbox.py <pytest args...>
"""

from __future__ import annotations

import os
import sys

_orig_mkdir = os.mkdir


def _sandbox_friendly_mkdir(path, mode=0o777, *, dir_fd=None):
    del mode  # 0o700-mode directories are unusable under the file sandbox
    if dir_fd is None:
        return _orig_mkdir(path)
    return _orig_mkdir(path, dir_fd=dir_fd)


os.mkdir = _sandbox_friendly_mkdir


def main(argv: list[str]) -> int:
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    import pytest

    return pytest.main(argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
