"""JetBrains IDE detection for the jetbrains-ide toolbox (Linux) - not implemented yet.

Stub module: mirrors the macOS surface (in_jetbrains, resolve_exec_path,
resolve_log_dir), but every entry point raises NotImplementedError for now.
"""

from pathlib import Path


def in_jetbrains() -> bool:
    """True when our terminal was launched by a JetBrains IDE - unimplemented on Linux."""
    raise NotImplementedError("in_jetbrains is not implemented for Linux yet")


def resolve_exec_path() -> str:
    """Absolute path to the JetBrains IDE binary we're running inside - unimplemented on Linux."""
    raise NotImplementedError("resolve_exec_path is not implemented for Linux yet")


def resolve_log_dir() -> Path:
    """Log dir of the IDE we're running inside - unimplemented on Linux."""
    raise NotImplementedError("resolve_log_dir is not implemented for Linux yet")
