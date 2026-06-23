---
description: Show the auto discretion directive — prints skills/auto/directive.md. Trigger ONLY when the user types /auto. NEVER auto-invoke.
user-invocable: true
disable-model-invocation: true
---

# Show the auto discretion directive

Run the bundled reader — nothing else:

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "${CLAUDE_PLUGIN_ROOT}/scripts/show_mode.ts" auto
```

`${CLAUDE_PLUGIN_ROOT}` resolves on Claude and Codex (aliased to `PLUGIN_ROOT`). Relay the script's output verbatim.
This only displays the directive; to **set** a directive, use `/directive:default`.
