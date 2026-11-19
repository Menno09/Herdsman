# herdr-pro: my Herdr setup

This folder holds my current Herdr desktop layout, **herdr-board**, and the steps to put it on another machine.

The window has three parts:

- **Top bar:** a pinned **Board** tab with a "needs you" badge, then the current space's tabs.
- **Body:** the spaces sidebar (220 px), where each space folds open to list its terminals, their agent status and the ports its dev servers listen on, and a main area that shows either:
  - the **Board**: every agent as a card in four columns: NEEDS YOU, WORKING, READY TO LAND, DONE
  - the **work** view, with the active tab's panes
- **Running panel** (right, toggled with **▤ Running** in the top bar): lists dev servers by port, shows whether each one answers on localhost, the errors in its logs, and its CPU and memory use. Click a port to open it in the browser.
- **Status bar:** counts of tasks, working, need you, done and idle.

Press **F** for focus mode. It fades everything except NEEDS YOU and shows the selected agent's live terminal, so you can answer it there. If a Claude Code card's agent has written a plan, the card gets a **Plan** button. It opens the plan with its todo progress.

Tested with Herdr app 0.1.16 and herdr CLI 0.9.5.

## What's in here

| File | Goes to | What it is |
|---|---|---|
| `herdr-app/layouts/herdr-board.json` | `~/.config/herdr-app/layouts/` | The layout: blocks, sizes, colors (graphite, purple accent), fonts (JetBrains Mono and Geist) |
| `herdr-app/mods/herdr-board/` | `~/.config/herdr-app/mods/` | The mod that draws the top bar, the board, the Running panel and the status bar |
| `herdr-app/mods/spaces-tree/` | `~/.config/herdr-app/mods/` | The spaces sidebar: a copy of Herdr's `spaces` mod where each space folds open |
| `herdr-app/keys.json` | `~/.config/herdr-app/` | My keybindings (see below) |
| `herdr-app/settings.json` | `~/.config/herdr-app/` | Dark appearance, sounds on, zoom 1 |
| `herdr/config.toml` | `~/.config/herdr/` | herdr CLI/TUI config: onboarding off, system notifications, dot status indicators |
| `claude/hooks/herdr-board-plan.py` | `~/.claude/hooks/` | Claude Code hook that records each agent's plan file and todos for the Plan button |
| `install.sh` | – | Does all of the above |

JetBrains Mono, Geist and Geist Mono come with Herdr. The Running panel and sidebar use `lsof`, `curl`, `ps` and `git`. Memory stats and opening ports in the browser use the macOS commands `sysctl hw.memsize` and `open`, so on Linux those two parts may stay empty or do nothing.

## Install on macOS or Linux (quick)

Copy this folder to the new machine with git, AirDrop, a USB stick or `scp -r`. Then:

1. **Install the Herdr app and open it once.** Finish the welcome screen, then quit. The script can install the app for you, but it stops until the app has run once, because Herdr writes its built-in mods on first start.
   ```sh
   curl -fsSL https://releases.herdr.dev/app/install.sh | sh
   ```
   You can also download the Mac DMG from https://releases.herdr.dev/app/Herdr.dmg. It is for Apple silicon. On Linux you need x86_64 or arm64.
2. **Run the installer:**
   ```sh
   cd herdr-pro
   ./install.sh
   ```
   It installs the `herdr` CLI if it's missing (through Homebrew if you have it, otherwise the official script). It copies the files, sets up agent integrations for Claude Code, OpenCode and Cursor if they're installed, and registers the plan hook in `~/.claude/settings.json`. Last, it checks the mod and switches to the layout. Before replacing any file, it keeps the old one as `*.bak-<time>`.
3. **Restart any running Claude Code sessions.** Claude Code only loads hooks when a session starts.

## Install by hand (or on Windows)

1. Install the app:
   - **Mac:** `curl -fsSL https://releases.herdr.dev/app/install.sh | sh`, or the DMG above
   - **Windows:** `powershell -c "irm https://releases.herdr.dev/app/install.ps1 | iex"`
   - The app installs `herdr-core` (`hc`) by itself.
2. Install the herdr CLI (optional, only needed for `herdr integration` and the TUI):
   - **Mac/Linux:** `brew install herdr`, or `curl -fsSL https://herdr.dev/install.sh | sh`
   - **Windows:** `powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"`
3. Open Herdr once, then quit.
4. Copy the files to the paths in the table above. On Windows the CLI config goes to `%APPDATA%\herdr\config.toml`. The app's home folder on Windows isn't covered in what I read. Open the app and ask an agent to read its `AGENTS.md` to find it.
5. Agent integrations: `herdr integration install claude` (also `opencode` and `cursor`). Check them with `herdr integration status`.
6. Plan button (optional, Claude Code only): add these to `~/.claude/settings.json` under `"hooks"`:
   ```json
   "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 '~/.claude/hooks/herdr-board-plan.py'", "timeout": 5 }] }],
   "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit|ExitPlanMode|TodoWrite|TaskCreate|TaskUpdate",
                     "hooks": [{ "type": "command", "command": "python3 '~/.claude/hooks/herdr-board-plan.py'", "timeout": 5 }] }]
   ```
   Replace `~` with your full home path. Inside quotes the shell doesn't expand `~`.
7. Check the mods and switch to the layout:
   ```sh
   herdr-app check ~/.config/herdr-app/mods/herdr-board
   herdr-app check ~/.config/herdr-app/mods/spaces-tree
   herdr-app do layout.switch --name herdr-board
   ```
   You can also press Cmd+Shift+L (Ctrl+Shift+L on Linux and Windows) to cycle through layouts.

## Key bindings (keys.json)

| Keys | Action |
|---|---|
| Cmd+T / Cmd+W | New-tab menu (pick a terminal or agent) / close tab |
| Cmd+1…9, Ctrl+1…9 | Go to tab N / go to space N |
| Cmd+] / Cmd+[ | Next / previous agent |
| Cmd+Alt+] / Cmd+Alt+[ | Next / previous space |
| Cmd+D / Cmd+Shift+D | Split pane right / down |
| Cmd+Alt+arrows | Move focus to the pane in that direction |
| Cmd+Alt+Shift+arrows | Swap pane in that direction |
| Cmd+Shift+Enter | Zoom pane |
| Cmd+Shift+L | Switch layout |
| Cmd+B | Toggle sidebar |
| Cmd+P / Cmd+Shift+P | Picker / command palette |
| F2 / Shift+F2 | Rename tab / rename space |
| Cmd+Left/Right, Alt+Left/Right | Start/end of line, word left/right in the terminal |

## What doesn't carry over

- **Your spaces, tabs and running agents.** Each machine keeps these in its own `herdr-core`. Create the spaces again on the new machine.
- **State files:** `shared.json`, `view.json`, `window.json` and `data/` in `~/.config/herdr-app`. They hold paths specific to this machine, and Herdr rewrites them anyway.

## Undo

- Press Cmd+Shift+L to go back to the `main` layout.
- Delete `~/.config/herdr-app/layouts/herdr-board.json` and `~/.config/herdr-app/mods/herdr-board/` to remove the layout.
- Restore any `*.bak-<time>` file the installer left to get your old settings back.
