---
description:
  Show the team strategy directive — prints skills/team/directive.md. Trigger ONLY when the user types /team. NEVER
  auto-invoke.
user-invocable: true
disable-model-invocation: true
---

# Show the team strategy directive

Run the bundled reader — nothing else:

```bash
"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/src/ripperdoc/wetware/directive/scripts/show-mode.ts" team
```

Relay the script's output verbatim. This only displays the directive; to **set** a directive, use `/directive:default`.
