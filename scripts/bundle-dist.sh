#!/usr/bin/env sh
# bundle-dist.sh — make every plugin CLI entry self-contained in the dist tree.
#
# A host (Claude/Codex/Gemini) installs a plugin by COPYING its own subtree into
# a private cache (e.g. ~/.claude/plugins/cache/<mp>/<plugin>/<version>/). That
# copy excludes the repo-root `lib/` and `node_modules/`, so a raw `.ts` entry
# whose imports climb into `../../../../../lib/text.ts` or name a bare npm dep
# (`cmdore`, `hono`, `zod`) can't resolve at runtime. Bundling inlines both into
# each entry, so the copied file stands alone — no lib/, no node_modules, no
# auto-install, no network.
#
# Run from the repo checkout root (where `lib/` and `node_modules/` resolve);
# pass the staged dist tree as $1 (default /tmp/stage). Each entry is built from
# the checkout and written OVER its staged copy under the same `.ts` path, so
# every manifest/hook/skill reference resolves unchanged.
set -eu

STAGE="${1:-/tmp/stage}"

# Resolve the npm deps the bundler will inline. CI-only: the result is baked into
# the entries, never shipped as node_modules.
bun install --frozen-lockfile

# Entry points = files that run as a CLI (`import.meta.main`), minus colocated
# tests/specs. Each gets its full import graph (core/*, lib/*, npm) inlined.
entries=$(grep -rl 'import.meta.main' ripperdoc --include='*.ts' | grep -vE '\.(test|spec)\.ts$')

for f in $entries; do
  echo "  bundle $f"
  bun build "$f" --target=bun --outfile="$STAGE/$f"
done
