## Prerequisites

- Bun — preemdeck's `.ts` source runs on a **pinned** Bun (`1.3.14`), vendored by `boot.sh` into
  `~/.preemdeck/.runtime/bin/bun` and invoked through the `preemdeck-runtime` shim. No host Bun needed; the fetch is
  best-effort and falls back to a host `bun` on `PATH` if it can't vendor.

## Format on edit

A project-local hook runs Biome (`.ts`/`.json`) and Prettier (`.md`/`.yml`/`.yaml`) after every agent edit on Claude
Code, Codex, and Gemini CLI. The hook script is run on the vendored Bun via the `preemdeck-runtime` shim; the formatters
it shells out to (Biome, Prettier) are unchanged. It never blocks the edit — failures warn on stderr.

| File                           | Role                                    |
| ------------------------------ | --------------------------------------- |
| `devscripts/format-on-edit.ts` | Shared script — single source of truth  |
| `.claude/settings.json`        | Claude: `PostToolUse` → script          |
| `.codex/config.toml`           | Codex: `[[hooks.PostToolUse]]` → script |
| `.gemini/settings.json`        | Gemini: `AfterTool` → script            |

**Codex trust:** first run prompts you to trust the project — accept it, or `.codex/config.toml` is silently ignored.
(Alt: pre-add `[projects."/abs/path/to/preemdeck"] trust_level = "trusted"` to `~/.codex/config.toml`.)

Full-repo format pass: `bun run format`.

## Tests

- `bun test` — what CI runs. The `bun:test` API; specs are colocated as `*.spec.ts` next to their source.
- The `wire:start`/`wire:stop` runtime path runs the TS toolbox via
  `"$HOME/.preemdeck/preemdeck-runtime" "${CLAUDE_PLUGIN_ROOT}/toolbox/start.ts"` (and `stop.ts`).

## Applying changes to a running harness

preemdeck's source lives in its own dir, `~/.preemdeck` — it does **not** squat `~/.claude` / `~/.codex` / `~/.gemini`.
The installer registers marketplaces/plugins by absolute path back into `~/.preemdeck` and **copies** the per-harness
overlay (`src/overwrite/<harness>/` — settings + the `fixer` agent) into the host config dir, backing up any clobbered
file once to `<file>.bak`. So editing this repo does **not** update a running harness: overlay edits need a re-install
to copy out again, and any edit only takes effect after the host CLI restarts.

**Apply on explicit request only. When the user asks to update their local copy / apply the changes, re-run `boot.sh`
yourself — you know the command, don't bounce it back. But only when asked: never apply unprompted after an edit.**
Re-running `boot.sh` fetches your channel (`stable` by default, or `edge` = `main`, selected via `PREEMDECK_CHANNEL`)
into `~/.preemdeck` (`fetch` + `reset --hard`) and re-installs every **detected** harness — each host with a config dir
(`~/.claude` / `~/.codex` / `~/.gemini`) — or just the one you name as an explicit override (`boot.sh codex`). With no
host detected it states so and exits nonzero.

Canonical flow — run on request:

```bash
git -C <dev-repo> add -A && git commit -m "…" && git push                           # 1. dev repo: commit + push
curl -fsSL https://raw.githubusercontent.com/mzpkdev/preemdeck/main/boot.sh | bash  # 2. deployed source: refresh ~/.preemdeck from your channel + re-install
```

Then restart the host CLI — plugins load at startup. To reverse an install,
`~/.preemdeck/preemdeck-runtime ~/.preemdeck/uninstall.ts [harness]` restores the `.bak` backups, unregisters the
plugins, and drops the harness from the manifest (`--dry-run` to preview, `--purge` to print the manual
`rm -rf ~/.preemdeck`).

## Agents

See [`llm-docs/INDEX.md`](llm-docs/INDEX.md) for the full working references (Claude↔Codex↔Gemini, coding standards,
contribution guide, how-to-create agents/hooks/skills).
