---
description: |
  Set up tmux as the JetBrains IDE terminal shell, with a per-repo persistent session,
  WITHOUT touching the user's shell rc. Points the IDE's terminal Shell path at
  preemdeck's `ideamux` wrapper. Use when the user wants tmux inside their JetBrains
  terminal, per-project persistent terminal sessions that survive detach/reopen, to
  "install / enable / set up ideamux", or to undo it again ("restore my terminal
  settings", "remove the tmux shell"). Runs install-tmux.ts (apply / --restore /
  --force / --dry-run).
user-invocable: true
allowed-tools: [Bash]
---

# idea:install-tmux

Make the JetBrains terminal open into a **per-repo tmux session** by setting the IDE's terminal Shell path to
preemdeck's `ideamux` wrapper. Configures the IDE, not your shell: nothing is written to `~/.zshrc` / `~/.bashrc`, and
the interactive shell _inside_ tmux stays whatever you run (tmux's `default-shell`, i.e. `$SHELL`).

## What it changes

For every detected JetBrains product config dir, it upserts one option in `<config>/options/terminal.xml`:

```xml
<application>
  <component name="TerminalOptionsProvider">
    <option name="shellPath" value="$HOME/.preemdeck/src/ripperdoc/dock/idea/toolbox/ideamux" />
  </component>
</application>
```

- Config roots: `~/Library/Application Support/JetBrains/<Product><ver>` (macOS), `~/.config/JetBrains/<Product><ver>`
  (Linux). Backup/service dirs are skipped.
- The original `terminal.xml` is backed up to `<file>.bak` once, so `--restore` puts it back. A legacy `myShellPath`
  option is rewritten in place; a missing file is created.

## Before you run: close the IDE

A **running IDE rewrites `terminal.xml` on exit** and would clobber the edit, so the command **refuses while any
JetBrains IDE is up** (exit 1) unless you pass `--force`. Quit the IDE(s) first, run it, then reopen.

## Canonical invocation

Run the CLI through the preemdeck-runtime shim by absolute path (cwd-independent):

```bash
TB="$HOME/.preemdeck/src/ripperdoc/dock/idea/toolbox"

"$HOME/.preemdeck/preemdeck-runtime" "$TB/install/install-tmux.ts"             # apply (IDE closed)
"$HOME/.preemdeck/preemdeck-runtime" "$TB/install/install-tmux.ts" --dry-run   # preview every change, write nothing
"$HOME/.preemdeck/preemdeck-runtime" "$TB/install/install-tmux.ts" --restore   # undo: restore terminal.xml from .bak
"$HOME/.preemdeck/preemdeck-runtime" "$TB/install/install-tmux.ts" --force     # override the running-IDE guard
```

Progress prints to stderr (`set shellPath in …`, `configured N/M config dir(s)`). Exit `0` on success, `1` when an IDE
is running without `--force`.

## Flags

- `--restore` — undo: restore each `terminal.xml` from its `.bak`, or strip only the option this installer added.
- `--force` — proceed even while a JetBrains IDE is running (it may overwrite the edit on exit).
- `--dry-run` — report what would change without writing a file (safe rehearsal).

## After it runs

Reopen a terminal tab in the IDE. It launches `ideamux`, which attaches to that repo's tmux session (creating it on
first use) on a per-repo socket under `~/.ideamux`. Detaching (`Ctrl-b d`) keeps the session's windows alive; reopening
a tab reattaches.

## Requirements

- **tmux** installed for the wrapping to happen. If tmux is absent, `ideamux` execs your login shell instead, so the IDE
  terminal always opens (you just get a plain shell, not tmux).
- The preemdeck-runtime shim and bundled Bun (from `boot.sh`); no other toolchain.
