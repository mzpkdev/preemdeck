#!/usr/bin/env bash
set -e

REPOSITORY="https://github.com/mzpkdev/preemdeck"
# Pinned Bun runtime (distribution model A "ship-the-runtime"): every host runs
# preemdeck's .ts source on THIS exact Bun, fetched to ~/.preemdeck/.runtime/bin/bun.
# Bump deliberately — porting code is validated against this version only.
BUN_VERSION="1.3.14"
# Harness selection lives in install.ts now. Any positional args here are forwarded as
# explicit targets; with NONE, install.ts auto-detects installed hosts by their config
# dir (~/.claude, ~/.codex, ~/.gemini) and installs to each — no prompt, no default. If it
# detects none, it states so and exits nonzero (propagated below via set -e).
# preemdeck's source lives in its OWN dir, never a harness config dir.
SOURCE_DIRECTORY="$HOME/.preemdeck"

command -v git >/dev/null     || { echo "      ⊘ git not found"; exit 1; }

# Channel -> branch. PREEMDECK_CHANNEL picks the stream (default stable = released
# main; edge = main HEAD). stable's tip is a tag so install.ts stamps vX.Y.Z; edge
# stamps the short SHA via git describe --always. install.ts persists the resolved
# channel into preemdeck.json so `update` (update.ts) can forward it back here.
CHANNEL="${PREEMDECK_CHANNEL:-stable}"
case "$CHANNEL" in
  stable) TARGET_BRANCH="stable" ;;
  edge)   TARGET_BRANCH="main" ;;
  *) echo "      ⊘ unknown channel '$CHANNEL' (use stable|edge)"; exit 1 ;;
esac
if [ -d "$SOURCE_DIRECTORY/.git" ]; then
  git -C "$SOURCE_DIRECTORY" fetch --depth 1 --quiet origin "$TARGET_BRANCH" 'refs/tags/*:refs/tags/*'
  git -C "$SOURCE_DIRECTORY" reset --hard --quiet FETCH_HEAD
else
  git clone --depth 1 --quiet --branch "$TARGET_BRANCH" "$REPOSITORY" "$SOURCE_DIRECTORY"
fi

# Ship-the-runtime: fetch the PINNED Bun into ~/.preemdeck/.runtime/bin/bun so all
# .ts source runs on one known interpreter. Idempotent (skips when already present),
# best-effort (a fetch failure warns but never aborts the install handoff).
fetch_bun() {
  RUNTIME_DIR="$SOURCE_DIRECTORY/.runtime"
  BUN_BIN="$RUNTIME_DIR/bin/bun"
  [ -x "$BUN_BIN" ] && return 0

  # OS + arch -> Bun asset slug. Bun names ARM "aarch64" (not "arm64") and uses
  # "x64"; on linux a musl libc (Alpine et al.) needs the "-musl" asset.
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64|aarch64) slug="bun-darwin-aarch64" ;;
        x86_64|x64)    slug="bun-darwin-x64" ;;
        *) echo "      ⊘ bun: unsupported macOS arch '$arch' — skipping runtime fetch"; return 0 ;;
      esac ;;
    Linux)
      libc=""
      if [ -f /etc/alpine-release ]; then
        libc="-musl"
      elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
        libc="-musl"
      fi
      case "$arch" in
        x86_64|x64)    slug="bun-linux-x64${libc}" ;;
        aarch64|arm64) slug="bun-linux-aarch64${libc}" ;;
        *) echo "      ⊘ bun: unsupported Linux arch '$arch' — skipping runtime fetch"; return 0 ;;
      esac ;;
    *) echo "      ⊘ bun: unsupported OS '$os' — skipping runtime fetch"; return 0 ;;
  esac

  base="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
  tmp="$(mktemp -d)"
  # Silent on success — install.ts's banner owns the on-screen UI. The failure/fallback
  # branches below still speak (download failed, SHA mismatch, unzip missing).
  if ! curl -fsSL "$base/$slug.zip" -o "$tmp/$slug.zip"; then
    echo "      ⚠ bun: download failed — skipping; .ts source will fall back to host bun"
    rm -rf "$tmp"; return 0
  fi
  # Verify SHA256 against the release's SHASUMS256.txt before trusting the binary.
  if curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"; then
    want="$(grep " $slug.zip\$" "$tmp/SHASUMS256.txt" | awk '{print $1}')"
    if command -v shasum >/dev/null 2>&1; then
      got="$(shasum -a 256 "$tmp/$slug.zip" | awk '{print $1}')"
    elif command -v sha256sum >/dev/null 2>&1; then
      got="$(sha256sum "$tmp/$slug.zip" | awk '{print $1}')"
    else
      got=""
    fi
    if [ -n "$want" ] && [ -n "$got" ] && [ "$want" != "$got" ]; then
      echo "      ⊘ bun: SHA256 mismatch (want $want, got $got) — aborting runtime fetch"
      rm -rf "$tmp"; return 0
    fi
  fi
  if ! command -v unzip >/dev/null 2>&1; then
    echo "      ⚠ bun: unzip not found — skipping; install unzip and re-run"
    rm -rf "$tmp"; return 0
  fi
  unzip -q -o "$tmp/$slug.zip" -d "$tmp"
  mkdir -p "$RUNTIME_DIR/bin"
  mv "$tmp/$slug/bun" "$BUN_BIN"
  chmod +x "$BUN_BIN"
  rm -rf "$tmp"
}
fetch_bun || true

# Prune dev-only paths from the deployed clone — the logic + the .trash patterns live
# in devscripts/trash.ts (git sparse-checkout). Best-effort; uses the Bun vendored above.
"$SOURCE_DIRECTORY/preemdeck-runtime" "$SOURCE_DIRECTORY/devscripts/trash.ts" || true

# Runtime deps (hono, zod, cmdore, …) are installed by install.ts itself, as a visible
# phase (installDeps) — so the bun-install runs under the banner UI, not as silent
# pre-handoff noise. install.ts keeps zero third-party imports so it can load first, on
# the vendored Bun above, before any node_modules exist.
"$SOURCE_DIRECTORY/preemdeck-runtime" "$SOURCE_DIRECTORY/install.ts" "$@"
