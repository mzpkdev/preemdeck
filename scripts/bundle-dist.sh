#!/usr/bin/env sh
# bundle-dist.sh — make every plugin CLI entry self-contained in the dist tree.
#
# A host (Claude/Codex/Gemini) installs a plugin by COPYING its own subtree into
# a private cache (e.g. ~/.claude/plugins/cache/<mp>/<plugin>/<version>/). That
# copy excludes the repo-root `lib/` and `node_modules/`, so a raw `.ts` entry
# whose imports climb into `../../../../../lib/text.ts` or name a bare npm dep
# (`cmdore`, `hono`, `zod`) can't resolve at runtime.
#
# We bundle PER PLUGIN with code-splitting: all of a plugin's CLI entries build
# together, so their shared imports — cmdore, lib/*, core/* — are hoisted into ONE
# `_chunks/` dir inside that plugin instead of a full copy being inlined into every
# entry (cmdore was duplicated ~12x in dock/idea alone). The plugin is still copied
# to the host cache as a self-contained subtree, so `_chunks/` rides along and the
# thin entries import it by relative path (`../_chunks/...`). Outputs are written
# OVER the staged `.ts` paths (--entry-naming keeps the `.ts` extension), so every
# manifest/hook/skill reference resolves unchanged.
#
# Run from the repo checkout root (where `lib/` and `node_modules/` resolve); pass
# the staged dist tree as $1 (default /tmp/stage).
set -eu

STAGE="${1:-/tmp/stage}"

# Resolve the npm deps the bundler will inline. CI-only: the result is baked into
# each chunk, never shipped. Track whether node_modules already existed so a
# CI-created one can be cleaned below — the dist publish `git add -A`s the whole
# worktree, and node_modules carries 60MB binaries + secret-scanning tripwires.
had_node_modules=0
if [ -d node_modules ]; then had_node_modules=1; fi
bun install --frozen-lockfile

# Plugin roots = every dir holding a Claude plugin manifest (the canonical marker;
# Codex/Gemini installs derive from the same tree). Each is a self-contained copy
# unit in the host cache, so chunks must be hoisted per-plugin, not repo-wide —
# code shared across plugins can't be, since each is copied independently.
plugin_roots=$(find ripperdoc -type f -path '*/.claude-plugin/plugin.json' -exec dirname {} \; | xargs -n1 dirname | sort -u)

for root in $plugin_roots; do
  # CLI entries in this plugin: `import.meta.main`, minus colocated tests/specs.
  entries=$(grep -rl 'import.meta.main' "$root" --include='*.ts' | grep -vE '\.(test|spec)\.ts$' || true)
  [ -n "$entries" ] || continue
  echo "  bundle $root ($(printf '%s\n' "$entries" | wc -l | tr -d ' ') entries)"
  # Unquoted $entries: word-split into separate entrypoints (paths carry no spaces).
  # --splitting needs esm; --root makes outputs preserve their in-plugin layout under
  # --outdir; --entry-naming pins the `.ts` extension so references resolve unchanged.
  # shellcheck disable=SC2086
  bun build $entries \
    --target=bun --splitting --format=esm \
    --root "$root" --outdir "$STAGE/$root" \
    --entry-naming '[dir]/[name].ts' \
    --chunk-naming '_chunks/[name]-[hash].ts'
done

# Drop node_modules only if THIS run created it (fresh CI checkout) — never nuke a
# contributor's existing install when the script is run locally.
if [ "$had_node_modules" = 0 ]; then rm -rf node_modules; fi
