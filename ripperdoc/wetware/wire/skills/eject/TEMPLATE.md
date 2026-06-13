# Eject — output template

The one-line close the operator returns after `/eject`, by branch.

## Default (this session's room)

```
wire session closed — this session's relay down, pid/port/secret files cleared.
```

Nothing was running for this session:

```
nothing to eject for this session — try /eject --all or /rooms
```

## `--all` (every relay on this host)

```
ejected 2 relay(s): default, ff49f4c0
```

Nothing was running anywhere:

```
no wire relays were running.
```

## `--room <id>` (one specific room)

```
room ff49f4c0 down — pid/port/secret cleared.
```
