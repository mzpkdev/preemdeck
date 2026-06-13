# Rooms — output template

The listing the operator returns after `/rooms`. One row per room; columns are ROOM (id, or `default` for the legacy
un-namespaced relay), PORT (bound), PID (with `(alive)` when the process answers `kill -0`), LIVE (`/health` answered),
and mine? (`<- you` on this session's row). A trailing `+secret` notes the secret file is present.

```
ROOM         PORT   PID      LIVE  mine?
ff49f4c0     55555  54321 (alive) yes   <- you +secret
a1b2c3d4     55556  54400 (alive) yes   -     +secret
default      55557  -        no    -     STALE: /eject --room default
```

## Stale hint

When a row is STALE (its portfile exists but `/health` does not answer — a leftover from a crashed or killed relay),
surface the clear-it hint:

```
room default looks stale (portfile present, not answering) — clear it with /eject --room default
```

## No rooms

```
no wire rooms on this host (none up). Open one with /uplink.
```
