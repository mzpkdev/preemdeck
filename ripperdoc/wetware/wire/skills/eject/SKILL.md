---
description: |
  Close the live multi-agent comms session — eject. Terminates this session's
  wire relay (via its room-namespaced pidfile, falling back to a scoped pkill),
  confirms it's down, and cleans up that room's pid/port/secret files. Pass
  --all to eject every relay on this host, or --room <id> to eject another
  session's. User-invoked via /eject.
user-invocable: true
argument-hint: '[--all | --room <id>]'
allowed-tools: [Bash]
---

# Eject

Close the wire session: kill the relay process and clean up. One relay is one conversation, so terminating the process
ends the conversation for everyone on it.

**Rooms are per session.** By default this ejects only THIS session's relay — its room id is the first 8 chars of
`CLAUDE_CODE_SESSION_ID`, the same id `/uplink` used, so it targets exactly the files this session wrote and leaves
other sessions' relays running. Two optional arguments widen or redirect that:

- `--all` — eject **every** relay on this host (every `wire/.relay*.pid`, legacy bare file included). Use when you want
  a clean slate.
- `--room <id>` — eject a **specific** room (e.g. another session's orphaned relay you saw in `/rooms`).

Parse `$ARGUMENTS`: empty → the per-session default below; `--all` → the all-rooms branch; `--room <id>` → the
specific-room branch.

## How to run

First decide the branch from `$ARGUMENTS`, then run that branch. Each path is fully bounded (`--max-time`, bounded
loops) — never block.

### Default (no arguments) — eject THIS session's relay

1. **Derive this session's room, kill its relay by pidfile (scoped pkill fallback), confirm down, clean up.** The room
   id and infix match `/uplink`'s (`CLAUDE_CODE_SESSION_ID`, first 8 chars; empty → legacy bare files). Kill the pid in
   this room's pidfile; if that's missing/dead, fall back to a **room-scoped** `pkill` (matching `--room <id>` in the
   cmdline) so you never kill another session's relay. If there is no pidfile for this room, there's nothing to eject
   for this session — say so and point at `--all` / `/rooms`.

   ```bash
   PLUGIN="${CLAUDE_PLUGIN_ROOT}"
   ROOM="${CLAUDE_CODE_SESSION_ID:0:8}"   # this session's room id ("" if env unset)
   RID="${ROOM:+.$ROOM}"                  # filename infix: ".<room>" or "" (legacy)
   PIDFILE="$PLUGIN/.relay${RID}.pid"
   PORTFILE="$PLUGIN/.relay${RID}.port"
   if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
     PID="$(cat "$PIDFILE")"
     kill "$PID" 2>/dev/null
     for i in $(seq 1 15); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
     kill -9 "$PID" 2>/dev/null || true   # hard-kill if it ignored TERM
   elif [ -f "$PIDFILE" ] || [ -f "$PORTFILE" ]; then
     # Pidfile present but pid already dead, or only a portfile left: scope the
     # fallback to THIS room so other sessions' relays are untouched.
     if [ -n "$ROOM" ]; then
       pkill -f "relay\.py.*--room $ROOM" 2>/dev/null || true
     else
       pkill -f "scripts/relay.py" 2>/dev/null || true   # legacy single-room fallback
     fi
   else
     echo "nothing to eject for this session — try /eject --all or /rooms"; exit 0
   fi
   # Confirm down (health must NOT answer) using this room's portfile.
   if [ -f "$PORTFILE" ] && [ -n "$(cat "$PORTFILE" 2>/dev/null)" ]; then
     PORT="$(cat "$PORTFILE")"
     if curl -s --max-time 1 "http://127.0.0.1:${PORT}/health" | grep -q ok; then
       echo "STILL UP — relay did not stop"
       [ -n "$ROOM" ] && pkill -9 -f "relay\.py.*--room $ROOM" 2>/dev/null || pkill -9 -f "scripts/relay.py" 2>/dev/null || true
     else
       echo "relay down"
     fi
   else
     echo "relay down (no portfile — nothing listening)"
   fi
   # Clean up this room's trio (relay removes them on clean exit, but make sure —
   # the secret is a credential, don't leave it lying around).
   rm -f "$PLUGIN/.relay${RID}.pid" "$PLUGIN/.relay${RID}.port" "$PLUGIN/.relay${RID}.secret"
   ```

### `--all` — eject every relay on this host

Glob every `wire/.relay*.pid` (covers the legacy bare `.relay.pid` AND every `.relay.<id>.pid`). For each: kill its pid
(TERM → wait → KILL), then remove that room's `.pid`/`.port`/`.secret`. Report how many were ejected and their room ids.

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT}"
n=0; ids=""
for pf in "$PLUGIN"/.relay*.pid; do
  [ -e "$pf" ] || continue            # no matches -> the glob stays literal; skip
  base="${pf%.pid}"                   # e.g. .../.relay.ff49f4c0  or  .../.relay
  id="${base##*/.relay}"; id="${id#.}"; [ -n "$id" ] || id="default"
  PID="$(cat "$pf" 2>/dev/null)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    for i in $(seq 1 15); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "${base}.pid" "${base}.port" "${base}.secret"
  n=$((n+1)); ids="${ids:+$ids, }$id"
done
if [ "$n" -eq 0 ]; then echo "no wire relays were running."; else echo "ejected $n relay(s): $ids"; fi
```

### `--room <id>` — eject one specific room

Target that id's trio directly (kill another session's orphan). `$ID` is the id parsed from `$ARGUMENTS`.

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT}"
ID="<the id from --room>"             # substitute the parsed id
PIDFILE="$PLUGIN/.relay.${ID}.pid"
PORTFILE="$PLUGIN/.relay.${ID}.port"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  PID="$(cat "$PIDFILE")"
  kill "$PID" 2>/dev/null
  for i in $(seq 1 15); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
  kill -9 "$PID" 2>/dev/null || true
else
  pkill -f "relay\.py.*--room $ID" 2>/dev/null || true
fi
if [ -f "$PORTFILE" ] && [ -n "$(cat "$PORTFILE" 2>/dev/null)" ]; then
  PORT="$(cat "$PORTFILE")"
  curl -s --max-time 1 "http://127.0.0.1:${PORT}/health" | grep -q ok && echo "STILL UP — room $ID did not stop" || echo "room $ID down"
fi
rm -f "$PLUGIN/.relay.${ID}.pid" "$PLUGIN/.relay.${ID}.port" "$PLUGIN/.relay.${ID}.secret"
```

## What to return

- **Default:** `wire session closed — this session's relay down, pid/port/secret files cleared.` (or, if nothing was
  running for this session, `nothing to eject for this session — try /eject --all or /rooms`).
- **`--all`:** the count + room ids ejected (e.g. `ejected 2 relay(s): default, ff49f4c0`), or
  `no wire relays were running.`
- **`--room <id>`:** `room <id> down — pid/port/secret cleared.` (or that it wasn't running).

## Critical

- Every command here is bounded (`--max-time`, bounded loops). Never block.
- **Default ejects only THIS session's room** (`CLAUDE_CODE_SESSION_ID`-derived id). The `pkill` fallback is **scoped**
  to that room (`--room <id>` in the cmdline) so you never kill another session's relay; only the legacy no-room case
  uses the broad `scripts/relay.py` match. Unset session id → legacy bare files.
- The health check reads the port from this room's `wire/.relay${RID}.port` — never hardcode a port. No portfile means
  nothing to check.
- Killing the process IS closing the conversation — there is no per-peer close on the host side. To start a new
  conversation in this session, run `/uplink` again.
