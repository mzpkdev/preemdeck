"""Unit tests for the framework-free room core.

No HTTP — exercises event-id ordering, the gap-free message seq, per-token
cursors, read_your_last_message, peer naming, jackout/validation status, and the
long-poll wake. All waits are tiny (<=0.2s) so the suite runs in seconds.
"""

from __future__ import annotations

import asyncio
import re

import pytest
from wire.config import Config
from wire.room import Message, Presence, Room, TokenStatus

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
    t1, _n1 = await room.jackin()
    assert room.peer_name_for(t1) == "peer-1"
    # name survives jackout
    await room.jackout(t1)
    assert room.peer_name_for(t1) == "peer-1"


async def test_jackout_removes_from_roster():
    room = make_room()
    t1, _ = await room.jackin()
    _t2, _ = await room.jackin()
    left = await room.jackout(t1)
    assert left == "peer-1"
    assert room.peers() == ["peer-2"]


# -- token validation surface --------------------------------------------


async def test_status_unknown_token():
    room = make_room()
    assert room.status("not-a-real-token") is TokenStatus.UNKNOWN
    assert room.is_known("not-a-real-token") is False
    assert room.peer_name_for("not-a-real-token") is None


async def test_token_stays_valid_after_jackout():
    # Tokens are immortal: jackout drops the peer from the roster but never kills
    # the token, so it remains VALID (and known) for the room's life.
    room = make_room()
    t1, _ = await room.jackin()
    assert room.status(t1) is TokenStatus.VALID
    assert room.is_known(t1) is True
    await room.jackout(t1)
    assert room.status(t1) is TokenStatus.VALID
    assert room.is_known(t1) is True


# -- seq ordering ---------------------------------------------------------


async def test_event_id_climbs_across_different_senders():
    # Two joins take event id 1,2 (each jackin appends a presence event); the
    # three sends then climb 3,4,5 on the same global event-id counter. Their
    # message-only seq, untouched by the joins, climbs 1,2,3.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    r1 = await room.send(ta, "hi from a")
    r2 = await room.send(tb, "hi from b")
    r3 = await room.send(ta, "again from a")
    assert [r1["id"], r2["id"], r3["id"]] == [3, 4, 5]
    assert [r1["seq"], r2["seq"], r3["seq"]] == [1, 2, 3]


async def test_message_seq_is_contiguous_despite_interleaved_presence():
    # The whole point of the split: a presence event wedged between two messages
    # burns an event id but NOT a message seq. A jacks in, sends, then B jacks in
    # (a join lands on the stream), then A sends again. The two messages carry
    # seq 1 then 2 (gap-free), while their event ids straddle B's join (2 and 4,
    # not 2 and 3) — id is the stream position, seq is the message-only counter.
    room = make_room()
    ta, _ = await room.jackin()  # join -> event id 1
    r1 = await room.send(ta, "first")  # message -> id 2, seq 1
    await room.jackin()  # B joins -> presence event id 3, burns NO seq
    r2 = await room.send(ta, "second")  # message -> id 4, seq 2

    # message seq is contiguous; event id is not (B's join wedged in at id 3)
    assert (r1["seq"], r2["seq"]) == (1, 2)
    assert (r1["id"], r2["id"]) == (2, 4)

    # confirmed on the log entries themselves, not just the return values
    messages = [e for e in room._messages if isinstance(e, Message)]
    assert [(m.id, m.seq, m.message) for m in messages] == [(2, 1, "first"), (4, 2, "second")]


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
    senders = [(e.id, e.sender, e.message) for e in out["events"] if e.type == "message"]
    # joins took event id 1-3; the two messages are id 4 and 5
    assert senders == [(4, "peer-1", "from a"), (5, "peer-2", "from b")]


# -- per-token cursor -----------------------------------------------------


async def test_cursor_advances_on_delivery():
    # joins take id 1,2; messages "one"/"two" are id 3,4 and "three" is id 5.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "one")
    await room.send(ta, "two")
    first = await room.recv(tb, wait=0)
    # message ids only (tb also receives ta's join at id 1)
    assert [e.id for e in first["events"] if e.type == "message"] == [3, 4]
    # cursor advanced past everything delivered — a second recv with no new
    # entries heartbeats empty
    await room.send(ta, "three")
    second = await room.recv(tb, wait=0)
    assert [e.id for e in second["events"]] == [5]


async def test_cursor_unchanged_on_heartbeat():
    # joins take id 1,2; "one" is id 3, "two" is id 4.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "one")
    # deliver it (plus ta's join at id 1)
    first = await room.recv(tb, wait=0)
    assert [e.id for e in first["events"] if e.type == "message"] == [3]
    # quiet recv -> heartbeat, cursor stays put
    hb = await room.recv(tb, wait=0.05)
    assert hb["events"] == []
    # now a new message is still seen (cursor wasn't clobbered)
    await room.send(ta, "two")
    third = await room.recv(tb, wait=0)
    assert [e.id for e in third["events"]] == [4]


async def test_each_token_has_its_own_cursor():
    # joins take id 1-3; "shared" is id 4.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    tc, _ = await room.jackin()
    await room.send(ta, "shared")
    # b reads it, c does not
    out_b = await room.recv(tb, wait=0)
    assert [e.id for e in out_b["events"] if e.type == "message"] == [4]
    out_c = await room.recv(tc, wait=0)
    assert [e.id for e in out_c["events"] if e.type == "message"] == [4]
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
    # joins take id 1-3. Then peer-2 (id4), peer-1 (id5), peer-3 (id6).
    # peer-1 must get EXACTLY message ids [4, 6] in order — its own id5 is
    # filtered, but id6 (above its own send) is NOT skipped. Cursor ends at 6;
    # a follow-up is a heartbeat.
    room = make_room()
    t1, _ = await room.jackin()
    t2, _ = await room.jackin()
    t3, _ = await room.jackin()
    id1 = (await room.send(t2, "from peer-2"))["id"]
    id2 = (await room.send(t1, "from peer-1"))["id"]  # peer-1's own
    id3 = (await room.send(t3, "from peer-3"))["id"]
    assert [id1, id2, id3] == [4, 5, 6]

    out = await room.recv(t1, wait=0)
    msgs = [(e.id, e.sender) for e in out["events"] if e.type == "message"]
    assert msgs == [(4, "peer-2"), (6, "peer-3")]

    # cursor advanced to 6 -> a follow-up recv is a heartbeat (own id5 stays filtered)
    follow = await room.recv(t1, wait=0.05)
    assert follow["events"] == []


async def test_other_peers_still_receive_my_message():
    # The flip side of no-echo: peer-2 DOES see peer-1's interleaved message.
    # joins take id 1-3; sends are id 4,5,6.
    room = make_room()
    t1, _ = await room.jackin()
    t2, _ = await room.jackin()
    t3, _ = await room.jackin()
    await room.send(t2, "from peer-2")  # id4
    await room.send(t1, "from peer-1")  # id5 (peer-1's own)
    await room.send(t3, "from peer-3")  # id6

    out = await room.recv(t2, wait=0)
    # peer-2 does not see its OWN message (id4), but does see peer-1's id5 and peer-3's id6
    msgs = [(e.id, e.sender) for e in out["events"] if e.type == "message"]
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


# -- send's behind_by / present_peers signal -----------------------------


async def test_send_behind_by_counts_unseen_others_messages():
    # The signal a sender gets for free: how many unread chat messages from
    # OTHERS sit past its cursor. peer-1 hasn't recv'd, so peer-2's two messages
    # are still unread — peer-1's own send reports behind_by 2.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(tb, "from b one")
    await room.send(tb, "from b two")
    out = await room.send(ta, "from a")
    assert out["behind_by"] == 2


async def test_send_behind_by_excludes_own_messages():
    # A peer's own messages never count — including the one just sent. peer-1
    # talks to an otherwise-silent room, so its own sends never bump behind_by.
    room = make_room()
    ta, _ = await room.jackin()
    await room.jackin()  # peer-2 present but silent
    assert (await room.send(ta, "mine one"))["behind_by"] == 0
    assert (await room.send(ta, "mine two"))["behind_by"] == 0


async def test_send_behind_by_excludes_presence():
    # behind_by counts CHAT only — a join/leave is not a message and never bumps
    # it. peer-2 joins (presence) and leaves (presence) before peer-1 sends; with
    # no OTHERS' chat outstanding, peer-1's send reports behind_by 0.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()  # presence: join
    await room.jackout(tb)  # presence: leave
    out = await room.send(ta, "anyone?")
    assert out["behind_by"] == 0


async def test_send_does_not_advance_cursor():
    # CRITICAL: send is not a consumer. peer-2's message is unread when peer-1
    # sends (behind_by 1), and because send NEVER touches the cursor, peer-1's
    # very next recv still delivers that message.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(tb, "unread by a")  # id 3
    out = await room.send(ta, "from a")  # id 4
    assert out["behind_by"] == 1
    # the cursor never moved: the recv right after still returns peer-2's message
    after = await room.recv(ta, wait=0)
    msgs = [(e.id, e.sender) for e in after["events"] if e.type == "message"]
    assert msgs == [(3, "peer-2")]


async def test_send_present_peers_reflects_roster():
    # present_peers on a send is the live roster in join order — the same set
    # peers() reports. A jacked-out peer drops out of it.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    out = await room.send(ta, "hello")
    assert out["present_peers"] == ["peer-1", "peer-2"] == room.peers()
    await room.jackout(tb)
    out = await room.send(ta, "just me now")
    assert out["present_peers"] == ["peer-1"]


# -- long-poll ------------------------------------------------------------


async def test_recv_returns_immediately_when_unread_exists():
    # joins take id 1,2; the message is id 3.
    room = make_room()
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "already here")
    out = await asyncio.wait_for(room.recv(tb, wait=10), timeout=0.2)
    assert [e.id for e in out["events"] if e.type == "message"] == [3]


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
    assert [e.id for e in msgs] == [3]
    assert msgs[0].message == "wake up"


async def test_quiet_recv_returns_heartbeat_after_wait():
    room = make_room()
    await room.jackin()
    tb, _ = await room.jackin()
    # drain tb's backlog (peer-1's join) so the next recv parks then heartbeats
    await room.recv(tb, wait=0)
    out = await asyncio.wait_for(room.recv(tb, wait=0.05), timeout=0.5)
    assert out["events"] == []
    assert "peer-1" in out["present_peers"] and "peer-2" in out["present_peers"]


async def test_wait_is_clamped_to_config_max():
    # wait_max is 0.2; asking for 100 must still heartbeat quickly. A lone peer
    # has no events about anyone else (its own join is filtered), so it parks.
    room = make_room()
    ta, _ = await room.jackin()
    out = await asyncio.wait_for(room.recv(ta, wait=100), timeout=0.5)
    assert out["events"] == []


# -- quiet_for: seconds since the last chat message ----------------------


async def test_quiet_for_is_none_before_any_message():
    # No one has spoken yet -> quiet_for is null, NOT 0 (which would read as
    # "someone just spoke"). A join is not talk, so it stays None after jackin.
    room = make_room()
    ta, _ = await room.jackin()
    out = await room.recv(ta, wait=0)
    assert out["quiet_for"] is None


async def test_quiet_for_is_zero_right_after_a_message():
    # Right after a message lands, the lull is ~0 (same clock instant).
    room, _clock = _idle_room(idle_timeout=10)
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "hi")  # stamps _last_msg_at at clock.now
    out = await room.recv(tb, wait=0)  # tb sees the message; no clock advance
    assert out["quiet_for"] == 0


async def test_quiet_for_grows_as_the_clock_advances():
    # quiet_for measures from the last message on the SAME seam the reaper uses,
    # so advancing the fake clock grows the lull (whole seconds, floored).
    room, clock = _idle_room(idle_timeout=10)
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "hi")
    await room.recv(tb, wait=0)  # drain so the next recv heartbeats
    clock.now += 7  # 7s of silence pass
    out = await asyncio.wait_for(room.recv(tb, wait=0.05), timeout=0.5)
    assert out["events"] == []
    assert out["quiet_for"] == 7


async def test_quiet_for_resets_on_a_new_message_presence_does_not_count():
    # A fresh message resets the lull to ~0; a join/leave in between does NOT
    # (presence is not talk), so quiet_for keeps climbing from the last message.
    room, clock = _idle_room(idle_timeout=10)
    ta, _ = await room.jackin()
    tb, _ = await room.jackin()
    await room.send(ta, "first")
    clock.now += 5
    await room.jackin()  # a third peer joins — presence, not talk
    out = await room.recv(tb, wait=0)
    assert out["quiet_for"] == 5  # the join did not reset the lull
    await room.send(ta, "second")  # a real message resets it
    out = await room.recv(tb, wait=0)
    assert out["quiet_for"] == 0


# -- presence events: join / leave on the stream -------------------------


async def test_jackin_appends_join_other_peers_receive():
    # alice is in; bob joins -> alice's recv carries a clean action(join) for bob.
    room = make_room()
    ta, _ = await room.jackin(requested="alice")
    await room.recv(ta, wait=0)  # drain alice's own-join-is-filtered backlog (empty)
    _tb, nb = await room.jackin(requested="bob")  # nb == "bob-1"
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
    # stream from id 0: alice's join AND alice's message, in event-id order.
    room = make_room()
    ta, na = await room.jackin(requested="alice")  # na == "alice-1"
    await room.send(ta, "early bird")
    tb, _ = await room.jackin(requested="bob")
    out = await room.recv(tb, wait=0)
    # bob filters his OWN join; he sees alice's join (id1) then alice's msg (id2)
    shape = [(e.id, e.type, getattr(e, "peer", getattr(e, "sender", None))) for e in out["events"]]
    assert shape == [(1, "action(join)", na), (2, "message", na)]


async def test_presence_rides_the_same_event_id_counter():
    # joins and a message share one climbing event-id counter, in order.
    room = make_room()
    ta, _ = await room.jackin(requested="alice")  # id1
    _tb, _ = await room.jackin(requested="bob")  # id2
    msg_id = (await room.send(ta, "hi"))["id"]  # id3
    tc, _ = await room.jackin(requested="carol")  # id4
    assert msg_id == 3
    # carol (fresh) backfills id1..3 (her own id4 join is filtered)
    out = await room.recv(tc, wait=0)
    assert [e.id for e in out["events"]] == [1, 2, 3]


# -- idle peer drop: reap_idle on the injected clock ----------------------
# These drive Room._now directly (no real sleeps): a mutable [t] list backs a
# clock we advance by assignment. idle_timeout stays > wait_max so the room's
# constructor guard is satisfied.


class _FakeClock:
    """A controllable monotonic clock for reap_idle tests. Reads return ``now``;
    tests set ``clock.now`` to fast-forward without any real waiting."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


def _idle_room(idle_timeout: int = 10) -> tuple[Room, _FakeClock]:
    clock = _FakeClock()
    cfg = Config(
        host="127.0.0.1",
        port=0,
        secret="s3cr3t",
        topic="testing the wire",
        wait_default=0.05,
        wait_max=0.2,
        idle_timeout=idle_timeout,
    )
    return Room(cfg, now=clock), clock


def _leaves_about(room: Room, name: str) -> list:
    return [e for e in room._messages if isinstance(e, Presence) and e.type == "action(leave)" and e.peer == name]


def _joins_about(room: Room, name: str) -> list:
    return [e for e in room._messages if isinstance(e, Presence) and e.type == "action(join)" and e.peer == name]


async def test_reap_idle_drops_peer_past_timeout_one_leave():
    # (a) A peer silent past idle_timeout is dropped, emitting exactly ONE leave.
    room, clock = _idle_room(idle_timeout=10)
    _t1, n1 = await room.jackin()  # last_active stamped at clock.now (1000)
    await room.jackin()  # a second peer so the roster isn't emptied
    clock.now += 11  # 11 > 10 -> peer-1 is idle
    await room.reap_idle()
    assert n1 not in room.peers()
    assert len(_leaves_about(room, n1)) == 1


async def test_reap_idle_keeps_peer_under_timeout():
    # (b) A peer still within idle_timeout is NOT dropped and emits no leave.
    room, clock = _idle_room(idle_timeout=10)
    _t1, n1 = await room.jackin()
    clock.now += 9  # 9 < 10 -> still active (boundary is strict >)
    await room.reap_idle()
    assert n1 in room.peers()
    assert _leaves_about(room, n1) == []


async def test_activity_after_drop_readds_peer_one_join():
    # (c) Activity after an idle drop re-adds the peer, emitting exactly ONE join
    # for the rejoin (on top of the original jackin join).
    room, clock = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin()
    await room.jackin()  # keep the room populated
    assert len(_joins_about(room, n1)) == 1  # the original jackin join
    clock.now += 11
    await room.reap_idle()
    assert n1 not in room.peers()
    # a token-bearing call (recv ENTRY stamps + rejoins) brings peer-1 back
    await room.recv(t1, wait=0)
    assert n1 in room.peers()
    assert len(_joins_about(room, n1)) == 2  # original + the rejoin, exactly one new


async def test_reap_idle_twice_emits_no_second_leave():
    # (d) Idempotency: a peer already reaped is not re-dropped on the next sweep.
    room, clock = _idle_room(idle_timeout=10)
    _, n1 = await room.jackin()
    await room.jackin()
    clock.now += 11
    await room.reap_idle()
    assert len(_leaves_about(room, n1)) == 1
    # clock advances further, but a second sweep must NOT emit another leave
    clock.now += 100
    await room.reap_idle()
    assert len(_leaves_about(room, n1)) == 1


async def test_jackout_then_same_token_rejoins_on_next_call():
    # (e) jackout drops the peer from the roster but the SAME token stays VALID
    # and rejoins on its next token-bearing call.
    room, _ = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin()
    await room.jackin()  # keep the room populated
    await room.jackout(t1)
    assert n1 not in room.peers()
    assert room.status(t1) is TokenStatus.VALID  # token survives jackout
    # next call (recv ENTRY) rejoins it with exactly one new join
    await room.recv(t1, wait=0)
    assert n1 in room.peers()
    assert len(_joins_about(room, n1)) == 2  # original jackin + the rejoin


async def test_reap_idle_disabled_when_timeout_zero():
    # idle_timeout == 0 disables idle drop: no peer is ever reaped, however long
    # it's been silent. (Also pins that the constructor guard is skipped at 0.)
    room, clock = _idle_room(idle_timeout=0)
    _, n1 = await room.jackin()
    clock.now += 100_000
    await room.reap_idle()
    assert n1 in room.peers()
    assert _leaves_about(room, n1) == []


async def test_idle_timeout_must_exceed_wait_max():
    # The latent-bug guard: a room whose idle_timeout <= wait_max would reap a
    # peer parked in a legitimate long-poll, so the constructor rejects it.
    with pytest.raises(AssertionError):
        Config_and_room_with_bad_idle()


def Config_and_room_with_bad_idle() -> Room:
    cfg = Config(
        host="127.0.0.1",
        port=0,
        secret="s3cr3t",
        topic="testing the wire",
        wait_max=60,
        idle_timeout=30,  # 30 <= 60 -> illegal
    )
    return Room(cfg)


# ========================================================================
# PHASE 3 — adversarial hardening of idle peer drop. Six gap groups, all on
# the injected clock (no real sleeps) except where a /recv must genuinely
# park, which is bounded tightly. Helpers (_idle_room, _FakeClock,
# _leaves_about, _joins_about) are reused from the Phase 1 section above.
# ========================================================================


# -- GAP 1: parked-poller survives (the marquee invariant) ----------------
# A peer genuinely parked in /recv across the idle window is NOT reaped,
# because last_active is stamped at recv ENTRY. Proven two ways: (a) pure
# clock-driven with a sweep run WHILE the recv is parked; (b) a small
# bounded real park to prove it holds without any clock seam help.


async def test_parked_recv_is_not_reaped_when_sweep_runs_mid_park():
    # The stamp-on-entry invariant, deterministic, with the entry stamp as the
    # ONLY thing keeping the peer alive (a mutation removing it makes this fail).
    # peer-1 jacks in at t=1000, then the clock advances PAST the threshold to
    # 1011 BEFORE peer-1 polls — so its stale jackin stamp (1000) would be
    # reaped. peer-1 then enters /recv at 1011: the entry stamp refreshes
    # last_active to 1011. A full sweep runs at 1011 WHILE peer-1 is parked; it
    # must survive purely on that fresh entry stamp, then heartbeat normally.
    room, clock = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin()  # last_active = 1000
    t2, _n2 = await room.jackin()  # peer-2, roster anchor
    await room.recv(t1, wait=0)  # drain peer-1's backlog (peer-2's join)

    # Advance PAST the threshold first: the jackin stamps (1000) are now stale.
    clock.now = 1011
    # Keep the anchor fresh so the sweep below drops NOBODY but the (would-be)
    # stale peer-1 — isolating the entry stamp as the only variable under test.
    await room.recv(t2, wait=0)  # stamps peer-2 at 1011

    # peer-1 parks; its ENTRY stamp fires at the current clock (1011). Without
    # that stamp, the stale 1000 would be reaped by the sweep below.
    recv_task = asyncio.create_task(room.recv(t1, wait=0.2))
    await asyncio.sleep(0.02)  # let the recv reach the park (lock released)

    # Sweep at the SAME instant the entry stamp was taken: 1011 - 1011 = 0,
    # not > 10, so peer-1 survives — only because the entry stamp refreshed it.
    await room.reap_idle()
    assert n1 in room.peers(), "parked poller was reaped despite a fresh entry stamp"
    assert _leaves_about(room, n1) == []

    # The parked recv returns normally (a heartbeat — nothing was sent).
    out = await asyncio.wait_for(recv_task, timeout=0.5)
    assert out["events"] == []
    assert n1 in room.peers()


async def test_recv_entry_stamp_is_what_keeps_a_long_poller_alive():
    # Counterfactual that pins the mechanism: WITHOUT the recv-entry stamp the
    # same peer WOULD be reaped. peer-1 jacks in at 1000; the clock then
    # advances past the threshold BEFORE peer-1 polls. If we reap first, it
    # drops; but a /recv (which stamps at the now-advanced clock) brings it
    # right back and a subsequent reap at the same instant leaves it alone —
    # exactly because the entry stamp refreshed last_active.
    room, clock = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin()  # last_active = 1000
    await room.jackin()  # roster anchor

    clock.now = 1011  # 11 > 10 from the stale 1000 stamp -> would reap
    await room.reap_idle()
    assert n1 not in room.peers()  # confirms staleness drops it

    # A token-bearing recv stamps last_active at the CURRENT clock (1011) on
    # entry, rejoining the peer; a reap at the SAME instant now finds it fresh.
    await room.recv(t1, wait=0)
    assert n1 in room.peers()
    await room.reap_idle()  # 1011 - 1011 = 0, not > 10
    assert n1 in room.peers(), "entry stamp failed to protect the peer from the very next sweep"
    # exactly one rejoin join beyond the original jackin join
    assert len(_joins_about(room, n1)) == 2


# -- GAP 2: reaper-vs-rejoin transition ordering (no double-announce) ------
# Single event loop, so this is about transition ordering under the lock, not
# flaky concurrency. Each ordering must produce exactly the right event count
# and a consistent final in_roster. Augments Phase 1's reap-twice idempotency.


async def test_leave_then_join_then_reap_while_absent_is_a_noop():
    # Ordering A: reap (leave) -> rejoin (join) -> reap-while-present-and-fresh
    # (no-op). Exactly one leave then one join beyond the jackin join; the final
    # reap at the rejoin instant must not fire anything.
    room, clock = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin()
    await room.jackin()  # anchor

    clock.now = 1011
    await room.reap_idle()  # leave #1
    assert len(_leaves_about(room, n1)) == 1
    assert n1 not in room.peers()

    await room.recv(t1, wait=0)  # rejoin (join #2), stamps last_active=1011
    assert len(_joins_about(room, n1)) == 2
    assert n1 in room.peers()

    await room.reap_idle()  # fresh stamp -> no-op, no second leave
    assert len(_leaves_about(room, n1)) == 1
    assert n1 in room.peers()


async def test_reap_while_already_absent_emits_no_leave():
    # Ordering B: jackout (leave) -> reap-while-absent (no-op). A peer already
    # out of the roster is never re-dropped, however idle the clock claims it is.
    room, clock = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin()
    await room.jackin()  # anchor

    await room.jackout(t1)  # leave #1
    assert len(_leaves_about(room, n1)) == 1
    assert n1 not in room.peers()

    clock.now = 5000  # wildly idle, but it's already absent
    await room.reap_idle()
    assert len(_leaves_about(room, n1)) == 1  # still exactly one
    assert n1 not in room.peers()


async def test_full_leave_join_leave_cycle_is_balanced():
    # A complete churn: jackin(join) -> reap(leave) -> recv(join) -> reap(leave).
    # End state OUT of roster, with exactly 2 joins and 2 leaves about the peer
    # and no duplicate announce at any transition.
    room, clock = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin()  # join #1
    await room.jackin()  # anchor

    clock.now = 1011
    await room.reap_idle()  # leave #1
    await room.recv(t1, wait=0)  # join #2 (stamps last_active=1011)
    clock.now = 1011 + 11  # idle again from the rejoin stamp
    await room.reap_idle()  # leave #2

    assert len(_joins_about(room, n1)) == 2
    assert len(_leaves_about(room, n1)) == 2
    assert n1 not in room.peers()


# -- GAP 3: multi-peer — only the idle drop; name stability on rejoin ------


async def test_reap_drops_only_idle_peers_active_ones_survive():
    # Three peers; only the one left idle past the threshold is dropped. The
    # other two are refreshed (a token call) within the window and survive, and
    # the surviving roster keeps join order.
    room, clock = _idle_room(idle_timeout=10)
    _t1, n1 = await room.jackin()  # peer-1 — will go idle
    t2, n2 = await room.jackin()  # peer-2 — stays active
    t3, n3 = await room.jackin()  # peer-3 — stays active

    clock.now = 1008  # refresh peer-2 and peer-3 just under the threshold
    await room.recv(t2, wait=0)  # stamps peer-2 at 1008
    await room.recv(t3, wait=0)  # stamps peer-3 at 1008

    clock.now = 1011  # 11 > 10 for peer-1 (stale 1000); 3 < 10 for the others
    await room.reap_idle()

    assert room.peers() == [n2, n3]  # peer-1 gone, join order preserved
    assert len(_leaves_about(room, n1)) == 1
    assert _leaves_about(room, n2) == [] and _leaves_about(room, n3) == []


async def test_reaped_peer_rejoins_with_its_ORIGINAL_name_no_inflation():
    # The selling point: a dropped peer that rejoins is the SAME _Peer, so it
    # keeps its original name — no name-2 inflation. Even though the name is
    # never freed, rejoining via the same token does not mint a new suffix.
    room, clock = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin(requested="alice")  # alice-1
    await room.jackin()  # anchor
    assert n1 == "alice-1"

    clock.now = 1011
    await room.reap_idle()
    assert n1 not in room.peers()

    # Same token re-calls -> same peer, SAME name (not alice-2).
    await room.recv(t1, wait=0)
    assert room.peer_name_for(t1) == "alice-1"
    assert "alice-1" in room.peers()
    assert "alice-2" not in room.peers()
    # the name was never duplicated in the join-order ledger either
    assert room._join_order.count("alice-1") == 1


async def test_reap_drops_all_idle_peers_in_one_sweep():
    # When several peers are all idle, a single sweep drops every one of them,
    # one leave each, emptying the roster.
    room, clock = _idle_room(idle_timeout=10)
    _, n1 = await room.jackin()
    _, n2 = await room.jackin()
    _, n3 = await room.jackin()

    clock.now = 1011  # all three stale
    await room.reap_idle()

    assert room.peers() == []
    assert len(_leaves_about(room, n1)) == 1
    assert len(_leaves_about(room, n2)) == 1
    assert len(_leaves_about(room, n3)) == 1


# -- GAP 4: leave/join event VISIBILITY + payload + subject filter ---------


async def test_reaped_leave_is_visible_to_others_but_not_to_self():
    # The reaped peer's action(leave) reaches OTHER peers via the shared log
    # with the right subject, and is filtered from the reaped peer's OWN stream.
    room, clock = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin()  # will be reaped
    t2, _ = await room.jackin()  # observer
    await room.recv(t2, wait=0)  # drain peer-1's join from the observer

    clock.now = 1011
    await room.reap_idle()

    # observer sees exactly one action(leave) about peer-1, well-formed
    out_obs = await room.recv(t2, wait=0)
    leaves = [e for e in out_obs["events"] if e.type == "action(leave)"]
    assert len(leaves) == 1
    assert leaves[0].peer == n1
    assert _ISO_UTC_Z_RE.match(leaves[0].sent_at), leaves[0].sent_at

    # the reaped peer rejoins on its next call; its OWN leave is never echoed
    out_self = await room.recv(t1, wait=0)
    assert [e for e in out_self["events"] if getattr(e, "peer", None) == n1] == []


async def test_rejoin_join_is_visible_to_others_but_not_to_self():
    # The flip side: after a reap+rejoin, the rejoin's action(join) reaches an
    # observer but not the rejoining peer itself.
    room, clock = _idle_room(idle_timeout=10)
    t1, n1 = await room.jackin()
    t2, _ = await room.jackin()

    clock.now = 1011
    await room.reap_idle()  # peer-1 dropped
    await room.recv(t1, wait=0)  # peer-1 rejoins -> action(join) #2

    # the observer drains everything, then we count joins about peer-1 it saw:
    # the original jackin join AND the rejoin join (two, both about peer-1)
    out_obs = await room.recv(t2, wait=0)
    joins_about_p1 = [e for e in out_obs["events"] if e.type == "action(join)" and e.peer == n1]
    assert len(joins_about_p1) == 2

    # peer-1 never sees its OWN join on its own stream
    out_self = await room.recv(t1, wait=0)
    assert [e for e in out_self["events"] if e.type == "action(join)" and e.peer == n1] == []


# -- GAP 5: the strict `>` boundary — exactly-at is NOT dropped -------------


async def test_reap_boundary_exactly_at_timeout_is_not_dropped():
    # STRICT >: at EXACTLY idle_timeout the peer survives; one tick past, it
    # drops. Pin both sides on the same room/clock.
    room, clock = _idle_room(idle_timeout=10)
    _, n1 = await room.jackin()  # last_active = 1000
    await room.jackin()  # anchor

    clock.now = 1010  # 1010 - 1000 == 10, NOT > 10 -> survives
    await room.reap_idle()
    assert n1 in room.peers(), "peer at exactly idle_timeout was wrongly dropped"
    assert _leaves_about(room, n1) == []

    clock.now = 1010.001  # just over -> drops
    await room.reap_idle()
    assert n1 not in room.peers()
    assert len(_leaves_about(room, n1)) == 1


# -- empty-room self-close: should_self_close on the injected clock --------
# Same _FakeClock seam as the idle-drop tests (no real sleeps). empty_grace is
# set via the config; idle_timeout is picked independently (and kept > wait_max
# where idle drop is exercised, so the constructor guard stays satisfied). The
# decision is PURE — these only read should_self_close(), nothing shuts down.


def _grace_room(empty_grace: int = 100, idle_timeout: int = 10) -> tuple[Room, _FakeClock]:
    clock = _FakeClock()
    cfg = Config(
        host="127.0.0.1",
        port=0,
        secret="s3cr3t",
        topic="testing the wire",
        wait_default=0.05,
        wait_max=0.2,
        idle_timeout=idle_timeout,
        empty_grace=empty_grace,
    )
    return Room(cfg, now=clock), clock


async def test_self_close_fires_after_grace_when_empty():
    # (1) jackin then jackout empties the roster; past empty_grace -> True.
    room, clock = _grace_room(empty_grace=100)
    t1, _ = await room.jackin()  # occupied -> _empty_since cleared
    assert await room.should_self_close() is False
    await room.jackout(t1)  # roster empty -> _empty_since = 1000
    clock.now += 101  # 101 > 100
    assert await room.should_self_close() is True


async def test_self_close_not_before_grace_strict_boundary():
    # (2) Before grace it does NOT fire; STRICT >: exactly-at = False, one tick
    # past = True. Pin both sides on the same room/clock.
    room, clock = _grace_room(empty_grace=100)
    t1, _ = await room.jackin()
    await room.jackout(t1)  # _empty_since = 1000

    clock.now = 1050  # well under grace
    assert await room.should_self_close() is False

    clock.now = 1100  # 1100 - 1000 == 100, NOT > 100 -> survives
    assert await room.should_self_close() is False, "exactly at empty_grace must NOT self-close"

    clock.now = 1100.001  # just over -> fires
    assert await room.should_self_close() is True


async def test_self_close_resets_when_peer_joins_or_rejoins():
    # (3) An empty room past grace is rescued by a fresh jackin, and separately by
    # a rejoin of the immortal token via recv/send.
    # --- fresh jackin clears the stamp ---
    room, clock = _grace_room(empty_grace=100)
    t1, _ = await room.jackin()
    await room.jackout(t1)
    clock.now += 200  # past grace
    assert await room.should_self_close() is True
    await room.jackin()  # a brand-new peer occupies the room
    assert await room.should_self_close() is False

    # --- rejoin via the immortal token (recv) clears the stamp ---
    room2, clock2 = _grace_room(empty_grace=100)
    tok, _ = await room2.jackin()
    await room2.jackout(tok)  # empty, token still VALID
    clock2.now += 200  # past grace
    assert await room2.should_self_close() is True
    await room2.recv(tok, wait=0)  # recv ENTRY rejoins the same peer
    assert await room2.should_self_close() is False

    # --- and a rejoin via send clears it too ---
    room3, clock3 = _grace_room(empty_grace=100)
    tok3, _ = await room3.jackin()
    await room3.jackout(tok3)
    clock3.now += 200
    assert await room3.should_self_close() is True
    await room3.send(tok3, "back")  # send also rejoins via the activity choke
    assert await room3.should_self_close() is False


async def test_self_close_boot_armed_never_joined_room():
    # (4) BOOT-ARMED: a room nobody EVER joins still dies. _empty_since is stamped
    # at construction (clock start = 1000), so advancing past empty_grace with an
    # empty roster from the start -> True.
    room, clock = _grace_room(empty_grace=100)
    assert room.peers() == []
    assert await room.should_self_close() is False  # ~0 elapsed at boot
    clock.now += 101
    assert await room.should_self_close() is True


async def test_self_close_disabled_at_zero_never_fires():
    # (5) empty_grace == 0 disables self-close: an empty roster, advanced
    # arbitrarily far, never fires and never crashes.
    room, clock = _grace_room(empty_grace=0)
    assert await room.should_self_close() is False  # never-joined, disabled
    clock.now += 10_000_000
    assert await room.should_self_close() is False
    t1, _ = await room.jackin()
    await room.jackout(t1)  # empty again
    clock.now += 10_000_000
    assert await room.should_self_close() is False


async def test_self_close_last_instant_join_cancels():
    # (6) An empty room past grace, then a jackin lands and clears _empty_since;
    # the very next should_self_close() reads None under the lock -> False. This
    # is the decision-side close of the last-instant /jackin race.
    room, clock = _grace_room(empty_grace=100)
    t1, _ = await room.jackin()
    await room.jackout(t1)
    clock.now += 200  # past grace; a poll right now would self-close
    await room.jackin()  # but a join lands first -> _empty_since = None
    assert await room.should_self_close() is False


async def test_self_close_additive_cascade_after_idle_drop():
    # (7) A lone silent peer: idle drop runs FIRST (after idle_timeout), and only
    # then does the empty-room clock start — so self-close is ~0 elapsed right
    # after the reap, and fires another empty_grace later.
    room, clock = _grace_room(empty_grace=100, idle_timeout=10)
    _t1, n1 = await room.jackin()  # last_active = 1000; room occupied
    assert await room.should_self_close() is False

    clock.now += 11  # 11 > idle_timeout 10 -> the lone peer is now idle
    await room.reap_idle()  # drops it -> roster empty -> _empty_since stamped HERE
    assert n1 not in room.peers()
    # Empty clock starts at the reap instant, not the jackout — additive, not
    # overlapping: right after the drop ~0 has elapsed against empty_grace.
    assert await room.should_self_close() is False

    clock.now += 101  # empty_grace + epsilon past the reap instant
    assert await room.should_self_close() is True
