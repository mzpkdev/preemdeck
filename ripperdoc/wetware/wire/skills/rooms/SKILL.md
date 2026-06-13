---
description: |
  List the wire relays (rooms) running on this host — read-only. Globs the
  per-room state files, health-checks each port, and prints a compact table
  (ROOM | PORT | PID | LIVE | mine?), marking this session's own room and
  flagging stale rooms (portfile present but /health dead). Never kills
  anything. User-invoked via /rooms.
user-invocable: true
allowed-tools: [Bash]
---

# Rooms

Show every wire relay (room) on this host. **Read-only** — this never kills a process or removes a file; to stop a relay
use `/eject` (this session), `/eject --room <id>` (another session's), or `/eject --all`.

Each Claude session that ran `/uplink` has its own room, namespaced by the first 8 chars of `CLAUDE_CODE_SESSION_ID`. A
legacy un-namespaced relay (no session id) shows as room `default`. This skill enumerates them so you can see what's up,
which one is yours, and whether any are stale (left a portfile behind but no longer answering).

## How to run

Glob `wire/.relay*.port`. For each portfile, derive the room id from the filename (`.relay.port` → `default`,
`.relay.<id>.port` → `<id>`), read the port, probe `/health` (bounded `--max-time 1`) for LIVE, read the sibling
`.relay*.pid` and `kill -0` it for pid-alive, and note whether the secret file is present. Mark the row whose id equals
this session's (`${CLAUDE_CODE_SESSION_ID:0:8}`) as **mine**. A row whose portfile exists but whose `/health` does not
answer is **STALE** — hint `/eject --room <id>` to clear it. Every curl is bounded; nothing here blocks.

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT}"
MINE="${CLAUDE_CODE_SESSION_ID:0:8}"   # this session's room id ("" if env unset)
printf '%-12s %-6s %-8s %-5s %-5s\n' ROOM PORT PID LIVE mine?
found=0
for portf in "$PLUGIN"/.relay*.port; do
  [ -e "$portf" ] || continue          # no matches -> literal glob -> skip
  found=1
  base="${portf%.port}"                # .../.relay.<id>  or  .../.relay
  id="${base##*/.relay}"; id="${id#.}"; [ -n "$id" ] || id="default"
  port="$(cat "$portf" 2>/dev/null)"
  # LIVE? bounded health probe.
  live="no"
  if [ -n "$port" ] && curl -s --max-time 1 "http://127.0.0.1:${port}/health" 2>/dev/null | grep -q ok; then
    live="yes"
  fi
  # PID + alive?
  pid="-"; palive=""
  if [ -f "${base}.pid" ]; then
    pid="$(cat "${base}.pid" 2>/dev/null)"; [ -n "$pid" ] || pid="-"
    [ "$pid" != "-" ] && kill -0 "$pid" 2>/dev/null && palive=" (alive)"
  fi
  # secret file present?
  sec=""; [ -f "${base}.secret" ] && sec=" +secret"
  mark=""; [ -n "$MINE" ] && [ "$id" = "$MINE" ] && mark="<- you"
  stale=""; { [ "$live" = "no" ]; } && stale="  STALE: /eject --room ${id}"
  printf '%-12s %-6s %-8s %-5s %-5s%s\n' "$id" "${port:--}" "${pid}${palive}" "$live" "${mark:--}" "${sec}${stale}"
done
[ "$found" -eq 1 ] || echo "no wire rooms on this host (none up). Open one with /uplink."
```

## What to return

The table verbatim (one row per room), then — if any row is **STALE** — the one-line hint to clear it with
`/eject --room <id>`. If no rooms exist, the single "none up" line. Do not kill or remove anything; this is a read-only
view.

## Critical

- **Read-only.** Never `kill`, never `rm`. Stopping a relay is `/eject`'s job.
- Every health probe is bounded (`curl --max-time 1`). Nothing here blocks.
- The room marked `<- you` is this session's (id = `${CLAUDE_CODE_SESSION_ID:0:8}`). Unset session id → no row is marked
  mine (and your own un-namespaced relay, if any, shows as `default`).
- A row that is **STALE** (portfile present, `/health` dead) is a leftover — clear it with `/eject --room <id>` (or
  `/eject` if it's your own `default`).
