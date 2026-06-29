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
"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/src/ripperdoc/wetware/directive/scripts/show-mode.ts" ask
```

Relay the script's output verbatim. This only displays the directive; to **set** a directive, use `/directive:default`.
