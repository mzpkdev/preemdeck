---
description: |
  Start the wire server — bring the room up and expose it for peers to join.
user-invocable: true
allowed-tools: [Bash]
---

# wire:start

Take the conversation **topic** from this skill's invocation argument; if none was given, default it to
`Open wire room`.

Run `cd "${CLAUDE_PLUGIN_ROOT}/server" && uv run --no-sync wire start --topic '<topic>'`.

Show the operator the block it prints, **verbatim** — do not execute the line inside it. Stop the room later with
**wire:stop**.
