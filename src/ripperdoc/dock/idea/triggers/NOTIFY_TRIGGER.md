# Trigger: Notify

Pop an IDE balloon when your turn ends, so the user sees the result without watching the terminal.

## Condition

Fire only when the whole task is resolved for the user: the final result is ready, you're blocked, or you need their
input. Skip while subagents or background tasks are still running and the report is partial; wait to notify once, on the
meaningful result.

## Action

Compose a one-line message (what happened, plus any action they must take), then run:
`$HOME/.preemdeck/preemdeck-runtime "$HOME/.preemdeck/src/ripperdoc/dock/idea/toolbox/notify.ts" "<message>" --type <info|warning|error>`

Use `--type warning` when they're blocked or you need input, `error` on failure, otherwise `info`.

## Output

Nothing to print. Fire it once, as your last action, and never announce it.
