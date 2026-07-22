#!/usr/bin/env sh
# Install the fakereum Claude skill into your personal skills directory so it's
# available in every Claude Code session (not just this repo).
#
#   ./install.sh            copy SKILL.md into ~/.claude/skills/fakereum
#   ./install.sh --link     symlink this dir instead (edits here take effect live)
#   ./install.sh --help
#
# Honors $CLAUDE_CONFIG_DIR if you keep your Claude config somewhere other than
# ~/.claude. Re-run any time to update an existing install.
set -eu

SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DEST_DIR="$CLAUDE_DIR/skills/fakereum"

LINK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --link) LINK=1 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -f "$SRC_DIR/SKILL.md" ]; then
  echo "error: SKILL.md not found next to install.sh ($SRC_DIR)" >&2
  exit 1
fi

mkdir -p "$CLAUDE_DIR/skills"

if [ "$LINK" -eq 1 ]; then
  rm -rf "$DEST_DIR"
  ln -s "$SRC_DIR" "$DEST_DIR"
  echo "Linked $DEST_DIR -> $SRC_DIR"
else
  mkdir -p "$DEST_DIR"
  cp "$SRC_DIR/SKILL.md" "$DEST_DIR/SKILL.md"
  echo "Installed skill to $DEST_DIR"
fi

echo "Open a new Claude Code session (or run /skills) to pick it up."
