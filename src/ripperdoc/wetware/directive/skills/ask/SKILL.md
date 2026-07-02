---
description:
  Adopt the ask discretion directive for this session — loads skills/ask/directive.md into your context and applies it
  to your own behavior. It prints nothing to the user and does not change the persisted directive. Trigger ONLY when the
  user types /ask. NEVER auto-invoke.
user-invocable: true
disable-model-invocation: true
---

# Adopt the ask discretion directive

Load the directive into your own context — nothing else:

```bash
cat "$HOME/.preemdeck/src/ripperdoc/wetware/directive/skills/ask/directive.md"
```

Adopt it as your operating directive for the rest of this session and apply it to how you work from here on. Do **not**
print or summarize it back to the user, and do **not** write `preemdeck.json` — this is an in-session application only.
To set the persisted directive instead, use `/directive:set-default`. Acknowledge in one short line (e.g. "Ask discretion
active").
