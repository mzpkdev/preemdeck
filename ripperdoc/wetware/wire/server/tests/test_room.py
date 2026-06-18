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
    # every name is <base>-<n>; the first alice lands on alice-1
    assert n1 == "alice-1"
    # reflected everywhere the name flows: peers, the token binding, and from
    assert room.peers() == ["alice-1"]
    assert room.peer_name_for(t1) == "alice-1"
    t2, _ = await room.jackin()
    # alice-1 can be addressed as a sender on a delivered message
    await _assert_sends_as(room, t1, t2, "alice-1")


async def _assert_sends_as(room: Room, sender_token: str, reader_token: str, expected: str) -> None:
    await room.send(sender_token, "hi")
    out = await room.recv(reader_token, wait=0)
    # filter to message events — the reader also sees the sender's join
    assert [e.sender for e in out["events"] if e.type == "message"] == [expected]


async def test_repeated_name_increments_n():
    # Every name is <base>-<n>; repeating a base just climbs n from 1.
    room = make_room()
    _, n1 = await room.jackin(requested="alice")
    _, n2 = await room.jackin(requested="alice")
    _, n3 = await room.jackin(requested="alice")
    assert (n1, n2, n3) == ("alice-1", "alice-2", "alice-3")


async def test_named_peer_does_not_consume_a_peer_n_slot():
    # Numbering is per-base: a named peer leaves no gap in the peer-N line, so an
    # unnamed peer after alice-1 is peer-1, NOT peer-2.
    room = make_room()
    _, n1 = await room.jackin(requested="alice")
    _, n2 = await room.jackin()
    _, n3 = await room.jackin(requested="bob")
    _, n4 = await room.jackin()
    assert (n1, n2, n3, n4) == ("alice-1", "peer-1", "bob-1", "peer-2")


async def test_collision_is_case_insensitive():
    # The base is lowercased on the way in, so Alice/alice/ALICE all normalize to
    # the same `alice` base and the suffix just climbs.
    room = make_room()
    _, n1 = await room.jackin(requested="Alice")
    _, n2 = await room.jackin(requested="alice")
    _, n3 = await room.jackin(requested="ALICE")
    assert n1 == "alice-1"
    assert n2 == "alice-2"
    assert n3 == "alice-3"


async def test_name_blocked_even_after_jackout():
    # A name is bound for the room's life: jacking out does not free its slot.
    room = make_room()
    t1, n1 = await room.jackin(requested="alice")
    await room.jackout(t1)
    _, n2 = await room.jackin(requested="alice")
    assert n1 == "alice-1"
    assert n2 == "alice-2"


@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        ("My Agent", "my-agent-1"),  # inner space -> -, lowercased
        ("has space", "has-space-1"),  # inner space -> -, not deleted
        ("a@b c!", "ab-c-1"),  # invalid chars dropped, space -> -
        ("a -- b", "a-b-1"),  # double seps collapse cleanly
        ("my_agent", "my-agent-1"),  # underscore folds to - (true kebab)
        ("a@b", "ab-1"),  # invalid chars removed
        ("@alice", "alice-1"),  # leading @ stripped
        ("no/slash", "noslash-1"),
        ("dot.dot", "dotdot-1"),
        ("-x-", "x-1"),  # leading/trailing separators stripped
        ("_x_", "x-1"),  # underscores fold to -, then strip leading/trailing
        ("", "peer-1"),  # empty -> default base
        ("@@@", "peer-1"),  # nothing survives normalizing -> default base
        ("   ", "peer-1"),  # whitespace-only -> default base
        ("!!!", "peer-1"),  # all-invalid -> default base
    ],
)
async def test_name_is_normalized_to_base(requested, expected):
    room = make_room()
    _, name = await room.jackin(requested=requested)
    assert name == expected


async def test_oversized_base_is_capped_to_32():
    # The base is capped at 32 chars before the -<n> suffix is appended.
    room = make_room()
    _, name = await room.jackin(requested="x" * 40)
    assert name == "x" * 32 + "-1"


async def test_name_equal_to_peer_lands_in_peer_sequence():
    # &name=peer is just the default base, so it shares the peer-N sequence.
    room = make_room()
    _, n1 = await room.jackin()  # peer-1
    _, n2 = await room.jackin(requested="peer")  # peer-2
    assert (n1, n2) == ("peer-1", "peer-2")


async def test_already_suffixed_request_is_treated_as_base():
    # A request that already looks suffixed is taken verbatim as the base, so it
    # gets its own -<n> on top (acceptable edge behavior).
    room = make_room()
    _, name = await room.jackin(requested="alice-2")
    assert name == "alice-2-1"


async def test_omitting_name_still_gives_peer_n():
    room = make_room()
    _, n1 = await room.jackin()
    _, n2 = await room.jackin(requested=None)
    assert (n1, n2) == ("peer-1", "peer-2")


async def test_surrounding_whitespace_is_stripped():
    room = make_room()
    _, name = await room.jackin(requested="  alice  ")
    assert name == "alice-1"


async def test_surrounding_whitespace_stripped_and_lowercased():
    # Trim happens on both sides and the base is lowercased.
    room = make_room()
    _, name = await room.jackin(requested="  Alice  ")
    assert name == "alice-1"


async def test_case_insensitive_collision_two_peers():
    # The briefing's exact case: "Alice" then "alice" share a normalized base.
    room = make_room()
    _, n1 = await room.jackin(requested="Alice")
    _, n2 = await room.jackin(requested="alice")
    assert (n1, n2) == ("alice-1", "alice-2")


async def test_no_duplicate_names_across_mixed_jackins():
    # A churn of valid, repeated, sanitized-to-same, and auto requests must never
    # produce two peers with the same (case-insensitive) name.
    room = make_room()
    requests = ["alice", "Alice", "bob", "peer", "x x", None, "bob", "carol", "", None]
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
    tb, nb = await room.jackin(requested="bob")  # nb == "bob-1"
    out = await room.recv(ta, wait=0)
    joins = [e for e in out["events"] if e.type == "action(join)"]
    assert len(joins) == 1
    join = joins[0]
    assert join.peer == nb
    assert join.type == "action(join)"
    assert _ISO_UTC_Z_RE.match(join.sent_at), join.sent_at


async def test_jackout_appends_leave_other_peers_receive():
    room = make_room()
    ta, _ = await room.jackin(requested="alice")
    tb, nb = await room.jackin(requested="bob")  # nb == "bob-1"
    await room.recv(ta, wait=0)  # drain bob's join
    await room.jackout(tb)
    out = await room.recv(ta, wait=0)
    leaves = [e for e in out["events"] if e.type == "action(leave)"]
    assert len(leaves) == 1
    assert leaves[0].peer == nb
    assert leaves[0].type == "action(leave)"
    assert _ISO_UTC_Z_RE.match(leaves[0].sent_at), leaves[0].sent_at


async def test_peer_does_not_receive_its_own_join_or_leave():
    # A peer's own join and leave are filtered from its own stream (subject==self).
    room = make_room()
    ta, na = await room.jackin(requested="alice")  # na == "alice-1"
    # alice's own join must not come back to her
    out = await room.recv(ta, wait=0)
    assert out["events"] == []
    # bob joins and leaves; bob never sees his OWN join/leave (only alice's
    # presence, which is alice's join — about alice, so bob does see that)
    tb, nb = await room.jackin(requested="bob")  # nb == "bob-1"
    await room.jackout(tb)
    out_b = await room.recv(tb, wait=0)
    subjects_about_bob = [e for e in out_b["events"] if getattr(e, "peer", None) == nb]
    assert subjects_about_bob == []
    # what bob DOES see is alice's join (a presence event about alice)
    assert [(e.type, e.peer) for e in out_b["events"]] == [("action(join)", na)]


async def test_late_joiner_backfills_prior_events_including_joins():
    # alice joins, sends; bob joins late -> bob's first recv replays the prior
    # stream from seq 0: alice's join AND alice's message, in seq order.
    room = make_room()
    ta, na = await room.jackin(requested="alice")  # na == "alice-1"
    await room.send(ta, "early bird")
    tb, _ = await room.jackin(requested="bob")
    out = await room.recv(tb, wait=0)
    # bob filters his OWN join; he sees alice's join (seq1) then alice's msg (seq2)
    shape = [(e.seq, e.type, getattr(e, "peer", getattr(e, "sender", None))) for e in out["events"]]
    assert shape == [(1, "action(join)", na), (2, "message", na)]


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
