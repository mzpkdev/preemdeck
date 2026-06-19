"""API tests — the HTTP layer over the frozen room core.

Drives create_app() through FastAPI's TestClient: the ungated probes, the
one-status-401 contract (three distinct bodies), the jackin -> send -> recv
loop, jackout, and the heartbeat. recv tests use wait=0 to stay fast — the
parked-wake concurrency is already proven at the unit layer (test_room.py).
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import signal
import time

import pytest
from fastapi.testclient import TestClient
from wire.app import _default_shutdown, _lifespan, _reaper_loop, create_app
from wire.config import Config
from wire.room import Room

SECRET = "s3cret"
TOPIC = "test room"
PUBLIC_URL = "https://wire.example.com"

# ISO-8601 UTC, second precision, Z-suffixed: e.g. 2026-06-18T13:57:02Z.
_ISO_UTC_Z_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


@pytest.fixture
def client() -> TestClient:
    app = create_app(Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC))
    return TestClient(app)


@pytest.fixture
def client_public() -> TestClient:
    # A room behind a declared public base URL (e.g. a tunnel). Every URL a peer
    # reads must be emitted against PUBLIC_URL, not the TestClient request base.
    app = create_app(Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC, public_url=PUBLIC_URL))
    return TestClient(app)


# -- ungated probes -------------------------------------------------------


def test_health(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_schema_is_openapi(client: TestClient):
    r = client.get("/schema")
    assert r.status_code == 200
    doc = r.json()
    assert doc["openapi"].startswith("3.")
    assert "/jackin" in doc["paths"]
    assert "/recv" in doc["paths"]


# -- /shard (markdown, self-checked secret) -------------------------------


def test_shard_wrong_secret_401_markdown(client: TestClient):
    r = client.get("/shard", params={"secret": "wrong"})
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.text == "You are not authorized to view this resource, your secret is invalid."
    # markdown body, so the machine-readable code rides a response header
    assert r.headers["x-wire-error"] == "invalid_secret"


def test_shard_missing_secret_401_markdown(client: TestClient):
    r = client.get("/shard")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.headers["x-wire-error"] == "invalid_secret"


def test_shard_correct_secret_200_markdown(client: TestClient):
    r = client.get("/shard", params={"secret": SECRET})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.text.startswith("# WIRE")
    # $URL/$SECRET are now interpolated server-side: with no public_url, the
    # manual carries the concrete request base (TestClient's http://testserver)
    # and the real secret — the literal placeholders are gone.
    assert "http://testserver" in r.text
    assert SECRET in r.text
    assert "$URL" not in r.text
    assert "$SECRET" not in r.text
    # $TOKEN stays literal — it's unknown until /jackin mints one.
    assert "$TOKEN" in r.text


# -- /jackin secret gate --------------------------------------------------


def test_jackin_wrong_secret_401(client: TestClient):
    r = client.post("/jackin", params={"secret": "wrong"})
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid secret", "code": "invalid_secret"}


def test_jackin_missing_secret_401(client: TestClient):
    r = client.post("/jackin")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid secret", "code": "invalid_secret"}


def test_jackin_correct_secret_200(client: TestClient):
    r = client.post("/jackin", params={"secret": SECRET})
    assert r.status_code == 200
    body = r.json()
    token = body["token"]
    assert token
    assert body["conversation_topic"] == TOPIC
    assert body["peers"] == ["peer-1"]
    # actions: send (POST, with body) + recv (GET); URLs carry the real token
    actions = body["actions"]
    assert len(actions) == 2
    send_action, recv_action = actions
    assert send_action["method"] == "POST"
    assert send_action["url"].endswith(f"/send?token={token}")
    assert send_action["body"] == "<message>"
    assert recv_action["method"] == "GET"
    assert recv_action["url"].endswith(f"/recv?token={token}")


# -- optional self-naming at /jackin --------------------------------------


def test_jackin_with_name_is_suffixed(client: TestClient):
    # every name is <base>-<n>; the first alice lands on alice-1
    r = client.post("/jackin", params={"secret": SECRET, "name": "alice"})
    assert r.status_code == 200
    body = r.json()
    assert body["you_are"] == "alice-1"
    assert body["peers"] == ["alice-1"]


def test_jackin_name_is_normalized(client: TestClient):
    # Requested names are normalized: trimmed, lowercased, inner whitespace and
    # underscores -> -, slugified, then -<n> appended. "  My Agent  " -> my-agent-1.
    r = client.post("/jackin", params={"secret": SECRET, "name": "  My Agent  "})
    assert r.status_code == 200
    assert r.json()["you_are"] == "my-agent-1"


def test_jackin_repeated_name_increments_n(client: TestClient):
    first = client.post("/jackin", params={"secret": SECRET, "name": "alice"})
    assert first.json()["you_are"] == "alice-1"
    second = client.post("/jackin", params={"secret": SECRET, "name": "alice"})
    assert second.status_code == 200
    assert second.json()["you_are"] == "alice-2"


def test_jackin_no_name_gives_peer_n(client: TestClient):
    r1 = client.post("/jackin", params={"secret": SECRET})
    assert r1.status_code == 200
    assert r1.json()["you_are"] == "peer-1"
    r2 = client.post("/jackin", params={"secret": SECRET})
    assert r2.json()["you_are"] == "peer-2"


def test_jackin_name_requires_secret(client: TestClient):
    # the name param does not bypass the secret gate — 401 contract untouched
    r = client.post("/jackin", params={"name": "alice"})
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid secret", "code": "invalid_secret"}


def test_schema_documents_jackin_name_param(client: TestClient):
    doc = client.get("/schema").json()
    params = doc["paths"]["/jackin"]["post"].get("parameters", [])
    name = next((p for p in params if p["name"] == "name" and p["in"] == "query"), None)
    assert name is not None, "name query param missing on /jackin"
    assert name.get("required", False) is False  # optional
    # the description documents the always-suffixed <name>-<n> scheme
    assert "<name>-<n>" in name.get("description", "")


# -- one-401 contract: token endpoints with a bogus token -----------------


def test_recv_bogus_token_401(client: TestClient):
    r = client.get("/recv", params={"token": "nope"})
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token", "code": "invalid_token"}


def test_send_bogus_token_401(client: TestClient):
    r = client.post("/send", params={"token": "nope"}, content=b"hi")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token", "code": "invalid_token"}


def test_jackout_bogus_token_401(client: TestClient):
    r = client.post("/jackout", params={"token": "nope"})
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token", "code": "invalid_token"}


def test_recv_missing_token_401(client: TestClient):
    r = client.get("/recv")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token", "code": "invalid_token"}


# -- guardrail: a MISSING credential must 401, never FastAPI's auto-422.
# The doc marks secret/token required, but the signatures stay optional so the
# handler sees None and returns 401. These pin that the params did NOT become
# required Query(...) params (which would auto-422 a missing one).


def test_send_missing_token_401_not_422(client: TestClient):
    r = client.post("/send", content=b"hi")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token", "code": "invalid_token"}


def test_jackout_missing_token_401_not_422(client: TestClient):
    r = client.post("/jackout")
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid token", "code": "invalid_token"}


# -- the loop: jackin x2, send, recv --------------------------------------


def _jackin(client: TestClient) -> str:
    r = client.post("/jackin", params={"secret": SECRET})
    assert r.status_code == 200
    return r.json()["token"]


def test_send_recv_loop(client: TestClient):
    # /jackin tells each joiner its own seat via you_are, in join order
    r1 = client.post("/jackin", params={"secret": SECRET})
    assert r1.json()["you_are"] == "peer-1"
    t1 = r1.json()["token"]
    r2 = client.post("/jackin", params={"secret": SECRET})
    assert r2.json()["you_are"] == "peer-2"
    t2 = r2.json()["token"]

    # peer-1 sends a raw-text message. Two joins already took stream id 1,2, so
    # the message's event id is 3 — but it's the FIRST chat message, so its own
    # message seq is 1. /send returns BOTH numbers.
    r = client.post("/send", params={"token": t1}, content=b"hello peer-2")
    assert r.status_code == 200
    assert r.json() == {"id": 3, "seq": 1}

    # peer-2 reads it (non-blocking wait=0). Its stream also carries peer-1's
    # earlier join (id 1); peer-2's own join (id 2) is filtered. Pick the message.
    r = client.get("/recv", params={"token": t2, "wait": 0})
    assert r.status_code == 200
    body = r.json()
    msgs = [e for e in body["events"] if e["type"] == "message"]
    assert len(msgs) == 1
    msg = msgs[0]
    # sent_at is nondeterministic wall-clock — assert the stable fields exactly,
    # then the timestamp by FORMAT/presence (regex), not by value. The event id
    # is the stream position (3); the chat-only seq+body live nested under message.
    assert {k: msg[k] for k in ("id", "type", "from", "message")} == {
        "id": 3,
        "type": "message",
        "from": "peer-1",
        "message": {"seq": 1, "body": "hello peer-2"},
    }
    # CLEAN per-type: a message event has no presence field
    assert "peer" not in msg
    assert _ISO_UTC_Z_RE.match(msg["sent_at"]), msg["sent_at"]
    # peer-2 also sees peer-1's join, clean per-type (no message fields)
    join = next(e for e in body["events"] if e["type"] == "action(join)")
    assert {k: join[k] for k in ("id", "type", "peer")} == {"id": 1, "type": "action(join)", "peer": "peer-1"}
    assert "from" not in join and "message" not in join
    assert set(body["peers"]) == {"peer-1", "peer-2"}
    # peer-2 just read peer-1's last message, but that's reported to the SENDER:
    # peer-2 itself hasn't sent anything, so its own read_your_last_message is empty
    assert body["read_your_last_message"] == []

    # peer-1 polls: it must NOT see its own message echoed back (no-echo) nor its
    # own join; peer-2's join (seq2) is about peer-2, so peer-1 does see that.
    r = client.get("/recv", params={"token": t1, "wait": 0})
    assert r.status_code == 200
    body = r.json()
    assert [e for e in body["events"] if e["type"] == "message"] == []
    assert [(e["type"], e["peer"]) for e in body["events"]] == [("action(join)", "peer-2")]
    assert body["read_your_last_message"] == ["peer-2"]


# -- sent_at on a delivered message ---------------------------------------


def test_recv_message_carries_sent_at(client: TestClient):
    # After send -> recv, the delivered message carries sent_at in ISO-8601 UTC,
    # second precision, Z-form. Format/presence (regex), not an exact value.
    t1 = _jackin(client)  # peer-1
    t2 = _jackin(client)  # peer-2
    client.post("/send", params={"token": t1}, content=b"timestamped")
    r = client.get("/recv", params={"token": t2, "wait": 0})
    assert r.status_code == 200
    msgs = [e for e in r.json()["events"] if e["type"] == "message"]
    assert msgs, "expected one message event"
    sent_at = msgs[0]["sent_at"]
    assert sent_at is not None
    assert _ISO_UTC_Z_RE.match(sent_at), sent_at


# -- jackout drops from the roster but keeps the token alive ---------------


def test_jackout_drops_from_roster(client: TestClient):
    t1 = _jackin(client)  # peer-1
    t2 = _jackin(client)  # peer-2

    r = client.post("/jackout", params={"token": t2})
    assert r.status_code == 200
    assert r.json() == {"left": "peer-2"}

    # peer-2 is gone from the roster (peer-1 reads the live roster)
    body = client.get("/recv", params={"token": t1, "wait": 0}).json()
    assert body["peers"] == ["peer-1"]


def test_jackout_token_still_works_and_rejoins(client: TestClient):
    # Tokens are immortal: after jackout the SAME token still works on every
    # gated endpoint (no dead-token 401), and a token-bearing call rejoins the
    # peer to the roster.
    t1 = _jackin(client)  # peer-1
    t2 = _jackin(client)  # peer-2
    client.post("/jackout", params={"token": t2})

    # /send with the jacked-out token succeeds (and rejoins peer-2)
    r = client.post("/send", params={"token": t2}, content=b"back again")
    assert r.status_code == 200
    assert "seq" in r.json()

    # peer-2 is back in the roster, seen by peer-1
    body = client.get("/recv", params={"token": t1, "wait": 0}).json()
    assert "peer-2" in body["peers"]

    # /recv and /jackout with the same token are likewise accepted (200, not 401)
    assert client.get("/recv", params={"token": t2, "wait": 0}).status_code == 200
    assert client.post("/jackout", params={"token": t2}).status_code == 200


# -- presence events over HTTP --------------------------------------------


def test_recv_shows_join_clean_per_type(client: TestClient):
    # alice in; bob joins -> alice's recv carries a clean action(join), no nulls.
    ta = _jackin(client)  # peer-1
    client.get("/recv", params={"token": ta, "wait": 0})  # drain (own join filtered -> empty)
    _jackin(client)  # peer-2 joins
    r = client.get("/recv", params={"token": ta, "wait": 0})
    assert r.status_code == 200
    joins = [e for e in r.json()["events"] if e["type"] == "action(join)"]
    assert len(joins) == 1
    join = joins[0]
    # exactly id/type/peer/sent_at — NO null padding (no `from`, no `message`)
    assert set(join.keys()) == {"id", "type", "peer", "sent_at"}
    assert join["type"] == "action(join)"
    assert join["peer"] == "peer-2"
    assert _ISO_UTC_Z_RE.match(join["sent_at"]), join["sent_at"]


def test_recv_shows_leave_clean_per_type(client: TestClient):
    ta = _jackin(client)  # peer-1
    tb = _jackin(client)  # peer-2
    client.get("/recv", params={"token": ta, "wait": 0})  # drain peer-2's join
    r = client.post("/jackout", params={"token": tb})
    assert r.json() == {"left": "peer-2"}
    r = client.get("/recv", params={"token": ta, "wait": 0})
    assert r.status_code == 200
    leaves = [e for e in r.json()["events"] if e["type"] == "action(leave)"]
    assert len(leaves) == 1
    leave = leaves[0]
    assert set(leave.keys()) == {"id", "type", "peer", "sent_at"}
    assert leave["type"] == "action(leave)"
    assert leave["peer"] == "peer-2"


def test_peer_never_sees_its_own_join(client: TestClient):
    # peer-1's own join is never in peer-1's stream; once peer-2 joins, peer-1
    # sees peer-2's join but still never its own.
    ta = _jackin(client)  # peer-1
    r = client.get("/recv", params={"token": ta, "wait": 0})
    assert r.json()["events"] == []  # own join filtered -> empty
    _jackin(client)  # peer-2
    r = client.get("/recv", params={"token": ta, "wait": 0})
    peers_in_events = {e.get("peer") for e in r.json()["events"] if e["type"].startswith("action")}
    assert "peer-1" not in peers_in_events  # never its own join
    assert peers_in_events == {"peer-2"}


def test_third_peer_backfills_others_join_and_leave(client: TestClient):
    # The positive side of self-filter: a fresh peer-3 sees peer-1's & peer-2's
    # joins and peer-2's leave on its backfill, but never its own join.
    _jackin(client)  # peer-1
    tb = _jackin(client)  # peer-2
    client.post("/jackout", params={"token": tb})  # peer-2 leaves
    tc = _jackin(client)  # peer-3, fresh -> backfills the whole stream
    r = client.get("/recv", params={"token": tc, "wait": 0})
    about = [(e["type"], e.get("peer")) for e in r.json()["events"] if e["type"].startswith("action")]
    assert ("action(join)", "peer-1") in about
    assert ("action(join)", "peer-2") in about
    assert ("action(leave)", "peer-2") in about
    assert ("action(join)", "peer-3") not in about  # never its own


def test_recv_late_joiner_backfills_join_and_message(client: TestClient):
    # alice joins + sends; bob joins late -> bob backfills alice's join + message.
    ta = _jackin(client)  # peer-1
    client.post("/send", params={"token": ta}, content=b"early")
    tb = _jackin(client)  # peer-2, late
    r = client.get("/recv", params={"token": tb, "wait": 0})
    body = r.json()
    shape = [(e["id"], e["type"]) for e in body["events"]]
    # peer-1's join (id 1), then peer-1's message (id 2); peer-2's own join filtered
    assert shape == [(1, "action(join)"), (2, "message")]


def test_message_seq_is_contiguous_while_event_id_straddles_a_join(client: TestClient):
    # The id-vs-seq contract, end to end over HTTP. A presence event wedged
    # between two chat messages bumps the room-wide event `id` but NOT the
    # chat-only `message.seq`: so the two messages' seq are contiguous (1, 2)
    # while their event ids straddle the join (non-contiguous). The wedge is pure
    # presence (B leaves + rejoins via /recv, NO chat message), so the chat
    # counter sees only A's two sends — seq is the gap-free message number.
    #
    # Stream the third peer backfills:
    #   id 1  action(join)  peer-1       <- A jackin
    #   id 2  action(join)  peer-2       <- B jackin
    #   id 3  message seq 1 "ping"       <- A's first send
    #   id 4  action(leave) peer-2       <- B jacks out (wedge: leave)
    #   id 5  action(join)  peer-2       <- B's /recv rejoins it (wedge: join, NO message)
    #   id 6  message seq 2 "pong"       <- A's second send (seq 2 — gap-free)
    ta = _jackin(client)  # peer-1 (A) -> join id 1
    tb = _jackin(client)  # peer-2 (B) -> join id 2

    first = client.post("/send", params={"token": ta}, content=b"ping")  # id 3, seq 1
    assert first.json() == {"id": 3, "seq": 1}

    # B leaves, then a token-bearing /recv rejoins B — wedging leave(id 4) +
    # join(id 5) into the stream between A's two messages, with NO chat message
    # of its own, so the chat-only seq counter is untouched by the churn.
    client.post("/jackout", params={"token": tb})  # id 4: action(leave) peer-2
    client.get("/recv", params={"token": tb, "wait": 0})  # id 5: action(join) peer-2 (rejoin)

    second = client.post("/send", params={"token": ta}, content=b"pong")  # id 6, seq 2
    # event id jumped 3 -> 6 (presence churn burned ids 4 & 5), but the chat-only
    # seq only climbed 1 -> 2: gap-free regardless of the joins/leaves between.
    assert second.json() == {"id": 6, "seq": 2}

    # A fresh third peer backfills the whole stream and sees A's two messages with
    # message.seq == 1 then 2 (CONTIGUOUS) while their event ids are 3 and 6
    # (NON-contiguous — straddling the wedged leave/join).
    tc = _jackin(client)  # peer-3 (C), fresh observer
    body = client.get("/recv", params={"token": tc, "wait": 0}).json()
    a_msgs = [e for e in body["events"] if e["type"] == "message" and e["from"] == "peer-1"]
    assert [m["message"]["seq"] for m in a_msgs] == [1, 2]  # gap-free chat counter
    assert [m["id"] for m in a_msgs] == [3, 6]  # event ids straddle the join
    assert [m["message"]["body"] for m in a_msgs] == ["ping", "pong"]
    # the wedged join/leave about peer-2 really did land between the two messages
    p2_presence = [e["id"] for e in body["events"] if e.get("peer") == "peer-2"]
    assert p2_presence == [2, 4, 5]  # initial join, the wedge leave, the wedge rejoin


# -- heartbeat ------------------------------------------------------------


def test_heartbeat_empty_events(client: TestClient):
    # A lone peer's own join is filtered, so a wait=0 recv returns empty events.
    t1 = _jackin(client)
    r = client.get("/recv", params={"token": t1, "wait": 0})
    assert r.status_code == 200
    body = r.json()
    assert body["events"] == []
    assert body["peers"] == ["peer-1"]
    assert body["read_your_last_message"] == []


# -- /schema is honest and self-explaining --------------------------------


def test_schema_documents_send_body(client: TestClient):
    doc = client.get("/schema").json()
    rb = doc["paths"]["/send"]["post"]["requestBody"]
    assert rb["required"] is True
    assert "text/plain" in rb["content"]
    assert rb["content"]["text/plain"]["schema"]["type"] == "string"
    assert "@peer" in rb["description"]


def test_schema_marks_credentials_required(client: TestClient):
    doc = client.get("/schema").json()
    paths = doc["paths"]

    def required(path: str, method: str, name: str) -> bool:
        for p in paths[path][method].get("parameters", []):
            if p["name"] == name and p["in"] == "query":
                return p.get("required", False)
        raise AssertionError(f"{name} param missing on {method} {path}")

    assert required("/jackin", "post", "secret")
    assert required("/shard", "get", "secret")
    assert required("/send", "post", "token")
    assert required("/recv", "get", "token")
    assert required("/jackout", "post", "token")


def test_schema_gated_routes_document_401(client: TestClient):
    doc = client.get("/schema").json()
    paths = doc["paths"]
    for path, method in (
        ("/shard", "get"),
        ("/jackin", "post"),
        ("/send", "post"),
        ("/recv", "get"),
        ("/jackout", "post"),
    ):
        assert "401" in paths[path][method]["responses"]


def test_schema_401_descriptions_name_the_codes(client: TestClient):
    # /schema's 401 descriptions should surface the machine-readable codes a
    # peer can branch on, per route.
    doc = client.get("/schema").json()
    paths = doc["paths"]

    def desc(path: str, method: str) -> str:
        return paths[path][method]["responses"]["401"]["description"]

    # secret gate -> invalid_secret (JSON on /jackin, header on /shard)
    assert "invalid_secret" in desc("/jackin", "post")
    assert "invalid_secret" in desc("/shard", "get")
    # token gates -> invalid_token only. Tokens are immortal (neither jackout
    # nor an idle drop retires one), so the removed dead_token code must NOT
    # appear in the advertised schema.
    for path, method in (("/send", "post"), ("/recv", "get"), ("/jackout", "post")):
        assert "invalid_token" in desc(path, method)
        assert "dead_token" not in desc(path, method)


def test_schema_carries_descriptions(client: TestClient):
    doc = client.get("/schema").json()
    paths = doc["paths"]
    # every route has a description
    for path, method in (
        ("/health", "get"),
        ("/shard", "get"),
        ("/jackin", "post"),
        ("/jackout", "post"),
        ("/send", "post"),
        ("/recv", "get"),
    ):
        assert paths[path][method].get("description")
    # the wait param is described
    wait = next(p for p in paths["/recv"]["get"]["parameters"] if p["name"] == "wait")
    assert wait.get("description")
    # response fields are described, incl. the semantics-bearing ones
    schemas = doc["components"]["schemas"]
    assert schemas["JackinResponse"]["properties"]["you_are"].get("description")
    # the message event still emits `from` (aliased) and describes it
    assert schemas["MessageEvent"]["properties"]["from"].get("description")
    # the presence event models join/leave with a `peer` and a `type` discriminator
    assert schemas["PresenceEvent"]["properties"]["peer"].get("description")
    assert schemas["PresenceEvent"]["properties"]["type"].get("description")
    # the events field is described and explains the type-branching
    events_desc = schemas["RecvResponse"]["properties"]["events"]["description"]
    assert "type" in events_desc
    rylm = schemas["RecvResponse"]["properties"]["read_your_last_message"]["description"]
    assert "read-cursor" in rylm and "receipt" in rylm


# -- the live reaper: background task + lifespan --------------------------
#
# These prove Phase 2 wiring end to end: that entering the app's lifespan
# launches the background sweeper, that a peer which never polls actually
# DROPS (and a leave is observable on the stream), that the task cancels
# cleanly on shutdown (no pending-task warning), and that idle_timeout==0
# starts no task. The drop is forced FAST without sleeping past wait_max by
# swapping the room clock seam (room._now) to a far-future instant, so the
# next ~1s sweep tick sees the silent peer as idle.


def _idle_app():
    # Small values that satisfy the Room invariant (idle_timeout > wait_max).
    # sweep_interval=1 keeps the live tick quick; the clock-seam swap is what
    # makes the drop deterministic rather than the 2s timeout elapsing for real.
    config = Config(
        host="127.0.0.1",
        port=0,
        secret=SECRET,
        topic=TOPIC,
        wait_default=1,
        wait_max=1,
        idle_timeout=2,
        sweep_interval=1,
    )
    return create_app(config)


def test_idle_reaper_drops_silent_peer_live(recwarn):
    app = _idle_app()
    # Entering the context runs the app's lifespan startup -> the background
    # reaper task is now live; exiting runs shutdown -> the task is cancelled.
    with TestClient(app) as client:
        # peer-1 jacks in and then goes silent (never polls).
        t1 = client.post("/jackin", params={"secret": SECRET}).json()["token"]
        assert "peer-1" in app.state.room.peers()

        # Force every existing peer to look idle on the next sweep by jumping the
        # clock seam far past idle_timeout. (last_active was stamped at ~0.)
        app.state.room._now = lambda: 1e9

        # The live background task sweeps every ~1s. Poll the roster (bounded) for
        # the silent peer to vanish — proves the task is actually running, not
        # just that reap_idle works.
        deadline = time.monotonic() + 5.0
        while "peer-1" in app.state.room.peers() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert "peer-1" not in app.state.room.peers(), "silent peer was not reaped by the live task"

        # The drop is observable on the stream as an action(leave). A freshly
        # jacked-in observer is stamped at the (far-future) clock, so it survives
        # the same sweep and can read the backfilled leave about peer-1. wait=0
        # keeps it non-blocking.
        t_obs = client.post("/jackin", params={"secret": SECRET}).json()["token"]
        body = client.get("/recv", params={"token": t_obs, "wait": 0}).json()
        leaves = [e for e in body["events"] if e["type"] == "action(leave)" and e["peer"] == "peer-1"]
        assert leaves, f"no action(leave) for peer-1 observed: {body['events']}"
        # peer-1's token is immortal — a later call just rejoins it, never 401s.
        assert client.get("/recv", params={"token": t1, "wait": 0}).status_code == 200

    # After the context exits, shutdown must have cancelled the reaper cleanly:
    # no "Task was destroyed but it is pending" RuntimeWarning leaked.
    pending = [w for w in recwarn.list if "was destroyed but it is pending" in str(w.message)]
    assert not pending, f"reaper task leaked past shutdown: {[str(w.message) for w in pending]}"


def test_idle_disabled_starts_no_reaper():
    # idle_timeout == 0 disables idle drop: no background task, and a silent peer
    # is never dropped even after the clock jumps far past any timeout.
    config = Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC, idle_timeout=0)
    app = create_app(config)
    with TestClient(app) as client:
        client.post("/jackin", params={"secret": SECRET})
        assert "peer-1" in app.state.room.peers()
        app.state.room._now = lambda: 1e9
        # Give any (erroneously-started) sweeper several ticks to misbehave.
        time.sleep(0.3)
        assert "peer-1" in app.state.room.peers()


# ========================================================================
# PHASE 3 — HTTP-level hardening: the parked-poller invariant end to end over
# the live reaper (GAP 1), and the full user-story acceptance test (GAP 6).
# ========================================================================


# -- GAP 1 (HTTP): a genuinely parked /recv survives a real sweep ----------


def test_parked_recv_survives_live_reaper_over_http():
    # The marquee invariant, end to end, with the entry stamp as the SOLE
    # protector. With wait_max=1, idle_timeout=2, sweep_interval=1, a peer that
    # genuinely PARKS in /recv across the wait_max window is NOT reaped. To make
    # the entry stamp load-bearing (not the fresh jackin stamp), we jump the
    # clock seam to a fixed far-future instant BEFORE parking: the jackin/drain
    # stamps (taken at near-zero monotonic) are now wildly stale and WOULD be
    # reaped, but the park's recv-ENTRY stamp is taken at that same far-future
    # instant, so the ~1s sweep firing mid-park sees it as fresh (delta ~0) and
    # leaves it alone. It must heartbeat empty, NOT 401, and stay in the roster.
    app = _idle_app()  # wait_default=1, wait_max=1, idle_timeout=2, sweep_interval=1
    with TestClient(app) as client:
        t1 = client.post("/jackin", params={"secret": SECRET}).json()["token"]
        client.post("/jackin", params={"secret": SECRET})  # peer-2 anchor
        # drain peer-1's backlog (peer-2's join) so its next recv genuinely parks
        client.get("/recv", params={"token": t1, "wait": 0})

        # Freeze the clock far in the future. Existing stamps are now stale; only
        # a fresh stamp taken AT this instant survives a sweep. The park's entry
        # stamp is taken here, so peer-1 must survive purely on it.
        app.state.room._now = lambda: 1e9

        # peer-1 parks for the full wait_max window (1s); the background reaper
        # ticks at ~1s during the hold. Survives only via the entry stamp.
        r = client.get("/recv", params={"token": t1, "wait": 1})
        assert r.status_code == 200  # never 401, and the park returned

        # The sweep demonstrably FIRED mid-park: it reaped the stale anchor
        # peer-2, whose action(leave) woke peer-1 (proving a real sweep ran
        # while peer-1 was parked — this isn't a vacuous pass).
        events = r.json()["events"]
        assert any(e["type"] == "action(leave)" and e["peer"] == "peer-2" for e in events), (
            f"expected the mid-park sweep to reap the stale anchor: {events}"
        )
        # peer-1 SURVIVED that same sweep purely on its entry stamp: still in the
        # roster, and it never received a leave about ITSELF.
        assert "peer-1" in app.state.room.peers(), "a parked long-poller was wrongly reaped"
        assert not any(e["type"] == "action(leave)" and e["peer"] == "peer-1" for e in events)


# -- GAP 6: the end-to-end acceptance story (the whole spec, one test) -----


def test_end_to_end_idle_drop_rejoin_story():
    # The user's full spec in one flow:
    #   jackin -> go idle -> reaped (leave seen by an observer)
    #          -> same token /send -> rejoined (join seen) -> SAME name
    #          -> the token NEVER 401s anywhere in the cycle.
    # Drop is forced deterministically via the clock seam (no real idle wait),
    # while the live background task is what actually performs the reap.
    app = _idle_app()
    with TestClient(app) as client:
        # 1) jackin with a requested name so we can pin name STABILITY later.
        r = client.post("/jackin", params={"secret": SECRET, "name": "alice"})
        assert r.status_code == 200
        t_alice = r.json()["token"]
        assert r.json()["you_are"] == "alice-1"

        # an observer that will witness alice's leave/join on the shared stream
        t_obs = client.post("/jackin", params={"secret": SECRET, "name": "bob"}).json()["token"]
        client.get("/recv", params={"token": t_obs, "wait": 0})  # drain alice's join

        # token works before going idle (sanity: never a 401)
        assert client.get("/recv", params={"token": t_alice, "wait": 0}).status_code == 200
        assert "alice-1" in app.state.room.peers()

        # 2) go idle: jump the clock seam far past idle_timeout so the next live
        #    sweep sees both existing peers as idle. Re-stamp the observer right
        #    after so it survives the same sweep and can still read the backfill.
        app.state.room._now = lambda: 1e9
        deadline = time.monotonic() + 5.0
        while "alice-1" in app.state.room.peers() and time.monotonic() < deadline:
            time.sleep(0.05)
        # 3) reaped: alice is gone from the roster
        assert "alice-1" not in app.state.room.peers(), "alice was not reaped by the live task"

        # the leave is observable to the observer (re-stamped by its own recv at
        # the far-future clock, so it survives this sweep) via the shared log
        body = client.get("/recv", params={"token": t_obs, "wait": 0}).json()
        leaves = [e for e in body["events"] if e["type"] == "action(leave)" and e["peer"] == "alice-1"]
        assert leaves, f"observer never saw alice's leave: {body['events']}"

        # 4) same token calls /send — it must NOT 401 (immortal token) and the
        #    call rejoins alice to the roster.
        r = client.post("/send", params={"token": t_alice}, content=b"i'm back")
        assert r.status_code == 200, "the immortal token 401'd on /send after a reap"
        assert "seq" in r.json()

        # 5) rejoined: alice is back AND keeps her ORIGINAL name (no alice-2).
        assert "alice-1" in app.state.room.peers()
        assert "alice-2" not in app.state.room.peers()
        assert app.state.room.peer_name_for(t_alice) == "alice-1"

        # the rejoin's action(join) about alice is observable to the observer,
        # and so is the message she then sent
        body = client.get("/recv", params={"token": t_obs, "wait": 0}).json()
        rejoin = [e for e in body["events"] if e["type"] == "action(join)" and e["peer"] == "alice-1"]
        assert rejoin, f"observer never saw alice's rejoin: {body['events']}"
        msgs = [e for e in body["events"] if e["type"] == "message" and e["from"] == "alice-1"]
        assert msgs and msgs[0]["message"] == {"seq": 1, "body": "i'm back"}

        # 6) the token NEVER 401s anywhere in the cycle — every gated endpoint
        #    still accepts it after the full idle->rejoin round trip.
        assert client.get("/recv", params={"token": t_alice, "wait": 0}).status_code == 200
        assert client.post("/send", params={"token": t_alice}, content=b"still here").status_code == 200
        assert client.post("/jackout", params={"token": t_alice}).status_code == 200


# ========================================================================
# PHASE B — empty-room self-close: folded into the background reaper loop.
#
# The reaper now also evaluates room.should_self_close() each tick and, when
# the roster has sat empty past empty_grace, fires an INJECTED shutdown hook
# EXACTLY ONCE and stops. Production wires _default_shutdown (an in-process
# SIGINT uvicorn turns into a graceful shutdown). These tests NEVER fire the
# real SIGINT — that would tear down the pytest runner — they SPY the hook
# and drive the loop with a far-future clock so it's fast (no real grace wait).
# ========================================================================


def _empty_close_app(idle_timeout: int = 0, empty_grace: int = 900):
    # sweep_interval=1 keeps the live tick quick; the clock seam (room._now)
    # jumped far-future is what makes should_self_close() fire on the next tick
    # rather than a real `empty_grace` elapsing. idle_timeout defaults to 0 so
    # the empty-close path is exercised in isolation (reap_idle is a no-op).
    config = Config(
        host="127.0.0.1",
        port=0,
        secret=SECRET,
        topic=TOPIC,
        wait_default=1,
        wait_max=1,
        idle_timeout=idle_timeout,
        sweep_interval=1,
        empty_grace=empty_grace,
    )
    return create_app(config)


# -- (8) the loop FIRES the hook when the room is empty past grace ---------


def test_reaper_loop_fires_shutdown_when_empty_past_grace():
    # Drive _reaper_loop directly with a SPY hook and a far-future clock: the
    # boot-armed empty room is instantly "past grace", so the first tick must
    # call the hook exactly once and then return. We assert the spy fired within
    # a bounded poll and the loop task completed on its own (self-stopped).
    async def _run():
        room = Room(Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC, empty_grace=900))
        room._now = lambda: 1e9  # far future -> empty-since (boot-armed) is past grace
        fired = []
        task = asyncio.create_task(_reaper_loop(room, sweep_interval=0, shutdown=lambda: fired.append(1)))
        try:
            # Bounded wait for the spy to fire (sweep_interval=0 -> next loop turn).
            deadline = time.monotonic() + 5.0
            while not fired and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            assert fired, "loop never fired the shutdown hook on an empty-past-grace room"
            # Fire-once-then-stop: the loop returned itself, not via cancellation.
            await asyncio.wait_for(task, timeout=1.0)
            assert task.done() and not task.cancelled()
            assert fired == [1], f"shutdown hook must fire EXACTLY once, got {len(fired)}"
        finally:
            if not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    asyncio.run(_run())


# -- (8b) the loop does NOT fire while the room is POPULATED ----------------


def test_reaper_loop_does_not_fire_while_populated():
    # Negative test: with a peer present, _empty_since is None, so even at a
    # far-future clock should_self_close() is False and the hook NEVER fires.
    async def _run():
        room = Room(Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC, empty_grace=900))
        await room.jackin()  # a peer is present -> roster not empty
        room._now = lambda: 1e9  # far future, but the room is occupied
        fired = []
        task = asyncio.create_task(_reaper_loop(room, sweep_interval=0, shutdown=lambda: fired.append(1)))
        try:
            # Let many ticks run; a populated room must never trip the close.
            await asyncio.sleep(0.3)
            assert not fired, "loop fired shutdown while a peer was still present"
            assert not task.done(), "loop should still be running over a populated room"
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    asyncio.run(_run())


def test_reaper_loop_does_not_fire_before_grace_elapses():
    # Empty roster, but NOT yet past grace: clock barely advanced (< empty_grace),
    # so should_self_close() is False and the hook stays silent.
    async def _run():
        clock = {"t": 0.0}
        room = Room(
            Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC, empty_grace=900),
            now=lambda: clock["t"],
        )
        # boot-armed empty-since == 0.0; advance only 10s, well under the 900s grace.
        clock["t"] = 10.0
        fired = []
        task = asyncio.create_task(_reaper_loop(room, sweep_interval=0, shutdown=lambda: fired.append(1)))
        try:
            await asyncio.sleep(0.2)
            assert not fired, "loop fired shutdown before the empty grace elapsed"
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    asyncio.run(_run())


# -- (9) the lifespan wires a REAL callable hook without dying -------------


def test_lifespan_wires_real_shutdown_hook():
    """_lifespan defaults its shutdown hook to a real callable (_default_shutdown).

    The REAL process-exit path is intentionally NOT exercised here: invoking
    _default_shutdown raises SIGINT in this process and would tear down the
    pytest runner. We only assert the wiring — that a real callable is the
    default hook and that _default_shutdown is signal.raise_signal(SIGINT)-shaped
    — WITHOUT ever calling it.
    """
    # The default hook is the real one, and it's a callable.
    assert _lifespan.__defaults__ == (_default_shutdown,)
    assert callable(_default_shutdown)

    # _default_shutdown is SIGINT-shaped: it calls signal.raise_signal(SIGINT)
    # and nothing else. We verify by spying signal.raise_signal so the real
    # signal is NEVER delivered to the process.
    raised = []
    real_raise = signal.raise_signal
    signal.raise_signal = lambda sig: raised.append(sig)
    try:
        _default_shutdown()
    finally:
        signal.raise_signal = real_raise
    assert raised == [signal.SIGINT], "the production hook must raise exactly SIGINT"


# -- (10) the start-gate: launch when EITHER reaper job is enabled ----------


def test_empty_close_only_starts_reaper():
    # idle_timeout == 0 but empty_grace > 0: the loop MUST still start (else
    # empty-close never runs). We prove it's live by spying the hook through the
    # lifespan with a far-future clock — the empty room trips the close.
    app = _empty_close_app(idle_timeout=0, empty_grace=900)
    fired = []
    # Re-wire the lifespan with a spy hook so the real SIGINT is never fired.
    app.router.lifespan_context = _lifespan(app.state.room, app.state.config, shutdown=lambda: fired.append(1))
    app.state.room._now = lambda: 1e9  # boot-armed empty room is instantly past grace
    with TestClient(app):
        deadline = time.monotonic() + 5.0
        while not fired and time.monotonic() < deadline:
            time.sleep(0.02)
    assert fired, "reaper did not start (or fire) with idle_timeout==0 but empty_grace>0"
    assert fired == [1], f"shutdown hook must fire EXACTLY once, got {len(fired)}"


def test_idle_only_still_starts_reaper():
    # The converse of the widened gate: idle on (>0), empty-close off (==0) still
    # starts the reaper — the existing idle-drop behavior is unchanged. A silent
    # peer is reaped by the live task; the empty-close hook never fires.
    app = _empty_close_app(idle_timeout=2, empty_grace=0)
    fired = []
    app.router.lifespan_context = _lifespan(app.state.room, app.state.config, shutdown=lambda: fired.append(1))
    with TestClient(app) as client:
        client.post("/jackin", params={"secret": SECRET})
        assert "peer-1" in app.state.room.peers()
        app.state.room._now = lambda: 1e9
        deadline = time.monotonic() + 5.0
        while "peer-1" in app.state.room.peers() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert "peer-1" not in app.state.room.peers(), "idle reaper did not run with empty_grace==0"
    # empty_grace==0 disables self-close: the hook must NOT have fired.
    assert not fired, "empty-close hook fired with empty_grace==0 (disabled)"


def test_both_disabled_starts_no_reaper():
    # BOTH knobs zero -> NO background task at all. Mirrors
    # test_idle_disabled_starts_no_reaper, but also pins empty_grace==0: neither
    # a silent peer is dropped nor does the room self-close.
    fired = []
    config = Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC, idle_timeout=0, empty_grace=0)
    app = create_app(config)
    app.router.lifespan_context = _lifespan(app.state.room, app.state.config, shutdown=lambda: fired.append(1))
    with TestClient(app) as client:
        client.post("/jackin", params={"secret": SECRET})
        assert "peer-1" in app.state.room.peers()
        app.state.room._now = lambda: 1e9
        time.sleep(0.3)  # give any erroneously-started sweeper ticks to misbehave
        assert "peer-1" in app.state.room.peers(), "a task ran with both knobs disabled"
    assert not fired, "self-close fired with both knobs disabled"


# -- (11) clean shutdown leaks NO task with the empty-close loop running ----


def test_empty_close_loop_no_pending_task_warning(recwarn):
    # With the empty-close loop running (idle off, empty on) but the room NOT
    # past grace (default clock), exiting the app context must cancel + await the
    # reaper cleanly — no "Task was destroyed but it is pending" RuntimeWarning.
    # The hook is spied so even if a tick fired it would not SIGINT the runner.
    fired = []
    app = _empty_close_app(idle_timeout=0, empty_grace=900)
    app.router.lifespan_context = _lifespan(app.state.room, app.state.config, shutdown=lambda: fired.append(1))
    with TestClient(app) as client:
        client.post("/jackin", params={"secret": SECRET})  # occupy so it never self-closes
        time.sleep(0.1)
    pending = [w for w in recwarn.list if "was destroyed but it is pending" in str(w.message)]
    assert not pending, f"empty-close reaper leaked past shutdown: {[str(w.message) for w in pending]}"


# ========================================================================
# PUBLIC URL — the decoupled tunnel seam. With Config.public_url set, every URL
# a peer reads (/jackin actions, /shard manual) is emitted against that exact
# base, NOT the request base. Unset, both fall back to the request base — the
# backward-compatible path proven by the request-relative tests above.
# ========================================================================


def test_config_carries_public_url():
    # The frozen Config carries public_url; default is None.
    assert Config(host="h", port=0, secret=SECRET, topic=TOPIC).public_url is None
    cfg = Config(host="h", port=0, secret=SECRET, topic=TOPIC, public_url=PUBLIC_URL)
    assert cfg.public_url == PUBLIC_URL


def test_jackin_actions_use_public_url(client_public: TestClient):
    # With public_url set, the action URLs are built against it, not the request
    # base (TestClient's http://testserver), so an LLM peer follows a real URL.
    r = client_public.post("/jackin", params={"secret": SECRET})
    assert r.status_code == 200
    body = r.json()
    token = body["token"]
    for action in body["actions"]:
        assert action["url"].startswith(PUBLIC_URL)
        assert "testserver" not in action["url"]
    send_action, recv_action = body["actions"]
    assert send_action["url"] == f"{PUBLIC_URL}/send?token={token}"
    assert recv_action["url"] == f"{PUBLIC_URL}/recv?token={token}"


def test_jackin_actions_fall_back_to_request_base(client: TestClient):
    # Backward-compat: no public_url → action URLs are the request base.
    body = client.post("/jackin", params={"secret": SECRET}).json()
    for action in body["actions"]:
        assert action["url"].startswith("http://testserver")


def test_shard_manual_uses_public_url(client_public: TestClient):
    # With public_url set, the manual interpolates it for $URL (not the request
    # base) and the real secret for $SECRET; $TOKEN stays literal.
    r = client_public.get("/shard", params={"secret": SECRET})
    assert r.status_code == 200
    assert PUBLIC_URL in r.text
    assert "testserver" not in r.text
    assert "$URL" not in r.text
    assert SECRET in r.text and "$SECRET" not in r.text
    assert "$TOKEN" in r.text


def test_shard_manual_falls_back_to_request_base(client: TestClient):
    # Backward-compat: no public_url → the manual carries the request base.
    r = client.get("/shard", params={"secret": SECRET})
    assert "http://testserver" in r.text
    assert "$URL" not in r.text
