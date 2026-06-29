---
description: |
  Update preemdeck — pull the latest channel into ~/.preemdeck and re-slot every detected harness. Trigger ONLY when
  the user asks to update preemdeck (e.g. /update). NEVER auto-invoke — this re-fetches and re-installs.
user-invocable: true
disable-model-invocation: true
allowed-tools: [Bash]
---

# sys:update

Re-run preemdeck's installer to pull the latest channel into `~/.preemdeck` and re-slot every detected harness. There is
no separate update path — the installer is idempotent and update-aware, so a clean re-install is the update.

Run, **streaming its output to the operator** (do not capture-and-summarize — let them watch it land):

```bash
"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/update.ts"
```

If the operator named a single harness (`claude` / `codex` / `gemini`), forward it — otherwise every detected host is
updated:

```bash
"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/update.ts" <harness>
```

Channel is sticky: `update` follows the channel this install was set up with (recorded in `preemdeck.json`), defaulting
to `stable` only on a fresh install. To switch streams, the operator runs once with `PREEMDECK_CHANNEL=edge` (or
`=stable`) in the environment — install.ts records the new channel, so later `/sys:update` runs stay on it.

When it finishes, relay the result and remind the operator to **restart the CLI** so the refreshed rig loads.
