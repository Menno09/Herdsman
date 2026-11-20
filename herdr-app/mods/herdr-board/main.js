// Herdr Board: the xo board (herdr.dev/layouts/jkuepker/board) fed by Herdr's own agents instead of the xo CLI.
// Each agent is a card; its column comes from its status. "Close" closes the agent's pane.
// Originally: the xo crew as a board in Herdr. One mod draws every part; the layout says which with props().part:
// "top" (the pinned Board tab with its needs-you badge, then the shown space's tabs), "board" (today's numbers, the
// next move, project chips and four columns: NEEDS YOU, WORKING, READY TO LAND, DONE) and "bottom" (the counts).
// Data comes from the xo CLI, as the xo-bridge mod reads it: `xo bearings --rows` (the tasks and their group),
// `xo log --json` (what landed when) and `xo act` (Merge, Ship, Archive). local.json beside this file may say
// {"xo": "/path/to/xo", "home": "/an/xo/home"}. Focus (F) fades everything but NEEDS YOU and shows the picked task's
// live terminal in the layout's hidden "focus-term" block, so the question can be answered in place.
import { View, div, image, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, panes, terminals, run, props, exec, readTextFile, appHome, home, watchFolder, shared, setShared, window, knownAgents, nextCommand, layout, openOverlay, closeOverlay } from "herdr";

const findNode = (node, id) => node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null);

const MOD = "herdr-board";
const C = {
  top: "#101012", side: "#0f0f11", main: "#121214", card: "#1a1a1d", raised: "#242328", hover: "#1f1f23",
  line: "#1e1e20", line2: "#2a2a30", text: "#e4e4e7", soft: "#c8c8cc", muted: "#8a898e", dim: "#56555b",
  accent: "#b4a0db", accentDim: "#625187",
  you: "#ffb406", youBg: "#1f1a10", youCard: "#1b1912", youAsk: "#241f12", youLine: "#4a3a12",
  work: "#8f7fd1", land: "#53cf91", landBg: "#12201a", landLine: "#1d3a2c", done: "#6fb3f2", red: "#e0707f",
};
const COLS = [
  ["done", "IDLE", C.done],
  ["in_flight", "WORKING", C.work],
  ["needs_you", "NEEDS YOU", C.you],
  ["ready", "DONE", C.land], // finished while you weren't looking
];
const CHIPS = [
  ["#e0707f", "#3b1d24"], ["#3ec9b4", "#11302d"], ["#f0a050", "#3a2410"], ["#a690e8", "#2a2245"],
  ["#e6c35c", "#352c10"], ["#6fb3f2", "#152a40"], ["#e88cc8", "#3a1a30"], ["#8fd18a", "#1c321c"],
];
const MONO = "JetBrains Mono";
const SANS = "Geist";
const SAFETY_MS = 15000; // a read nothing asked for
const TICK_MS = 1000; // checks worker terminals and running actions; runs no program while nothing moved
const ASK_MS = 5000; // how often the questions of blocked agents are read off their screens
const CONFIRM = new Set(["merge", "ship", "remove", "land", "push", "cut", "clean"]); // asked on the card first
const LABEL = { merge: "Merge", ship: "Ship PR", remove: "Close", land: "Merge PR", sync: "Sync", push: "Push", cut: "Release", clean: "Clean" };

// the next moves a task's bearing offers as buttons: xo sync (catch up with its base), xo land (merge its PR), xo merge, xo ship
function moves(t) {
  const out = [];
  if (/^xo sync /.test(t.next)) out.push("sync");
  if (/^xo land /.test(t.next)) out.push("land");
  if (/^xo merge /.test(t.next)) out.push("merge");
  if (/^xo ship /.test(t.next) || /\bor xo ship\b/.test(t.next + " " + t.reason)) out.push("ship");
  return out;
}
const VIEW = "herdr-board.view"; // shared: "board" or "work", which child of the main stack shows
const LEFT = "herdr-board.left"; // shared: when the top bar last sent a picked space to the work view (ms)
const FOCUS = "herdr-board.focus"; // shared: Focus is on (the top bar fades tabs too)
const COUNTS = "herdr-board.counts"; // shared: what the top bar and status bar count

let counter = 0;
const clientId = () => `brd-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const firstLine = (s) => ((s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 160);
const mono = (size, color, text) => div().font_family(MONO).text_size(size).text_color(color).child(text);
const icon = (name, size, color) => svg(`mods/herdr-board/${name}.svg`).size(size).flex_none().text_color(color);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function human(n) { // like xo's tokens.human: 52.5K, 926K, 1.2M
  if (n < 1000) return String(n);
  for (const [size, unit] of [[1e3, "K"], [1e6, "M"], [1e9, "B"]]) {
    const v = n / size, text = v >= 99.95 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
    if (Number(text) < 1000 || unit === "B") return text + unit;
  }
  return String(n);
}
function dur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d`;
}
function chip(name) {
  let h = 0;
  for (const ch of String(name ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [fg, bg] = CHIPS[h % CHIPS.length];
  return div().flex_none().px(5).rounded(3).bg(bg).text_color(fg).font_family(SANS).text_size(11).child(name);
}
// a count that is a number: xo prints "-" or "?" when it can't tell
const num = (v) => (v === undefined || v === null || v === "-" || v === "?" ? null : Number(v));
// what the agent is doing, as xo-bridge shows it
function pill(row) {
  const a = row.agent ?? "-";
  if (a === "blocked" || a === "idle" || a === "working" || a.startsWith("queued #") || a.startsWith("slot #")) return a;
  return row.session_status !== "Live" ? "gone" : a === "-" ? "no agent" : a;
}

// what a blocked agent asks: the lowest line on its screen that ends a question (as Slate reads it)
async function question(address) {
  const r = await exec("hc", ["read", address]);
  if (r.code !== 0) return "";
  const lines = r.stdout.split("\n").map((l) => l.replace(/^[\s│┃╭╰╮╯─━❯›>⎿⏺●•◆□☐✳*]+/u, "").trim()).reverse();
  const q = lines.find((l) => l.length >= 10 && /\p{L}/u.test(l) && /\?(\s|\)|$)/.test(l) && !l.startsWith("?") && !/shortcuts/i.test(l));
  return !q ? "" : q.length > 160 ? q.slice(0, 159) + "…" : q;
}

// Cursor has no hook for "waiting for your approval", so Herdr kept it on working. Read the screens of working Cursor
// agents and report blocked to Herdr ourselves (the OSC 7501 its status hooks send), then working once it's answered.
// Cursor's own hooks only send idle/working/done, so a blocked Cursor agent is always one we reported.
const APPROVAL = /Run this command\?|Approval \d+ of \d+|Skip & tell the agent/;
async function reportStatus(address, state) {
  const g = JSON.parse((await exec("hc", ["get", address])).stdout);
  const tty = (await exec("ps", ["-o", "tty=", "-p", String(g.foreground?.pid ?? g.pid)])).stdout.trim();
  if (!tty || tty.startsWith("?")) return;
  await exec("sh", ["-c", 'printf "\\033]7501;state=%s:app=cursor\\007" "$1" > "/dev/$2"', "sh", state, tty]);
}
async function watchApprovals() {
  for (const a of agents()) {
    if (a.app !== "cursor" || a.address.includes("/")) continue; // shortcut: local terminals only, their tty is here
    if (a.status !== "working" && a.status !== "blocked") continue;
    try {
      const asks = APPROVAL.test(((await exec("hc", ["read", a.address])).stdout ?? "").split("\n").slice(-25).join("\n"));
      if (asks && a.status === "working") await reportStatus(a.address, "blocked");
      else if (!asks && a.status === "blocked") await reportStatus(a.address, "working");
    } catch { /* gone or no screen: next round */ }
  }
}

// what changes a card: an agent's status, title or place
const agentSig = () => [...agents().map((a) => `${a.address}:${a.status}:${a.title}:${a.tab}`),
  ...terminals().filter((k) => k.parent && k.state === "live").map((k) => `${k.address}:${k.status}`)].sort().join(" ");
const clean = (x) => (x ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const KIND = { blocked: "needs_you", working: "in_flight", done: "ready", idle: "done" };

// What the agent hooks recorded for an agent (model, plan file, todos), or null.
const stateDir = () => `${home()}/.local/state/herdr-board`;
async function planState(address) {
  if (address.includes("/")) return null; // shortcut: another machine's hook writes there; read only local agents
  try {
    return JSON.parse(await readTextFile(`${stateDir()}/${address}.json`));
  } catch { return null; }
}
const hasPlan = (st) => Boolean(st?.plan_file || st?.todos?.length);
// claude-opus-5-5 -> Opus 5.5; other models (gpt-6.1, composer-2) as they are
function modelName(m) {
  const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m ?? "");
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : m ?? "";
}
const openPlan = (address) => openOverlay({ mod: MOD, kind: "dialog", width: 860, height: 680, props: { part: "plan", address } });
// progress items: the agent's todo list, else the plan's own checkboxes
function progress(todos, lines) {
  if (todos?.length) return todos.map((t) => ({ text: t.content, state: t.status }));
  return lines.filter((l) => /^\s*[-*] \[[ xX]\]/.test(l))
    .map((l) => ({ text: l.replace(/^\s*[-*] \[[ xX]\]\s*/, ""), state: /\[[xX]\]/.test(l) ? "completed" : "pending" }));
}

// Claude sessions here run without a saved transcript, so their hook can't always tell the model. Fallback: the
// agent's own screen history, its startup banner ("Opus 5.5 with high effort") or a later /model "Set model to".
const SCAN_MS = 120000;
const BANNER = /\b((?:Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?) with \w+ effort/g;
const SWITCH = /Set model to[^\n]*?\b((?:Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?)/g;
function lastModel(text) {
  const all = [...text.matchAll(BANNER), ...text.matchAll(SWITCH)].sort((x, y) => x.index - y.index);
  return all.length ? all[all.length - 1][1] : null;
}

// A plan written as a chat reply: the agent's last reply, read off its screen, when a short heading-like line names a
// plan ("Plan to take this live"). Claude Code marks a reply with ⏺/●/•, a prompt with ❯ and a finished turn with
// "✻ Worked for 4m · done". When history no longer reaches the reply's start, what's left of it counts.
const PLAN_LINE = /^\s*(?:#+\s*)?[^.\n]{0,60}\bplan\b[^.\n]{0,60}:?\s*$/im;
function replyPlan(text) {
  const lines = text.split("\n");
  let end = lines.length, start = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*[✻✳✢*] \S+ for \d/.test(lines[i])) { end = i; break; }
  for (let i = end - 1; i >= 0; i--) {
    if (/^❯ \S/.test(lines[i])) { start = i + 1; break; }
    if (/^[⏺●•] /.test(lines[i])) { start = i; break; }
  }
  const out = [];
  for (const raw of lines.slice(start, end)) {
    if (/^\[hc\]/.test(raw)) continue;
    const l = raw.replace(/^[⏺●•] /, "").replace(/^ {2}/, "");
    const prev = out[out.length - 1];
    const ind = (x) => x.length - x.trimStart().length;
    // the terminal wraps long lines: a deeper-indented line that isn't a list item continues the one before
    if (prev?.trim() && l.trim() && ind(l) > ind(prev) && !/^\s*([-*]|\d+\.)\s/.test(l)) out[out.length - 1] = `${prev} ${l.trim()}`;
    else out.push(l);
  }
  const reply = out.join("\n").trim();
  return PLAN_LINE.test(reply) ? reply : null;
}
const readReplyPlan = (address) => exec("hc", ["read", "--lines", "1500", address]).then((r) => replyPlan(r.stdout ?? ""), () => null);

// Listening TCP ports per herdr terminal: lsof's listeners, matched to a terminal by the HC_TERMINAL_ID every process
// started in one inherits (read off the nearest parent that still shows it: next-server renames itself). Prints "<terminal> <port>" lines.
const PORTS_SH = `lsof -nP -iTCP -sTCP:LISTEN -Fpn 2>/dev/null | awk '/^p/{p=substr($0,2)} /^n/{print p, substr($0,2)}' | sort -u |
while read -r pid addr; do
  p=$pid; t=
  while [ -z "$t" ] && [ "\${p:-1}" -gt 1 ]; do
    t=$(ps -E -ww -o command= -p "$p" 2>/dev/null | grep -o 'HC_TERMINAL_ID=[^ ]*' | head -1 | cut -d= -f2)
    [ -n "$t" ] || p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  [ -n "$t" ] && echo "$t \${addr##*:}"
done`;

// Resource use per herdr terminal: CPU and memory of its whole process tree, sampled every 10 s, 15 minutes kept.
const SAMPLE_MS = 10000;
// The board view is dropped while a tab shows, so the always-shown top bar samples and keeps the history in shared
// state (it also survives a restart); the board only draws it.
const SAMPLES = "herdr-board.samples"; // [{cpu: {terminal: % of the machine}, mem: {terminal: bytes}}]
const SYS = "herdr-board.sys"; // {mem, cores}
const KEEP = 90;
const SERIES = ["#53cf91", "#8f7fd1", "#f0a050", "#6fb3f2", "#e88cc8", "#3ec9b4"];
const bytes = (n) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GiB` : `${Math.round(n / 1048576)} MiB`;
const paint = (p, color) => globalThis.window.paint_path(p.build(), color).absolute().top(0).left(0).size_full();
const level = (f) => f < 0.6 ? C.land : f < 0.85 ? "#f0a050" : C.red;

// Server health: error lines in a dev server's recent output (not "0 errors"), and the last one, tidied.
// Paths and URLs don't count (a request for /build/assets/input-error.js isn't an error); QueryException does.
const ERR = /(\w*exception\b|\berror\b|\bfatal\b|\bfailed\b|\brefused\b|\bpanic\b|\btraceback\b)/i;
const isError = (l) => { const x = l.replace(/\S*\/\S*/g, ""); return ERR.test(x) && !/\b(0|no) errors?\b/i.test(x); };
// a line that shows the server working: ✓ Compiled, "ready", GET / 200, artisan's "/health ..... ~ 0.04ms"
const OK_LINE = /(✓|\bcompiled\b|\bready\b|\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b.*\b[23]\d\d\b|~\s*[\d.]+\s*ms\s*$)/i;
function logErrors(text) {
  // only this run: what follows the last shell prompt (➜ / ❯ / $ / %), so an earlier failed command doesn't count
  const lines = text.split("\n");
  let from = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*(➜|❯|\$|%)\s+\S/.test(lines[i])) { from = i + 1; break; }
  // only errors it hasn't got past: what follows its last healthy line (a compile, a 2xx/3xx request, a served hit)
  const run = lines.slice(from);
  let since = run;
  for (let i = run.length - 1; i >= 0; i--) if (!isError(run[i]) && OK_LINE.test(run[i])) { since = run.slice(i + 1); break; }
  const bad = since.filter(isError);
  const last = (bad[bad.length - 1] ?? "").replace(/^\s*\[[\w-]+\]\s*/, "").replace(/[│┃┌┐└┘╭╮╰╯─━]+/g, " ").replace(/\s+/g, " ").trim();
  return { count: bad.length, last };
}

// Herdr's agents in the shape the board read from `xo bearings --rows`: one task per agent.
class Agents {
  constructor() { this.seen = new Map(); this.replies = new Map(); } // address -> {model|plan, at, busy, key}

  // a Claude agent's reply plan, read again when its status changes and at most once a minute otherwise
  screenPlan(a) {
    const c = this.replies.get(a.address);
    if (!c || (!c.busy && (c.key !== a.status || Date.now() - c.at > 60000))) {
      const e = { plan: c?.plan ?? null, at: Date.now(), busy: true, key: a.status };
      this.replies.set(a.address, e);
      readReplyPlan(a.address).then((p) => { const was = e.plan; e.plan = p; if (Boolean(was) !== Boolean(p)) this.onChange?.(); })
        .finally(() => { e.busy = false; e.at = Date.now(); });
    }
    return this.replies.get(a.address).plan;
  }

  screenModel(address) {
    const c = this.seen.get(address);
    if (!c || (!c.busy && Date.now() - c.at > SCAN_MS)) {
      const e = { model: c?.model ?? null, at: Date.now(), busy: true };
      this.seen.set(address, e);
      exec("hc", ["read", "--lines", "20000", address])
        .then((r) => { e.model = lastModel(r.stdout ?? "") ?? e.model; }, () => {})
        .finally(() => { e.busy = false; e.at = Date.now(); });
    }
    return this.seen.get(address).model;
  }

  async state() {
    const tabs = new Map(spaces().flatMap((sp) => sp.tabs).map((t) => [t.id, t]));
    const rows = [], bearings = [];
    const list = agents();
    const plans = await Promise.all(list.map((a) => planState(a.address)));
    for (const [i, a] of list.entries()) {
      const tab = tabs.get(a.tab);
      const title = clean(a.title);
      const reply = a.app === "claude-code" ? this.screenPlan(a) : null;
      // finished with a plan: it waits for your go-ahead
      const waits = Boolean(reply) && (a.status === "idle" || a.status === "done");
      rows.push({ key: a.address, project: a.space_name || "space", slug: a.program?.name || a.address, session: a.address, mux: "hc", agent: a.status, session_status: "Live", plan: hasPlan(plans[i]) ? plans[i] : reply ? { reply: true } : null, model: plans[i]?.model || (a.app === "claude-code" ? this.screenModel(a.address) : null),
        pane: a.pane, harness: a.program?.key, title: tab?.named ? tab.name : title && !/^[~/]/.test(title) ? title : tab?.name ?? "" });
      bearings.push({ key: a.address, kind: waits ? "needs_you" : KIND[a.status] ?? "done", reason: waits ? "It has a plan for you: open Plan to read it." : a.status ?? "", next: "" });
    }
    // Helpers an agent started with `hc run` have no pane, so they aren't in agents(): a card each, in the project of
    // the listed agent they descend from. Clicking one peeks at it (goTo).
    const byAddr = new Map(list.map((a) => [a.address, a]));
    const all = terminals();
    const parentOf = new Map(all.map((k) => [k.address, k.parent]));
    for (const k of all) {
      if (k.state !== "live" || !k.parent || !k.status || byAddr.has(k.address)) continue;
      let p = k.parent, root = null;
      for (let i = 0; p && !root && i < 10; i++) { root = byAddr.get(p); p = parentOf.get(p); }
      if (!root) continue; // a helper of something not on the board
      const st = k.status === "error" ? "blocked" : k.status; // as the agents mod shows them
      rows.push({ key: k.address, project: root.space_name || "space", slug: k.program?.name || k.address, session: k.address, mux: "hc", agent: st, session_status: "Live", plan: null, model: null,
        pane: null, harness: k.program?.key, title: `${k.name || k.address} · helper of ${clean(root.title) || root.address}` });
      bearings.push({ key: k.address, kind: KIND[st] ?? "done", reason: st ?? "", next: "" });
    }
    return { rows, bearings };
  }
  async log() { return []; }
  // the only action left: Close ("remove") ends the agent's pane
  async start(key, what) {
    const a = agents().find((x) => x.address === key);
    if (what === "remove" && a) run("pane.close", { pane: a.pane });
    else if (what === "remove") await exec("hc", ["kill", key]).catch(() => {}); // a helper: no pane to close
    return { state: "done", code: 0, output: "" };
  }
  async action() { return { state: "done", code: 0 }; }
}

export default class Board extends View {
  init(_props, cx) {
    this.part = _props?.part ?? props()?.part;
    this.now = Date.now();
    if (this.part === "plan") return this.initPlan(cx);
    if (this.part === "servers") return this.initServers(cx);
    if (this.part === "top") {
      this.pids = new Map(); // terminal -> its root process
      this.sys = shared(SYS);
      this.sample(cx);
      cx.timer.every(SAMPLE_MS, (cx) => this.sample(cx));
      cx.timer.every(2000, () => { watchApprovals(); }); // the top bar is always shown, and only once
    }
    if (this.part !== "board") { // the bars only draw what the board shares, and the clock
      cx.timer.every(30000, (cx) => { this.now = Date.now(); cx.notify(); });
      return;
    }
    this.h = cx.focus_handle();
    this.src = new Agents();
    this.tasks = []; // {key, project, slug, kind, reason, next, row}
    this.events = [];
    this.problem = null;
    this.polling = false;
    this.again = false;
    this.lastRead = 0;
    this.termSig = null;
    this.titles = {}; // task key -> first line of its brief
    this.asks = {}; // task key -> the question on its screen
    this.asking = false;
    this.programs = {}; // harness -> Program, for the agent icons
    this.filter = null; // a project, or null for all
    this.pushes = []; // {key: project, reason, next} for projects ahead of origin
    this.sel = null; // the selected task key
    this.focus = false;
    this.confirm = null; // {key, do}; key "*" archives every DONE task
    this.acts = {}; // task key -> {id, do, state, line}
    this.configured = false;
    // Focus starts off; the layout remembers a shown focus-term across reloads, so close it to match
    run("layout.hide", { id: "focus-term" });
    if (shared(FOCUS)) setShared(FOCUS, false);
    cx.spawn(async (cx) => {
      this.configured = true;
      this.refresh(cx);
      this.watchPlans(cx);
      this.readHealth(cx);
      try { for (const p of await knownAgents()) this.programs[p.key] = p; } catch { /* no icons: letters */ }
      cx.notify();
    });
    // board.<command> from keys.json or `herdr-app do`: works while the board doesn't have the keyboard
    cx.spawn(async (cx) => { for (;;) { this.command(String(await nextCommand()).replace(/^board\./, ""), cx); cx.notify(); } });
    this.health = []; // [{terminal, pane, tab, name, ports, code, errors, last}]
    cx.timer.every(10000, (cx) => this.readHealth(cx));
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.timer.every(ASK_MS, (cx) => this.readAsks(cx));
    cx.timer.every(30000, (cx) => { this.now = Date.now(); cx.notify(); });
  }

  // ---- data -------------------------------------------------------------------------------------------------

  sample(cx) {
    if (this.sampling) return;
    this.sampling = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.sys) {
          const [mem, cores] = (await exec("sysctl", ["-n", "hw.memsize", "hw.ncpu"])).stdout.trim().split(/\s+/).map(Number);
          this.sys = { mem, cores: cores || 1 };
          setShared(SYS, this.sys);
        }
        const live = terminals().filter((t) => t.state === "live" && !String(t.address).includes("/")).map((t) => t.address);
        await Promise.all(live.filter((t) => !this.pids.has(t)).map(async (t) => {
          try { this.pids.set(t, JSON.parse((await exec("hc", ["get", t])).stdout).pid); } catch { /* next time */ }
        }));
        for (const t of [...this.pids.keys()]) if (!live.includes(t)) this.pids.delete(t);
        const kids = new Map(), use = new Map();
        for (const line of (await exec("ps", ["-axo", "pid=,ppid=,pcpu=,rss="])).stdout.split("\n")) {
          const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number);
          if (!pid) continue;
          use.set(pid, [cpu, rss * 1024]);
          if (!kids.has(ppid)) kids.set(ppid, []);
          kids.get(ppid).push(pid);
        }
        const cpu = {}, mem = {};
        for (const [t, root] of this.pids) {
          let c = 0, m = 0;
          for (const stack = [root]; stack.length;) {
            const pid = stack.pop();
            const [pc, rs] = use.get(pid) ?? [0, 0];
            c += pc; m += rs;
            stack.push(...(kids.get(pid) ?? []));
          }
          if (use.has(root)) { cpu[t] = c / this.sys.cores; mem[t] = m; }
        }
        setShared(SAMPLES, [...(shared(SAMPLES) ?? []), { cpu, mem }].slice(-KEEP));
      } catch { /* skip this sample */ }
      this.sampling = false;
      cx.notify();
    });
  }

  // local dev servers: terminals listening on a port (the Running panel's scan, or our own when it's stale), each checked
  // for an HTTP answer and for error lines in its last 300 lines
  readHealth(cx) {
    if (this.checking) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      try {
        let ports = shared("herdr-board.ports");
        if (!ports || Date.now() - ports.at > 12000) {
          const out = {};
          for (const line of ((await exec("sh", ["-c", PORTS_SH])).stdout ?? "").split("\n")) {
            const [term, port] = line.trim().split(" ");
            if (term && /^\d+$/.test(port ?? "")) out[term] = [...new Set([...(out[term] ?? []), Number(port)])].sort((x, y) => x - y);
          }
          ports = { at: Date.now(), ports: out };
          setShared("herdr-board.ports", ports);
        }
        const isAgent = new Set(agents().map((a) => a.address));
        const byTerm = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p]));
        const servers = Object.entries(ports.ports).filter(([term]) => !isAgent.has(term) && byTerm.has(term));
        this.health = await Promise.all(servers.map(async ([term, list]) => {
          const p = byTerm.get(term);
          let code = "000";
          try { code = (await exec("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", `http://localhost:${list[0]}/`])).stdout.trim(); } catch { /* down */ }
          let errs = { count: 0, last: "" };
          try { errs = logErrors((await exec("hc", ["read", "--lines", "300", term])).stdout ?? ""); } catch { /* no screen */ }
          return { terminal: term, pane: p.pane, tab: p.tab, name: clean(p.title) || p.program?.name || term, ports: list, code, errors: errs.count, last: errs.last };
        }));
      } catch { /* keep the last check */ }
      this.checking = false;
      cx.notify();
    });
  }

  // reads again when the plan hook writes
  watchPlans(cx) {
    cx.spawn(async (cx) => {
      this.src.onChange = () => this.refresh(cx);
      try { await exec("mkdir", ["-p", stateDir()]); } catch { return; }
      for (;;) {
        try { await watchFolder(stateDir()); } catch { return; } // the 15s safety read still covers it
        this.refresh(cx);
      }
    });
  }

  // ---- the Running panel: dev servers, then each workspace's terminals ----------------------------------------------

  initServers(cx) {
    this.ports = new Map(); // terminal -> [port]
    const scan = (cx) => cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", PORTS_SH]);
        const m = new Map();
        for (const line of (r.stdout ?? "").split("\n")) {
          const [t, port] = line.trim().split(" ");
          if (t && /^\d+$/.test(port ?? "")) m.set(t, [...new Set([...(m.get(t) ?? []), Number(port)])].sort((x, y) => x - y));
        }
        this.ports = m;
        setShared("herdr-board.ports", { at: Date.now(), ports: Object.fromEntries(m) }); // the sidebar's open spaces use it too
      } catch { /* keep the last scan */ }
      cx.notify();
    });
    scan(cx);
    cx.timer.every(5000, (cx) => scan(cx));
  }

  serversView() {
    const isAgent = new Set(agents().map((a) => a.address)); // an agent's own sockets aren't dev servers
    const ports = (term) => (isAgent.has(term) ? [] : this.ports.get(term) ?? []);
    const where = new Map();
    for (const sp of spaces()) for (const tab of sp.tabs) where.set(tab.id, { sp, tab });
    const all = panes().filter((p) => p.terminal && where.has(p.tab));
    const go = (p) => {
      const w = where.get(p.tab);
      run("space.select", { id: w.sp.id });
      run("tab.select", { id: p.tab });
      run("pane.focus", { pane: p.pane });
      run("layout.select", { stack: "main", child: "work" });
      setShared(LEFT, Date.now());
      setShared(VIEW, "work");
    };
    const pic = (p) => p.program?.icon ? (p.program.tint ? svg(p.program.icon).size(13).flex_none().text_color(C.muted) : image(p.program.icon).w(13).h(13).flex_none())
      : div().w(13).h(13).flex_none();
    const mark = (st) => st === "working" ? icon("spinner", 10, C.work).spin(900) : st ? div().w(6).h(6).rounded(3).flex_none()
      .bg({ blocked: C.you, done: C.land, idle: C.done }[st] ?? C.dim) : null;
    const portChip = (p, port) => div().id(`port-${p.pane}-${port}`).flex_none().px(5).rounded(3).bg(C.landBg).border(1).border_color(C.landLine)
      .font_family(MONO).text_size(10.5).text_color(C.land).cursor_pointer().hover((st) => st.opacity(0.8)).tooltip(`Open http://localhost:${port}`)
      .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [`http://localhost:${port}`]).catch(() => {}); }).child(`:${port}`);
    const row = (p, sub) => h_flex().id(`run-${p.pane}`).w_full().gap(7).px(8).py(5).rounded(5).items_center().cursor_pointer()
      .hover((st) => st.bg(C.hover)).on_click(() => go(p))
      .child(pic(p))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().font_family(SANS).text_size(12.5).text_color(C.text).child(clean(p.title) || p.program?.name || p.terminal))
        .when(!!sub, (el) => el.child(div().truncate().font_family(MONO).text_size(10.5).text_color(C.dim).child(sub))))
      .children(ports(p.terminal).map((port) => portChip(p, port)))
      .children(mark(p.status) ? [mark(p.status)] : []);
    const head = (label, n) => h_flex().w_full().gap(6).px(8).pt(10).pb(4).items_center()
      .child(mono(10, C.dim, label)).child(mono(10, C.dim, String(n)));

    const servers = all.filter((p) => ports(p.terminal).length);
    return v_flex().id("running").size_full().bg(C.top).border_l(1).border_color(C.line)
      .child(h_flex().w_full().flex_none().h(38).px(12).gap(8).items_center().border_b(1).border_color(C.line)
        .child(div().flex_1().font_family(MONO).text_size(11).text_color(C.muted).child("RUNNING"))
        .child(div().id("running-hide").px(5).rounded(4).cursor_pointer().text_color(C.dim).hover((st) => st.bg(C.raised).text_color(C.text))
          .tooltip("Collapse").on_click(() => run("layout.hide", { id: "servers" })).child(mono(13, C.dim, "»"))))
      .child(v_flex().id("running-body").w_full().flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(10)
        .child(head("DEV SERVERS", servers.length))
        .children(servers.map((p) => row(p, where.get(p.tab).sp.name)))
        .when(!servers.length, (el) => el.child(div().px(8).py(4).font_family(SANS).text_size(12).text_color(C.dim).child("No dev servers running."))));
  }

  // ---- the plan dialog ------------------------------------------------------------------------------------------

  initPlan(cx) {
    this.addr = props()?.address;
    this.plan = null;
    this.text = "";
    this.msg = "";
    const load = (cx) => cx.spawn(async (cx) => {
      this.plan = await planState(this.addr);
      try { this.text = this.plan?.plan_file ? await readTextFile(this.plan.plan_file) : (await readReplyPlan(this.addr)) ?? ""; } catch { this.text = ""; }
      try { this.msg = JSON.parse((await exec("hc", ["get", this.addr])).stdout)?.status?.msg ?? ""; } catch { this.msg = ""; }
      cx.notify();
    });
    load(cx);
    cx.timer.every(2000, (cx) => load(cx));
  }

  planView() {
    const a = agents().find((x) => x.address === this.addr);
    const status = a?.status ?? "gone";
    const color = { working: C.work, blocked: C.you, done: C.land, idle: C.done }[status] ?? C.dim;
    const lines = this.text.split("\n");
    const items = progress(this.plan?.todos, lines);
    const done = items.filter((i) => i.state === "completed").length;
    const close = () => closeOverlay(props().overlay);
    const mark = (st) => st === "completed" ? mono(12, C.land, "✓") : st === "in_progress" ? icon("spinner", 11, C.work).spin(900) : mono(12, C.dim, "○");

    let code = false;
    const md = lines.map((l, i) => {
      if (/^\s*```/.test(l)) { code = !code; return div().h(4); }
      if (code) return div().w_full().px(10).bg(C.card).font_family(MONO).text_size(12).text_color(C.soft).child(l || " ");
      const plain = l.replace(/\*\*/g, "");
      const h = /^(#{1,6})\s+(.*)/.exec(plain);
      if (h) return div().w_full().pt(i ? 10 : 0).font_family(SANS).font_weight(700).text_size([20, 16, 14][Math.min(2, h[1].length - 1)]).text_color(C.text).child(h[2]);
      const box = /^(\s*)[-*] \[([ xX])\]\s*(.*)/.exec(plain);
      if (box) return h_flex().w_full().gap(8).pl(box[1].length * 6).child(mono(12, box[2] === " " ? C.dim : C.land, box[2] === " " ? "☐" : "☑"))
        .child(div().flex_1().min_w(0).font_family(SANS).text_size(13).text_color(box[2] === " " ? C.soft : C.muted).child(box[3]));
      const li = /^(\s*)([-*]|\d+\.)\s+(.*)/.exec(plain);
      if (li) return h_flex().w_full().gap(8).pl(li[1].length * 6).items_start().child(mono(12, C.dim, /\d/.test(li[2]) ? li[2] : "•"))
        .child(div().flex_1().min_w(0).font_family(SANS).text_size(13).text_color(C.soft).child(li[3]));
      return plain.trim() ? div().w_full().font_family(SANS).text_size(13).text_color(C.soft).child(plain) : div().h(6);
    });

    return v_flex().id("plan").size_full().bg(C.main).text_color(C.text)
      .child(h_flex().w_full().flex_none().gap(10).px(18).py(12).items_center().border_b(1).border_color(C.line)
        .child(div().w(8).h(8).rounded(4).bg(color))
        .child(div().flex_1().min_w(0).truncate().font_family(SANS).text_size(15).font_weight(600).child(clean(a?.title) || a?.program?.name || this.addr))
        .when(!!this.plan?.model, (el) => el.child(mono(11, C.muted, modelName(this.plan.model))))
        .child(mono(11, color, status))
        .when(!!a, (el) => el.child(this.btn("plan-go", "Go to agent", "plain", () => {
          close();
          run("agent.focus", { terminal: this.addr });
          run("layout.select", { stack: "main", child: "work" });
          setShared(VIEW, "work");
        })))
        .child(this.btn("plan-close", "✕", "plain", close)))
      .when(status === "working" && !!this.msg, (el) => el.child(h_flex().w_full().flex_none().gap(8).px(18).py(8).items_center().bg(C.card)
        .child(icon("spinner", 11, C.work).spin(900)).child(div().flex_1().min_w(0).truncate().font_family(SANS).text_size(12).text_color(C.soft).child(this.msg))))
      .child(v_flex().id("plan-body").w_full().flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).gap(4)
        .when(items.length > 0, (el) => el
          .child(h_flex().w_full().gap(10).items_center()
            .child(mono(10, C.dim, "PROGRESS"))
            .child(div().flex_1().h(6).rounded(3).bg(C.raised).child(div().h_full().rounded(3).bg(C.land).w(`${Math.round(100 * done / items.length)}%`)))
            .child(mono(11, C.muted, `${done}/${items.length}`)))
          .when(!!this.plan?.todos?.length, (el) => el.children(items.map((it) => h_flex().w_full().gap(8).items_center()
            .child(mark(it.state))
            .child(div().flex_1().min_w(0).font_family(SANS).text_size(13).text_color(it.state === "completed" ? C.muted : C.text).child(it.text)))))
          .child(div().h(12)))
        .when(!this.text, (el) => el.child(div().py(30).w_full().flex().justify_center().font_family(SANS).text_size(13).text_color(C.dim)
          .child(this.plan?.todos?.length ? "This agent has a todo list but no plan file." : "No plan yet. Ask the agent for a plan (plan mode) and it shows up here.")))
        .children(this.text ? md : []));
  }

  tick(cx) {
    if (!this.configured) return;
    const sig = agentSig();
    if (sig !== this.termSig) {
      const first = this.termSig === null;
      this.termSig = sig;
      if (!first) this.refresh(cx);
    }
    if (!this.polling && Date.now() - this.lastRead >= SAFETY_MS) this.refresh(cx);
    this.pollActs(cx);
  }

  refresh(cx) {
    if (this.polling) { this.again = true; return; }
    this.polling = true;
    this.again = false;
    cx.spawn(async (cx) => {
      try {
        const [state, events] = await Promise.all([this.src.state(), this.src.log()]);
        const rows = new Map((state.rows ?? []).map((r) => [r.key, r]));
        this.tasks = (state.bearings ?? []).filter((e) => rows.has(e.key)).map((e) => {
          const r = rows.get(e.key);
          return { key: e.key, project: r.project, slug: r.slug ?? e.key.split("/").pop(), kind: e.kind, reason: e.reason, next: e.next ?? "", row: r };
        });
        // a project whose branch is ahead of origin (bearing kind push), or with merged task branches left (kind
        // clean): keyed by the project, no task row
        this.pushes = (state.bearings ?? []).filter((e) => e.kind === "push" || e.kind === "clean")
          .map((e) => ({ key: e.key, kind: e.kind, project: e.key, slug: e.key, reason: e.reason ?? "", next: e.next ?? "" }));
        this.events = events ?? [];
        this.problem = state.error || null;
        for (const t of this.tasks) {
          if (this.titles[t.key] === undefined && t.row.brief) {
            this.titles[t.key] = "";
            readTextFile(t.row.brief).then((s) => { this.titles[t.key] = firstLine(s).replace(/^#+\s*/, ""); cx.notify(); }, () => {});
          }
        }
        if (this.sel && !this.tasks.some((t) => t.key === this.sel)) this.sel = null;
        this.share();
      } catch (e) {
        this.problem = String(e.message ?? e);
      } finally {
        this.polling = false;
        this.lastRead = Date.now();
        this.now = Date.now();
      }
      cx.notify();
      this.readAsks(cx);
      if (this.again) this.refresh(cx);
    });
  }

  // what the bars draw; written only when it changed
  share() {
    const n = (k) => this.tasks.filter((t) => t.kind === k).length;
    const counts = { tasks: this.tasks.length, needs: n("needs_you"), working: n("in_flight"), ready: n("ready"), done: n("done"),
      when: new Date().toTimeString().slice(0, 5), problem: this.problem };
    if (JSON.stringify(counts) !== JSON.stringify(shared(COUNTS) ?? {})) setShared(COUNTS, counts);
  }

  readAsks(cx) {
    if (this.asking) return;
    const blocked = this.tasks.filter((t) => t.kind === "needs_you" && t.row.mux === "hc" && t.row.session);
    if (!blocked.length) return;
    this.asking = true;
    cx.spawn(async (cx) => {
      let changed = false;
      for (const t of blocked) {
        let q = "";
        try { q = await question(t.row.session); } catch { /* no screen */ }
        if (q !== (this.asks[t.key] ?? "")) { this.asks[t.key] = q; changed = true; }
      }
      this.asking = false;
      if (changed) cx.notify();
    });
  }

  // ---- actions ----------------------------------------------------------------------------------------------

  act(cx, task, what) {
    const a = this.acts[task.key];
    if (a && a.state === "running") return;
    const rec = { id: clientId(), do: what, state: "running", line: "", polled: 0 };
    this.acts[task.key] = rec;
    this.confirm = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const reply = await this.src.start(task.key, what, rec.id);
        if (reply?.state && reply.state !== "running" && reply.state !== "starting") this.finish(cx, task.key, rec, reply);
      } catch (e) {
        rec.state = "failed"; rec.line = String(e.message ?? e);
      }
      cx.notify();
    });
  }

  pollActs(cx) {
    for (const [key, rec] of Object.entries(this.acts)) {
      if (rec.state !== "running" || Date.now() - rec.polled < 2000) continue;
      rec.polled = Date.now();
      cx.spawn(async (cx) => {
        try {
          const got = await this.src.action(rec.id);
          if (got?.state && got.state !== "running" && got.state !== "starting") this.finish(cx, key, rec, got);
        } catch { /* not in the log yet: ask again next tick */ }
      });
    }
  }

  finish(cx, key, rec, got) {
    rec.state = got.state === "done" && !got.code ? "done" : "failed";
    rec.line = firstLine(got.output) || (rec.state === "done" ? "done" : `exit ${got.code}`);
    if (rec.state === "done") delete this.acts[key]; // a failed one stays on its card
    this.refresh(cx);
    cx.notify();
  }

  ask(cx, task, what) {
    if (CONFIRM.has(what)) { this.confirm = { key: task.key, do: what }; cx.notify(); } else this.act(cx, task, what);
  }

  archiveAll(cx) {
    for (const t of this.visible().filter((t) => t.kind === "done")) this.act(cx, t, "remove");
  }

  // ---- moving around ------------------------------------------------------------------------------------------

  visible() {
    const shown = this.tasks.filter((t) => !this.filter || t.project === this.filter);
    return COLS.flatMap(([k]) => shown.filter((t) => t.kind === k && (!this.focus || k === "needs_you")));
  }

  pick(cx, key) {
    this.sel = key;
    const t = this.tasks.find((x) => x.key === key);
    if (this.focus && t?.kind === "needs_you") this.answerIn(t);
    cx.notify();
  }

  // shows the task's agent in the focus-term block and gives that block the keyboard (pane.focus prefers a visible
  // layout terminal block showing the address), so typing answers it
  answerIn(t) {
    if (!t.row.session) return;
    run("agent.focus", { terminal: t.row.session });
    run("pane.focus", { terminal: t.row.session });
  }

  move(cx, by) {
    const list = this.visible();
    if (!list.length) return;
    const i = list.findIndex((t) => t.key === this.sel);
    this.pick(cx, list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + by))].key);
  }

  goTo(cx, t) {
    if (!t?.row.session) return;
    if (this.focus) this.setFocus(cx, false);
    run("layout.select", { stack: "main", child: "work" });
    setShared(VIEW, "work");
    if (!t.row.pane) run("terminal.peek", { terminal: t.row.session }); // a helper: peek over the tab
    else run("agent.focus", { terminal: t.row.session });
  }

  setFocus(cx, on, task) {
    this.focus = on;
    if (on) {
      const needs = this.visible();
      const t = task ?? needs.find((x) => x.key === this.sel) ?? needs[0];
      run("layout.show", { id: "focus-term" });
      if (t) {
        this.sel = t.key;
        this.answerIn(t);
      }
    } else {
      run("layout.hide", { id: "focus-term" });
      this.h?.focus();
    }
    setShared(FOCUS, on);
    cx.notify();
  }

  command(c, cx) {
    const t = this.tasks.find((x) => x.key === this.sel);
    if (c === "focus") this.setFocus(cx, !this.focus);
    else if (c === "unfocus") { if (this.focus) this.setFocus(cx, false); }
    else if (c === "next") this.move(cx, 1);
    else if (c === "prev") this.move(cx, -1);
    else if (c === "go" && t) this.goTo(cx, t);
    else if (c === "archive" && t?.kind === "done") this.ask(cx, t, "remove");
    else if (c === "yes" && this.confirm) {
      if (this.confirm.key === "*") this.archiveAll(cx);
      else { const ct = this.tasks.find((x) => x.key === this.confirm.key) ?? this.projectTarget(this.confirm); if (ct) this.act(cx, ct, this.confirm.do); }
    } else if (c === "no") this.confirm = null;
  }

  key(e, cx) {
    const k = e.key;
    const t = this.tasks.find((x) => x.key === this.sel);
    if (this.confirm && (k === "y" || k === "enter")) {
      const c = this.confirm;
      if (c.key === "*") this.archiveAll(cx);
      else { const ct = this.tasks.find((x) => x.key === c.key) ?? this.projectTarget(c); if (ct) this.act(cx, ct, c.do); }
      return;
    }
    if (this.confirm && (k === "n" || k === "escape")) { this.confirm = null; cx.notify(); return; }
    if (k === "j" || k === "down") this.move(cx, 1);
    else if (k === "k" || k === "up") this.move(cx, -1);
    else if (k === "enter" && t) this.goTo(cx, t);
    else if (k === "f") this.setFocus(cx, !this.focus);
    else if (k === "escape" && this.focus) this.setFocus(cx, false);
    else if (k === "a" && t?.kind === "done") this.ask(cx, t, "remove");
    else return;
    cx.stop_propagation();
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  render() {
    if (this.part === "plan") return this.planView();
    if (this.part === "servers") return this.serversView();
    if (this.part === "top") return this.top();
    if (this.part === "bottom") return this.bottom();
    if (this.part === "board") return this.board();
    return div().child(`board: unknown part ${this.part}`);
  }

  // terminal address -> its tab's times, for "waiting 6m" and "working 12m"
  times() {
    const tabs = new Map();
    for (const s of spaces()) for (const t of s.tabs) tabs.set(t.id, t);
    const out = new Map();
    for (const a of agents()) {
      const t = tabs.get(a.tab);
      if (t) out.set(a.address, { changed: t.changed_at, working: t.working_since, program: a.program });
    }
    return out;
  }

  glyph(t, times) {
    const p = times.get(t.row.session)?.program ?? this.programs[t.row.harness];
    if (p?.icon) return p.tint ? svg(p.icon).size(14).flex_none().text_color(C.muted) : image(p.icon).w(14).h(14).flex_none();
    return div().w(14).h(14).flex_none().rounded(3).bg(C.raised).flex().items_center().justify_center()
      .font_family(MONO).text_size(9).text_color(C.muted).child((t.row.harness ?? "?").slice(0, 1).toUpperCase());
  }

  btn(id, label, kind, onClick) {
    const [bg, fg, border] = kind === "you" ? [C.you, "#1a1300", C.you] : kind === "land" ? [C.land, "#08180f", C.land]
      : kind === "on" ? [C.you, "#1a1300", C.you] : [C.raised, C.text, C.line2];
    return div().id(id).flex_none().px(9).py(3).rounded(5).bg(bg).border(1).border_color(border).text_color(fg)
      .font_family(SANS).text_size(12).cursor_pointer().hover((st) => st.opacity(0.85))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  stat(label, value, color, extra, win) {
    return v_flex().flex_1().min_w(0).px(12).py(9).rounded(8).border(1)
      .bg(win ? C.landBg : C.card).border_color(win ? C.landLine : C.line)
      .child(mono(10, C.dim, label))
      .child(div().font_family(SANS).text_size(22).text_color(color).child(value))
      .children(extra ? [extra] : []);
  }

  tile(label, right) {
    return v_flex().h_full().min_w(0).px(12).py(9).gap(4).rounded(8).bg(C.card).border(1).border_color(C.line)
      .child(h_flex().w_full().gap(6).items_center().child(div().flex_1().child(mono(10, C.dim, label))).children(right ? [right] : []));
  }

  // a half-ring meter, 0..1, green to orange to red
  gauge(label, f, value, sub) {
    const cx = 66, cy = 66, r = 54;
    const arc = (v) => {
      const a = Math.PI * (1 - Math.max(0.002, Math.min(1, v)));
      return PathBuilder.stroke(10).move_to(cx - r, cy).arc_to(r, r, 0, false, true, cx + r * Math.cos(a), cy - r * Math.sin(a));
    };
    return this.tile(label).w(176).flex_none().items_center()
      .child(div().relative().w(132).h(72).flex_none()
        .child(paint(arc(1), C.raised))
        .child(paint(arc(f), level(f)))
        .child(div().absolute().left(0).bottom(-2).w_full().flex().justify_center()
          .child(div().font_family(SANS).text_size(19).text_color(level(f)).child(value))))
      .child(mono(10, C.dim, sub));
  }

  // stacked areas per terminal over the kept samples, newest on the right
  chart(label, key, fmt) {
    const S = shared(SAMPLES) ?? [], names = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, clean(p.title) || p.program?.name || p.terminal]));
    const last = S[S.length - 1]?.[key] ?? {};
    const top = Object.keys(last).sort((x, y) => last[y] - last[x]).slice(0, SERIES.length);
    const total = (s) => Object.values(s[key]).reduce((a, b) => a + b, 0);
    const max = Math.max(key === "cpu" ? 5 : 268435456, ...S.map(total)) * 1.15;
    const x = (i) => `${((KEEP - S.length + i) / (KEEP - 1)) * 100}%`;
    const y = (v) => `${100 - (v / max) * 100}%`;
    const base = S.map(() => 0), layers = [];
    top.forEach((t, k) => {
      const upper = S.map((s, i) => base[i] + (s[key][t] ?? 0));
      if (S.length > 1) {
        const pts = [...upper.map((v, i) => [x(i), y(v)]), ...base.map((v, i) => [x(i), y(v)]).reverse()];
        layers.push(paint(PathBuilder.fill().add_polygon(pts, true), SERIES[k] + "66"));
        let line = PathBuilder.stroke(1.5).move_to(x(0), y(upper[0]));
        upper.forEach((v, i) => { if (i) line = line.line_to(x(i), y(v)); });
        layers.push(paint(line, SERIES[k]));
      }
      upper.forEach((v, i) => { base[i] = v; });
    });
    const now = S.length ? total(S[S.length - 1]) : 0;
    return this.tile(label, mono(11, C.text, S.length ? fmt(now) : "…")).flex_1()
      .child(div().relative().w_full().flex_1().min_h(40).border_b(1).border_color(C.line2)
        .children(layers)
        .child(div().absolute().top(0).left(0).child(mono(9.5, C.dim, fmt(max / 1.15))))
        .when(S.length < 2, (el) => el.child(div().absolute().top(16).left(0).w_full().flex().justify_center().child(mono(10, C.dim, "collecting…")))))
      .child(h_flex().w_full().gap(10).overflow_hidden()
        .child(mono(9.5, C.dim, "15m"))
        .children(top.map((t, k) => h_flex().gap(4).items_center().min_w(0)
          .child(div().w(7).h(7).rounded(2).flex_none().bg(SERIES[k]))
          .child(div().max_w(150).truncate().font_family(SANS).text_size(10.5).text_color(C.muted).child(`${names.get(t) ?? t} ${fmt(last[t])}`)))));
  }

  // local servers: up or not, and errors in their logs
  healthTile() {
    const hs = this.health;
    const bad = (h) => h.code === "000" || Number(h.code) >= 500 || h.errors > 0;
    const state = (h) => h.code === "000" ? "down" : Number(h.code) >= 500 ? `HTTP ${h.code}` : h.errors ? plural(h.errors, "error") : "OK";
    const go = (h) => {
      run("tab.select", { id: h.tab });
      run("pane.focus", { pane: h.pane });
      run("layout.select", { stack: "main", child: "work" });
      setShared(VIEW, "work");
    };
    const worst = hs.find(bad);
    return this.tile("SERVERS", mono(11, !hs.length ? C.dim : worst ? C.red : C.land, !hs.length ? "none" : worst ? "needs a look" : "healthy")).w(300).flex_none()
      .child(v_flex().id("health-list").w_full().flex_1().min_h(0).gap(3).overflow_y_scrollbar()
        .children(hs.map((h) => v_flex().id(`health-${h.terminal}`).w_full().px(6).py(3).rounded(5).cursor_pointer().hover((st) => st.bg(C.hover))
          .on_click(() => go(h))
          .child(h_flex().w_full().gap(6).items_center()
            .child(div().w(7).h(7).rounded(4).flex_none().bg(bad(h) ? C.red : C.land))
            .child(div().flex_1().min_w(0).truncate().font_family(SANS).text_size(12).text_color(C.text).child(h.name))
            .child(mono(10, C.dim, h.ports.map((p) => `:${p}`).join(" ")))
            .child(mono(10.5, bad(h) ? C.red : C.land, state(h))))
          .when(!!h.errors && !!h.last, (el) => el.child(div().pl(13).truncate().font_family(MONO).text_size(10).text_color(C.muted).child(h.last)))))
        .when(!hs.length, (el) => el.child(div().py(10).font_family(SANS).text_size(12).text_color(C.dim).child("No local servers running."))));
  }

  dashboard() {
    const S = shared(SAMPLES) ?? [], last = S[S.length - 1], sys = shared(SYS);
    const cpu = last ? Object.values(last.cpu).reduce((a, b) => a + b, 0) : 0;
    const mem = last ? Object.values(last.mem).reduce((a, b) => a + b, 0) : 0;
    return div().w_full().h(168).flex_none().flex().flex_row().gap(10)
      .child(this.gauge("CPU", cpu / 100, `${cpu.toFixed(1)}%`, sys ? `of ${sys.cores} cores` : "…"))
      .child(this.gauge("MEMORY", sys ? mem / sys.mem : 0, bytes(mem), sys ? `of ${bytes(sys.mem)}` : "…"))
      .child(this.healthTile())
      .child(this.chart("CPU BY TERMINAL", "cpu", (v) => `${(v ?? 0).toFixed(1)}%`))
      .child(this.chart("MEMORY BY TERMINAL", "mem", (v) => bytes(v ?? 0)));
  }

  week() {
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const today = day(new Date(this.now));
    const counts = Array(7).fill(0);
    for (const e of this.events) {
      if (e.kind !== "merged" && e.kind !== "landed" && e.kind !== "shipped") continue;
      const ts = e.ts ? e.ts * 1000 : Date.parse(e.at ?? "");
      const ago = Math.round((today - day(new Date(ts))) / 86400000);
      if (ago >= 0 && ago < 7) counts[6 - ago]++;
    }
    return counts;
  }

  card(t, times) {
    const r = t.row, sel = t.key === this.sel, kindColor = COLS.find(([k]) => k === t.kind)?.[2] ?? C.dim;
    const tt = times.get(r.session);
    const now = this.now;
    const when = t.kind === "needs_you" ? (tt?.changed ? `waiting ${dur(now - tt.changed)}` : "waiting")
      : t.kind === "in_flight" ? (tt?.working ? dur(now - tt.working) : pill(r))
      : t.kind === "ready" ? "done" : firstLine(t.reason).slice(0, 28);
    const facts = [];
    const commits = num(r.commits), changed = num(r.changed);
    if (commits !== null) facts.push([plural(commits, "commit"), C.muted]);
    if (changed) facts.push([`${changed} uncommitted`, C.muted]);
    const lines = r.lines ?? (typeof r.added === "number" ? { added: r.added, removed: r.deleted ?? 0 } : null); // xo sends lines; the fixture added/deleted
    if (lines) facts.push([`+${lines.added}`, C.land], [`−${lines.removed}`, C.red]);
    if (r.tokens?.total) facts.push([`${human(r.tokens.total)} tok`, C.muted]);
    if (r.checks_state === "pass") facts.push(["✓ checks", C.land]);
    else if (r.checks_state === "FAIL") facts.push(["✗ checks", C.red]);
    else if (r.checks_state === "stale") facts.push(["checks stale", C.you]);
    const a = this.acts[t.key];
    const confirming = this.confirm?.key === t.key;
    const ask = this.asks[t.key];

    let actions = null;
    if (a && a.state !== "done") {
      actions = h_flex().gap(6).items_center()
        .child(a.state === "running" ? icon("spinner", 11, C.work).spin(900) : div().child(""))
        .child(mono(11, a.state === "failed" ? C.red : C.muted, a.state === "running" ? `${LABEL[a.do] ?? a.do}…` : `${LABEL[a.do] ?? a.do} failed: ${a.line}`));
    } else if (confirming) {
      actions = h_flex().flex_wrap().gap(6).items_center()
        .child(mono(11, C.text, `${LABEL[this.confirm.do]} ${t.slug}?`))
        .child(this.btn(`yes-${t.key}`, "Yes  y", this.confirm.do === "remove" ? "plain" : "land", (cx) => this.act(cx, t, this.confirm.do)))
        .child(this.btn(`no-${t.key}`, "No  n", "plain", (cx) => { this.confirm = null; cx.notify(); }));
    } else if (t.kind === "needs_you") {
      actions = h_flex().gap(6)
        .child(this.btn(`answer-${t.key}`, "Answer", "you", (cx) => this.setFocus(cx, true, t)));
    } else if (moves(t).length) {
      actions = h_flex().gap(6)
        .children(moves(t).map((w) => this.btn(`${w}-${t.key}`, LABEL[w], w === "merge" || w === "land" ? "land" : "plain", (cx) => this.ask(cx, t, w))));
    }

    // a flex row (stretching, unlike h_flex) so the colour bar on the left runs the card's full height
    return div().id(`card-${t.key}`).w_full().flex_none().flex().flex_row().rounded(6).overflow_hidden()
      .bg(t.kind === "needs_you" ? C.youCard : C.card).border(1).border_color(sel ? C.accentDim : C.line)
      .cursor_pointer().hover((st) => st.bg(C.hover))
      .on_click((_e, cx) => { this.pick(cx, t.key); if (!this.focus) this.goTo(cx, t); })
      .child(div().w(3).flex_none().bg(kindColor))
      .child(v_flex().flex_1().min_w(0).px(11).py(9).gap(4)
      .child(h_flex().w_full().gap(6).items_center()
        .child(this.glyph(t, times))
        .child(chip(t.project))
        .when(!!r.model, (el) => el.child(div().flex_none().px(5).rounded(3).bg(C.raised).font_family(MONO).text_size(10.5).text_color(C.soft).child(modelName(r.model))))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11).text_color(C.dim).child(t.slug))
        .child(mono(11, t.kind === "needs_you" ? C.you : t.kind === "ready" ? C.land : C.dim, when))
        .when(t.kind === "done" && !confirming && !(a && a.state !== "done"), (el) => el.child(div().id(`close-${t.key}`).flex_none().p(2).rounded(4)
          .cursor_pointer().text_color(C.dim).hover((st) => st.bg(C.raised).text_color(C.text)).tooltip("Close agent")
          .on_click((_e, cx) => { cx.stop_propagation(); this.ask(cx, t, "remove"); })
          .child(svg("mods/workspace-chrome/x.svg").size(12)))))
      .child(div().font_family(SANS).text_size(13).text_color(C.text).child(r.title || t.slug))
      .when(t.kind === "needs_you", (el) => el.child(v_flex().px(8).py(6).rounded(4).bg(C.youAsk)
        .child(mono(10, C.you, "ASKS YOU"))
        .child(div().font_family(SANS).text_size(12).text_color(C.soft).child(ask || firstLine(t.reason)))))
      .when(t.kind === "in_flight" && pill(r) !== "working", (el) => el.child(mono(11, C.muted, `→ ${pill(r)}`)))
      .child(h_flex().flex_wrap().gap(10).children(facts.map(([s, c]) => mono(11, c, s))))
      .children(actions || r.plan ? [h_flex().gap(6).flex_wrap().items_center().children(actions ? [actions] : [])
        .when(!!r.plan, (el) => el.child(this.planBtn(t)))] : []));
  }

  planBtn(t) {
    const todos = t.row.plan?.todos ?? [];
    const done = todos.filter((x) => x.status === "completed").length;
    return this.btn(`plan-${t.key}`, todos.length ? `Plan ${done}/${todos.length}` : "Plan", "plain", () => openPlan(t.key));
  }

  board() {
    // drawing means the stack shows the board (a hidden child doesn't draw, nor take commands): tell the top bar,
    // which can't see the stack, also after a keys.json layout.select brought the board back
    // (not right after the top bar sent a picked space to its terminal: the board can draw once more before the stack switches)
    if (shared(VIEW) === "work" && Date.now() - (shared(LEFT) ?? 0) > 1500) setShared(VIEW, "board");
    const times = this.times();
    const shown = this.tasks.filter((t) => !this.filter || t.project === this.filter);
    const by = (k) => shown.filter((t) => t.kind === k);
    const needs = by("needs_you");
    const dimmed = (el) => el.when(this.focus, (e) => e.opacity(0.18));
    // the oldest question
    const next = needs.slice().sort((a, b) => (times.get(a.row.session)?.changed ?? 0) - (times.get(b.row.session)?.changed ?? 0))[0];
    const projects = [...new Set(this.tasks.map((t) => t.project))].sort();

    const strip = dimmed(this.dashboard());

    const banner = next && h_flex().w_full().flex_none().gap(14).px(14).py(10).rounded(8).items_center()
      .bg(C.youBg).border(1).border_color(C.youLine)
      .child(mono(10, C.you, "NEXT MOVE"))
      .child(v_flex().flex_1().min_w(0)
        .child(div().font_family(SANS).text_size(15).text_color(C.text).truncate()
          .child(`${next.slug} asks: ${this.asks[next.key] ? `“${this.asks[next.key]}”` : firstLine(next.reason)}`))
        .child(mono(11, C.muted, [next.project, times.get(next.row.session)?.changed ? `waiting ${dur(this.now - times.get(next.row.session).changed)}` : null,
          num(next.row.commits) !== null ? plural(num(next.row.commits), "commit") : null].filter(Boolean).join(" · "))))
      .child(this.btn("next-answer", "Answer  ⏎", "you", (cx) => this.setFocus(cx, true, next)))
      .when(!!next.row.session, (el) => el.child(this.btn("next-go", "Go to agent", "plain", (cx) => this.goTo(cx, next))));

    const chips = h_flex().w_full().flex_none().gap(6).items_center()
      .child(dimmed(h_flex().gap(6).items_center()
        .child(this.filterChip(null, "all", this.tasks.length))
        .children(projects.map((p) => this.filterChip(p, p, this.tasks.filter((t) => t.project === p).length,
          this.tasks.some((t) => t.project === p && t.kind === "needs_you"))))))
      .child(div().flex_1())
      .child(mono(11, C.dim, this.focus ? "type in the terminal to answer · click the board, then F to leave" : "j/k move · ⏎ go to agent · a close"))
      .when(!!this.filter, (el) => el.child(this.projectActions({ key: this.filter, slug: this.filter }, ["cut"])))
      .child(this.btn("focus", this.focus ? "◎ Focus  F" : "◎ Focus  F", this.focus ? "on" : "plain", (cx) => this.setFocus(cx, !this.focus)));

    const pushes = this.pushes.filter((p) => !this.filter || p.key === this.filter).map((p) =>
      dimmed(h_flex().w_full().flex_none().gap(8).items_center().px(10).py(6).rounded(6).bg(C.card).border(1).border_color(C.line)
        .child(div().w(7).h(7).rounded(4).bg(CHIPS[[...p.key].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0) % CHIPS.length][0]))
        .child(mono(12, C.text, p.key))
        .child(mono(11, C.muted, p.reason))
        .child(div().flex_1())
        .child(this.projectActions(p, p.next === `xo ${p.kind} ${p.key}` ? [p.kind] : [])))); // a dirty checkout gets push --dry-run: no button

    const column = ([k, label, color]) => {
      const list = by(k);
      const head = h_flex().w_full().h(22).flex_none().gap(7).items_center()
        .child(k === "needs_you" ? div().w(7).h(7).rounded(4).bg(color).loop("opacity", { from: 0.35, to: 1, period: 1200 })
          : k === "in_flight" ? icon("spinner", 10, color).spin(900) : div().w(7).h(7).rounded(4).bg(color))
        .child(mono(11, C.dim, label))
        .child(div().px(5).rounded(8).bg(C.raised).font_family(MONO).text_size(10).text_color(C.muted).child(String(list.length)))
        .child(div().flex_1())
        .when(k === "done" && list.length > 0, (el) => el.child(this.confirm?.key === "*"
          ? h_flex().gap(5).items_center().child(mono(11, C.text, `Close ${list.length}?`))
            .child(this.btn("all-yes", "Yes", "plain", (cx) => this.archiveAll(cx)))
            .child(this.btn("all-no", "No", "plain", (cx) => { this.confirm = null; cx.notify(); }))
          : this.btn("archive-all", "Close all", "plain", (cx) => { this.confirm = { key: "*", do: "remove" }; cx.notify(); })));
      const empty = { needs_you: "Nothing needs you.", in_flight: "Nothing running.", ready: "Nothing finished.", done: "No idle agents." }[k];
      return v_flex().id(`col-${k}`).flex_1().min_w(0).min_h(0).gap(8).p(8).rounded(10).bg("#161619").border(1).border_color(C.line)
        .when(this.focus && k !== "needs_you", (el) => el.opacity(0.18))
        .child(head)
        .child(v_flex().id(`list-${k}`).w_full().flex_1().min_h(0).gap(8).overflow_y_scrollbar()
          .children(list.map((t) => this.card(t, times)))
          .when(!list.length, (el) => el.child(div().py(16).w_full().flex().justify_center().font_family(SANS).text_size(12).text_color(C.dim).child(empty))));
    };

    return v_flex().id("board").size_full().bg(C.main).px(16).pt(14).pb(10).gap(12)
      .track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.h.focus())
      .child(strip)
      .children(banner ? [banner] : [])
      .when(!!this.problem, (el) => el.child(mono(11, C.red, String(this.problem))))
      .child(chips)
      .children(pushes)
      // a plain flex row: h_flex centres its children, which would shrink each column to its header
      .child(div().w_full().flex_1().min_h(0).flex().flex_row().gap(12)
        .children(COLS.map(column)));
  }

  // the project a push, clean or release question is about, as act() takes it
  projectTarget(c) { return c.do === "push" || c.do === "cut" || c.do === "clean" ? { key: c.key, slug: c.key } : null; }

  // Push, Clean or Release for a project ({key: project, kind?}): what runs, the question, or the buttons
  projectActions(p, offer) {
    const a = this.acts[p.key];
    if (a && a.state !== "done") {
      return h_flex().gap(6).items_center()
        .child(a.state === "running" ? icon("spinner", 11, C.work).spin(900) : div().child(""))
        .child(mono(11, a.state === "failed" ? C.red : C.muted, a.state === "running" ? `${LABEL[a.do]}…` : `${LABEL[a.do]} failed: ${a.line}`))
        .when(a.state === "failed", (el) => el.child(this.btn(`ok-${p.key}`, "OK", "plain", (cx) => { delete this.acts[p.key]; cx.notify(); })));
    }
    if (this.confirm?.key === p.key && (!p.kind || this.confirm.do === p.kind)) {
      return h_flex().gap(6).items_center()
        .child(mono(11, C.text, this.confirm.do === "cut" ? `Release a patch version of ${p.key}?`
          : this.confirm.do === "clean" ? `Delete ${p.key}'s merged task branches?` : `Push ${p.key} to origin?`))
        .child(this.btn(`yes-${p.key}`, "Yes  y", "land", (cx) => this.act(cx, p, this.confirm.do)))
        .child(this.btn(`no-${p.key}`, "No  n", "plain", (cx) => { this.confirm = null; cx.notify(); }));
    }
    return h_flex().gap(6).children(offer.map((w) => this.btn(`${w}-${p.key}`, LABEL[w], w === "push" ? "land" : "plain", (cx) => this.ask(cx, p, w))));
  }

  filterChip(p, label, n, alert) {
    const on = this.filter === p;
    return h_flex().id(`chip-${label}`).flex_none().gap(6).px(8).py(2).rounded(5).items_center().cursor_pointer()
      .border(1).border_color(on ? C.accentDim : C.line2).bg(on ? "#1c1926" : "#00000000")
      .hover((st) => st.bg(C.hover))
      .on_click((_e, cx) => { this.filter = on ? null : p; cx.notify(); })
      .when(p !== null, (el) => el.child(div().w(7).h(7).rounded(4).bg(CHIPS[[...String(p)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0) % CHIPS.length][0])))
      .child(mono(11, on ? C.text : C.soft, label))
      .child(mono(11, C.dim, String(n)))
      .when(!!alert, (el) => el.child(div().w(6).h(6).rounded(3).bg(C.you)));
  }

  top() {
    const counts = shared(COUNTS) ?? {};
    const view = shared(VIEW) ?? "board";
    const focus = Boolean(shared(FOCUS));
    const space = spaces().find((s) => s.active);
    // a space picked in the sidebar or the picker shows its terminal, not the board (Focus moves the space itself;
    // with the side terminal open, the board stays and the side shows it)
    const side = findNode(layout(), "side");
    const sideOpen = Boolean(side && !side.hidden);
    if (space && this.lastSpace && space.id !== this.lastSpace && !focus && view === "board" && !sideOpen) {
      run("layout.select", { stack: "main", child: "work" });
      setShared(LEFT, Date.now());
      setShared(VIEW, "work");
    }
    this.lastSpace = space?.id;
    const mac = window()?.platform === "macos";
    const noDrag = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const tabEl = (id, on, children, onClick, faded) => noDrag(h_flex().id(id).h_full().flex_none().px(11).items_center().gap(7).relative()
      .font_family(MONO).text_size(12).text_color(on ? C.text : C.muted).cursor_pointer()
      .hover((st) => st.text_color(C.text)).when(faded, (el) => el.opacity(0.25))
      .on_click(onClick)
      .children(children)
      .child(div().absolute().bottom(0).left(8).right(8).h(2).rounded(1).bg(on ? C.accent : "#00000000")));
    const boardTab = tabEl("tab-board", view === "board", [
      div().child("▦ Board"),
      ...(counts.needs ? [div().px(5).rounded(8).bg(C.you).text_color("#1a1300").text_size(10).font_weight(700).child(String(counts.needs))] : []),
    ], () => { run("layout.select", { stack: "main", child: "board" }); setShared(VIEW, "board"); }, false);
    const tabs = (space?.tabs ?? []).filter((t) => !t.settled || t.status === "blocked").map((t) =>
      tabEl(`tab-${t.id}`, view === "work" && t.active, [
        ...(t.status === "blocked" ? [div().w(7).h(7).rounded(4).bg(C.you)] : t.status === "working" ? [icon("spinner", 10, C.work).spin(900)] : []),
        div().child(t.name),
        // × closes the tab (as the shipped tab bar does); its press doesn't select or drag
        div().id(`close-${t.id}`).flex_none().p(2).rounded(3).text_color(C.dim).hover((st) => st.bg(C.raised).text_color(C.text))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: t.id }); })
          .child(svg("mods/workspace-chrome/x.svg").size(11)),
      ], () => { run("tab.select", { id: t.id }); run("layout.select", { stack: "main", child: "work" }); setShared(VIEW, "work"); },
      focus && t.status !== "blocked"));
    return h_flex().id("top").size_full().bg(C.top).border_b(1).border_color(C.line)
      .child(h_flex().w(mac ? 170 : 110).h_full().flex_none().pl(mac ? 84 : 16).items_center()
        .child(div().font_family(MONO).text_size(12).font_weight(700).text_color(C.accent).child("H E R D R")))
      .child(boardTab)
      .child(div().w(1).h(16).mx(4).bg(C.line2))
      .child(h_flex().id("tabs").flex_1().min_w(0).h_full().overflow_x_scrollbar().children(tabs)
        // + opens Herdr's new menu: a terminal or one of the installed agents (⌘T does the same here)
        .child(noDrag(div().id("tab-new").flex_none().ml(4).px(8).h(24).rounded(5).flex().items_center().cursor_pointer()
          .text_color(C.dim).hover((st) => st.bg(C.hover).text_color(C.text)).tooltip("New tab: terminal or agent  ⌘T")
          .on_click(() => run("mod.open", { name: "new-menu" })).child(div().text_size(15).child("+")))))
      .child(h_flex().h_full().flex_none().pr(12).gap(6).items_center()
        .child(noDrag(div().id("running-toggle").px(8).py(2).mr(8).rounded(5).cursor_pointer().border(1)
          .border_color(findNode(layout(), "servers")?.hidden ? C.line2 : C.accentDim).hover((st) => st.bg(C.hover))
          .on_click(() => run(findNode(layout(), "servers")?.hidden ? "layout.show" : "layout.hide", { id: "servers" }))
          .child(mono(11, findNode(layout(), "servers")?.hidden ? C.muted : C.text, "▤ Running"))))
        .child(mono(11, C.muted, "commands"))
        .children((mac ? ["⌘", "⇧", "P"] : ["Ctrl", "Shift", "P"]).map((k) =>
          div().px(5).rounded(3).bg(C.raised).font_family(MONO).text_size(10).text_color(C.muted).child(k))));
  }

  bottom() {
    const c = shared(COUNTS) ?? {};
    const item = (text, color, dot) => h_flex().gap(5).items_center()
      .when(!!dot, (el) => el.child(div().w(6).h(6).rounded(3).bg(dot)))
      .child(mono(11, color, text));
    return h_flex().id("bottom").size_full().px(12).gap(16).items_center().bg(C.side).border_t(1).border_color(C.line)
      .child(item(plural(c.tasks ?? 0, "task"), C.muted))
      .child(item(`${c.working ?? 0} working`, C.muted, C.work))
      .child(item(`${c.needs ?? 0} ${c.needs === 1 ? "needs" : "need"} you`, c.needs ? C.you : C.muted, C.you))
      .child(item(`${c.ready ?? 0} done`, C.muted, C.land))
      .child(item(`${c.done ?? 0} idle`, C.muted, C.done))
      .child(div().flex_1())
      .when(!!c.problem, (el) => el.child(item(String(c.problem).slice(0, 80), C.red)))
      .child(item(c.when ? `read ${c.when}` : "reading agents…", C.dim))
      .child(item(new Date(this.now).toTimeString().slice(0, 5), C.muted));
  }
}
