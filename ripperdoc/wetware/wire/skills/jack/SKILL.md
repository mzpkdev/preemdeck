---
description: |
  Open a live multi-agent comms session — jack in. Launches the wire bus broker
  DETACHED on this host (0.0.0.0, auto-selecting a free port), prints the one
  curl line to hand a colleague's Claude so they join over the LAN, and joins the
  host's own session as a peer so you can talk too. User-invoked via /jack. One
  process == one conversation; close it with /eject.
user-invocable: true
allowed-tools: [Bash]
---

# Jack

Open a live group chat over the LAN and jack into it yourself. One bus process is one conversation. The host:port IS the
conversation identity — no rooms. The bus auto-selects a free port (base `55555`, scanning upward if busy) and writes
the port it actually bound to `wire/.bus.port`.

## How to run

1. **Refuse to double-start, then launch the bus DETACHED.** It must NOT block this session. If `wire/.bus.port` exists
   and that port answers `/health` with `ok`, a bus is already up — say so and stop. Otherwise start the bus in the
   background, fully detached, with output to a log, passing `55555` as the base port. The bus auto-scans upward for a
   free port and writes both its pidfile (`wire/.bus.pid`) and portfile (`wire/.bus.port`) so `/eject` can find it.

   ```bash
   PLUGIN="${CLAUDE_PLUGIN_ROOT}"
   PORTFILE="$PLUGIN/.bus.port"
   # Refuse to double-start: if a portfile exists and that port is healthy, a bus is already up.
   if [ -f "$PORTFILE" ]; then
     EXIST_PORT="$(cat "$PORTFILE" 2>/dev/null)"
     if [ -n "$EXIST_PORT" ] && curl -s --max-time 1 "http://127.0.0.1:${EXIST_PORT}/health" | grep -q ok; then
       echo "a wire bus is already up on :${EXIST_PORT} — run /eject first, or use it."; exit 0
     fi
   fi
   nohup python3 "$PLUGIN/scripts/bus.py" 0.0.0.0 55555 \
     > "$PLUGIN/.bus.log" 2>&1 < /dev/null &
   disown 2>/dev/null || true
   ```

   The bus binds `0.0.0.0:<free-port>` (base `55555`, scanning up if taken) and writes its pid to `$PLUGIN/.bus.pid` and
   the bound port to `$PLUGIN/.bus.port`.

2. **Wait for the portfile to appear, then health-check that port** (short, bounded — never block):

   ```bash
   PLUGIN="${CLAUDE_PLUGIN_ROOT}"
   PORTFILE="$PLUGIN/.bus.port"
   PORT=""
   for i in $(seq 1 30); do
     [ -f "$PORTFILE" ] && PORT="$(cat "$PORTFILE" 2>/dev/null)" && [ -n "$PORT" ] && break
     sleep 0.2
   done
   if [ -z "$PORT" ]; then
     echo "bus did not write a portfile — startup failed:"; tail -n 20 "$PLUGIN/.bus.log"; exit 1
   fi
   for i in $(seq 1 20); do
     curl -s --max-time 1 "http://127.0.0.1:${PORT}/health" | grep -q ok && { echo "up on :${PORT}"; break; }
     sleep 0.2
   done
   ```

   If it never reports `up`, print the tail of `$PLUGIN/.bus.log` and stop. Use `$PORT` (the bound port) for everything
   below — do NOT assume any fixed port.

3. **Detect this host's LAN IP** (try the common macOS/Linux paths, fall back):

   ```bash
   LAN_IP="$(ipconfig getifaddr en0 2>/dev/null \
     || ipconfig getifaddr en1 2>/dev/null \
     || hostname -I 2>/dev/null | awk '{print $1}' \
     || hostname -i 2>/dev/null)"
   echo "${LAN_IP:-<this-host-LAN-IP>}"
   ```

4. **Print the exact line to hand a colleague.** Substitute the detected IP and the bound `$PORT`:

   ```
   Give your colleague's Claude this:

     Run  curl http://<LAN_IP>:<PORT>/join  — follow its instructions and discuss <your topic>.
   ```

   If on the same machine they can use `localhost` instead of `<LAN_IP>`.

5. **Join the host's own session as a peer** so the host (you) can talk too — against the bound `$PORT`:

   ```bash
   curl -s --max-time 5 "http://127.0.0.1:${PORT}/join"
   ```

   That returns the plain-text manual with YOUR token already filled into the `recv` / `send` / `leave` curls (the
   manual templates the real bound port automatically). Use those to participate. Run `recv` to listen; `send` to post;
   `leave` (or `/eject`) when done.

## What to return

- One line confirming the bus is up (host:port with the real bound port + pid if known).
- The colleague hand-off line with the real LAN IP and bound port filled in.
- The host's own `recv` / `send` / `leave` curl commands (from the manual, token baked in) so the user can talk
  immediately.

## Critical

- The bus MUST be detached — this session cannot block on it. Background + log + `< /dev/null`.
- The bound port is whatever the bus wrote to `wire/.bus.port` — never hardcode a port. Read it from the portfile.
- One bus == one conversation. To start fresh, `/eject` then `/jack` again.
- The conversation auto-closes (and the process exits) on the turn cap, wall-clock cap, repetition kill, or when the
  last peer leaves.
