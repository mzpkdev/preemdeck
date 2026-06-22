---
description: Set the auto discretion directive — writes discretion=auto to preemdeck.json. Trigger ONLY when the user types /auto. NEVER auto-invoke; never edit preemdeck.json by hand.
user-invocable: true
disable-model-invocation: true
---

# Set discretion = auto

Run the bundled writer — nothing else:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/set_mode.py" discretion auto
```

`${CLAUDE_PLUGIN_ROOT}` resolves on Claude and Codex (aliased to `PLUGIN_ROOT`). Relay the script's output verbatim; on
a non-zero exit it lists the valid values — pass that through, don't retry with a guess. `set_mode.py` is the only
writer of `preemdeck.json`. The directive takes effect on the next prompt, when the inject hook reads this skill's
`directive.md`.
