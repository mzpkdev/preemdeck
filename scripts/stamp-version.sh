#!/usr/bin/env sh
# stamp-version.sh — set every plugin manifest's "version" in the staged dist tree.
#
# Source manifests are pinned at 0.0.0 in git; the real patch is stamped HERE, at
# publish time, so every deploy advances the version string. That string is the
# cache key for all three hosts — Claude (plugin.json + marketplace entry), Codex
# (.codex-plugin/plugin.json), Gemini (gemini-extension.json) — and a CHANGED
# version is what forces a re-copy on update. A static version is a silent no-op
# (the reason edge content wasn't reaching installed caches). See the publish
# workflows, which pass 0.0.<git-rev-count> so the patch advances per commit.
#
#   sh scripts/stamp-version.sh /tmp/stage 0.0.157
#
# Portable in-place edit (sed to a temp + mv) so it runs the same on CI (GNU) and a
# local macOS (BSD) checkout — no `sed -i` flavor divergence. Repo manifest paths
# carry no spaces. Files with no "version" key (e.g. empty marketplaces) are skipped.
set -eu

STAGE="${1:?usage: stamp-version.sh <stage-dir> <version>}"
VERSION="${2:?usage: stamp-version.sh <stage-dir> <version>}"

find "$STAGE" -type f \( -name 'marketplace.json' -o -name 'plugin.json' -o -name 'gemini-extension.json' \) |
  while IFS= read -r f; do
    grep -q '"version"' "$f" || continue
    tmp="$f.stamp.$$"
    sed 's/"version": "[^"]*"/"version": "'"$VERSION"'"/g' "$f" >"$tmp" && mv "$tmp" "$f"
  done

n=$(grep -rl "\"version\": \"$VERSION\"" "$STAGE" --include='*.json' 2>/dev/null | wc -l | tr -d ' ')
echo "stamped version $VERSION into $n manifest(s) under $STAGE"
