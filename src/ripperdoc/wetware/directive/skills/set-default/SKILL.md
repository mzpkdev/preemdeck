---
description:
  Set a directive — writes the given value (ask|swarm|team|auto) into its derived slot in preemdeck.json,
  deterministically. Trigger ONLY when the user types /directive:set-default. NEVER auto-invoke; never edit
  preemdeck.json by hand.
user-invocable: true
disable-model-invocation: true
---

# Set a directive

The user invokes `/directive:set-default <value>` with a value (`ask`|`swarm`|`team`|`auto`). Run the bundled writer
with that value — nothing else:

```bash
"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/src/ripperdoc/wetware/directive/scripts/set-mode.ts" <value>
```

The script derives the slot from the value, so you pass only the value. Relay the script's output verbatim; on a
non-zero exit it lists the valid values — pass that through, don't retry with a guess. `set-mode.ts` is the only writer
of `preemdeck.json`. The directive takes effect on the next prompt, when the inject hook reads it.
