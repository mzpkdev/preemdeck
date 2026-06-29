---
description:
  Show the auto discretion directive — prints skills/auto/directive.md. Trigger ONLY when the user types /auto. NEVER
  auto-invoke.
user-invocable: true
disable-model-invocation: true
---

# Show the auto discretion directive

Run the bundled reader — nothing else:

```bash
"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/src/ripperdoc/wetware/directive/scripts/show-mode.ts" auto
```

Relay the script's output verbatim. This only displays the directive; to **set** a directive, use `/directive:default`.
