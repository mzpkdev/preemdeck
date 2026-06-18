"""Unit tests for the framework-free room core.

No HTTP — exercises seq ordering, per-token cursors, read_your_last_message,
peer naming, jackout/validation status, and the long-poll wake. All waits are
tiny (<=0.2s) so the suite runs in seconds.
"""

from __future__ import annotations

import asyncio
import re

import pytest

from wire.config import Config
from wire.room import Room, TokenStatus

# ISO-8601 UTC, second precision, Z-suffixed: e.g. 2026-06-18T13:57:02Z.
_ISO_UTC_Z_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def make_room(**overrides) -> Room:
    cfg = Config(
        host="127.0.0.1",
        port=0,
        secret="s3cr3t",
        topic="testing the wire",
        **{"wait_default": 0.05, "wait_max": 0.2, **overrides},
    )
    return Room(cfg)


# -- peer naming & membership --------------------------------------------


async def test_peer_naming_is_join_order():
    room = make_room()
    t1, n1 = await room.jackin()
    t2, n2 = await room.jackin()
    t3, n3 = await room.jackin()
    assert (n1, n2, n3) == ("peer-1", "peer-2", "peer-3")
    assert t1 != t2 != t3
    assert room.peers() == ["peer-1", "peer-2", "peer-3"]


# -- optional self-naming -------------------------------------------------


async def test_requested_valid_name_is_assigned():
    room = make_room()
    t1, n1 = await room.jackin(requested="alice")
    assert n1 == "alice"
    # reflected everywhere the name flows: peers, the token binding, and from
    assert room.peers() == ["alice"]
    assert room.peer_name_for(t1) == "alice"
    t2, _ = await room.jackin()
    # alice can be addressed as a sender on a delivered message
    await _assert_sends_as(room, t1, t2, "alice")


async def _assert_sends_as(room: Room, sender_token: str, reader_token: str, expected: str) -> None:
    await room.send(sender_token, "hi")
    out = await room.recv(reader_token, wait=0)
    # filter to message events — the reader also sees the sender's join
    assert [e.sender for e in out["events"] if e.type == "message"] == [expected]


async def test_requested_name_coexists_with_auto_peer():
    # A named peer still advances the counter, so a later un-named peer gets the
    # right peer-N (the counter is not consumed by the custom name's slot).
    room = make_room()
    _, n1 = await room.jackin(requested="alice")
    _, n2 = await room.jackin()
    _, n3 = await room.jackin(requested="bob")
    _, n4 = await room.jackin()
    assert (n1, n2, n3, n4) == ("alice", "peer-2", "bob", "peer-4")


async def test_taken_name_falls_back_to_peer_n():
    room = make_room()
    _, n1 = await room.jackin(requested="alice")
    _, n2 = await room.jackin(requested="alice")
    assert n1 == "alice"
    assert n2 == "peer-2"  # taken -> fallback, counter-based


async def test_taken_name_is_case_insensitive():
    # Alice blocks a later alice (and ALICE) — names dedupe case-insensitively.
    room = make_room()
    _, n1 = await room.jackin(requested="Alice")
    _, n2 = await room.jackin(requested="alice")
    _, n3 = await room.jackin(requested="ALICE")
    assert n1 == "Alice"  # original casing preserved for display
    assert n2 == "peer-2"
    assert n3 == "peer-3"


async def test_taken_name_blocked_even_after_jackout():
    # A name is bound for the room's life: jacking out does not free it.
    room = make_room()
    t1, n1 = await room.jackin(requested="alice")
    await room.jackout(t1)
    _, n2 = await room.jackin(requested="alice")
    assert n1 == "alice"
    assert n2 == "peer-2"


@pytest.mark.parametrize(
    "bad",
    [
        "has space",
        "a@b",
        "@alice",
        "",
        "x" * 33,
        "no/slash",
        "dot.dot",
    ],
)
async def test_malformed_name_falls_back(bad):
    room = make_room()
    _, name = await room.jackin(requested=bad)
    assert name == "peer-1"


async def test_reserved_peer_n_request_falls_back():
    # Can't impersonate the auto-scheme: peer-5 (any peer-\d+) is rejected.
    room = make_room()
    _, n1 = await room.jackin(requested="peer-5")
    _, n2 = await room.jackin(requested="peer-99")
    assert n1 == "peer-1"
    assert n2 == "peer-2"


async def test_omitting_name_still_gives_peer_n():
    room = make_room()
    _, n1 = await room.jackin()
    _, n2 = await room.jackin(requested=None)
    assert (n1, n2) == ("peer-1", "peer-2")


async def test_surrounding_whitespace_is_stripped():
    room = make_room()
    _, name = await room.jackin(requested="  alice  ")
    assert name == "alice"


async def test_no_duplicate_names_across_mixed_jackins():
    # A churn of valid, taken, malformed, reserved, and auto requests must never
    # produce two peers with the same (case-insensitive) name.
    room = make_room()
    requests = ["alice", "Alice", "bob", "peer-2", "x x", None, "bob", "carol", "", None]
    names = [(await room.jackin(requested=r))[1] for r in requests]
    folded = [n.casefold() for n in names]
    assert len(folded) == len(set(folded)), names


async def test_token_binds_to_one_peer_for_life():
    room = make_room()
    t1, n1 = await room.jackin()
    assert room.peer_name_for(t1) == "peer-1"
    # name survives jackout
    await room.jackout(t1)
    assert room.peer_name_for(t1) == "peer-1"


async def test_jackout_removes_from_connected_peers():
    room = make_room()
    t1, _ = await room.jackin()
    t2, _ = await room.jackin()
    left = await room.jackout(t1)
    assert left == "peer-1"
    assert room.peers() == ["peer-2"]


# -- token validation surface --------------------------------------------


async def test_status_unknown_token():
    room = make_room()
    assert room.status("not-a-real-token") is TokenStatus.UNKNOWN
    assert room.is_known("not-a-real-token") is False
    assert room.peer_name_for("not-a-real-token") is None


async def test_status_valid_then_dead_after_jackout():
    room = make_room()
    t1, _ = await room.jackin()
    assert room.status(t1) is TokenStatus.VALID
    assert room.is_known(t1) is True
    await room.jackout(t1)
    assert room.status(t1) is TokenStatus.DEAD
    # still known (binding is permanent), just dead
    assert room.is_known(t1) is True


# -- seq ordering ---------------------------------------------------------


async def test_seq_climbs_across_different_senders():
    # Two joins take seq 1,2 (each jackin appends a presence event); the three
    # sends then climb 3,4,5 on the same global counter.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    s1 = await room.send(ta, "hi from a")
    s2 = await room.send(tb, "hi from b")
    s3 = await room.send(ta, "again from a")
    assert [s1, s2, s3] == [3, 4, 5]


async def test_send_stamps_sent_at_iso_utc_z():
    # The send time is stamped on the Message in ISO-8601 UTC, second precision,
    # Z-suffixed. Asserted by FORMAT/presence (regex), not an exact value — the
    # timestamp is nondeterministic wall-clock.
    room = make_room()
    ta, _ = await room.jackin()
    await room.send(ta, "stamp me")
    msg = room._messages[-1]
    assert msg.sent_at is not None
    assert _ISO_UTC_Z_RE.match(msg.sent_at), msg.sent_at


async def test_send_stamps_sender_name():
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    tc, _ = await room.jackin()
    await room.send(ta, "from a")
    await room.send(tb, "from b")
    # peer-3 reads both, confirming the from-names (a third peer so neither
    # message is filtered as its own under no-echo). Filter to message events —
    # peer-3 also receives the earlier joins of peer-1/peer-2 on its stream.
    out = await room.recv(tc, wait=0)
    senders = [(e.seq, e.sender, e.message) for e in out["events"] if e.type == "message"]
    # joins took seq 1-3; the two messages are seq 4 and 5
    assert senders == [(4, "peer-1", "from a"), (5, "peer-2", "from b")]


# -- per-token cursor -----------------------------------------------------


async def test_cursor_advances_on_delivery():
    # joins take seq 1,2; messages "one"/"two" are seq 3,4 and "three" is seq 5.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "one")
    await room.send(ta, "two")
    first = await room.recv(tb, wait=0)
    # message seqs only (tb also receives ta's join at seq 1)
    assert [e.seq for e in first["events"] if e.type == "message"] == [3, 4]
    # cursor advanced past everything delivered — a second recv with no new
    # entries heartbeats empty
    await room.send(ta, "three")
    second = await room.recv(tb, wait=0)
    assert [e.seq for e in second["events"]] == [5]


async def test_cursor_unchanged_on_heartbeat():
    # joins take seq 1,2; "one" is seq 3, "two" is seq 4.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "one")
    # deliver it (plus ta's join at seq 1)
    first = await room.recv(tb, wait=0)
    assert [e.seq for e in first["events"] if e.type == "message"] == [3]
    # quiet recv -> heartbeat, cursor stays put
    hb = await room.recv(tb, wait=0.05)
    assert hb["events"] == []
    # now a new message is still seen (cursor wasn't clobbered)
    await room.send(ta, "two")
    third = await room.recv(tb, wait=0)
    assert [e.seq for e in third["events"]] == [4]


async def test_each_token_has_its_own_cursor():
    # joins take seq 1-3; "shared" is seq 4.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    tc, _ = await room.jackin()
    await room.send(ta, "shared")
    # b reads it, c does not
    out_b = await room.recv(tb, wait=0)
    assert [e.seq for e in out_b["events"] if e.type == "message"] == [4]
    out_c = await room.recv(tc, wait=0)
    assert [e.seq for e in out_c["events"] if e.type == "message"] == [4]
    # b re-reads: nothing new
    again_b = await room.recv(tb, wait=0.05)
    assert again_b["events"] == []


# -- a peer never sees its own messages in unread (no echo) --------------


async def test_own_message_never_echoed_back():
    # peer-1 sends and nobody else speaks -> peer-1's own recv must never echo
    # its own message back. (It does still see peer-2's earlier join — a presence
    # event about someone else — so events isn't empty, but it holds no message.)
    room = make_room()
    ta, _ = await room.jackin()
    await room.jackin()  # peer-2 present but silent
    await room.send(ta, "mine")
    out = await room.recv(ta, wait=0)
    assert [e for e in out["events"] if e.type == "message"] == []  # no own message echoed


async def test_own_message_interleaved_below_others_not_skipped():
    # joins take seq 1-3. Then peer-2 (seq4), peer-1 (seq5), peer-3 (seq6).
    # peer-1 must get EXACTLY message seqs [4, 6] in order — its own seq5 is
    # filtered, but seq6 (above its own send) is NOT skipped. Cursor ends at 6;
    # a follow-up is a heartbeat.
    room = make_room()
    t1, _ = await room.jackin()
    t2, _ = await room.jackin()
    t3, _ = await room.jackin()
    s1 = await room.send(t2, "from peer-2")
    s2 = await room.send(t1, "from peer-1")  # peer-1's own
    s3 = await room.send(t3, "from peer-3")
    assert [s1, s2, s3] == [4, 5, 6]

    out = await room.recv(t1, wait=0)
    msgs = [(e.seq, e.sender) for e in out["events"] if e.type == "message"]
    assert msgs == [(4, "peer-2"), (6, "peer-3")]

    # cursor advanced to 6 -> a follow-up recv is a heartbeat (own seq5 stays filtered)
    follow = await room.recv(t1, wait=0.05)
    assert follow["events"] == []


async def test_other_peers_still_receive_my_message():
    # The flip side of no-echo: peer-2 DOES see peer-1's interleaved message.
    # joins take seq 1-3; sends are seq 4,5,6.
    room = make_room()
    t1, _ = await room.jackin()
    t2, _ = await room.jackin()
    t3, _ = await room.jackin()
    await room.send(t2, "from peer-2")  # seq4
    await room.send(t1, "from peer-1")  # seq5 (peer-1's own)
    await room.send(t3, "from peer-3")  # seq6

    out = await room.recv(t2, wait=0)
    # peer-2 does not see its OWN message (seq4), but does see peer-1's seq5 and peer-3's seq6
    msgs = [(e.seq, e.sender) for e in out["events"] if e.type == "message"]
    assert msgs == [(5, "peer-1"), (6, "peer-3")]


# -- read_your_last_message ----------------------------------------------


async def test_read_your_last_message_empty_before_sending():
    room = make_room()
    ta, _ = await room.jackin()
    await room.jackin()
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == []


async def test_read_your_last_message_reflects_readers():
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    tc, _ = await room.jackin()
    await room.send(ta, "anyone there?")
    # nobody has read it yet
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == []
    # b reads it
    await room.recv(tb, wait=0)
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == ["peer-2"]
    # c reads it too -> join order preserved
    await room.recv(tc, wait=0)
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == ["peer-2", "peer-3"]


async def test_read_your_last_message_excludes_self():
    room = make_room()
    ta, _ = await room.jackin()
    await room.send(ta, "talking to myself")
    # sender reads past its own message; must not list itself
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == []


async def test_read_your_last_message_tracks_latest_only():
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "first")
    await room.recv(tb, wait=0)  # b reads a's first message
    # a sends again; b has NOT read the second yet
    await room.send(ta, "second")
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == []
    # now b catches up
    await room.recv(tb, wait=0)
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == ["peer-2"]


# -- long-poll ------------------------------------------------------------


async def test_recv_returns_immediately_when_unread_exists():
    # joins take seq 1,2; the message is seq 3.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "already here")
    out = await asyncio.wait_for(room.recv(tb, wait=10), timeout=0.2)
    assert [e.seq for e in out["events"] if e.type == "message"] == [3]


async def test_parked_recv_wakes_on_send():
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    # drain tb's backlog (it sees ta's join) so the next recv genuinely parks
    await room.recv(tb, wait=0)

    async def speak_soon():
        await asyncio.sleep(0.02)
        return await room.send(ta, "wake up")

    # b parks with a generous wait; a's send must wake it well before timeout
    recv_task = asyncio.create_task(room.recv(tb, wait=10))
    send_task = asyncio.create_task(speak_soon())
    out = await asyncio.wait_for(recv_task, timeout=0.2)
    await send_task
    msgs = [e for e in out["events"] if e.type == "message"]
    assert [e.seq for e in msgs] == [3]
    assert msgs[0].message == "wake up"


async def test_quiet_recv_returns_heartbeat_after_wait():
    room = make_room()
    await room.jackin()
    tb, _ = await room.jackin()
    # drain tb's backlog (peer-1's join) so the next recv parks then heartbeats
    await room.recv(tb, wait=0)
    out = await asyncio.wait_for(room.recv(tb, wait=0.05), timeout=0.5)
    assert out["events"] == []
    assert "peer-1" in out["peers"] and "peer-2" in out["peers"]


async def test_wait_is_clamped_to_config_max():
    # wait_max is 0.2; asking for 100 must still heartbeat quickly. A lone peer
    # has no events about anyone else (its own join is filtered), so it parks.
    room = make_room()
    ta, _ = await room.jackin()
    out = await asyncio.wait_for(room.recv(ta, wait=100), timeout=0.5)
    assert out["events"] == []


# -- presence events: join / leave on the stream -------------------------


async def test_jackin_appends_join_other_peers_receive():
    # alice is in; bob joins -> alice's recv carries a clean action(join) for bob.
    room = make_room()
    ta, _ = await room.jackin(requested="alice")
    await room.recv(ta, wait=0)  # drain alice's own-join-is-filtered backlog (empty)
    tb, _ = await room.jackin(requested="bob")
    out = await room.recv(ta, wait=0)
    joins = [e for e in out["events"] if e.type == "action(join)"]
    assert len(joins) == 1
    join = joins[0]
    assert join.peer == "bob"
    assert join.type == "action(join)"
    assert _ISO_UTC_Z_RE.match(join.sent_at), join.sent_at


async def test_jackout_appends_leave_other_peers_receive():
    room = make_room()
    ta, _ = await room.jackin(requested="alice")
    tb, _ = await room.jackin(requested="bob")
    await room.recv(ta, wait=0)  # drain bob's join
    await room.jackout(tb)
    out = await room.recv(ta, wait=0)
    leaves = [e for e in out["events"] if e.type == "action(leave)"]
    assert len(leaves) == 1
    assert leaves[0].peer == "bob"
    assert leaves[0].type == "action(leave)"
    assert _ISO_UTC_Z_RE.match(leaves[0].sent_at), leaves[0].sent_at


async def test_peer_does_not_receive_its_own_join_or_leave():
    # A peer's own join and leave are filtered from its own stream (subject==self).
    room = make_room()
    ta, _ = await room.jackin(requested="alice")
    # alice's own join must not come back to her
    out = await room.recv(ta, wait=0)
    assert out["events"] == []
    # bob joins and leaves; bob never sees his OWN join/leave (only alice's
    # presence, which is alice's join — about alice, so bob does see that)
    tb, _ = await room.jackin(requested="bob")
    await room.jackout(tb)
    out_b = await room.recv(tb, wait=0)
    subjects_about_bob = [e for e in out_b["events"] if getattr(e, "peer", None) == "bob"]
    assert subjects_about_bob == []
    # what bob DOES see is alice's join (a presence event about alice)
    assert [(e.type, e.peer) for e in out_b["events"]] == [("action(join)", "alice")]


async def test_late_joiner_backfills_prior_events_including_joins():
    # alice joins, sends; bob joins late -> bob's first recv replays the prior
    # stream from seq 0: alice's join AND alice's message, in seq order.
    room = make_room()
    ta, _ = await room.jackin(requested="alice")
    await room.send(ta, "early bird")
    tb, _ = await room.jackin(requested="bob")
    out = await room.recv(tb, wait=0)
    # bob filters his OWN join; he sees alice's join (seq1) then alice's msg (seq2)
    shape = [(e.seq, e.type, getattr(e, "peer", getattr(e, "sender", None))) for e in out["events"]]
    assert shape == [(1, "action(join)", "alice"), (2, "message", "alice")]


async def test_presence_rides_the_same_seq_counter():
    # joins and a message share one climbing counter, in order.
    room = make_room()
    ta, _ = await room.jackin(requested="alice")  # seq1
    tb, _ = await room.jackin(requested="bob")  # seq2
    s = await room.send(ta, "hi")  # seq3
    tc, _ = await room.jackin(requested="carol")  # seq4
    assert s == 3
    # carol (fresh) backfills seq1..3 (her own seq4 join is filtered)
    out = await room.recv(tc, wait=0)
    assert [e.seq for e in out["events"]] == [1, 2, 3]
