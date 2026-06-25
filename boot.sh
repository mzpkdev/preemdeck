#!/usr/bin/env bash
set -e

REPOSITORY="https://github.com/mzpkdev/preemdeck"
# Pinned Bun runtime (distribution model A "ship-the-runtime"): every host runs
# preemdeck's .ts source on THIS exact Bun, fetched to ~/.preemdeck/.runtime/bin/bun.
# Bump deliberately — porting code is validated against this version only.
BUN_VERSION="1.3.14"
if [ $# -ge 1 ]; then
  HARNESS="$1"; shift
elif [ -e /dev/tty ] && [ -r /dev/tty ]; then
  printf "      ▸ harness (claude): "
  read -r HARNESS < /dev/tty
  HARNESS="${HARNESS:-claude}"
else
  HARNESS="claude"
fi
# preemdeck's source lives in its OWN dir, never the harness config dir.
# HARNESS selects which host to install FOR; it no longer decides the clone location.
SOURCE_DIRECTORY="$HOME/.preemdeck"

command -v git >/dev/null     || { echo "      ⊘ git not found"; exit 1; }

# Release channel -> branch. PREEMDECK_CHANNEL picks a published stream (default stable);
# install from dist-<channel>. An unknown/unpublished channel errors out rather than
# silently serving main's full (un-pruned) tree.
CHANNEL="${PREEMDECK_CHANNEL:-stable}"
TARGET_BRANCH="dist-$CHANNEL"
git ls-remote --exit-code --heads "$REPOSITORY" "$TARGET_BRANCH" >/dev/null 2>&1 \
  || { echo "      ⊘ unknown channel '$CHANNEL' (no $TARGET_BRANCH branch)"; exit 1; }

# Re-runnable: ~/.preemdeck is preemdeck's own source, not user config — refresh it
# in place rather than backing it up. (Full update logic lives in update.ts.)
if [ -d "$SOURCE_DIRECTORY/.git" ]; then
  git -C "$SOURCE_DIRECTORY" fetch --depth 1 --quiet origin "$TARGET_BRANCH"
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
  echo "      ▸ fetching bun v$BUN_VERSION ($slug)"
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
  echo "      ✓ bun v$BUN_VERSION ready at $BUN_BIN"
}
fetch_bun || true

"$SOURCE_DIRECTORY/scripts/preemdeck-bun" "$SOURCE_DIRECTORY/install.ts" "$HARNESS" "$@"
