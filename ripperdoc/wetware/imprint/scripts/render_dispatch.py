#!/usr/bin/env python3
"""Render a JOBS ASCII-tree panel from status flags.

Draws the fixed subagent-dispatch panel as a box-drawing tree:
a `JOBS  <gauge>  <done>/<total>` root over one branch per job. This is the
no-tail mode — each branch is `<glyph> <label>` (plus ` — waits on X` for a
blocked job); there is no lane/tail split and no tail-stripe alignment.

Grammar (status flags, each takes one or more LABEL args):
  --done LABEL...      ■ done
  --running LABEL...   ▣ running   (comma-groupable into a parallel wave)
  --pending LABEL...   □ queued    (comma-groupable into a parallel wave)
  --failed LABEL...    ⊞ failed
  --blocked LABEL      ⊟ blocked; must be followed by `--waits-on X`, which
                       appends ` — waits on X` to that job's line.

A LABEL is a single label — the whole arg string is the job's text.

Parallel waves (only --running / --pending): a comma-grouped arg renders as a
bare `⎇` node with its members nested one rail-level beneath it.
  - tight comma separates members:        "a,b"      -> wave [a, b]
  - a trailing bare comma continues into
    the next arg:                          "a," "b"   -> wave [a, b]
  - a comma followed by a space is literal: "retry, then bail" -> one label
  - a singleton (no comma) stays a plain branch, NOT a parallel node.
For --done / --failed / --blocked, commas are always literal.

Order is left-to-right command-line order; flags may repeat and interleave.

Auto-computed (never input): total = leaf-job count (each wave member counts;
the parallel node does not), done = count of ■ jobs, gauge = "▰"*done +
"▱"*(total-done), one segment per leaf.

No jobs / no args is the IDLE state, not an error: it renders an empty panel
(`JOBS  ▱  0/0` over a single `└── idle` node) to STDOUT and exits 0.

Fails LOUD (nonzero exit + stderr) on: an unknown flag, `--waits-on` without a
preceding `--blocked`, or `--waits-on` with no value. Never emits a partial or
quietly-wrong panel.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field

GLYPH = {
    "done": "■",  # ■ U+25A0 black square
    "running": "▣",  # ▣ U+25A3 white square containing black small square
    "pending": "□",  # □ U+25A1 white square  queued
    "failed": "⊞",  # ⊞ U+229E squared plus
    "blocked": "⊟",  # ⊟ U+229F squared minus
}
FILLED = "▰"  # ▰
EMPTY = "▱"  # ▱
PARALLEL = "⎇"  # ⎇ U+2387 — parallel-wave node label

STATUS_FLAGS = {
    "--done": "done",
    "--running": "running",
    "--pending": "pending",
    "--failed": "failed",
    "--blocked": "blocked",
}
WAVE_FLAGS = {"--running", "--pending"}  # only these comma-group into waves

# Rail pieces (box-drawing tree rails).
TEE = "├── "  # ├──
ELBOW = "└── "  # └──
PIPE = "│   "  # │ + 3 spaces
GAP = "    "  # 4 spaces (under a finished parent)


class DispatchError(Exception):
    """Raised for any malformed invocation — surfaced as exit 2 + stderr."""


@dataclass
class Node:
    """One top-level entry: a single job, or a `parallel` wave of members.

    A wave node has status == "parallel"; `member_status` then carries the
    status key (running/pending) whose glyph every member draws, and `members`
    holds their labels. A plain job uses `status`/`label` and leaves the rest.
    """

    status: str  # status key ("done"/…), or "parallel" for a wave
    label: str = ""  # job text (unused for a parallel node)
    waits_on: str | None = None  # set only for blocked jobs
    member_status: str = ""  # member glyph status, parallel nodes only
    members: list[str] = field(default_factory=list)  # wave member labels


def split_waves(args: list[str]) -> list[list[str]]:
    """Group a wave flag's value args into waves (each a list of member labels).

    Each arg normally starts its OWN wave — the shell glues `"a","b"` into the
    single token `a,b`, so one such arg with an internal separating comma is one
    wave of [a, b]. The exception is a continuation: an arg ending on a bare
    trailing comma joins the next arg's members into the same wave (the slip
    `"a", "b"` → tokens `a,` then `b` → one wave [a, b]).

    A separator is a comma NOT immediately followed by a space; a comma+space is
    literal text (`"retry, then bail"` → one member).
    """
    waves: list[list[str]] = []
    carry = False  # previous arg ended on a separating comma → join forward
    for arg in args:
        pieces, ends_open = _scan_arg(arg)
        if carry and waves:
            # the bare trailing comma was a separator: these are further
            # members of the SAME wave, not text to glue onto a member.
            waves[-1].extend(pieces)
        else:
            waves.append(list(pieces))
        carry = ends_open
    # drop empty members, then drop any wave left with nothing
    cleaned = [[m for m in wave if m != ""] for wave in waves]
    return [wave for wave in cleaned if wave]


def _scan_arg(arg: str) -> tuple[list[str], bool]:
    """Split one arg on separating commas → (pieces, ends_on_separating_comma).

    A comma followed by a space (or end-of-arg, when it is a *trailing* comma)
    is the distinction: trailing bare comma = separator that continues forward;
    comma+space = literal. Returns the non-fused pieces plus whether the arg
    closed on a forward-continuing comma.
    """
    pieces: list[str] = []
    cur: list[str] = []
    ends_open = False
    i = 0
    n = len(arg)
    while i < n:
        ch = arg[i]
        if ch == "," and (i + 1 >= n or arg[i + 1] != " "):
            # separating comma: close the current piece
            pieces.append("".join(cur))
            cur = []
            if i + 1 >= n:
                ends_open = True  # bare trailing comma → continue forward
            i += 1
            continue
        cur.append(ch)
        i += 1
    if cur or not ends_open:
        pieces.append("".join(cur))
    return pieces, ends_open


def parse(argv: list[str]) -> list[Node]:
    """Walk argv left-to-right into an ordered list of Nodes.

    Preserves cross-flag command-line order (argparse would bucket per flag and
    lose it). Raises DispatchError on any malformed input.
    """
    nodes: list[Node] = []
    i = 0
    n = len(argv)
    while i < n:
        tok = argv[i]
        if tok == "--waits-on":
            raise DispatchError("--waits-on must follow a --blocked job")
        if tok not in STATUS_FLAGS:
            raise DispatchError(f"unknown flag: {tok}")
        status = STATUS_FLAGS[tok]
        # gather this flag's value args (everything up to the next flag)
        j = i + 1
        values: list[str] = []
        while j < n and not argv[j].startswith("--"):
            values.append(argv[j])
            j += 1
        if status == "blocked":
            if len(values) != 1:
                raise DispatchError("--blocked takes exactly one LABEL")
            label = values[0]
            # must be immediately followed by --waits-on VALUE
            if j >= n or argv[j] != "--waits-on":
                raise DispatchError("--blocked must be followed by --waits-on")
            if j + 1 >= n or argv[j + 1].startswith("--"):
                raise DispatchError("--waits-on requires a value")
            nodes.append(Node("blocked", label=label, waits_on=argv[j + 1]))
            i = j + 2
            continue
        if not values:
            raise DispatchError(f"{tok} requires at least one LABEL")
        if tok in WAVE_FLAGS:
            waves = split_waves(values)
            if not waves:
                raise DispatchError(f"{tok} requires at least one LABEL")
            for wave in waves:
                # a singleton wave is a plain branch; 2+ members → parallel node
                if len(wave) == 1:
                    nodes.append(Node(status, label=wave[0]))
                else:
                    nodes.append(Node("parallel", member_status=status, members=wave))
        else:
            # done / failed: commas are literal, one branch per value arg
            for v in values:
                nodes.append(Node(status, label=v))
        i = j
    return nodes


def render(nodes: list[Node]) -> str:
    """Render parsed nodes into the JOBS panel text (no trailing newline)."""
    if not nodes:
        # idle state: empty 0/0 gauge over a single `idle` node
        return f"JOBS  {EMPTY}  0/0\n{ELBOW}idle"

    total = 0
    done = 0
    for node in nodes:
        if node.status == "parallel":
            total += len(node.members)
            # parallel members are running/pending → never ■, so add 0 to done
        else:
            total += 1
            if node.status == "done":
                done += 1

    gauge = FILLED * done + EMPTY * (total - done)
    lines = [f"JOBS  {gauge}  {done}/{total}"]

    for idx, node in enumerate(nodes):
        last = idx == len(nodes) - 1
        branch = ELBOW if last else TEE
        if node.status == "parallel":
            lines.append(f"{branch}{PARALLEL}")
            member_glyph = GLYPH[node.member_status]
            cont = GAP if last else PIPE
            for midx, member in enumerate(node.members):
                mlast = midx == len(node.members) - 1
                mbranch = ELBOW if mlast else TEE
                lines.append(f"{cont}{mbranch}{member_glyph} {member}")
        else:
            glyph = GLYPH[node.status]
            line = f"{branch}{glyph} {node.label}"
            if node.waits_on is not None:
                line += f" — waits on {node.waits_on}"  # — waits on X
            lines.append(line)

    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if "-h" in argv or "--help" in argv:
        print((__doc__ or "").strip())
        return 0
    try:
        nodes = parse(argv)
        panel = render(nodes)
    except DispatchError as exc:
        print(f"render_dispatch: {exc}", file=sys.stderr)
        return 2
    print(panel)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
