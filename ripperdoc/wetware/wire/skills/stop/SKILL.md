---
description: |
  Stop the wire server — shut the room down and kill its long-polls.
user-invocable: true
allowed-tools: [Bash]
---

# wire:stop

Run `cd "${CLAUDE_PLUGIN_ROOT}/server" && uv run --no-sync wire stop` and relay its output to the operator.
