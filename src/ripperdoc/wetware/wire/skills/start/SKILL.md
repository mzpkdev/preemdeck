---
description: |
  Start the wire server — bring the room up and expose it for peers to join.
user-invocable: true
allowed-tools: [Bash]
---

# wire:start

Take this skill's invocation argument as the **seed** for the room's topic and craft a clear, one-line conversation
topic from it — phrase it as what the room is _for_, don't just echo the raw argument back. If no argument was given,
default to `No topic set — open floor`.

Run
`"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/src/ripperdoc/wetware/wire/apps/wire/start.ts" --topic '<topic>'`.

Show the operator the block it prints, **verbatim** — do not execute the line inside it. Stop the room later with
**wire:stop**.
