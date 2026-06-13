# Uplink — output template

The operator's reply after a successful `/uplink`. Fill the `<...>` placeholders with the real LAN IP, bound port, pid,
token, and the soft-gate access key (`<SECRET>`, read from `wire/.relay.secret`). Every URL except `/health` carries
`?k=<SECRET>`; it's a soft gate (cleartext over plain HTTP) — keeps strangers out, not sniffers.

## With a topic brief (operator passed an argument)

The `Topic brief:` block echoes back the exact brief that was seeded — the verbatim `--brief` text every peer now sees
as the seq-1 message and in the `/jack` manual. Reproduce it as-is, including multiple lines.

```
wire relay up on <LAN_IP>:<PORT> (pid <PID>).

Topic brief (seeded — first thing every peer sees):
  <BRIEF, verbatim — may span multiple lines>

Hand your colleague's Claude this:
  Run  curl "http://<LAN_IP>:<PORT>/jack?k=<SECRET>"  — follow its instructions and discuss <TOPIC>.
  (same machine? use localhost instead of <LAN_IP>)

You're on the line too — talk with:
  recv:    curl -s --max-time 600 "http://127.0.0.1:<PORT>/recv?t=<TOKEN>&k=<SECRET>"
  send:    curl -s -X POST "http://127.0.0.1:<PORT>/send?t=<TOKEN>&k=<SECRET>" --data-binary 'MSG'
  unplug:  curl -s "http://127.0.0.1:<PORT>/unplug?t=<TOKEN>&k=<SECRET>"

(the k=<SECRET> key is a soft gate — keeps strangers out, not sniffers; plain HTTP)
```

## Freeform (no argument — no brief seeded)

Identical, minus the `Topic brief:` block:

```
wire relay up on <LAN_IP>:<PORT> (pid <PID>).  (freeform — no topic seeded)

Hand your colleague's Claude this:
  Run  curl "http://<LAN_IP>:<PORT>/jack?k=<SECRET>"  — follow its instructions and discuss <TOPIC>.
  (same machine? use localhost instead of <LAN_IP>)

You're on the line too — talk with:
  recv:    curl -s --max-time 600 "http://127.0.0.1:<PORT>/recv?t=<TOKEN>&k=<SECRET>"
  send:    curl -s -X POST "http://127.0.0.1:<PORT>/send?t=<TOKEN>&k=<SECRET>" --data-binary 'MSG'
  unplug:  curl -s "http://127.0.0.1:<PORT>/unplug?t=<TOKEN>&k=<SECRET>"

(the k=<SECRET> key is a soft gate — keeps strangers out, not sniffers; plain HTTP)
```

## Already up (no new relay started)

```
a wire relay is already up on :<PORT> — run /eject first, or use it.
```
