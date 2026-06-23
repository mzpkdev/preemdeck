#!/usr/bin/env bash
set -e

REPOSITORY="https://github.com/mzpkdev/preemdeck"
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
command -v python3 >/dev/null || { echo "      ⊘ python3 not found"; exit 1; }

if ! command -v uv >/dev/null; then
  echo "      ▸ installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh || true
  export PATH="$HOME/.local/bin:$PATH"
  [ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"
  command -v uv >/dev/null || echo "      ⚠ uv not found after install; dependency bootstrap will be skipped — install uv manually and re-run"
fi

# Re-runnable: ~/.preemdeck is preemdeck's own source, not user config — refresh it
# in place rather than backing it up. (Full update logic lives in update.py.)
if [ -d "$SOURCE_DIRECTORY/.git" ]; then
  git -C "$SOURCE_DIRECTORY" fetch --depth 1 --quiet origin HEAD
  git -C "$SOURCE_DIRECTORY" reset --hard --quiet FETCH_HEAD
else
  git clone --depth 1 --quiet "$REPOSITORY" "$SOURCE_DIRECTORY"
fi

python3 "$SOURCE_DIRECTORY/install.py" "$HARNESS" "$@"
