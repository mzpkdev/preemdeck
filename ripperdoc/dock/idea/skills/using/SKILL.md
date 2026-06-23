---
description: |
  Drive the running JetBrains IDE from the terminal — the idea toolbox CLI. Use whenever the
  user wants to OPEN a file or URL in the IDE ("open X in the IDE/WebStorm/PyCharm", "pull this
  up", "jump to line N", "preview localhost"), SHOW a DIFF or review a proposed change ("diff
  these", "show me the diff", "review this edit/suggestion side by side"), present a code
  SNIPPET / SUGGESTION inline or MERGE one into a file ("show this snippet", "drop this
  suggestion in the editor", "merge this in", "3-way merge"), or NOTIFY them in-IDE ("notify
  me", "pop a notification", "let me know when it's done", "toast/balloon"). Covers every
  CLI tool: open_file, open_url, open_inline, diff_file, diff_inline, merge_file, merge_inline,
  read_logs, notify, in_idea.
user-invocable: true
allowed-tools: [Bash]
---

# idea:using

A manual for the **idea toolbox** — a set of small CLIs that drive the *currently running* JetBrains IDE from the
terminal: open files/URLs, show diffs, present code suggestions, run 3-way merges, tail the IDE log, and pop
notification balloons.

## Hard requirement: a live JetBrains terminal

Every tool drives the JetBrains IDE that **launched this terminal** — it walks the process ancestry to that IDE binary
(WebStorm, PyCharm, IntelliJ IDEA, GoLand, PhpStorm, RubyMine, CLion, Rider, DataGrip, RustRover). There is **no
browser/editor fallback**: if the terminal is not running inside a JetBrains IDE, every tool fails clean.

- Each tool first checks it's inside a live JetBrains terminal — run `in_idea.ts` to make that check yourself (see
  below). When the check fails, the tool prints `<tool>: no JetBrains IDE in the process ancestry` to stderr and **exits
  1**.
- **Exit-code semantics:** `0` = the action was dispatched to the IDE; `1` = no live IDE (or, for the path-taking tools,
  a missing input / OS error). The `--type`/`--action` validation errors in `notify` exit `2` (argparse usage error).
- The IDE is the one that *launched* the process, not whichever is focused. Switching focus does not retarget it;
  quitting the launching IDE makes the tools fail rather than hit a different IDE.

So before relying on these, confirm you're in a JetBrains terminal with `in_idea.ts` (exit `0` inside, `1` outside):

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "${CLAUDE_PLUGIN_ROOT}/toolbox/in_idea.ts"        # prints "in a JetBrains IDE terminal" / "not …"
"$HOME/.preemdeck/scripts/preemdeck-bun" "${CLAUDE_PLUGIN_ROOT}/toolbox/in_idea.ts" -q && echo "good to go"   # quiet: gate on the exit code
```

## Canonical invocation

The tools live in the plugin's `toolbox/` dir and are run through the **preemdeck-bun shim** by **absolute path**. The
shim (`$HOME/.preemdeck/scripts/preemdeck-bun`) runs the bundled Bun runtime against the `.ts` tool. Anchor on
`${CLAUDE_PLUGIN_ROOT}` (this plugin's root) so it works from any working directory — the run is **cwd-independent**
(you do *not* need to `cd` into the toolbox):

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "${CLAUDE_PLUGIN_ROOT}/toolbox/<tool>.ts" [args…]
```

For brevity below, assume:

```bash
TB="${CLAUDE_PLUGIN_ROOT}/toolbox"
```

Requires only the preemdeck-bun shim and the bundled Bun runtime (fetched by `boot.sh`) — no other toolchain.

## Fire-and-forget vs `--wait`

Most tools are **fire-and-forget**: they spawn the IDE action async and return immediately (the command exits `0`,
prints nothing). Pass `--wait` to **block** until the user closes the tab / applies the merge, and then the tool
**prints the result to stdout** (the edited file, the reconciled LEFT diff pane, or the merged output). Use `--wait`
when you need to read back what the user did; otherwise just dispatch and move on.

The `*_inline` tools spill their string args to temp files (the IDE only operates on files). On the `--wait` path the
temps are removed synchronously; on fire-and-forget they're handed to a deferred reaper, so you never need to clean up.

## Intent → tool map

Pick the tool from what the user asked for:

| The user says…                                                             | Tool              |
| -------------------------------------------------------------------------- | ----------------- |
| "open `<file>` in the IDE", "jump to line N", "pull up `app.py`"           | `open_file.ts`    |
| "open `<url>`", "preview localhost:3000", "show that page in the IDE"      | `open_url.ts`     |
| "show me this snippet/string", "open this text", "render this markdown"    | `open_inline.ts`  |
| "diff these two files", "show the diff", "review this change side by side" | `diff_file.ts`    |
| "diff this old vs new text", "compare these two snippets"                  | `diff_inline.ts`  |
| "merge these files", "3-way merge", "reconcile with a base"                | `merge_file.ts`   |
| "merge this suggestion in", "drop this proposed code into the file"        | `merge_inline.ts` |
| "what's in the IDE log", "tail the IDE's log", "show recent IDE log lines" | `read_logs.ts`    |
| "notify me", "pop a balloon", "let me know when X finishes", "toast me"    | `notify.ts`       |

Rules of thumb:

- A **file on disk** → the `_file` variants. A **string you already hold** (a snippet, generated text, a draft) → the
  `_inline` variants.
- Just *showing* a suggestion read-only → `open_inline`/`diff_inline`. Letting the user *accept it into* a file →
  `merge_inline` (or `diff_*` `--wait`, where the user pulls chunks into the LEFT pane and you read it back).
- Need to **read back** the user's edits/decision → add `--wait`.

______________________________________________________________________

## open_file.ts — open a file in the IDE

```
open_file.ts [-h] [--line LINE] [--column COLUMN] [--wait] [--preview] path
```

Open `path` at an optional caret position. Fire-and-forget by default; `--wait` blocks until the tab closes and then
prints the file's full text (whether or not it was edited).

- `path` — file to open (resolved to an absolute path).
- `--line LINE` — 1-based line to put the caret on (default `1`).
- `--column COLUMN` — 1-based column (optional).
- `--wait` — block until the tab closes, then print the file's contents to stdout.
- `--preview` — after opening, flip the editor to WebStorm's rendered preview (best-effort; a no-op for filetypes that
  have no preview). Useful for Markdown/HTML.

**When to use:** the user wants a real file opened, or wants to land on a specific line.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/open_file.ts" src/app.py --line 42      # jump to line 42, fire-and-forget
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/open_file.ts" notes.md --wait           # block until closed, then print the file
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/open_file.ts" README.md --preview       # open, then flip to rendered preview
```

## open_url.ts — open an http(s) URL in the IDE's preview

```
open_url.ts [-h] [--title TITLE] url
```

Open `url` in the IDE's embedded JCEF web-preview tab. Fire-and-forget (there's no editor to block on — **no
`--wait`**). **No browser fallback:** if there's no live IDE it exits 1 rather than shelling out to a browser.

- `url` — must be a non-empty **http/https** URL (anything else → usage note, exit 1).
- `--title TITLE` — tab label (the tab shows `Preview of <title>`); defaults to the URL's host[:port].

**When to use:** the user wants to view a page/dev-server *inside* the IDE.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/open_url.ts" http://localhost:3000              # preview a local dev server
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/open_url.ts" https://example.com --title docs   # custom tab label
```

## open_inline.ts — open a string in the IDE

```
open_inline.ts [-h] [--suffix SUFFIX] [--wait] [--preview] inline
```

String-native wrapper over `open_file.ts`: spills `inline` to a temp file and opens it. Use this to show a snippet or
any generated text you're holding as a string (no need to write a file first).

- `inline` — the literal string to open.
- `--suffix SUFFIX` — temp-file suffix; the IDE uses it to pick syntax highlighting (default `.txt`). E.g.
  `--suffix .py`, `--suffix .md`.
- `--wait` — block until the tab closes, then print the (possibly edited) contents to stdout.
- `--preview` — after opening, flip to rendered preview (pair with `--suffix .md`/`.html`).

**When to use:** "show me this snippet", "open this text", "render this markdown". Add `--wait` if you want to read back
the user's edits.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/open_inline.ts" "$snippet" --suffix .py        # open with .py highlighting
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/open_inline.ts" "$snippet" --wait              # block until closed, then print
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/open_inline.ts" "$md" --suffix .md --preview   # open, then flip to rendered preview
```

## diff_file.ts — 2-way diff of two files

```
diff_file.ts [-h] [--wait] target suggestion
```

Open a 2-way diff. Panes map straight to `idea diff L R`: **`target` is LEFT, `suggestion` is RIGHT**. The LEFT pane is
the editable/reported side — the user edits LEFT or pulls chunks from the RIGHT via the gutter arrows. With `--wait`,
blocks until the diff tab closes and prints the **LEFT file's** full text. Both inputs are resolved strictly: a missing
path fails before launch (exit 1).

- `target` — left pane; the file you reconcile into and get back.
- `suggestion` — right pane; the proposed version.
- `--wait` — block until the diff closes, then print LEFT.

**When to use:** "show the diff between these files", "review this change side by side". Convention: put the
user's/current file on the LEFT (`target`) so `--wait` reads back the reconciled result.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/diff_file.ts" mine.py theirs.py          # open the diff, fire-and-forget
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/diff_file.ts" mine.py theirs.py --wait   # block until closed, then print LEFT
```

## diff_inline.ts — 2-way diff of two strings

```
diff_inline.ts [-h] [--suffix SUFFIX] [--wait] target suggestion
```

Same as `diff_file.ts` but each side is a string (spilled to a temp file). `target` → LEFT, `suggestion` → RIGHT;
`--wait` prints the reconciled LEFT pane.

- `target` / `suggestion` — left / right strings.
- `--suffix SUFFIX` — shared suffix for both temps, for syntax highlighting (default `.txt`).
- `--wait` — block, then print LEFT.

**When to use:** compare two snippets / an old vs new version you hold as strings — e.g. show the user the current code
vs a proposed rewrite.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/diff_inline.ts" "$old" "$new" --suffix .py   # diff with .py highlighting
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/diff_inline.ts" "$old" "$new" --wait         # block until closed, then print LEFT
```

## merge_file.ts — 3-way merge of two files (optional base)

```
merge_file.ts [-h] [--wait] target suggestion [base]
```

Open the IDE's native 3-way merge: `target` (local) vs `suggestion` (remote), with an optional `base` (common ancestor).
The result is written to an **internal output temp** (not one of your files — the inputs are read-only). `idea merge`
**blocks natively** until the user hits Apply, so there's no native `--wait`; this tool's `--wait` joins that process
and then prints the merged result. Inputs are resolved strictly (missing path → exit 1).

- `target` — local pane (your version).
- `suggestion` — remote pane (the proposed version).
- `base` — optional 3-way base (common ancestor).
- `--wait` — block until the user applies, then print the merged result to stdout.

**When to use:** the user wants to reconcile two file versions, optionally against a base.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/merge_file.ts" mine.py theirs.py base.py   # 3-way merge with a base
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/merge_file.ts" mine.py theirs.py --wait    # block until applied, then print
```

## merge_inline.ts — 3-way merge of strings (optional base)

```
merge_inline.ts [-h] [--suffix SUFFIX] [--wait] target suggestion [base]
```

String-native `merge_file.ts`: each version is a string spilled to a temp file. Use this to let the user **merge a
proposed snippet into their version** without writing files first.

- `target` / `suggestion` — local / remote strings.
- `base` — optional common-ancestor string.
- `--suffix SUFFIX` — shared suffix for every temp, for syntax highlighting (default `.txt`).
- `--wait` — block until applied, then print the merged result.

**When to use:** "merge this suggestion into my code." Add `--wait` to capture the applied result.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/merge_inline.ts" "$mine" "$theirs" "$base" --suffix .py   # merge with a base
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/merge_inline.ts" "$mine" "$theirs" --wait                 # block until applied, print
```

## read_logs.ts — tail the IDE's log

```
read_logs.ts [-h] [n]
```

Print the last `n` lines of the active IDE's `idea.log` (from its resolved log dir).

- `n` — number of trailing lines to print (optional positional; default `50`).

**When to use:** diagnose IDE-side behavior — confirm an action reached the IDE, inspect an ideScript error, etc.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/read_logs.ts"       # last 50 lines (default)
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/read_logs.ts" 200   # last 200 lines
```

## in_idea.ts — check you're in a JetBrains terminal

```
in_idea.ts [-h] [-q]
```

Report whether this terminal is running inside a live JetBrains IDE — the same gate every other tool applies before it
acts. Prints `in a JetBrains IDE terminal` / `not in a JetBrains IDE terminal` to stdout and, more usefully, sets the
**exit code**: `0` inside, `1` outside. Use it to confirm the toolbox will work before you dispatch, or as a shell gate.

- `-q`, `--quiet` — print nothing; signal the result through the exit code only.

**When to use:** sanity-check the environment before relying on the other tools, or gate a script on being inside the
IDE.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/in_idea.ts"        # print yes/no, set the exit code
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/in_idea.ts" -q && "$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/notify.ts" "ready"  # only notify if inside
```

## notify.ts — pop an in-IDE notification balloon

```
notify.ts [-h] [--title TITLE] [--type {info,warning,error}] [--action NAME[=ARG]] message
```

Raise a transient notification balloon in the live IDE (via the platform Notification API). Fire-and-forget — there's no
tab to block on, **no `--wait`**. It is **best-effort and never raises**: the worker swallows failures with a stderr
note, and the CLI treats dispatch as success (the only non-zero exits are `1` for no live IDE and `2` for an invalid
`--type`/`--action`).

- `message` — the balloon body text (positional).

- `--title TITLE` — balloon title (default `"PreemDeck"`).

- `--type {info,warning,error}` — severity → NotificationType icon (default `info`).

- `--action NAME[=ARG]` — add a clickable button; **repeatable** (buttons render in the order given). `NAME` must be one
  of:

  - `open-url=<url>` — open the URL in the **external browser**.
  - `open-file=<path>` — open the path **in the editor**.
  - `open-preview=<url>` — open the URL in the IDE's **JCEF web-preview** tab (same mechanism as `open_url.ts`).

  Each of these three **requires** an arg (`--action open-url=https://…`); a bare or unknown name is a usage error (exit
  2).

**When to use:** tell the user something finished or needs attention — especially after a fire-and-forget action — and
optionally give them a one-click way to follow up.

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/notify.ts" "build finished"                              # info balloon, default title
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/notify.ts" --title Deploy "shipped to prod"              # custom title
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/notify.ts" --type error "tests failed"                   # error severity/icon
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/notify.ts" --action open-url=https://ci.example.com "build done"      # browser button
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/notify.ts" --action open-preview=http://localhost:3000 "dev up"       # JCEF preview
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/notify.ts" --action open-file=/tmp/build.log "see log"                # editor button
# two buttons + error severity:
"$HOME/.preemdeck/scripts/preemdeck-bun" "$TB/notify.ts" --action open-file=/tmp/build.log --action open-url=https://ci.example.com \
        --type error "build failed"
```

## Notes

- **Quote string args.** `open_inline`/`diff_inline`/`merge_inline` and `notify` take literal strings — wrap them in
  quotes so the shell doesn't split them.
- **Reading results back.** Only `--wait` prints anything to stdout (the edited file / reconciled LEFT pane / merged
  output). Without it the tools dispatch silently and exit `0`.
- **No cleanup needed.** The inline/merge tools manage their own temp files (synchronous unlink on `--wait`, deferred
  reap otherwise).
