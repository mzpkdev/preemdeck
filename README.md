<p align="center">
  <img src=".github/assets/banner.svg" alt="PREEMDECK — chrome for claude code, codex, and gemini cli" width="820"/>
</p>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mzpkdev/preemdeck/main/boot.sh | bash
```

This installs the **stable** channel by default. To track **edge** (latest `main`), set `PREEMDECK_CHANNEL=edge`:

```bash
curl -fsSL https://raw.githubusercontent.com/mzpkdev/preemdeck/main/boot.sh | PREEMDECK_CHANNEL=edge bash
```

The bootstrap clones the selected channel (stable by default; edge = `main`) to `~/.preemdeck` (its own directory — your
`~/.claude` / `~/.codex` / `~/.gemini` config is left in place) and runs `install.ts`. With no arguments it
**auto-detects** which of `~/.claude` / `~/.codex` / `~/.gemini` exist and installs to each — no prompt; if none are
found it says so and exits. Pass an explicit harness to override detection and target just one — `… | bash -s codex`.

Releases are cut by the **"Release (promote to stable)"** GitHub Action (Actions tab → Run workflow → a version like
`v0.1.0`), which tags the release and advances `stable`.

The installer registers preemdeck's marketplaces/plugins by absolute path into `~/.preemdeck`, then copies the
per-harness overlay (settings + the `fixer` agent) into your host config dir. Any file it overwrites is backed up once
to `<file>.bak` first. Restart your CLI afterward to load the plugins.

## Re-install / Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/mzpkdev/preemdeck/main/boot.sh | bash    # re-bootstrap + re-install; PREEMDECK_CHANNEL picks the stream (default stable)
~/.preemdeck/preemdeck-runtime ~/.preemdeck/uninstall.ts [harness] # restore backups, unregister plugins; --dry-run to preview, --purge to print the rm -rf
```
