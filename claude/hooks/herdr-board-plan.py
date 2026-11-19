#!/usr/bin/env python3
"""Records a Claude Code agent's plan file and todo list for the herdr-board mod.

Writes ~/.local/state/herdr-board/<HC_TERMINAL_ID>.json:
  {"session_id", "cwd", "model", "plan_file", "todos": [{"content", "status"}], "updated"}
Runs only inside herdr-app terminals, never prints, never fails the hook."""
import glob
import json
import os
import re
import sys
import time

PLANS = os.path.expanduser("~/.claude/plans")
STATE = os.path.expanduser("~/.local/state/herdr-board")


def tail(path, size=65536):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - size))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def last_model(transcript):
    """The model of the session's latest reply, e.g. claude-opus-5-5."""
    models = [m for m in re.findall(r'"model":"([^"]+)"', tail(transcript)) if not m.startswith("<")]
    return models[-1] if models else None


def slug_plan(transcript):
    """The session's plan file from the slug its transcript records (last 64 KB is enough)."""
    slugs = re.findall(r'"slug":"([^"/]+)"', tail(transcript))
    path = slugs and os.path.join(PLANS, slugs[-1] + ".md")
    return path if path and os.path.isfile(path) else None


def tasks(session_id):
    """Task-tool todos, if this Claude version keeps them in ~/.claude/tasks/<session>/."""
    out = []
    for p in sorted(glob.glob(os.path.expanduser(f"~/.claude/tasks/{session_id}/*.json"))):
        try:
            t = json.load(open(p))
            out.append({"content": t.get("subject") or t.get("content") or "", "status": t.get("status", "pending")})
        except (OSError, ValueError):
            pass
    return out


def main():
    term = os.environ.get("HC_TERMINAL_ID")
    if not term or "/" in term:
        return
    e = json.load(sys.stdin)
    sid = e.get("session_id") or ""
    path = os.path.join(STATE, f"{term}.json")
    try:
        state = json.load(open(path))
    except (OSError, ValueError):
        state = {}
    if state.get("session_id") != sid:  # a new session in this terminal: start clean
        state = {"session_id": sid, "plan_file": None, "todos": []}
    state["cwd"] = e.get("cwd")
    m = e.get("model")
    if isinstance(m, dict):
        m = m.get("id") or m.get("display_name")
    state["model"] = (m if isinstance(m, str) and m else None) or last_model(e.get("transcript_path", "")) or state.get("model")

    tool = e.get("tool_name") or ""
    ti = e.get("tool_input") if isinstance(e.get("tool_input"), dict) else {}
    tr = e.get("tool_response") if isinstance(e.get("tool_response"), dict) else {}
    fp = ti.get("file_path") or ""
    # plan mode's file, or a plan an agent keeps in the repo (docs/plan-dienstenrooster.md, PLAN.md)
    name = os.path.basename(fp).lower()
    if tool in ("Write", "Edit", "MultiEdit") and (os.path.abspath(fp).startswith(PLANS + os.sep) or (name.endswith(".md") and "plan" in name)):
        state["plan_file"] = os.path.abspath(fp)
    elif tool == "ExitPlanMode":
        state["plan_file"] = tr.get("filePath") or ti.get("planFilePath") or state.get("plan_file") or slug_plan(e.get("transcript_path", ""))
    elif tool == "TodoWrite":
        state["todos"] = [{"content": t.get("content", ""), "status": t.get("status", "pending")} for t in ti.get("todos", [])]
    elif tool.startswith("Task"):
        state["todos"] = tasks(sid) or state.get("todos", [])
    elif e.get("hook_event_name") == "SessionStart" and not state.get("plan_file"):
        state["plan_file"] = slug_plan(e.get("transcript_path", ""))

    state["updated"] = int(time.time() * 1000)
    os.makedirs(STATE, exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
