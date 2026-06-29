---
description:
  Show the swarm strategy directive — prints skills/swarm/directive.md. Trigger ONLY when the user types /swarm. NEVER
  auto-invoke.
user-invocable: true
disable-model-invocation: true
---

# Show the swarm strategy directive

Run the bundled reader — nothing else:

```bash
"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/src/ripperdoc/wetware/directive/scripts/show-mode.ts" swarm
```

Relay the script's output verbatim. This only displays the directive; to **set** a directive, use `/directive:default`.
