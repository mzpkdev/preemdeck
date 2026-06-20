"""JetBrains IDE detection for the jetbrains-ide toolbox (Windows) — not implemented yet.

Stub module: mirrors the macOS surface (in_jetbrains, resolve_exec_path,
resolve_log_dir), but every entry point raises NotImplementedError for now.
"""

from pathlib import Path


def in_jetbrains() -> bool:
    """True when this terminal was launched by a JetBrains IDE — unimplemented on Windows."""
    raise NotImplementedError("in_jetbrains is not implemented for Windows yet")


def resolve_exec_path() -> str:
    """Absolute path to the JetBrains IDE binary this process is running inside — unimplemented on Windows."""
    raise NotImplementedError("resolve_exec_path is not implemented for Windows yet")


def resolve_log_dir() -> Path:
    """Log dir of the IDE this process is running inside — unimplemented on Windows."""
    raise NotImplementedError("resolve_log_dir is not implemented for Windows yet")
