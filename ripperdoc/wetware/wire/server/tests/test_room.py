"""Unit tests for the framework-free room core.

No HTTP — exercises seq ordering, per-token cursors, read_your_last_message,
peer naming, jackout/validation status, and the long-poll wake. All waits are
tiny (<=0.2s) so the suite runs in seconds.
"""

from __future__ import annotations

import asyncio

import pytest

from wire.config import Config
from wire.room import Room, TokenStatus


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


def test_peer_naming_is_join_order():
    room = make_room()
    t1, n1 = room.jackin()
    t2, n2 = room.jackin()
    t3, n3 = room.jackin()
    assert (n1, n2, n3) == ("peer-1", "peer-2", "peer-3")
    assert t1 != t2 != t3
    assert room.peers() == ["peer-1", "peer-2", "peer-3"]


# -- optional self-naming -------------------------------------------------


def test_requested_valid_name_is_assigned():
    room = make_room()
    t1, n1 = room.jackin(requested="alice")
    assert n1 == "alice"
    # reflected everywhere the name flows: peers, the token binding, and from
    assert room.peers() == ["alice"]
    assert room.peer_name_for(t1) == "alice"
    t2, _ = room.jackin()
    # alice can be addressed as a sender on a delivered message
    asyncio.run(_assert_sends_as(room, t1, t2, "alice"))


async def _assert_sends_as(room: Room, sender_token: str, reader_token: str, expected: str) -> None:
    await room.send(sender_token, "hi")
    out = await room.recv(reader_token, wait=0)
    assert [m.sender for m in out["unread"]] == [expected]


def test_requested_name_coexists_with_auto_peer():
    # A named peer still advances the counter, so a later un-named peer gets the
    # right peer-N (the counter is not consumed by the custom name's slot).
    room = make_room()
    _, n1 = room.jackin(requested="alice")
    _, n2 = room.jackin()
    _, n3 = room.jackin(requested="bob")
    _, n4 = room.jackin()
    assert (n1, n2, n3, n4) == ("alice", "peer-2", "bob", "peer-4")


def test_taken_name_falls_back_to_peer_n():
    room = make_room()
    _, n1 = room.jackin(requested="alice")
    _, n2 = room.jackin(requested="alice")
    assert n1 == "alice"
    assert n2 == "peer-2"  # taken -> fallback, counter-based


def test_taken_name_is_case_insensitive():
    # Alice blocks a later alice (and ALICE) — names dedupe case-insensitively.
    room = make_room()
    _, n1 = room.jackin(requested="Alice")
    _, n2 = room.jackin(requested="alice")
    _, n3 = room.jackin(requested="ALICE")
    assert n1 == "Alice"  # original casing preserved for display
    assert n2 == "peer-2"
    assert n3 == "peer-3"


def test_taken_name_blocked_even_after_jackout():
    # A name is bound for the room's life: jacking out does not free it.
    room = make_room()
    t1, n1 = room.jackin(requested="alice")
    room.jackout(t1)
    _, n2 = room.jackin(requested="alice")
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
def test_malformed_name_falls_back(bad):
    room = make_room()
    _, name = room.jackin(requested=bad)
    assert name == "peer-1"


def test_reserved_peer_n_request_falls_back():
    # Can't impersonate the auto-scheme: peer-5 (any peer-\d+) is rejected.
    room = make_room()
    _, n1 = room.jackin(requested="peer-5")
    _, n2 = room.jackin(requested="peer-99")
    assert n1 == "peer-1"
    assert n2 == "peer-2"


def test_omitting_name_still_gives_peer_n():
    room = make_room()
    _, n1 = room.jackin()
    _, n2 = room.jackin(requested=None)
    assert (n1, n2) == ("peer-1", "peer-2")


def test_surrounding_whitespace_is_stripped():
    room = make_room()
    _, name = room.jackin(requested="  alice  ")
    assert name == "alice"


def test_no_duplicate_names_across_mixed_jackins():
    # A churn of valid, taken, malformed, reserved, and auto requests must never
    # produce two peers with the same (case-insensitive) name.
    room = make_room()
    requests = ["alice", "Alice", "bob", "peer-2", "x x", None, "bob", "carol", "", None]
    names = [room.jackin(requested=r)[1] for r in requests]
    folded = [n.casefold() for n in names]
    assert len(folded) == len(set(folded)), names


def test_token_binds_to_one_peer_for_life():
    room = make_room()
    t1, n1 = room.jackin()
    assert room.peer_name_for(t1) == "peer-1"
    # name survives jackout
    room.jackout(t1)
    assert room.peer_name_for(t1) == "peer-1"


def test_jackout_removes_from_connected_peers():
    room = make_room()
    t1, _ = room.jackin()
    t2, _ = room.jackin()
    left = room.jackout(t1)
    assert left == "peer-1"
    assert room.peers() == ["peer-2"]


# -- token validation surface --------------------------------------------


def test_status_unknown_token():
    room = make_room()
    assert room.status("not-a-real-token") is TokenStatus.UNKNOWN
    assert room.is_known("not-a-real-token") is False
    assert room.peer_name_for("not-a-real-token") is None


def test_status_valid_then_dead_after_jackout():
    room = make_room()
    t1, _ = room.jackin()
    assert room.status(t1) is TokenStatus.VALID
    assert room.is_known(t1) is True
    room.jackout(t1)
    assert room.status(t1) is TokenStatus.DEAD
    # still known (binding is permanent), just dead
    assert room.is_known(t1) is True


# -- seq ordering ---------------------------------------------------------


async def test_seq_climbs_across_different_senders():
    room = make_room()
    ta, _ = room.jackin()
    tb, _ = room.jackin()
    s1 = await room.send(ta, "hi from a")
    s2 = await room.send(tb, "hi from b")
    s3 = await room.send(ta, "again from a")
    assert [s1, s2, s3] == [1, 2, 3]


async def test_send_stamps_sender_name():
    room = make_room()
    ta, _ = room.jackin()
    tb, _ = room.jackin()
    tc, _ = room.jackin()
    await room.send(ta, "from a")
    await room.send(tb, "from b")
    # peer-3 reads both, confirming the from-names (a third peer so neither
    # message is filtered as its own under no-echo)
    out = await room.recv(tc, wait=0)
    senders = [(m.seq, m.sender, m.message) for m in out["unread"]]
    assert senders == [(1, "peer-1", "from a"), (2, "peer-2", "from b")]


# -- per-token cursor -----------------------------------------------------


async def test_cursor_advances_on_delivery():
    room = make_room()
    ta, _ = room.jackin()
    tb, _ = room.jackin()
    await room.send(ta, "one")
    await room.send(ta, "two")
    first = await room.recv(tb, wait=0)
    assert [m.seq for m in first["unread"]] == [1, 2]
    # cursor advanced — a second recv with no new messages heartbeats empty
    await room.send(ta, "three")
    second = await room.recv(tb, wait=0)
    assert [m.seq for m in second["unread"]] == [3]


async def test_cursor_unchanged_on_heartbeat():
    room = make_room()
    ta, _ = room.jackin()
    tb, _ = room.jackin()
    await room.send(ta, "one")
    # deliver it
    first = await room.recv(tb, wait=0)
    assert [m.seq for m in first["unread"]] == [1]
    # quiet recv -> heartbeat, cursor stays at 1
    hb = await room.recv(tb, wait=0.05)
    assert hb["unread"] == []
    # now a new message is still seen (cursor wasn't clobbered)
    await room.send(ta, "two")
    third = await room.recv(tb, wait=0)
    assert [m.seq for m in third["unread"]] == [2]


async def test_each_token_has_its_own_cursor():
    room = make_room()
    ta, _ = room.jackin()
    tb, _ = room.jackin()
    tc, _ = room.jackin()
    await room.send(ta, "shared")
    # b reads it, c does not
    out_b = await room.recv(tb, wait=0)
    assert [m.seq for m in out_b["unread"]] == [1]
    out_c = await room.recv(tc, wait=0)
    assert [m.seq for m in out_c["unread"]] == [1]
    # b re-reads: nothing new
    again_b = await room.recv(tb, wait=0.05)
    assert again_b["unread"] == []


# -- a peer never sees its own messages in unread (no echo) --------------


async def test_own_message_never_in_unread_heartbeat():
    # peer-1 sends and nobody else speaks -> peer-1's own recv must heartbeat
    # empty, never echo its own message back.
    room = make_room()
    ta, _ = room.jackin()
    room.jackin()  # peer-2 present but silent
    await room.send(ta, "mine")
    out = await room.recv(ta, wait=0)
    assert out["unread"] == []  # heartbeat, not the peer's own message


async def test_own_message_interleaved_below_others_not_skipped():
    # cursor 0; peer-2 (seq1), peer-1 (seq2), peer-3 (seq3). peer-1 must get
    # EXACTLY [seq1, seq3] in order — its own seq2 is filtered, but seq3 (above
    # its own send) is NOT skipped. Cursor ends at 3; a follow-up is a heartbeat.
    room = make_room()
    t1, _ = room.jackin()
    t2, _ = room.jackin()
    t3, _ = room.jackin()
    s1 = await room.send(t2, "from peer-2")
    s2 = await room.send(t1, "from peer-1")  # peer-1's own
    s3 = await room.send(t3, "from peer-3")
    assert [s1, s2, s3] == [1, 2, 3]

    out = await room.recv(t1, wait=0)
    assert [(m.seq, m.sender) for m in out["unread"]] == [(1, "peer-2"), (3, "peer-3")]

    # cursor advanced to 3 -> a follow-up recv is a heartbeat (own seq2 stays filtered)
    follow = await room.recv(t1, wait=0.05)
    assert follow["unread"] == []


async def test_other_peers_still_receive_my_message():
    # The flip side of no-echo: peer-2 DOES see peer-1's interleaved seq2.
    room = make_room()
    t1, _ = room.jackin()
    t2, _ = room.jackin()
    t3, _ = room.jackin()
    await room.send(t2, "from peer-2")  # seq1
    await room.send(t1, "from peer-1")  # seq2 (peer-1's own)
    await room.send(t3, "from peer-3")  # seq3

    out = await room.recv(t2, wait=0)
    # peer-2 does not see its OWN seq1, but does see peer-1's seq2 and peer-3's seq3
    assert [(m.seq, m.sender) for m in out["unread"]] == [(2, "peer-1"), (3, "peer-3")]


# -- read_your_last_message ----------------------------------------------


async def test_read_your_last_message_empty_before_sending():
    room = make_room()
    ta, _ = room.jackin()
    room.jackin()
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == []


async def test_read_your_last_message_reflects_readers():
    room = make_room()
    ta, _ = room.jackin()
    tb, _ = room.jackin()
    tc, _ = room.jackin()
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
    ta, _ = room.jackin()
    await room.send(ta, "talking to myself")
    # sender reads past its own message; must not list itself
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == []


async def test_read_your_last_message_tracks_latest_only():
    room = make_room()
    ta, _ = room.jackin()
    tb, _ = room.jackin()
    await room.send(ta, "first")
    await room.recv(tb, wait=0)  # b read seq 1
    # a sends again; b has NOT read seq 2 yet
    await room.send(ta, "second")
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == []
    # now b catches up
    await room.recv(tb, wait=0)
    out = await room.recv(ta, wait=0.05)
    assert out["read_your_last_message"] == ["peer-2"]


# -- long-poll ------------------------------------------------------------


async def test_recv_returns_immediately_when_unread_exists():
    room = make_room()
    ta, _ = room.jackin()
    tb, _ = room.jackin()
    await room.send(ta, "already here")
    out = await asyncio.wait_for(room.recv(tb, wait=10), timeout=0.2)
    assert [m.seq for m in out["unread"]] == [1]


async def test_parked_recv_wakes_on_send():
    room = make_room()
    ta, _ = room.jackin()
    tb, _ = room.jackin()

    async def speak_soon():
        await asyncio.sleep(0.02)
        return await room.send(ta, "wake up")

    # b parks with a generous wait; a's send must wake it well before timeout
    recv_task = asyncio.create_task(room.recv(tb, wait=10))
    send_task = asyncio.create_task(speak_soon())
    out = await asyncio.wait_for(recv_task, timeout=0.2)
    await send_task
    assert [m.seq for m in out["unread"]] == [1]
    assert out["unread"][0].message == "wake up"


async def test_quiet_recv_returns_heartbeat_after_wait():
    room = make_room()
    room.jackin()
    tb, _ = room.jackin()
    out = await asyncio.wait_for(room.recv(tb, wait=0.05), timeout=0.5)
    assert out["unread"] == []
    assert "peer-1" in out["peers"] and "peer-2" in out["peers"]


async def test_wait_is_clamped_to_config_max():
    # wait_max is 0.2; asking for 100 must still heartbeat quickly
    room = make_room()
    ta, _ = room.jackin()
    out = await asyncio.wait_for(room.recv(ta, wait=100), timeout=0.5)
    assert out["unread"] == []
