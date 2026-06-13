---
description: |
  Close the live multi-agent comms session — eject. Terminates the wire relay
  process started by /uplink (via its pidfile, falling back to pkill), confirms
  it's down, and cleans up the pid/port files. User-invoked via /eject.
user-invocable: true
allowed-tools: [Bash]
---

# Eject

Close the wire session: kill the relay process and clean up. One relay is one conversation, so terminating the process
ends the conversation for everyone.

## How to run

1. **Read the pidfile and terminate the relay.** The relay writes its pid to `wire/.relay.pid`. Kill that pid; if the
   pidfile is missing or the pid is gone, fall back to `pkill` matching the relay script. Both paths are bounded — never
   block.

   ```bash
   PLUGIN="${CLAUDE_PLUGIN_ROOT}"
   PIDFILE="$PLUGIN/.relay.pid"
   if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
     PID="$(cat "$PIDFILE")"
     kill "$PID" 2>/dev/null
     for i in $(seq 1 15); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
     kill -9 "$PID" 2>/dev/null || true   # hard-kill if it ignored TERM
   else
     pkill -f "scripts/relay.py" 2>/dev/null || true   # fallback: match the script
   fi
   ```

2. **Confirm it's down** (health must NOT answer). Read the bound port from `wire/.relay.port`; if there's no portfile,
   there's nothing to health-check, so just confirm the PID is gone.

   ```bash
   PLUGIN="${CLAUDE_PLUGIN_ROOT}"
   PORTFILE="$PLUGIN/.relay.port"
   if [ -f "$PORTFILE" ] && [ -n "$(cat "$PORTFILE" 2>/dev/null)" ]; then
     PORT="$(cat "$PORTFILE")"
     if curl -s --max-time 1 "http://127.0.0.1:${PORT}/health" | grep -q ok; then
       echo "STILL UP — relay did not stop"; pkill -9 -f "scripts/relay.py" 2>/dev/null || true
     else
       echo "relay down"
     fi
   else
     echo "relay down (no portfile — nothing listening)"
   fi
   ```

3. **Clean up the pidfile, portfile, and secretfile** (the relay removes them on a clean exit, but make sure — the
   secret is a credential, so don't leave it lying around):

   ```bash
   rm -f "$PLUGIN/.relay.pid" "$PLUGIN/.relay.port" "$PLUGIN/.relay.secret"
   ```

## What to return

One line: `wire session closed — relay down, pid/port/secret files cleared.` (or, if no relay was running,
`no wire relay was running.`).

## Critical

- Every command here is bounded (`--max-time`, bounded loops). Never block.
- The health check reads the port from `wire/.relay.port` — never hardcode a port. No portfile means nothing to check.
- Killing the process IS closing the conversation — there is no per-peer close on the host side. To start a new
  conversation, run `/uplink` again.
