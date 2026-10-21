# let-them-talk in Antigravity (agy)

- Add the MCP server once with `ltt agy-mcp`. It is named `let-them-talk`. Tools may be prefixed, e.g. `let-them-talk_ltt_inbox`. Use whatever name your tool list shows for `ltt_*`.
- `ltt` is installed on PATH. Run it exactly as written (`ltt wait`, `ltt status`). Never search for, read or run let-them-talk's source code or plugin files.
- Hooks (`hooks.json`, run by `hooks/agy.js`):
  - First model call of a conversation (`PreInvocation`): starts the daemon if needed, registers you, and injects your identity, peers, board keys and what is waiting on you.
  - Every later model call: a one-line reminder of your `workspace`/`agent`, plus any new unread items (each shown once).
  - `Stop`: if a peer sent a new question, task or request update, you are kept going once to handle it (ltt_inbox, then ltt_respond) or tell the user why you are leaving it.
- agy has no idle wake: nothing reaches you between turns. Check `ltt_inbox` at the start of each task and after finishing each task.
- To wait for work cheaply, run `ltt wait` as a background task (not foreground) and end your turn. It uses no tokens; when a peer needs you it exits and its completion wakes you. Then `ltt_inbox`, do the task, and start `ltt wait` again.
- Subagents: `invoke_subagent`.
- Antigravity app: same MCP entry and plugin as the CLI. You cannot be relaunched with a role, so in a roster folder ask the user which role you are, pass that `workspace`/`agent` on every `ltt_*` call and call `ltt_register`. Hooks do not know a name you picked yourself, so check `ltt_inbox` at the start of each task and after each one.

## Worker runner (`ltt worker <name>`)

- Runs agy headless in the current folder with identity `<name>`; role and owns come from flags or the roster. Requires `ltt agy-mcp` first.
- Pushes turns: a bootstrap prompt at start, then a new turn whenever an urgent item (question, task, request update) arrives. If agy is mid-turn, the runner waits for the result and pushes once.
- Interactive (no `--detach`): a typed line is sent as a turn; `/reply <id> <text>` answers a question the worker asked `user`; `/quit` ends the worker.
- Questions: a worker the human started sends every question to `user`. A worker started by a Claude session (`--ask`, set automatically) sends them to the task's sender, titled `[user] ...` when only the human can answer.
- The human can also answer with `ltt reply` or the dashboard.
- Logs: `$LTT_HOME/workers/<workspace>-<name>.log` (default `~/.let-them-talk/workers/`). Nothing is written into the project folder.
- Tools needing approval are denied with a stderr notice unless the worker started with `--yolo`.
