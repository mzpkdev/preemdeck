---
description: |
  Set the active mode-example mode by writing `preemdeck.json` via the bundled
  set_mode.py. Trigger ONLY when the user types `/mode <mode>` with mode-a,
  mode-b, or mode-c. NEVER trigger automatically, and never edit preemdeck.json
  by hand — the script is the only writer.
argument-hint: <mode>
user-invocable: true
disable-model-invocation: true
---

# Mode

Run the bundled writer with the mode the user gave — nothing else. `set_mode.py` is the single deterministic path: it
validates the mode against the shipped `modes/`, preserves other keys in `preemdeck.json`, and writes atomically. Never
edit `preemdeck.json` yourself.

## Run

Pass the user's chosen mode as the one positional argument. For `/mode mode-b`, run the script with `mode-b`:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/set_mode.py" <mode>
```

- **Argument** — substitute the literal mode from the `/mode` invocation. Do not depend on `$ARGUMENTS`; it expands only
  on Claude.
- **Path** — `${CLAUDE_PLUGIN_ROOT}` resolves on Claude and Codex (aliased to `PLUGIN_ROOT`). On Gemini it is unset; run
  the plugin's `scripts/set_mode.py` directly — the script self-locates `preemdeck.json` and `modes/` from its own path,
  so only the script's location matters.

Relay the script's output verbatim. On a non-zero exit (unknown mode, or no `preemdeck.json` found) it lists the valid
modes — pass that through; do not retry with a guess. The new mode takes effect on the next prompt, when the inject_mode
hook reads it.
