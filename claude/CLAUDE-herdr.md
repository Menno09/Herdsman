# Parallel helpers inside Herdr

When `HC_TERMINAL_ID` is set (this session runs in a Herdr terminal) and you want to hand work to background or parallel agents, start each one as its own Herdr terminal instead of the built-in Agent tool, so the person can watch, open and answer it on their Herdr board:

```sh
git worktree add ../<repo>-<name> -b <branch>   # when it needs its own checkout
hc run --bg --name <short-name> --cwd <folder> claude "<the full task, with everything it needs to know>"
```

Follow up with `hc wait <name>` (instead of sleeping) and `hc read <name>`. Quick read-only lookups and searches can still use the built-in Agent tool.
