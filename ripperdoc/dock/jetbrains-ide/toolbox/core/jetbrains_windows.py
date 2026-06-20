"""JetBrains IDE detection for the jetbrains-ide toolbox (Windows) - not implemented yet."""

from pathlib import Path


def in_jetbrains() -> bool:
    raise NotImplementedError("in_jetbrains is not implemented for Windows yet")


def resolve_exec_path() -> str:
    raise NotImplementedError("resolve_exec_path is not implemented for Windows yet")


def resolve_log_dir() -> Path:
    raise NotImplementedError("resolve_log_dir is not implemented for Windows yet")
