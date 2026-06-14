#!/usr/bin/env python3
"""
fake_agent.py - a stand-in for a real LLM coding agent, used only for proofs.

It uses the wire relay EXACTLY the way the MANUAL tells a real agent to:
  1. GET /jack                  -> receive the plain-text manual
  2. PARSE the token out of the manual text (just like a real agent reading it)
  3. loop: recv (long-poll /recv) -> maybe send (/send) -> recv -> ...
  4. run unplug (/unplug) when its goal condition is met

It deliberately does NOT get the token from a side channel -- it scrapes it from
the manual's curl lines, proving the manual is self-sufficient. Only urllib
(stdlib) is used, mirroring a curl-only peer. There are NO rooms: the base URL
(host:port) IS the conversation.

Two behaviours, selected by --mode:

  collab  (default): cooperative "count to TARGET" game. Peers read the running
          total off the shared log, each adds +1 on its turn, and whoever posts
          the number that REACHES the target announces done and leaves. This
          exercises group fanout, long-poll wake, and a clean civil leave.

  spammer: never stops, posts a fixed line on every turn. Used to prove the
          relay's turn-cap / repetition force-close. Pass --same to post the
          identical line every time (repetition kill); default appends a counter
          so only the turn cap trips.
"""

import argparse
import json
import random
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any, cast

# A transport failure (connection refused/reset) means the relay process is
# GONE -- and since one relay is one conversation, the conversation is over. We
# map that to a synthetic 409 "conversation closed" so callers stop cleanly via
# the exact same path as a real 409, instead of crashing on an unhandled
# exception. (The relay can exit the instant a cap trips, racing an in-flight
# request.)
_GONE = (409, "conversation closed: relay gone")


def http_get(url: str, timeout: float) -> tuple[int, str]:
    """GET url. Returns (status, text). 204 -> (204, ""). A dead relay -> _GONE."""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, ConnectionError, OSError):
        return _GONE


def http_post(url: str, body: str, timeout: float) -> tuple[int, str]:
    """POST a raw body. Returns (status, text). A dead relay -> _GONE."""
    data = body.encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, ConnectionError, OSError):
        return _GONE


def parse_manual(manual: str) -> tuple[str | None, str, str, str]:
    """Extract (handle, token, base_url, secret) from the manual TEXT, the same
    way a real agent would read its instructions. We pull the token AND the
    shared access key from the recv curl line and the base url from the same
    line. The recv line now looks like:
        recv:  curl -s --max-time 600 "http://h:p/recv?t=ab12cd&k=<secret>"
    A real agent just copy-pastes that whole line (key and all), so the stand-in
    scrapes the key the same way -- the manual stays self-sufficient. secret is
    "" if the manual carries no &k= (older/ungated manual)."""
    handle = None
    m = re.search(r"You are (\S+?)\.", manual)
    if m:
        handle = m.group(1)
    # base + token, stopping the base at the first '?' so the query (t=, k=) is
    # never swallowed into it.
    m = re.search(r'"(http://[^"?]+)/recv\?t=([0-9a-f]+)', manual)
    if not m:
        raise RuntimeError("could not find token/base in manual:\n" + manual)
    base, token = m.group(1), m.group(2)
    # The access key off the same recv line (hex, but match broadly).
    km = re.search(r"/recv\?t=[0-9a-f]+&k=([^\"&\s]+)", manual)
    secret = km.group(1) if km else ""
    return handle, token, base, secret


def log(handle: str | None, msg: str) -> None:
    print(f"  [{handle}] {msg}", flush=True)


def highest_count(msgs: list[dict[str, Any]], exclude: str | None) -> int | None:
    """Return the largest N in any 'count: N' posted by a handle != exclude,
    or None. Used by collab agents to read the running total off the log while
    ignoring their own echoes."""
    best = None
    for m in msgs:
        if m["handle"] == exclude:
            continue
        cm = re.match(r"count:\s*(\d+)", m["body"])
        if cm:
            v = int(cm.group(1))
            best = v if best is None else max(best, v)
    return best


def normalize_recv(text: str) -> list[dict[str, Any]]:
    """Turn a /recv 200 body into a uniform list of {"handle","body"} dicts,
    regardless of which shape the relay sent:

      * a JSON ARRAY of message entries (the normal "here are new messages"
        reply), or
      * a JSON OBJECT {"system": "conversation closed: <reason>"} -- the
        relay's UNAMBIGUOUS terminal signal for an already-closed, drained
        conversation (the deadlock fix: instead of an ambiguous 204, a closed
        conversation says so explicitly so the agent stops instead of re-polling
        forever).

    Either way the caller gets a list it can log and run terminal_signal over,
    so the closed notice is never silently swallowed."""
    obj = json.loads(text)
    if isinstance(obj, dict):
        # The explicit closed payload (or any single system object). Present it
        # as a one-element system message list.
        return [{"handle": "system", "body": obj.get("system", json.dumps(obj))}]
    return cast(list[dict[str, Any]], obj)


def terminal_signal(msgs: list[dict[str, Any]]) -> str | None:
    """Return "closed" if the conversation announced closure, "left" if a peer
    left, else None. Checked after EVERY read (the long-poll recv AND the
    non-blocking drain) so a termination signal is never silently swallowed."""
    for m in msgs:
        if "conversation closed" in m["body"]:
            return "closed"
    for m in msgs:
        if m["handle"] == "system" and "left" in m["body"]:
            return "left"
    return None


def run(base_root: str, mode: str, target: int, max_turns: int, same: bool, kickoff: bool, secret: str) -> None:
    # --- 1. JACK: fetch the manual --------------------------------------
    # /jack is itself behind the soft gate, so the key must ride the jack URL
    # too -- we can't scrape it from the manual we haven't fetched yet. verify.py
    # hands us the per-test secret via --secret; a real agent gets it from the
    # one pasteable jack URL its operator was given.
    kq = f"?k={secret}" if secret else ""
    status, manual = http_get(f"{base_root}/jack{kq}", timeout=10)
    if status != 200:
        # The relay may already be gone (conversation closed before we jacked
        # in) -- that is a clean miss, not a crash: stop quietly with exit 0.
        if status == 409 or "conversation closed" in manual:
            print("  [late] jacked in too late; conversation already closed -> stopping", flush=True)
            return
        print(f"jack failed: {status} {manual}", file=sys.stderr)
        sys.exit(1)
    handle, token, base, manual_secret = parse_manual(manual)
    # Prefer the explicitly-passed secret; fall back to whatever the manual baked
    # into its curls (a real agent would just reuse the manual's filled-in key).
    secret = secret or manual_secret
    log(handle, f"jacked in (token={token}) via manual")

    kk = f"&k={secret}" if secret else ""
    recv_url = f"{base}/recv?t={token}{kk}&wait=30"
    drain_url = f"{base}/recv?t={token}{kk}&wait=0"  # non-blocking peek
    send_url = f"{base}/send?t={token}{kk}"
    leave_url = f"{base}/unplug?t={token}{kk}"
    leave_done = f"{base}/unplug?t={token}{kk}&reason=done"

    turns_taken = 0
    last_seen = 0  # highest 'count: N' value WE have acted on (any author)

    # --- opening post --------------------------------------------------
    # Someone has to speak first or every peer's recv just long-polls an empty
    # log forever. In collab, exactly one agent is told (--kickoff) to open --
    # mirroring a human saying "you start". In spammer mode every agent opens
    # immediately (the whole point is runaway chatter the relay must stop).
    if mode == "collab" and kickoff:
        http_post(send_url, "count: 1", timeout=10)
        log(handle, "kicked off with 'count: 1'")
        last_seen = 1
    elif mode == "spammer":
        turns_taken += 1
        body = "spam: identical line" if same else f"spam line {turns_taken} from {handle}"
        st, _ = http_post(send_url, body, timeout=10)
        log(handle, f"send -> {body} (http {st})")
        if st == 409:
            # Conversation was already force-closed before we got a word in.
            log(handle, "send rejected 409 (conversation closed) -> stopping")
            return

    while True:
        # --- 2/3. RECV: long-poll for new messages ----------------------
        status, text = http_get(recv_url, timeout=40)

        if status == 204:
            # Nothing new before the poll timed out -- the manual says so:
            # just run recv again.
            continue
        if status != 200:
            log(handle, f"recv got HTTP {status}: {text.strip()[:80]} -> stopping")
            break

        msgs = normalize_recv(text)
        for m in msgs:
            log(handle, f"recv <- {m['handle']}: {m['body']}")

        # Check terminal signals after the long-poll read.
        sig = terminal_signal(msgs)
        if sig == "closed":
            log(handle, "conversation closed by relay -> stopping")
            break
        if sig == "left" and mode == "collab":
            # A peer left -> the goal was reached -> we leave too. This is the
            # clean cascade stop.
            log(handle, "a peer left (goal reached) -> leaving")
            http_get(leave_url, timeout=10)
            break

        if mode == "collab":
            # React only to numbers from OTHER peers -- ignore our own echoes
            # (the shared log fans every post back to its author too). This is
            # genuine turn-taking, not one agent racing solo.
            current = highest_count(msgs, exclude=handle)
            if current is None or current <= last_seen:
                continue  # nothing new from a peer to respond to
            last_seen = current

            if current >= target:
                # The target number is on the log. Announce done + leave; the
                # relay posts our "left" notice, which tells the others to
                # leave too -- proving a clean cascade stop.
                log(handle, f"target {target} reached -> announcing done + leaving")
                http_post(send_url, f"reached {target}. done -- leaving.", timeout=10)
                http_get(leave_done, timeout=10)
                break

            # Two peers can wake on the same number. Jitter, then do a
            # non-blocking drain (wait=0) to see if a peer already posted the
            # next value; if so, skip our turn. This keeps the count clean
            # without needing peer identities to assign turns.
            time.sleep(0.1 + random.random() * 0.3)
            st, drained = http_get(drain_url, timeout=5)
            if st == 200 and drained:
                dmsgs = normalize_recv(drained)
                for m in dmsgs:
                    log(handle, f"recv <- {m['handle']}: {m['body']}")
                # CRITICAL: the drain advances our cursor, so it -- not the next
                # long-poll -- may be what carries the closure / "left" notice.
                # Honor it here or the agent would park forever on a dead convo.
                dsig = terminal_signal(dmsgs)
                if dsig == "closed":
                    log(handle, "conversation closed by relay (seen on drain) -> stopping")
                    break
                if dsig == "left":
                    log(handle, "a peer left (seen on drain) -> leaving")
                    http_get(leave_url, timeout=10)
                    break
                newer = highest_count(dmsgs, exclude=handle)
                if newer is not None and newer > current:
                    last_seen = newer
                    continue  # a peer already advanced the count; yield our turn

            nxt = current + 1
            st, _ = http_post(send_url, f"count: {nxt}", timeout=10)
            log(handle, f"send -> count: {nxt} (http {st})")
            last_seen = nxt
            turns_taken += 1

        elif mode == "spammer":
            # The spammer never CHOOSES to stop on its own -- the relay MUST
            # force-close it. But it is not a runaway zombie: it stops the
            # instant the relay tells it the conversation is over. Two signals:
            #   (a) the recv above returned the closure notice -> handled by the
            #       `sig == "closed"` break before we get here, and
            #   (b) /send is rejected with HTTP 409 (already closed) -> we break
            #       here. A single 409 ends it immediately, so no agent spins on
            #       a dead conversation.
            turns_taken += 1
            body = "spam: identical line" if same else f"spam line {turns_taken} from {handle}"
            st, _ = http_post(send_url, body, timeout=10)
            log(handle, f"send -> {body} (http {st})")
            if st == 409:
                log(handle, "send rejected 409 (conversation closed) -> stopping")
                break
            # Backstop only -- the relay's caps should already have closed the
            # conversation (and our recv/409 checks should have stopped us).
            if turns_taken > max_turns + 20:
                log(handle, "safety stop (relay should have closed already)")
                break


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8765")
    ap.add_argument("--mode", choices=["collab", "spammer"], default="collab")
    ap.add_argument("--target", type=int, default=6, help="collab: count to reach")
    ap.add_argument("--max-turns", type=int, default=50, help="spammer self-stop guard")
    ap.add_argument("--same", action="store_true", help="spammer: post identical line each time")
    ap.add_argument("--kickoff", action="store_true", help="collab: this agent opens the discussion")
    ap.add_argument("--secret", default="", help="shared access key (?k=) -- gates /jack and all calls")
    args = ap.parse_args()
    run(args.base, args.mode, args.target, args.max_turns, args.same, args.kickoff, args.secret)


if __name__ == "__main__":
    main()
