---
description: Set a directive — writes the given value (ask|swarm|auto) into its derived slot in preemdeck.json, deterministically. Trigger ONLY when the user types /directive:default. NEVER auto-invoke; never edit preemdeck.json by hand.
user-invocable: true
disable-model-invocation: true
---

# Set a directive

The user invokes `/directive:default <value>` with a value (`ask`|`swarm`|`auto`). Run the bundled writer with that
value — nothing else:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/set_mode.py" <value>
```

`${CLAUDE_PLUGIN_ROOT}` resolves on Claude and Codex (aliased to `PLUGIN_ROOT`). The script derives the slot from the
value, so you pass only the value. Relay the script's output verbatim; on a non-zero exit it lists the valid values —
pass that through, don't retry with a guess. `set_mode.py` is the only writer of `preemdeck.json`. The directive takes
effect on the next prompt, when the inject hook reads it.
