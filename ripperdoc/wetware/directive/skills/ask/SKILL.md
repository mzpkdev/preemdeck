---
description:
  Show the ask discretion directive — prints skills/ask/directive.md. Trigger ONLY when the user types /ask. NEVER
  auto-invoke.
user-invocable: true
disable-model-invocation: true
---

# Show the ask discretion directive

Run the bundled reader — nothing else:

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "${CLAUDE_PLUGIN_ROOT}/scripts/show-mode.ts" ask
```

`${CLAUDE_PLUGIN_ROOT}` resolves on Claude and Codex (aliased to `PLUGIN_ROOT`). Relay the script's output verbatim.
This only displays the directive; to **set** a directive, use `/directive:default`.
