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
TARGET_DIRECTORY="$HOME/.$HARNESS"

command -v git >/dev/null     || { echo "      ⊘ git not found"; exit 1; }
command -v python3 >/dev/null || { echo "      ⊘ python3 not found"; exit 1; }

if ! command -v uv >/dev/null; then
  echo "      ▸ installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh || true
  export PATH="$HOME/.local/bin:$PATH"
  [ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"
  command -v uv >/dev/null || echo "      ⚠ uv not found after install; dependency bootstrap will be skipped — install uv manually and re-run"
fi

if [ -d "$TARGET_DIRECTORY" ]; then
  BACKUP="$TARGET_DIRECTORY.bak"
  [ -d "$BACKUP" ] && BACKUP="$TARGET_DIRECTORY.bak.$(date +%s)"
  mv "$TARGET_DIRECTORY" "$BACKUP"
fi

git clone --depth 1 --quiet "$REPOSITORY" "$TARGET_DIRECTORY"
cd "$TARGET_DIRECTORY" && python3 install.py "$HARNESS" "$@"
