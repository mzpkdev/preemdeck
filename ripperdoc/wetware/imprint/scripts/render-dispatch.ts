#!/usr/bin/env -S preemdeck-bun
/**
 * render-dispatch.ts — JOBS ASCII-tree panel from status flags (port of
 * render_dispatch.py). Byte-exact with the Python: same glyphs, rails, gauge,
 * alignment, error messages, and exit codes. CLI only; not hook-wired.
 *
 * The wave parser (splitWaves/scanArg) and the box-drawing renderer are bespoke
 * and ported line-for-line. See render_dispatch.py for the grammar.
 */

const DOC = `Render a JOBS ASCII-tree panel from status flags.

Draws the fixed subagent-dispatch panel as a box-drawing tree:
a \`JOBS  <gauge>  <done>/<total>\` root over one branch per job. This is the
no-tail mode — each branch is \`<glyph> <label>\` (plus \` — waits on X\` for a
blocked job); there is no lane/tail split and no tail-stripe alignment.

Grammar (status flags, each takes one or more LABEL args):
  --done LABEL...      ■ done
  --running LABEL...   ▣ running   (comma-groupable into a parallel wave)
  --pending LABEL...   □ queued    (comma-groupable into a parallel wave)
  --failed LABEL...    ⊞ failed
  --blocked LABEL      ⊟ blocked; must be followed by \`--waits-on X\`, which
                       appends \` — waits on X\` to that job's line.

A LABEL is a single label — the whole arg string is the job's text.

Parallel waves (only --running / --pending): a comma-grouped arg renders as a
bare \`⎇\` node with its members nested one rail-level beneath it.
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
(\`JOBS  ▱  0/0\` over a single \`└── idle\` node) to STDOUT and exits 0.

Fails LOUD (nonzero exit + stderr) on: an unknown flag, \`--waits-on\` without a
preceding \`--blocked\`, or \`--waits-on\` with no value. Never emits a partial or
quietly-wrong panel.`;

const GLYPH: Record<string, string> = {
  done: "■", // ■ U+25A0 black square
  running: "▣", // ▣ U+25A3 white square containing black small square
  pending: "□", // □ U+25A1 white square  queued
  failed: "⊞", // ⊞ U+229E squared plus
  blocked: "⊟", // ⊟ U+229F squared minus
};
const FILLED = "▰"; // ▰
const EMPTY = "▱"; // ▱
const PARALLEL = "⎇"; // ⎇ U+2387 — parallel-wave node label

const STATUS_FLAGS: Record<string, string> = {
  "--done": "done",
  "--running": "running",
  "--pending": "pending",
  "--failed": "failed",
  "--blocked": "blocked",
};
const WAVE_FLAGS = new Set(["--running", "--pending"]); // only these comma-group into waves

// Rail pieces (box-drawing tree rails).
const TEE = "├── "; // ├──
const ELBOW = "└── "; // └──
const PIPE = "│   "; // │ + 3 spaces
const GAP = "    "; // 4 spaces (under a finished parent)

/** Raised for any malformed invocation — surfaced as exit 2 + stderr. */
export class DispatchError extends Error {}

/** One top-level entry: a single job, or a `parallel` wave of members. */
export type Node = {
  status: string; // status key ("done"/…), or "parallel" for a wave
  label: string; // job text (unused for a parallel node)
  waitsOn: string | null; // set only for blocked jobs
  memberStatus: string; // member glyph status, parallel nodes only
  members: string[]; // wave member labels
};

const makeNode = (partial: Partial<Node> & { status: string }): Node => {
  return {
    status: partial.status,
    label: partial.label ?? "",
    waitsOn: partial.waitsOn ?? null,
    memberStatus: partial.memberStatus ?? "",
    members: partial.members ?? [],
  };
};

/**
 * Split one arg on separating commas -> [pieces, ends_on_separating_comma].
 * A comma followed by a space (or end-of-arg, when trailing) is the distinction:
 * trailing bare comma = separator that continues forward; comma+space = literal.
 */
export const scanArg = (arg: string): [string[], boolean] => {
  const pieces: string[] = [];
  let cur: string[] = [];
  let endsOpen = false;
  let i = 0;
  const n = arg.length;
  while (i < n) {
    const ch = arg[i];
    if (ch === "," && (i + 1 >= n || arg[i + 1] !== " ")) {
      // separating comma: close the current piece
      pieces.push(cur.join(""));
      cur = [];
      if (i + 1 >= n) {
        endsOpen = true; // bare trailing comma -> continue forward
      }
      i += 1;
      continue;
    }
    cur.push(ch as string);
    i += 1;
  }
  if (cur.length > 0 || !endsOpen) {
    pieces.push(cur.join(""));
  }
  return [pieces, endsOpen];
};

/** Group a wave flag's value args into waves (each a list of member labels). */
export const splitWaves = (args: string[]): string[][] => {
  const waves: string[][] = [];
  let carry = false; // previous arg ended on a separating comma -> join forward
  for (const arg of args) {
    const [pieces, endsOpen] = scanArg(arg);
    if (carry && waves.length > 0) {
      // the bare trailing comma was a separator: further members of the SAME wave.
      (waves[waves.length - 1] as string[]).push(...pieces);
    } else {
      waves.push([...pieces]);
    }
    carry = endsOpen;
  }
  // drop empty members, then drop any wave left with nothing
  const cleaned = waves.map((wave) => wave.filter((m) => m !== ""));
  return cleaned.filter((wave) => wave.length > 0);
};

/** Walk argv left-to-right into an ordered list of Nodes. */
export const parse = (argv: string[]): Node[] => {
  const nodes: Node[] = [];
  let i = 0;
  const n = argv.length;
  while (i < n) {
    const tok = argv[i] as string;
    if (tok === "--waits-on") {
      throw new DispatchError("--waits-on must follow a --blocked job");
    }
    if (!(tok in STATUS_FLAGS)) {
      throw new DispatchError(`unknown flag: ${tok}`);
    }
    const status = STATUS_FLAGS[tok] as string;
    // gather this flag's value args (everything up to the next flag)
    let j = i + 1;
    const values: string[] = [];
    while (j < n && !(argv[j] as string).startsWith("--")) {
      values.push(argv[j] as string);
      j += 1;
    }
    if (status === "blocked") {
      if (values.length !== 1) {
        throw new DispatchError("--blocked takes exactly one LABEL");
      }
      const label = values[0] as string;
      // must be immediately followed by --waits-on VALUE
      if (j >= n || argv[j] !== "--waits-on") {
        throw new DispatchError("--blocked must be followed by --waits-on");
      }
      if (j + 1 >= n || (argv[j + 1] as string).startsWith("--")) {
        throw new DispatchError("--waits-on requires a value");
      }
      nodes.push(makeNode({ status: "blocked", label, waitsOn: argv[j + 1] as string }));
      i = j + 2;
      continue;
    }
    if (values.length === 0) {
      throw new DispatchError(`${tok} requires at least one LABEL`);
    }
    if (WAVE_FLAGS.has(tok)) {
      const waves = splitWaves(values);
      if (waves.length === 0) {
        throw new DispatchError(`${tok} requires at least one LABEL`);
      }
      for (const wave of waves) {
        // a singleton wave is a plain branch; 2+ members -> parallel node
        if (wave.length === 1) {
          nodes.push(makeNode({ status, label: wave[0] as string }));
        } else {
          nodes.push(makeNode({ status: "parallel", memberStatus: status, members: wave }));
        }
      }
    } else {
      // done / failed: commas are literal, one branch per value arg
      for (const v of values) {
        nodes.push(makeNode({ status, label: v }));
      }
    }
    i = j;
  }
  return nodes;
};

/** Render parsed nodes into the JOBS panel text (no trailing newline). */
export const render = (nodes: Node[]): string => {
  if (nodes.length === 0) {
    // idle state: empty 0/0 gauge over a single `idle` node
    return `JOBS  ${EMPTY}  0/0\n${ELBOW}idle`;
  }

  let total = 0;
  let done = 0;
  for (const node of nodes) {
    if (node.status === "parallel") {
      total += node.members.length;
      // parallel members are running/pending -> never ■, so add 0 to done
    } else {
      total += 1;
      if (node.status === "done") {
        done += 1;
      }
    }
  }

  const gauge = FILLED.repeat(done) + EMPTY.repeat(total - done);
  const lines = [`JOBS  ${gauge}  ${done}/${total}`];

  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx] as Node;
    const last = idx === nodes.length - 1;
    const branch = last ? ELBOW : TEE;
    if (node.status === "parallel") {
      lines.push(`${branch}${PARALLEL}`);
      const memberGlyph = GLYPH[node.memberStatus] as string;
      const cont = last ? GAP : PIPE;
      for (let midx = 0; midx < node.members.length; midx++) {
        const member = node.members[midx] as string;
        const mlast = midx === node.members.length - 1;
        const mbranch = mlast ? ELBOW : TEE;
        lines.push(`${cont}${mbranch}${memberGlyph} ${member}`);
      }
    } else {
      const glyph = GLYPH[node.status] as string;
      let line = `${branch}${glyph} ${node.label}`;
      if (node.waitsOn !== null) {
        line += ` — waits on ${node.waitsOn}`; // — waits on X
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
};

/**
 * The CLI entry: print the help on `-h`/`--help`, else parse argv and write the
 * rendered panel. Returns the process exit code (0 on success/help; 2 on a
 * malformed invocation, after a stderr message) so the failure path never emits a
 * partial panel. Non-DispatchError throws propagate as real bugs.
 */
export const main = (argv: string[]): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${DOC}\n`);
    return 0;
  }
  let panel: string;
  try {
    const nodes = parse(argv);
    panel = render(nodes);
  } catch (exc) {
    if (exc instanceof DispatchError) {
      process.stderr.write(`render_dispatch: ${exc.message}\n`);
      return 2;
    }
    throw exc;
  }
  process.stdout.write(`${panel}\n`);
  return 0;
};

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)));
}
