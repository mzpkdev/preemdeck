#!/usr/bin/env python3
"""Golden-file tests for inject_hook.py — stdlib unittest, no third-party deps.

The script is exercised as a subprocess (the way hosts run it): feed a stdin
payload, pass CLI args, then assert on exit code and the parsed stdout JSON
envelope.

Path note: inject_hook resolves template/host args as `PLUGIN_ROOT / arg`, and
`pathlib` collapses `PLUGIN_ROOT / "/abs/path"` to `/abs/path`. So absolute
temp-file paths are honored verbatim, letting each test control template and
host-tools content while a couple of cases still hit the real repo files.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parent / "inject_hook.py"
PLUGIN_ROOT = SCRIPT_PATH.parent.parent


def run_hook(args: list[str], stdin: str) -> subprocess.CompletedProcess[str]:
    """Invoke inject_hook.py as a subprocess with the given argv tail + stdin."""
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *args],
        input=stdin,
        capture_output=True,
        text=True,
    )


class InjectHookTest(unittest.TestCase):
    def _write(self, content: str) -> str:
        """Write content to a temp file and return its absolute path."""
        fh = tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False, encoding="utf-8")
        self.addCleanup(lambda p=fh.name: Path(p).unlink(missing_ok=True))
        fh.write(content)
        fh.close()
        return fh.name

    # 1 — host-tools substitution
    def test_substitutes_host_tools(self) -> None:
        template = self._write("# T\n\n{{host_tools}}\n")
        host = self._write("HOST_TOOLS_MARKER")
        proc = run_hook([template, host], stdin="{}")
        self.assertEqual(proc.returncode, 0)
        env = json.loads(proc.stdout)
        ctx = env["hookSpecificOutput"]["additionalContext"]
        self.assertIn("HOST_TOOLS_MARKER", ctx)
        self.assertNotIn("{{host_tools}}", ctx)

    # 2 — Fix-2 regression guard: --event supplies the fallback
    def test_event_flag_is_fallback(self) -> None:
        template = self._write("body\n")
        proc = run_hook([template, "--event", "BeforeAgent"], stdin="{}")
        self.assertEqual(proc.returncode, 0)
        env = json.loads(proc.stdout)
        self.assertEqual(env["hookSpecificOutput"]["hookEventName"], "BeforeAgent")

    # 3 — stdin event wins over the flag
    def test_stdin_event_overrides_flag(self) -> None:
        template = self._write("body\n")
        proc = run_hook(
            [template, "--event", "BeforeAgent"],
            stdin=json.dumps({"hook_event_name": "UserPromptSubmit"}),
        )
        self.assertEqual(proc.returncode, 0)
        env = json.loads(proc.stdout)
        self.assertEqual(env["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")

    # 4 — no flag, no stdin event → hardcoded default
    def test_default_event_when_unspecified(self) -> None:
        template = self._write("body\n")
        proc = run_hook([template], stdin="{}")
        self.assertEqual(proc.returncode, 0)
        env = json.loads(proc.stdout)
        self.assertEqual(env["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")

    # 5 — missing template → exit 0, empty stdout (fail-silent)
    def test_missing_template_is_noop(self) -> None:
        proc = run_hook(["/nonexistent/template/____.md"], stdin="{}")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    # 6 — missing host-tools file → placeholder collapses to empty, still emits
    def test_missing_host_file_substitutes_empty(self) -> None:
        template = self._write("before {{host_tools}} after\n")
        proc = run_hook([template, "/nonexistent/host/____.md"], stdin="{}")
        self.assertEqual(proc.returncode, 0)
        env = json.loads(proc.stdout)
        ctx = env["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("{{host_tools}}", ctx)
        self.assertIn("before", ctx)
        self.assertIn("after", ctx)

    # 7 — whitespace-only template → exit 0, empty stdout
    def test_whitespace_template_is_noop(self) -> None:
        template = self._write("   \n\t\n")
        proc = run_hook([template], stdin="{}")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    # 8 — template without the placeholder → emitted unchanged
    def test_template_without_placeholder_unchanged(self) -> None:
        template = self._write("just some static body\n")
        proc = run_hook([template], stdin="{}")
        self.assertEqual(proc.returncode, 0)
        env = json.loads(proc.stdout)
        self.assertEqual(env["hookSpecificOutput"]["additionalContext"], "just some static body")

    # integration — real IMPRINT.md + real host file via the alias path
    def test_integration_real_files(self) -> None:
        proc = run_hook(
            ["IMPRINT.md", "hosts/host_gemini.md", "--event", "BeforeAgent"],
            stdin=json.dumps({"hook_event_name": "BeforeAgent"}),
        )
        self.assertEqual(proc.returncode, 0)
        env = json.loads(proc.stdout)
        out = env["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "BeforeAgent")
        self.assertNotIn("{{host_tools}}", out["additionalContext"])
        self.assertIn("IMPRINT", out["additionalContext"])

    # --file visuals --event SessionStart must parse with --event present
    def test_file_alias_with_event_flag(self) -> None:
        proc = run_hook(
            ["--file", "visuals", "--event", "SessionStart"],
            stdin="{}",
        )
        self.assertEqual(proc.returncode, 0)
        env = json.loads(proc.stdout)
        self.assertEqual(env["hookSpecificOutput"]["hookEventName"], "SessionStart")


if __name__ == "__main__":
    unittest.main()
