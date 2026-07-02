---
description:
  Adopt the swarm strategy directive for this session — loads skills/swarm/directive.md into your context and applies it
  to your own behavior, then echoes a one-line summary of its effect. It does not change the persisted directive.
  Trigger ONLY when the user types /swarm. NEVER auto-invoke.
user-invocable: true
disable-model-invocation: true
---

# Adopt the swarm strategy directive

Load the directive into your own context — nothing else:

```bash
cat "$HOME/.preemdeck/src/ripperdoc/wetware/directive/skills/swarm/directive.md"
```

Adopt it as your operating directive for the rest of this session and apply it to how you work from here on. Do **not**
dump the directive text back to the user, and do **not** write `preemdeck.json` — this is an in-session application
only. To set the persisted directive instead, use `/directive:set-default`. Then echo this summary back as Markdown (the
heading rendered, not fenced), verbatim and nothing else:

```text
# Strategy: Swarm

Runs the deck, doesn't do the work by hand: spins up one-and-done subagents, holds a thin synthesis layer, keeps its context clean. They edit; every commit is the orchestrator's.
```
