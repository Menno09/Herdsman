#!/bin/sh
# Reports Cursor's status to herdr-app (OSC 7501) so it shows as an agent, and
# saves its model for the herdr-board mod (~/.local/state/herdr-board/<terminal>.json).
# Usage from hooks.json: herdr-app-status.sh <idle|working|done>
payload=$(cat 2>/dev/null)
state="${1:-}"
[ "$state" = working ] && echo '{"continue":true}' || echo '{}'
[ -n "${HC_TERMINAL_ID:-}" ] || exit 0 # only inside herdr-app terminals

printf %s "$payload" | python3 -c '
import json, os, sys
try:
    m = json.load(sys.stdin).get("model")
except Exception:
    sys.exit(0)
if not isinstance(m, str) or not m or m == "unknown":
    sys.exit(0)
d = os.path.expanduser("~/.local/state/herdr-board")
p = os.path.join(d, os.environ["HC_TERMINAL_ID"] + ".json")
try:
    st = json.load(open(p))
except Exception:
    st = {}
if st.get("model") == m:
    sys.exit(0)
st["model"] = m
os.makedirs(d, exist_ok=True)
open(p + ".tmp", "w").write(json.dumps(st))
os.replace(p + ".tmp", p)
' 2>/dev/null

# Hook processes may have no controlling tty: walk up to the first ancestor that has one.
pid=$$
while [ "${pid:-1}" -gt 1 ]; do
  tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
  case "$tty" in ''|'?'|'??') ;; *) printf '\033]7501;state=%s:app=cursor\007' "$state" >"/dev/$tty" 2>/dev/null; exit 0 ;; esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
exit 0
