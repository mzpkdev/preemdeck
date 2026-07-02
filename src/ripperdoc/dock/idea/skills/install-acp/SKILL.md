---
description: |
  Pin the JetBrains ACP config so the IDE keeps launching Claude Code as an agent
  server after node/npx moves (an nvm switch, a Node version bump). Rewrites
  ~/.jetbrains/acp.json's agent_servers."Claude Code".command to the current npx
  path. Use when the IDE's Claude Code ACP integration stopped working, after
  switching Node/nvm versions, to "install / set up / fix ACP", or to undo it
  ("remove the ACP entry", "restore acp.json"). Runs install-acp.ts (apply /
  --restore / --dry-run).
user-invocable: true
allowed-tools: [Bash]
---

# idea:install-acp

Keep the JetBrains IDE able to launch Claude Code as an ACP agent server by pinning `~/.jetbrains/acp.json`'s
`agent_servers."Claude Code".command` to the current `npx`. The stored command is an absolute npx path that goes stale
whenever the active npx changes (an nvm switch, a Node upgrade); this re-resolves and rewrites it.

## What it changes

It reads `~/.jetbrains/acp.json`, resolves `npx` on the current `PATH`, and upserts one entry, preserving every other
key:

```json
{
  "agent_servers": {
    "Claude Code": {
      "command": "/abs/path/to/npx",
      "args": ["@zed-industries/claude-agent-acp"],
      "env": {}
    }
  }
}
```

- Idempotent: an entry already pointing at the current npx is left untouched.
- The original file is backed up to `acp.json.bak` once, so `--restore` puts it back. A stale command is rewritten to
  the default shape; a missing file is created.

## Canonical invocation

Run the CLI through the preemdeck-runtime shim by absolute path (cwd-independent):

```bash
TB="$HOME/.preemdeck/src/ripperdoc/dock/idea/toolbox"

"$HOME/.preemdeck/preemdeck-runtime" "$TB/install/install-acp.ts"             # pin to the current npx
"$HOME/.preemdeck/preemdeck-runtime" "$TB/install/install-acp.ts" --dry-run   # preview, write nothing
"$HOME/.preemdeck/preemdeck-runtime" "$TB/install/install-acp.ts" --restore   # undo: .bak, or strip the entry
```

Progress prints to stderr (`pinned "Claude Code" to …`, `already pins npx …`). Exit `0` on success, `1` when `npx` isn't
on `PATH`.

## Flags

- `--restore` — undo: restore `acp.json` from its `.bak`, or strip only the Claude Code entry (other agent servers are
  kept).
- `--dry-run` — report what would change without writing.

## When to run it

After switching Node/nvm versions or when the IDE's Claude Code ACP integration stops launching. It pins to whatever
`npx` is on `PATH` at run time, so run it from the shell whose Node you want the IDE to use.

## Requirements

- **npx** on `PATH` (from Node). Without it the command exits `1` and changes nothing.
- The preemdeck-runtime shim and bundled Bun (from `boot.sh`); no other toolchain.

The upstream original (`ensure_acp.py`) ran this on every `SessionStart` to auto-repin. This port is a manual command;
re-run it after a Node switch, or wire the same script into the idea plugin's `SessionStart` hooks for automatic
re-pinning.
