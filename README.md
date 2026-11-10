# glance

A small widget for [Claude Code](https://claude.com/claude-code) that sits above the prompt and shows the state of your session at a glance.

```
╭───────────────────────────────────────────────────────────────────────────────────────╮
│ ✻ Running Bash             spent $4.21  │ ctx  ━━━━━━━━━━╌╌╌╌╌╌╌╌╌╌  18%  182k / 1M   │
│ Opus 5.5 · high                         │ 5h   ━━━━━━━━━━━━╌╌╌╌╌╌╌╌  42%    ↻ 2h 30m  │
│ ~/code/my-app                  ⎇ main   │ week ━━━━━━━━━━━━━━━━━━━╌  91%     ↻ 3d 4h  │
╰───────────────────────────────────────────────────────────────────────────────────────╯
```

## What it shows

- **Status**: Idle, Working, Running `<Tool>`, Needs permission, Waiting for your answer, Compacting or Interrupted. While Claude works, the icon animates like Claude Code's own spinner.
- **Session cost**: what this session has spent so far in US dollars, as `/cost` totals it.
- **Model and effort**: for example `Opus 5.5 · high`.
- **Current directory**: shortened with `~`, and cut from the start when it is long.
- **Git branch**: or the commit when HEAD is detached, or "no git" outside a repository.
- **Context window**: a bar, the percentage used and the token count.
- **5-hour and weekly limits**: a bar, the percentage used and when the window resets.

Bars are green below 70%, yellow from 70% and red from 90%.

From about 100 columns the card splits in two, the session on the left and the bars on the right, and the bars grow with the width. On a narrower terminal it stacks into one column.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install glance --marketplace DevLiamF/glance
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```sh
claude plugin install glance --marketplace DevLiamF/glance
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `DevLiamF/glance`, then **Add plugin**.

## Use

glance appears above the prompt on its own. `/glance` hides or shows it.

## Notes

- The 5-hour and weekly bars appear only on a Claude subscription, after the session's first reply reports them. Usage from other sessions or devices shows up here after this session's next reply.
- The cost is worked out from the API's list prices. On a subscription it is what this usage would cost at those prices, not what you are billed.
- Effort comes from your `effortLevel` setting or `CLAUDE_CODE_EFFORT_LEVEL` until the first request, then from what each request actually sends.
- Once a permission prompt is answered, "Needs permission" stays until that tool call finishes.
- The directory, branch, cost and limits refresh after each reply, after each Bash call and every 15 seconds.
- The animated icon is drawn in terminals only; the desktop app shows a still dot.

## Development

Run it from a working copy for one session:

```sh
claude --plugin-dir /path/to/glance
```

Check and test it:

```sh
claude plugin validate .
claude plugin test .
```

The code is one hooks module, `hooks/register.tsx`. The values it keeps between redraws are declared in `types/index.d.ts`.

## License

[MIT](LICENSE)
