<p align="center">
  <img src=".github/assets/banner.svg" alt="PREEMDECK — chrome for claude code, codex, and gemini cli" width="820"/>
</p>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mzpkdev/preemdeck/main/boot.sh | bash
```

Installs the **stable** channel by default. For **edge** (republished on every push to `main`), set `PREEMDECK_CHANNEL`:

```bash
curl -fsSL https://raw.githubusercontent.com/mzpkdev/preemdeck/main/boot.sh | PREEMDECK_CHANNEL=edge bash
```

The bootstrap clones the source to `~/.preemdeck` (its own directory — your `~/.claude` / `~/.codex` / `~/.gemini`
config is left in place) and runs `install.ts <harness>`. The default harness is `claude`; pass another to target it —
`… | bash -s codex` (combine with `PREEMDECK_CHANNEL` as needed).

The installer registers preemdeck's marketplaces/plugins by absolute path into `~/.preemdeck`, then copies the
per-harness overlay (settings + the `fixer` agent) into your host config dir. Any file it overwrites is backed up once
to `<file>.bak` first. Restart your CLI afterward to load the plugins.

## Update / Uninstall

```bash
~/.preemdeck/scripts/preemdeck-bun ~/.preemdeck/update.ts              # sync to your channel + re-install every recorded harness
~/.preemdeck/scripts/preemdeck-bun ~/.preemdeck/uninstall.ts [harness] # restore backups, unregister plugins; --dry-run to preview, --purge to print the rm -rf
```

`update.ts` follows your channel — `version` in `preemdeck.json` (`stable` | `edge` | a `2.2.1` tag), overridable
per-run with `PREEMDECK_CHANNEL=edge`.
