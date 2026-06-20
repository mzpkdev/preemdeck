"""Tests for the read-only /spectate SSE endpoint + its room-core accessors.

A dedicated module because consuming /spectate needs a different harness from
the rest of the suite. The endpoint is an INFINITE Server-Sent Events stream
(``_spectate_stream`` is a ``while True`` generator), and NEITHER httpx's
``ASGITransport`` NOR Starlette's ``TestClient.stream`` can incrementally
consume an endless body — both buffer the whole response before yielding it, so
opening the stream hangs forever. So the harness drives the ASGI app directly: a
minimal ``http`` scope, a ``receive`` queue fed ``http.request`` then
``http.disconnect``, and a ``send`` that accumulates ``http.response.body``
bytes into blank-line-delimited SSE frames. It reads a BOUNDED number of frames
under an ``asyncio.wait_for`` deadline, then disconnects — the open stream can
never hang the test (see ``_collect_frames``).

The heartbeat is driven by monkeypatching ``app._SPECTATE_HEARTBEAT_SECONDS`` to
a tiny value so the quiet-window timeout fires in a fraction of a second instead
of the real 15s (never sits on a real wait).

asyncio_mode is "auto" (see pyproject), so ``async def test_*`` runs directly.
The 401-before-stream cases reuse the existing FastAPI ``TestClient`` — a wrong
secret returns a normal buffered 401 with no streaming body, so it consumes fine
the ordinary way.
"""

from __future__ import annotations

import asyncio
import json
import re

import pytest
import wire.app as appmod
from fastapi.testclient import TestClient
from wire.app import _event_to_model, _reaper_loop, create_app
from wire.config import Config
from wire.room import Room

SECRET = "s3cret"
TOPIC = "test room"

# ISO-8601 UTC, second precision, Z-suffixed: e.g. 2026-06-18T13:57:02Z.
_ISO_UTC_Z_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


# ========================================================================
# Harness — drive the ASGI app's /spectate stream directly and pull a bounded
# number of SSE frames, then disconnect. Hang-proof: every wait is bounded.
# ========================================================================


def _spectate_scope(headers: dict[str, str] | None = None) -> dict:
    """A minimal ASGI ``http`` scope for ``GET /spectate?secret=<SECRET>``."""
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "path": "/spectate",
        "raw_path": b"/spectate",
        "query_string": f"secret={SECRET}".encode(),
        "root_path": "",
        "scheme": "http",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "server": ("testserver", 80),
        "client": ("testclient", 50000),
    }


def _parse_frame(raw: str) -> dict:
    """One blank-line-delimited SSE frame -> ``{event, id, data}``.

    ``id`` is the parsed int event id or ``None`` (snapshot/heartbeat carry no
    ``id:`` line). ``data`` is the single ``data:`` line run through one
    ``json.loads`` — which also asserts each ``data:`` is exactly one JSON
    object (a frame with two ``data:`` lines would raise here)."""
    out: dict = {"event": None, "id": None, "data": None}
    data_lines = 0
    for line in raw.split("\n"):
        if line.startswith("id: "):
            out["id"] = int(line[len("id: ") :])
        elif line.startswith("event: "):
            out["event"] = line[len("event: ") :]
        elif line.startswith("data: "):
            data_lines += 1
            out["data"] = json.loads(line[len("data: ") :])
    assert data_lines == 1, f"each SSE frame must carry exactly one data: line, got {data_lines} in {raw!r}"
    return out


async def _collect_frames(
    app,
    n: int,
    *,
    headers: dict[str, str] | None = None,
    after_open=None,
    timeout: float = 5.0,
) -> tuple[dict, list[str]]:
    """Open /spectate on ``app``, collect ``n`` SSE frames, then disconnect.

    Returns ``(response, frames)`` where ``response`` is
    ``{"status": int, "headers": {name: value}}`` from ``http.response.start``
    and ``frames`` is the list of raw frame strings (blank line stripped).

    ``after_open`` is an optional async callback fired AFTER the first frame
    (the snapshot) has been emitted — the seam to drive room activity once the
    spectator is genuinely live on the stream, so a join/send/leave lands as a
    live event frame rather than racing the snapshot. Every wait is bounded by
    ``timeout`` so the endless stream can never hang the test.
    """
    recv_q: asyncio.Queue = asyncio.Queue()
    await recv_q.put({"type": "http.request", "body": b"", "more_body": False})

    response: dict = {"status": None, "headers": {}}
    frames: list[str] = []
    buf = ""
    started = asyncio.Event()  # first frame seen
    done = asyncio.Event()  # n frames seen

    async def receive():
        return await recv_q.get()

    async def send(message):
        nonlocal buf
        if message["type"] == "http.response.start":
            response["status"] = message["status"]
            response["headers"] = {k.decode().lower(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            buf += message["body"].decode()
            while "\n\n" in buf:
                raw, buf = buf.split("\n\n", 1)
                frames.append(raw)
                started.set()
            if len(frames) >= n:
                done.set()

    task = asyncio.create_task(app(_spectate_scope(headers), receive, send))
    try:
        # Wait for the snapshot to land, then (optionally) drive activity, then
        # wait for the full batch. Both waits are bounded.
        await asyncio.wait_for(started.wait(), timeout=timeout)
        if after_open is not None:
            await after_open()
        await asyncio.wait_for(done.wait(), timeout=timeout)
    finally:
        # Disconnect the client and let the generator unwind (its finally just
        # returns). Bounded: cancel if it somehow doesn't stop promptly.
        await recv_q.put({"type": "http.disconnect"})
        try:
            await asyncio.wait_for(task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    return response, frames


@pytest.fixture
def app():
    """A fresh wire app (one room). The heartbeat constant is module-global on
    ``wire.app``; tests that exercise the heartbeat monkeypatch it explicitly."""
    return create_app(Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC))


# ========================================================================
# (1) 401 BEFORE any stream bytes — wrong secret and missing secret.
# A buffered 401 (no stream body), so the plain TestClient consumes it fine.
# ========================================================================


def test_spectate_wrong_secret_401_before_stream():
    app = create_app(Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC))
    with TestClient(app) as client:
        r = client.get("/spectate", params={"secret": "wrong"})
        assert r.status_code == 401
        # the JSON 401 contract, identical to the other secret-gated routes
        assert r.json() == {"detail": "invalid secret", "code": "invalid_secret"}
        # NOT a stream: the 401 fired before the SSE body ever opened
        assert not r.headers["content-type"].startswith("text/event-stream")


def test_spectate_missing_secret_401_before_stream():
    app = create_app(Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC))
    with TestClient(app) as client:
        r = client.get("/spectate")
        assert r.status_code == 401
        assert r.json() == {"detail": "invalid secret", "code": "invalid_secret"}
        assert not r.headers["content-type"].startswith("text/event-stream")


# ========================================================================
# (2) 200 + text/event-stream; first frame is the snapshot (roster + quiet_for).
# ========================================================================


async def test_spectate_opens_stream_with_snapshot(app):
    # A peer is present so the snapshot roster is non-empty and meaningful.
    await app.state.room.jackin()  # peer-1
    response, frames = await _collect_frames(app, 1)

    assert response["status"] == 200
    assert response["headers"]["content-type"].startswith("text/event-stream")

    snap = _parse_frame(frames[0])
    assert snap["event"] == "snapshot"
    # the snapshot carries NO id: line (it is not a log entry, moves no cursor)
    assert snap["id"] is None
    # it is the LIVE roster + silence — exactly {present_peers, quiet_for}
    assert set(snap["data"].keys()) == {"present_peers", "quiet_for"}
    assert snap["data"]["present_peers"] == ["peer-1"]
    assert snap["data"]["quiet_for"] is None  # no one has spoken yet


# ========================================================================
# (3) join then message frames: event-name vs data.type divergence, the message
# data equals /recv's per-event JSON, and each data: parses as one json.loads.
# ========================================================================


async def test_spectate_join_then_message_frames(app):
    room: Room = app.state.room
    await room.jackin()  # peer-1, present before the spectator opens

    async def activity():
        # peer-2 joins (event id 2), then sends (event id 3) — observed LIVE.
        t2, _ = await room.jackin()
        await room.send(t2, "hello peer-2")

    # snapshot + join + message
    _response, frames = await _collect_frames(app, 3, after_open=activity)
    snap, join, msg = (_parse_frame(f) for f in frames)

    assert snap["event"] == "snapshot"

    # --- the join frame ---
    # GOTCHA: the SSE event NAME is the short "join", but the data.type is the
    # FULL "action(join)" string — they differ ON PURPOSE.
    assert join["event"] == "join"
    assert join["data"]["type"] == "action(join)"
    assert join["event"] != join["data"]["type"]
    assert join["id"] == 2  # the id: line is the event's stream position
    assert join["id"] == join["data"]["id"]
    # clean per-type presence payload: id/type/peer/sent_at, no message fields
    assert set(join["data"].keys()) == {"id", "type", "peer", "sent_at"}
    assert join["data"]["peer"] == "peer-2"
    assert _ISO_UTC_Z_RE.match(join["data"]["sent_at"])

    # --- the message frame ---
    assert msg["event"] == "message"
    assert msg["data"]["type"] == "message"
    assert msg["id"] == 3
    assert msg["id"] == msg["data"]["id"]
    # the message data equals EXACTLY what /recv emits for that same log entry
    entry = next(e for e in room._messages if e.id == 3)
    recv_json = json.loads(_event_to_model(entry).model_dump_json(by_alias=True))
    assert msg["data"] == recv_json
    # spelled out: the stable per-event message shape (sent_at by regex)
    assert {k: msg["data"][k] for k in ("id", "type", "from", "message")} == {
        "id": 3,
        "type": "message",
        "from": "peer-2",
        "message": {"seq": 1, "body": "hello peer-2"},
    }
    assert "peer" not in msg["data"]  # clean per-type: no presence field
    assert _ISO_UTC_Z_RE.match(msg["data"]["sent_at"])


# ========================================================================
# (4) leave produces a leave frame (short name vs full data.type again).
# ========================================================================


async def test_spectate_leave_frame(app):
    room: Room = app.state.room
    await room.jackin()  # peer-1
    t2, _ = await room.jackin()  # peer-2 (join id 2)

    async def activity():
        await room.jackout(t2)  # leave -> event id 3

    _response, frames = await _collect_frames(app, 2, after_open=activity)
    snap, leave = (_parse_frame(f) for f in frames)

    assert snap["event"] == "snapshot"
    assert leave["event"] == "leave"
    assert leave["data"]["type"] == "action(leave)"
    assert leave["event"] != leave["data"]["type"]
    assert leave["id"] == 3
    assert set(leave["data"].keys()) == {"id", "type", "peer", "sent_at"}
    assert leave["data"]["peer"] == "peer-2"


# ========================================================================
# (5) heartbeat after silence — monkeypatch the heartbeat to a tiny window so it
# fires fast; assert the heartbeat frame carries the roster + quiet_for.
# ========================================================================


async def test_spectate_heartbeat_after_silence(app, monkeypatch):
    # Drive the quiet-window timeout in a fraction of a second instead of 15s —
    # we never sit on a real wait. The constant is a module global on wire.app.
    monkeypatch.setattr(appmod, "_SPECTATE_HEARTBEAT_SECONDS", 0.2)
    await app.state.room.jackin()  # peer-1, so the heartbeat roster is non-empty

    # snapshot, then — with NOTHING sent — a heartbeat once the quiet window lapses
    _response, frames = await _collect_frames(app, 2)
    snap, hb = (_parse_frame(f) for f in frames)

    assert snap["event"] == "snapshot"
    assert hb["event"] == "heartbeat"
    # heartbeat carries NO id: line (not a log entry)
    assert hb["id"] is None
    # and the SAME {present_peers, quiet_for} snapshot the connect frame carries
    assert set(hb["data"].keys()) == {"present_peers", "quiet_for"}
    assert hb["data"]["present_peers"] == ["peer-1"]
    assert hb["data"]["quiet_for"] is None


async def test_spectate_heartbeat_reports_quiet_for_after_a_message(app, monkeypatch):
    # A populated, recently-talking room: the heartbeat's quiet_for is a real
    # whole-second lull (proof a silent stream still reads as a live room).
    monkeypatch.setattr(appmod, "_SPECTATE_HEARTBEAT_SECONDS", 0.2)
    room: Room = app.state.room
    t1, _ = await room.jackin()
    await room.jackin()  # peer-2 so the roster has two
    await room.send(t1, "spoke just now")  # quiet_for now ticks from ~0

    _response, frames = await _collect_frames(app, 2)
    snap, hb = (_parse_frame(f) for f in frames)
    assert hb["event"] == "heartbeat"
    assert set(hb["data"]["present_peers"]) == {"peer-1", "peer-2"}
    # someone HAS spoken -> quiet_for is an int (a small lull), never null here
    assert isinstance(hb["data"]["quiet_for"], int)


# ========================================================================
# (6) Last-Event-ID replay: header N -> only events with id > N; garbage /
# missing / future id clamps to the current max (no crash, starts live).
# ========================================================================


async def _seed_backlog(room: Room) -> None:
    """peer-1 join(1), peer-2 join(2), message(3), peer-2 leave(4). Max id = 4."""
    await room.jackin()  # id 1
    t2, _ = await room.jackin()  # id 2
    await room.send(t2, "backlog msg")  # id 3
    await room.jackout(t2)  # id 4


async def test_spectate_last_event_id_replays_only_past_it(app):
    room: Room = app.state.room
    await _seed_backlog(room)
    assert room.event_id == 4

    # Last-Event-ID = 2 -> snapshot, then replay ONLY id 3 (message) and id 4
    # (leave); the two joins (id 1, 2) are at/under the cursor and skipped.
    _response, frames = await _collect_frames(app, 3, headers={"Last-Event-ID": "2"})
    parsed = [_parse_frame(f) for f in frames]
    assert parsed[0]["event"] == "snapshot"  # always first, no id
    replayed = [(p["event"], p["id"]) for p in parsed[1:]]
    assert replayed == [("message", 3), ("leave", 4)]


async def test_spectate_last_event_id_zero_replays_whole_backlog(app):
    room: Room = app.state.room
    await _seed_backlog(room)

    # Last-Event-ID = 0 -> every entry (id 1..4) replays, in order, after the snapshot.
    _response, frames = await _collect_frames(app, 5, headers={"Last-Event-ID": "0"})
    parsed = [_parse_frame(f) for f in frames]
    assert parsed[0]["event"] == "snapshot"
    assert [(p["event"], p["id"]) for p in parsed[1:]] == [
        ("join", 1),
        ("join", 2),
        ("message", 3),
        ("leave", 4),
    ]


async def test_spectate_garbage_last_event_id_clamps_to_max(app, monkeypatch):
    # Non-numeric Last-Event-ID -> clamp to the current max (no replay, no crash);
    # the stream starts LIVE, so after the snapshot the next frame is a heartbeat.
    monkeypatch.setattr(appmod, "_SPECTATE_HEARTBEAT_SECONDS", 0.2)
    room: Room = app.state.room
    await _seed_backlog(room)  # max id 4 -> would replay if it weren't clamped

    _response, frames = await _collect_frames(app, 2, headers={"Last-Event-ID": "not-a-number"})
    parsed = [_parse_frame(f) for f in frames]
    assert parsed[0]["event"] == "snapshot"
    # no backlog replayed: the second frame is the heartbeat, not an event frame
    assert parsed[1]["event"] == "heartbeat"


async def test_spectate_negative_last_event_id_clamps_to_max(app, monkeypatch):
    # A negative id is malformed too -> clamp to current max, start live (heartbeat).
    monkeypatch.setattr(appmod, "_SPECTATE_HEARTBEAT_SECONDS", 0.2)
    room: Room = app.state.room
    await _seed_backlog(room)

    _response, frames = await _collect_frames(app, 2, headers={"Last-Event-ID": "-5"})
    parsed = [_parse_frame(f) for f in frames]
    assert parsed[0]["event"] == "snapshot"
    assert parsed[1]["event"] == "heartbeat"


async def test_spectate_future_last_event_id_clamps_to_max(app, monkeypatch):
    # A future id can't skip live events: it clamps to the current max, so no
    # backlog replays and the stream starts live (heartbeat after the snapshot).
    monkeypatch.setattr(appmod, "_SPECTATE_HEARTBEAT_SECONDS", 0.2)
    room: Room = app.state.room
    await _seed_backlog(room)  # max id 4; ask to resume past 99999

    _response, frames = await _collect_frames(app, 2, headers={"Last-Event-ID": "99999"})
    parsed = [_parse_frame(f) for f in frames]
    assert parsed[0]["event"] == "snapshot"
    assert parsed[1]["event"] == "heartbeat"


async def test_spectate_missing_last_event_id_starts_live(app, monkeypatch):
    # No Last-Event-ID header at all -> live-only from the current max, no backlog.
    monkeypatch.setattr(appmod, "_SPECTATE_HEARTBEAT_SECONDS", 0.2)
    room: Room = app.state.room
    await _seed_backlog(room)

    _response, frames = await _collect_frames(app, 2)  # no headers
    parsed = [_parse_frame(f) for f in frames]
    assert parsed[0]["event"] == "snapshot"
    assert parsed[1]["event"] == "heartbeat"


# ========================================================================
# (7) INVISIBILITY: a connected/parked spectator never appears in present_peers
# and does NOT keep the room alive (empty-room self-close still fires).
# ========================================================================


async def test_spectator_is_invisible_in_roster(app):
    # A spectator on an OTHERWISE-empty room sees an empty roster — it never adds
    # itself to present_peers (no token, no roster entry).
    _response, frames = await _collect_frames(app, 1)
    snap = _parse_frame(frames[0])
    assert snap["event"] == "snapshot"
    assert snap["data"]["present_peers"] == []  # the spectator itself is invisible
    # the room core agrees: no peer was ever minted by opening the stream
    assert app.state.room.peers() == []


async def test_parked_spectator_does_not_block_empty_room_self_close(monkeypatch):
    # The INVISIBILITY invariant's teeth: hold a spectator parked on room.cond and
    # the empty room must STILL self-close — the spectator touches neither the
    # roster nor last_active, so should_self_close() fires and the reaper hook is
    # called. Driven on the clock seam (far-future) so no real grace elapses.
    monkeypatch.setattr(appmod, "_SPECTATE_HEARTBEAT_SECONDS", 15.0)  # park, don't heartbeat
    app = create_app(Config(host="127.0.0.1", port=0, secret=SECRET, topic=TOPIC, empty_grace=900))
    room: Room = app.state.room
    room._now = lambda: 1e9  # boot-armed empty room is instantly past grace

    # Open the stream and read the snapshot (so the spectator is genuinely parked
    # on room.cond), keeping it open while we evaluate the close decision.
    recv_q: asyncio.Queue = asyncio.Queue()
    await recv_q.put({"type": "http.request", "body": b"", "more_body": False})
    got_snapshot = asyncio.Event()
    snapshot_body: list[str] = []

    async def receive():
        return await recv_q.get()

    async def send(message):
        if message["type"] == "http.response.body" and message["body"]:
            snapshot_body.append(message["body"].decode())
            got_snapshot.set()

    stream_task = asyncio.create_task(app(_spectate_scope(), receive, send))
    try:
        await asyncio.wait_for(got_snapshot.wait(), timeout=5.0)
        # the spectator is parked AND invisible in its own snapshot roster
        data = json.loads(snapshot_body[0].split("data: ", 1)[1])
        assert data["present_peers"] == []

        # the empty-room decision fires DESPITE the parked spectator
        assert await room.should_self_close() is True

        # and the live reaper actually calls the shutdown hook (spied, never SIGINT)
        # while the spectator is still parked — exactly once, then it self-stops.
        fired: list[int] = []
        reaper = asyncio.create_task(_reaper_loop(room, sweep_interval=0, shutdown=lambda: fired.append(1)))
        try:
            deadline = asyncio.get_event_loop().time() + 5.0
            while not fired and asyncio.get_event_loop().time() < deadline:
                await asyncio.sleep(0.01)
            assert fired == [1], "empty room with a parked spectator must still self-close exactly once"
            await asyncio.wait_for(reaper, timeout=1.0)  # fire-once-then-stop
            assert reaper.done() and not reaper.cancelled()
        finally:
            if not reaper.done():
                reaper.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await reaper
    finally:
        await recv_q.put({"type": "http.disconnect"})
        try:
            await asyncio.wait_for(stream_task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            stream_task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await stream_task


# ========================================================================
# (8) ROOM-CORE UNITS — the spectator accessors, no HTTP. Mirrors test_room.py:
# direct awaits on a Room built via make_room().
# ========================================================================


def make_room(**overrides) -> Room:
    cfg = Config(
        host="127.0.0.1",
        port=0,
        secret="s3cr3t",
        topic="testing the wire",
        **{"wait_default": 0.05, "wait_max": 0.2, **overrides},
    )
    return Room(cfg)


async def test_events_since_returns_strictly_past_id_no_self_filter():
    # events_since(id) returns every log entry with id > the given id, in order,
    # with NO per-peer self-filter — UNLIKE recv, a spectator sees the WHOLE
    # room (every message and every join/leave), including a peer's own entries.
    room = make_room()
    t1, _ = await room.jackin()  # join id 1
    t2, _ = await room.jackin()  # join id 2
    await room.send(t1, "from peer-1")  # message id 3
    await room.send(t2, "from peer-2")  # message id 4

    # from id 0: the entire log, in event-id order, nothing filtered out
    everything = room.events_since(0)
    assert [e.id for e in everything] == [1, 2, 3, 4]
    types = [(e.id, e.type) for e in everything]
    assert types == [(1, "action(join)"), (2, "action(join)"), (3, "message"), (4, "message")]
    # both peers' OWN messages are present — no self-filter (recv would drop one)
    senders = {e.sender for e in everything if e.type == "message"}
    assert senders == {"peer-1", "peer-2"}

    # strict >: events_since(2) drops ids 1 and 2, keeps 3 and 4
    assert [e.id for e in room.events_since(2)] == [3, 4]
    # at/above the max -> empty (nothing past the cursor)
    assert room.events_since(4) == []
    assert room.events_since(99) == []


async def test_events_since_includes_the_subject_peers_own_entries():
    # Sharper than the recv contract: a lone peer's own join AND own message both
    # come back from events_since — there is no don't-echo-me filter at all.
    room = make_room()
    t1, _ = await room.jackin()  # own join id 1
    await room.send(t1, "talking to myself")  # own message id 2
    entries = room.events_since(0)
    assert [(e.id, e.type) for e in entries] == [(1, "action(join)"), (2, "message")]


async def test_event_id_is_the_current_max_cursor():
    # event_id is the current max stream position — a fresh spectator's live
    # start cursor. It climbs by one for EVERY log entry (message or presence).
    room = make_room()
    assert room.event_id == 0  # nothing logged yet
    await room.jackin()  # join -> id 1
    assert room.event_id == 1
    t2, _ = await room.jackin()  # join -> id 2
    assert room.event_id == 2
    await room.send(t2, "hi")  # message -> id 3
    assert room.event_id == 3
    # the cursor equals the last entry's id, so events_since(event_id) is empty
    assert room.events_since(room.event_id) == []


async def test_spectate_roster_shape_present_peers_and_quiet_for():
    # spectate_roster() is exactly {present_peers, quiet_for}: the SAME roster
    # peers() lists and the SAME quiet_for recv reports — LIVE-ONLY, no backlog.
    room = make_room()
    # before anyone joins: empty roster, quiet_for null (no one has spoken)
    snap = room.spectate_roster()
    assert set(snap.keys()) == {"present_peers", "quiet_for"}
    assert snap == {"present_peers": [], "quiet_for": None}

    t1, _ = await room.jackin()  # peer-1
    await room.jackin()  # peer-2
    roster = room.spectate_roster()
    assert roster["present_peers"] == ["peer-1", "peer-2"] == room.peers()  # join order, matches peers()
    assert roster["quiet_for"] is None  # still no message

    await room.send(t1, "spoke")  # now quiet_for ticks from the last message
    after = room.spectate_roster()
    assert isinstance(after["quiet_for"], int)  # someone has spoken -> int, not null


async def test_spectate_roster_drops_a_jacked_out_peer():
    # The roster reflects live membership: a jacked-out peer leaves present_peers
    # (no backlog/history rides the snapshot), matching peers().
    room = make_room()
    t1, _ = await room.jackin()  # peer-1
    await room.jackin()  # peer-2
    await room.jackout(t1)
    roster = room.spectate_roster()
    assert roster["present_peers"] == ["peer-2"]
    assert roster["present_peers"] == room.peers()


async def test_cond_is_the_rooms_long_poll_condition():
    # cond exposes the SAME asyncio.Condition the room notifies on every append —
    # the object a tokenless spectator parks on. Identity check (not a copy).
    room = make_room()
    assert isinstance(room.cond, asyncio.Condition)
    assert room.cond is room._cond
