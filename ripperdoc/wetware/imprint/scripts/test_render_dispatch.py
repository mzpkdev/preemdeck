#!/usr/bin/env python3
"""Golden-file tests for render_dispatch.py — stdlib unittest, no third-party.

The script is exercised as a subprocess (the way it's invoked): pass CLI args,
then assert on exit code and the exact stdout panel. Panels are compared as
verbatim strings so any rail/glyph/gauge drift is caught — the whole point of a
golden test for a fixed-shape renderer.
"""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parent / "render_dispatch.py"


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    """Invoke render_dispatch.py as a subprocess with the given argv tail."""
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *args],
        capture_output=True,
        text=True,
    )


class RenderDispatchTest(unittest.TestCase):
    def assert_panel(self, args: list[str], expected: str) -> None:
        """Run args, assert exit 0 and that stdout equals expected verbatim."""
        proc = run(args)
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        self.assertEqual(proc.stdout, expected + "\n")

    # 1 — the golden anchor: must match the spec byte-for-byte
    def test_golden_anchor(self) -> None:
        expected = (
            "JOBS  ▰▱▱▱▱▱  1/6\n"
            "├── ■ Task 1 - Scout\n"
            "├── ⎇\n"
            "│   ├── ▣ Task 2\n"
            "│   └── ▣ Task 3\n"
            "├── ⎇\n"
            "│   ├── ▣ Task 4\n"
            "│   └── ▣ Task 5\n"
            "└── □ Task 7 - Lint"
        )
        self.assert_panel(
            [
                "--done",
                "Task 1 - Scout",
                "--running",
                "Task 2,Task 3",
                "Task 4,Task 5",
                "--pending",
                "Task 7 - Lint",
            ],
            expected,
        )

    # 2 — a lone atomic job collapses to a one-branch tree (└──), shape kept
    def test_lone_job_one_branch(self) -> None:
        expected = "JOBS  ▱  0/1\n└── ▣ solo"
        self.assert_panel(["--running", "solo"], expected)

    # 3 — sequential mix of every plain status, command-line order preserved
    def test_sequential_mix(self) -> None:
        expected = "JOBS  ▰▱▱▱  1/4\n├── ■ a\n├── ▣ b\n├── □ c\n└── ⊞ d"
        self.assert_panel(
            ["--done", "a", "--running", "b", "--pending", "c", "--failed", "d"],
            expected,
        )

    # 4 — interleaved repeated flags keep left-to-right order (A B C, not A C B)
    def test_interleaved_order_preserved(self) -> None:
        expected = "JOBS  ▰▰▱  2/3\n├── ■ A\n├── ▣ B\n└── ■ C"
        self.assert_panel(["--done", "A", "--running", "B", "--done", "C"], expected)

    # 5 — a single running wave nests its members under a bare `⎇` node
    def test_single_running_wave(self) -> None:
        expected = "JOBS  ▱▱▱  0/3\n└── ⎇\n    ├── ▣ p\n    ├── ▣ q\n    └── ▣ r"
        self.assert_panel(["--running", "p,q,r"], expected)

    # 6 — a pending wave uses the queued glyph □
    def test_pending_wave(self) -> None:
        expected = "JOBS  ▱▱  0/2\n└── ⎇\n    ├── □ lint\n    └── □ types"
        self.assert_panel(["--pending", "lint,types"], expected)

    # 7 — multiple waves plus a trailing singleton, each wave its own node
    def test_multiple_waves_then_singleton(self) -> None:
        expected = "JOBS  ▱▱▱▱▱  0/5\n├── ⎇\n│   ├── ▣ a\n│   └── ▣ b\n├── ⎇\n│   ├── ▣ c\n│   └── ▣ d\n└── ▣ tail"
        self.assert_panel(["--running", "a,b", "c,d", "tail"], expected)

    # 8 — a wave that is NOT the last sibling continues on │, not a blank gap
    def test_wave_not_last_uses_pipe(self) -> None:
        expected = "JOBS  ▰▱▱  1/3\n├── ⎇\n│   ├── ▣ x\n│   └── ▣ y\n└── ■ z"
        self.assert_panel(["--running", "x,y", "--done", "z"], expected)

    # 9 — blocked job draws ⊟ and appends ` — waits on X`
    def test_blocked_waits_on(self) -> None:
        expected = "JOBS  ▰▱  1/2\n├── ■ scout\n└── ⊟ verify — waits on parallel"
        self.assert_panel(
            ["--done", "scout", "--blocked", "verify", "--waits-on", "parallel"],
            expected,
        )

    # 10 — comma robustness: a tight comma separates → parallel wave
    def test_comma_tight_makes_wave(self) -> None:
        expected = "JOBS  ▱▱  0/2\n└── ⎇\n    ├── ▣ a\n    └── ▣ b"
        self.assert_panel(["--running", "a,b"], expected)

    # 11 — comma robustness: the shell slip `"a", "b"` (tokens a, then b) → one wave
    def test_comma_split_slip_makes_wave(self) -> None:
        expected = "JOBS  ▱▱  0/2\n└── ⎇\n    ├── ▣ a\n    └── ▣ b"
        # the shell hands the program the two tokens "a," and "b"
        self.assert_panel(["--running", "a,", "b"], expected)

    # 12 — comma robustness: a comma followed by a space is literal → one label
    def test_comma_space_is_literal(self) -> None:
        expected = "JOBS  ▱  0/1\n└── ▣ retry, then bail"
        self.assert_panel(["--running", "retry, then bail"], expected)

    # 13 — gauge and counts: each wave member counts, parallel node does not
    def test_gauge_and_counts(self) -> None:
        # 2 done singletons + a 3-member wave = 5 leaves, 2 done
        expected = "JOBS  ▰▰▱▱▱  2/5\n├── ■ one\n├── ■ two\n└── ⎇\n    ├── ▣ a\n    ├── ▣ b\n    └── ▣ c"
        self.assert_panel(["--done", "one", "two", "--running", "a,b,c"], expected)

    # 14 — done/failed never form waves: commas there are literal
    def test_done_comma_is_literal(self) -> None:
        expected = "JOBS  ▰  1/1\n└── ■ a,b"
        self.assert_panel(["--done", "a,b"], expected)

    # --- error cases: fail LOUD (nonzero exit, message on stderr) ---

    def assert_error(self, args: list[str]) -> None:
        proc = run(args)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        self.assertNotEqual(proc.stderr.strip(), "")

    # 15 — no jobs at all → idle: empty 0/0 panel on stdout, exit 0 (not an error)
    def test_empty_idle_panel(self) -> None:
        expected = "JOBS  ▱  0/0\n└── idle"
        self.assert_panel([], expected)

    # 16 — an unknown flag → nonzero exit
    def test_error_unknown_flag(self) -> None:
        self.assert_error(["--bogus", "x"])

    # 17 — --waits-on with no preceding --blocked → nonzero exit
    def test_error_dangling_waits_on(self) -> None:
        self.assert_error(["--waits-on", "x"])

    # 18 — --blocked with no following --waits-on → nonzero exit
    def test_error_blocked_without_waits_on(self) -> None:
        self.assert_error(["--blocked", "verify"])

    # 19 — --waits-on with no value → nonzero exit
    def test_error_waits_on_no_value(self) -> None:
        self.assert_error(["--blocked", "verify", "--waits-on"])

    # 20 — a status flag with no LABEL → nonzero exit
    def test_error_flag_without_label(self) -> None:
        self.assert_error(["--running"])


if __name__ == "__main__":
    unittest.main()
