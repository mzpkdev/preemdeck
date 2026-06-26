---
description:
  Update preemdeck — pull the latest source and re-install every recorded harness. Trigger ONLY when the user types
  /sys:update. NEVER auto-invoke.
user-invocable: true
disable-model-invocation: true
allowed-tools: [Bash]
---

# Update preemdeck

Run exactly this — nothing else — and relay its output verbatim:

```bash
"$HOME/.preemdeck/scripts/preemdeck-bun" "$HOME/.preemdeck/update.ts"
```

It syncs `~/.preemdeck` to your channel (`version` in `preemdeck.json`, or a `PREEMDECK_CHANNEL` override) and
re-installs every harness in the manifest — it writes nothing else. On a non-zero exit, pass through the message it
prints (dirty tree, missing manifest, failed fast-forward); don't retry with a guess.

Plugins load at startup, so the update takes effect after the host CLI restarts.
