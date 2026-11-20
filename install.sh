#!/usr/bin/env bash
# Installs Herdr and this "herdsman" layout on macOS or Linux. Safe to re-run:
# every file it replaces is kept beside the original as <name>.bak-<time>.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STAMP="$(date +%Y%m%d-%H%M%S)"
export PATH="$HOME/.local/bin:$PATH"

# 1. Herdr desktop app (brings herdr-core / hc) and the herdr CLI
if ! command -v herdr-app >/dev/null; then
  echo "==> Installing the Herdr desktop app"
  curl -fsSL https://releases.herdr.dev/app/install.sh | sh
fi
if ! command -v herdr >/dev/null; then
  echo "==> Installing the herdr CLI"
  if command -v brew >/dev/null; then brew install herdr; else curl -fsSL https://herdr.dev/install.sh | sh; fi
fi

# Herdr writes its own built-in mods on first start; ours go on top of those.
if [ ! -f "$APP_HOME/installed.json" ]; then
  echo "Open the Herdr app once (finish the welcome screen), close it, then run this script again."
  exit 1
fi

put() { # put <source> <destination>: copy, keeping whatever was there as a backup
  mkdir -p "$(dirname "$2")"
  if [ -e "$2" ]; then mv "$2" "$2.bak-$STAMP"; fi
  cp -R "$1" "$2"
  echo "    $2"
}

echo "==> Copying the layout, mod, keys and settings"
put "$HERE/herdr-app/layouts/herdsman.json" "$APP_HOME/layouts/herdsman.json"
put "$HERE/herdr-app/mods/herdr-board"         "$APP_HOME/mods/herdr-board"
put "$HERE/herdr-app/mods/spaces-tree"         "$APP_HOME/mods/spaces-tree"
put "$HERE/herdr-app/keys.json"                "$APP_HOME/keys.json"
put "$HERE/herdr-app/settings.json"            "$APP_HOME/settings.json"
put "$HERE/herdr/config.toml"                  "$HOME/.config/herdr/config.toml"
put "$HERE/claude/hooks/herdr-board-plan.py"   "$HOME/.claude/hooks/herdr-board-plan.py"

echo "==> Agent integrations (status dots + session restore)"
command -v claude   >/dev/null && herdr integration install claude   || true
command -v opencode >/dev/null && herdr integration install opencode || true
{ command -v agent >/dev/null || command -v cursor-agent >/dev/null; } && herdr integration install cursor || true

echo "==> Registering the board's plan hook in ~/.claude/settings.json"
python3 - "$HOME/.claude/settings.json" "$STAMP" <<'PY'
import json, os, shutil, sys
path, stamp = sys.argv[1], sys.argv[2]
cmd = "python3 '" + os.path.expanduser("~/.claude/hooks/herdr-board-plan.py") + "'"
try:
    s = json.load(open(path))
    shutil.copy(path, f"{path}.bak-{stamp}")
except FileNotFoundError:
    s = {}
hooks = s.setdefault("hooks", {})
wanted = {"SessionStart": "", "PostToolUse": "Write|Edit|MultiEdit|ExitPlanMode|TodoWrite|TaskCreate|TaskUpdate"}
for event, matcher in wanted.items():
    groups = hooks.setdefault(event, [])
    if any(h.get("command") == cmd for g in groups for h in g.get("hooks", [])):
        continue  # already registered
    groups.append({"matcher": matcher, "hooks": [{"type": "command", "command": cmd, "timeout": 5}]})
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(s, open(path, "w"), indent=2)
PY

if [ -d "$HOME/.cursor" ]; then
  echo "==> Cursor status hooks (so Herdr shows Cursor as working / done)"
  put "$HERE/cursor/herdr-app-status.sh" "$HOME/.cursor/herdr-app-status.sh"
  python3 - "$HOME/.cursor/hooks.json" "$STAMP" <<'PY'
import json, os, shutil, sys
path, stamp = sys.argv[1], sys.argv[2]
script = os.path.expanduser("~/.cursor/herdr-app-status.sh")
try:
    h = json.load(open(path))
    shutil.copy(path, f"{path}.bak-{stamp}")
except FileNotFoundError:
    h = {"version": 1}
hooks = h.setdefault("hooks", {})
for event, state in [("sessionStart", "idle"), ("beforeSubmitPrompt", "working"), ("stop", "done")]:
    cmd = f"sh '{script}' {state}"
    lst = hooks.setdefault(event, [])
    if not any(x.get("command") == cmd for x in lst):
        lst.append({"command": cmd})
json.dump(h, open(path, "w"), indent=2)
PY
fi

echo "==> Checking the mods"
herdr-app check "$APP_HOME/mods/herdr-board"
herdr-app check "$APP_HOME/mods/spaces-tree"
herdr-app do layout.switch --name herdsman 2>/dev/null \
  || echo "Open Herdr and press Ctrl+Shift+L (or Cmd+Shift+L) until 'herdsman' shows."
echo "Done. Restart running Claude Code sessions so they load the new hook."
