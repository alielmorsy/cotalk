# let-them-talk

Lets coding-agent sessions on one machine work together: Claude Code, Antigravity (`agy`, CLI or app) and Codex (CLI or app) sessions share a board of contracts and decisions, ask each other questions, and hand each other tasks. A Claude session can also lead headless agy workers, and any agent can ask **you** directly.

It is one small local server (a "daemon") plus a plugin for each tool. Nothing leaves your machine.

> **Status: early.** The daemon, CLI and hooks have automated tests (`npm test`). Live use inside each tool is still being verified: the Claude Code plugin and `agy plugin install` are confirmed by hand; agy workers and Codex hooks are not yet. If something misbehaves, check [Troubleshooting](#troubleshooting) and report it.

## What you get

- **Board:** agents publish contracts other agents depend on (API routes, schemas, decisions). Readers get notified when an entry changes.
- **Questions and tasks:** an agent asks a peer, a peer answers; an agent assigns a task, the owner claims it and marks it done.
- **You in the loop:** agents can send questions to `user` (you). You answer from the terminal or the dashboard, without spending agent tokens.
- **Workers:** `ltt worker` runs a headless agy that receives tasks as they arrive.
- **Dashboard:** a live control panel: answer what waits on you, filter, drop and reassign requests, read and delete board entries, start and stop workers, and change settings.

## Requirements

- **Node.js 22.13 or newer** on your PATH (`node --version`).
- **Git**.
- At least one agent CLI: **Claude Code**, **Antigravity CLI (`agy`) 1.2.13+**, or **Codex CLI 0.115+**.
- Tested on Windows 11; macOS and Linux should work.

## 1. Install (once per machine)

```sh
git clone <url-of-this-repo> let-them-talk
cd let-them-talk
npm link              # puts the `ltt` command on your PATH (no dependencies to download)
ltt start             # starts the local daemon on 127.0.0.1:7777 and prints the dashboard link
```

Open the printed `http://127.0.0.1:7777/?token=…` link once. It signs your browser in, and from then on `http://127.0.0.1:7777/` works on its own, so bookmark that. `ltt dashboard` prints the link again.

Then connect the tools you use. You only need the sections for your tools.

**Claude Code.** Inside any Claude session:

```
/plugin marketplace add <full path to let-them-talk>
/plugin install let-them-talk@let-them-talk-dev
```

Use forward slashes on Windows, e.g. `/plugin marketplace add C:/src/let-them-talk`. To try it without installing, start Claude with `claude --plugin-dir <full path to let-them-talk>`. Claude gets the token automatically.

*Updating:* Claude copies the plugin into `~/.claude/plugins/cache/`, keyed by the `version` in the manifests. After changing hooks or skills in this repo, bump the version (all six manifests), then run `/plugin marketplace update let-them-talk-dev`, reinstall (`/plugin uninstall let-them-talk@let-them-talk-dev`, then `/plugin install …`) and restart Claude. The `ltt` command itself runs straight from the repo (`npm link`), so CLI fixes need no update.

**Antigravity (`agy`).** In a terminal:

```sh
agy plugin install <full path to let-them-talk>   # skills + hooks (not `agy plugin link`: that is for marketplaces)
ltt agy-mcp --dry-run                             # preview
ltt agy-mcp                                       # `agy mcp add`, plus the allow-rule mcp(let-them-talk/*) in agy's settings.json (backup kept)
```

Restart agy afterwards, then check with `agy mcp list`.

- `agy plugin install` **copies** the folder into `~/.gemini/config/plugins/let-them-talk`. After you update this repo, run it again to refresh the copy.
- The plugin does not carry the MCP server (agy reports `mcpServers: skipped`), so `ltt agy-mcp` is a separate, required step. Workers refuse to start without it.

**Codex.** In a terminal:

```sh
ltt codex-mcp --dry-run      # preview (token masked)
ltt codex-mcp                # adds [mcp_servers.let-them-talk] to ~/.codex/config.toml (backed up first)
ltt codex-mcp --hooks        # optional: also enables Codex's experimental hooks
```

Restart Codex afterwards.

**Status line (optional).** It shows `[api@shop] 📬2 ⏳1`: this session's name and workspace, unread items, and requests waiting on you. It edits your tool's settings and keeps a backup (`settings.json.ltt-bak`, made once):

```sh
ltt statusline claude     # ~/.claude/settings.json; chains a status line you already had
ltt statusline agy        # ~/.gemini/antigravity-cli/settings.json; stacks with agy's default
```

Restart the tool afterwards. The script is copied to `~/.let-them-talk/ltt-statusline.mjs`.

**It shows nothing when the session has no identity**, and that is normal. That means no `.ltt.json` in the folder or any parent, or a roster folder where the session was started without a role (plain `claude` instead of `ltt run <role> -- claude`). With an identity you see `[name@workspace] ⚫ offline` if the daemon is down, and the counts otherwise.

agy cannot run a command whose path has spaces (it splits on spaces and ignores quotes). If your home folder has one (`C:\Users\Ali Elmorsy`), `ltt statusline agy` writes the Windows short path (`C:/Users/ALIELM~1/...`) instead. On a path without a short name it stops and asks you to set `LTT_HOME` to a path without spaces.

## 2. Quick start A: sessions in separate folders

For example, one session per service: `api` and `web`.

```sh
cd ~/shop/api
ltt init --workspace shop --agent api --role "REST API" --owns "api/**"
claude                           # or agy, or: ltt run api -- codex

cd ~/shop/web                    # in a second terminal
ltt init --workspace shop --agent web --role "frontend" --owns "web/**"
agy
```

- `workspace` is the project name, and must be the same for every session of the project.
- `agent` is this session's name, and must be unique within the workspace.
- `ltt init` writes a `.ltt.json` file. Commit it if your teammates use this too.

Try it: in **web**, say *"Ask api how the users endpoint paginates."* In **api**, the question appears on your next prompt. An idle Claude session wakes up by itself. The agent answers, and **web** sees the answer on its next step.

## 3. Quick start B: one folder, a Claude lead plus agy workers

Put a role list in the project root's `.ltt.json`:

```json
{
  "workspace": "engine",
  "agents": {
    "lead":    { "role": "architect, splits work into tasks", "owns": ["docs/**"] },
    "physics": { "role": "physics and collision",             "owns": ["src/physics/**"] },
    "audio":   { "role": "audio system",                      "owns": ["src/audio/**"] }
  }
}
```

Each entry is a name with an optional `role` (one line describing the job) and `owns` (paths that agent may edit). `workspace` is the project name.

Start the lead, then one terminal per worker:

```sh
ltt run lead -- claude        # Claude session with the role "lead"
ltt worker physics            # headless agy worker (reads its role from .ltt.json)
ltt worker audio
```

**You don't have to list the workers up front.** A roster entry only saves typing. `ltt worker <name> --role "..." --owns "a/**,b/**"` starts a worker for any name, listed or not, so the lead can propose workers as the plan takes shape (see `ltt-lead`). The roster can be just the lead:

```json
{ "workspace": "engine", "agents": { "lead": { "role": "architect" } } }
```

In a folder with a roster, **every session needs a role**. A plain `claude` or `agy` there has no identity and is not on the board; start it with `ltt run <role> -- <tool>`.

### Step by step: Claude leads, agy does the small tasks

Once per machine (section 1): `npm link`, the Claude plugin, `agy plugin install <path>`, `ltt agy-mcp`, then restart agy. `agy mcp list` must show `let-them-talk`, and `~/.gemini/antigravity-cli/settings.json` must have `mcp(let-them-talk/*)` under `permissions.allow` (`ltt agy-mcp` adds it; without it a headless agy cannot call any `ltt_*` tool).

For each project:

1. Put a `.ltt.json` with at least a lead in the project root (above).
2. In the project root, start the lead: `ltt run lead -- claude`. **You never start agy yourself.**
3. Ask for the work, for example: *"Have agy implement X in `src/foo/`. Use the ltt-lead skill."*
4. Claude proposes a worker (name, role, owned paths) and waits. Answer yes. Say so if you want unattended edits (`--yolo`); otherwise the worker's file edits are denied.
5. Claude runs `ltt worker <name> --role "..." --owns "..." --detach`. That launches a headless agy in the background. Watch it: `ltt status`, the dashboard, or `~/.let-them-talk/workers/<workspace>.<name>.log`.
6. Claude sends the worker a task. The worker claims it, does it, and marks it done. Claude is woken with the result and reviews it. Give follow-up tasks the same way; the worker stays running and later tasks are cheap.
7. If the worker needs a decision it asks you: `ltt inbox`, then `ltt reply <id> <text>`.
8. Stop a worker when you are done: `/quit` in its own terminal, or **Stop** in the dashboard's Peers & Workers view if it was started with `--detach`.

Each worker terminal is also a chat window:

- Type a line to talk to that worker.
- `/reply <id> <text>` answers a question the worker asked you.
- `/quit` stops the worker.

`--detach` runs a worker in the background instead, logging to `~/.let-them-talk/workers/`.

Worker notes:

- **Permissions.** A headless agy cannot ask you for approval. It denies the action and prints which allow-rule would permit it. The `ltt_*` tools are covered by the rule `ltt agy-mcp` adds; file edits and shell commands are not. `--yolo` auto-approves everything (sandboxed), but use it only if you accept unattended edits.
- **Cost.** A worker's first turn uses about 35-70k tokens (agy's system prompt plus the task). Later tasks use much less, so keep workers running rather than restarting them.
- **One folder, many writers.** Give workers non-overlapping `owns` paths, or run each one in its own git worktree.

### agy as a chat you type into (Claude sends it tasks)

Instead of a headless worker you can run a normal interactive agy with a name, so you watch it and approve its edits yourself:

```sh
cd <project root>
ltt run gfx --role "render graph / RHI" --owns "Engine/Gfx/**" -- agy
```

1. **Type a first message in agy**, for example *"You are gfx. Check ltt_inbox now and after every task."* An interactive agy registers on its first model call, and until then Claude cannot address it (`no agent gfx in workspace`).
2. In the Claude lead: *"Send agy `gfx` this task: …"*. Claude sends it with `ltt_request`, kind `task`, to `gfx`.
3. **agy is never woken.** The task waits until agy's next step, so type any message such as *"check ltt_inbox"* to make it pick the task up. It claims the task, works (you approve edits as usual) and marks it done, and the lead is woken with the result.
4. If a step is unclear, `ltt status` shows whether `gfx` is registered (tool `agy`).

Verified with a one-shot `agy -p` started through `ltt run`: it got its identity, registered, and claimed and answered a task. The interactive screen itself has not been driven.

### Who can lead, who can be a worker

`ltt worker` always launches a headless **agy**. There is no Claude or Codex worker. Any session that can call the `ltt_*` tools and run a shell command can lead.

| Lead | Workers | Status |
|---|---|---|
| Claude (`ltt run lead -- claude`) | agy (`ltt worker`) | Worker flow verified end to end. A Claude lead assigning in a real session is not yet. |
| Codex (`ltt run lead -- codex`, after `ltt codex-mcp`) | agy | Untested. Codex has no idle wake, so results show up on its next turn or when it calls `ltt_wait` / `ltt_inbox`. Its shell sandbox may block the connection to the daemon, which would stop `ltt worker`. |
| agy (interactive) | a Claude or Codex session you started yourself | Possible: agy sends tasks with `ltt_request`, but it cannot start those sessions, and it is not woken when they reply. |
| any | a headless Claude | Not supported. |

A tool started *inside* another tool's session (for example `claude -p` run by an agy worker) does not inherit that session's identity, on purpose (`LTT_TOOL`). It works as a plain one-shot command, with no board access.

### Desktop apps (Codex app, Antigravity app)

The desktop apps read the same config as their CLIs, so section 1 is all the setup they need: `ltt agy-mcp` (it writes `~/.gemini/config/`, which the Antigravity app also reads) and `agy plugin install`, or `ltt codex-mcp` for Codex (`~/.codex/config.toml`). Restart the app afterwards. **Not yet verified inside the apps themselves.**

An app cannot be started with `ltt run`, so it gets its identity one of two ways:

- **Own folder or git worktree with a single-agent `.ltt.json`** (`ltt init --workspace W --agent A`). The session hooks register it as usual. This is the clean path.
- **Shared roster folder.** The session is told the roles and asks you which one it is, then passes that `workspace`/`agent` on every `ltt_*` call. Hooks cannot know a name the session picked itself, so it gets no per-prompt news and no Stop-block; every `ltt_*` result still starts with the unread line.

Like the CLIs, an app is not woken while idle: type *"check ltt_inbox"* to make it pick up a task. The app asks you to approve `ltt_*` calls itself (the `mcp(let-them-talk/*)` allow-rule from `ltt agy-mcp` lives in the CLI's `settings.json`).

To check: in the Antigravity app, Additional Options > MCP Servers lists `let-them-talk`. In the Codex app, the `ltt_*` tools appear after a restart.

## Check it works

- `ltt status`: shows whether the daemon is up, who this folder or session is, the peers, and the unread count.
- The dashboard's Peers view lists every session with its app and status (active, idle or offline).
- A request stuck open or claimed by an agent that is gone: press **Cancel** on its row in the Requests view (or tick several and drop them together), or **Reassign** it to another agent.
- Claude: `/mcp` shows `ltt` connected, and the session starts with "let-them-talk: you are agent …".
- agy: `agy mcp list` shows `let-them-talk`.

## Everyday commands

| Command | What it does |
|---|---|
| `ltt status` | Daemon, identity, peers, unread count |
| `ltt dashboard` | Prints the dashboard sign-in link (open once, then the plain URL works) |
| `ltt usage [--fresh] [--json]` | Quota left for agy and Claude: % left per window and when it resets. The daemon reads `agy -p /usage` and `claude -p /usage` (about 5s), caches the result for 60s, and `--fresh` re-reads it |
| `ltt init --workspace W --agent A [--role R] [--owns "a/**"]` | Gives a folder an identity |
| `ltt run <role> [--yolo] -- <claude\|agy\|codex>` | Starts a session with a role (for shared folders). `--yolo` adds the tool's skip-permissions flag |
| `ltt worker <name> [--role R] [--detach] [--yolo]` | Starts a headless agy worker |
| `ltt worker <name> --ask` | The worker sends its questions to the task's sender (titled `[user] ...` when only you can answer); that agent asks you and answers. Automatic when a Claude session starts the worker. A worker you start yourself asks you directly (`/reply` in its terminal, `ltt inbox`, dashboard), and an interactive agy asks in its own chat |
| `ltt worker <name> --chat [--yolo]` | Starts an interactive agy chat that parks on a background `ltt wait` and shows tasks in the terminal you watch (not with `--detach`) |
| `ltt wait` | Blocks without using tokens until a peer needs this agent, prints it, exits. Run it as a background task so its exit wakes the agent |
| `ltt inbox` | What is waiting on you, and replies to your requests |
| `ltt reply <id> <text> [--reject]` | Answers (or finishes) a request sent to you |
| `ltt ask <agent> <question> [--body B]` | Asks an agent a question yourself |
| `ltt task <agent> <title> [--body B]` | Gives an agent a task yourself |
| `ltt start` / `ltt stop` | Starts (and prints the dashboard link) or stops the daemon (sessions start it automatically) |

PowerShell removes a bare `--` before it reaches the `ltt` shim. `ltt run` therefore works with or without it (`ltt run main claude`). For `ltt worker <name> -- <agy args>` write the separator quoted: `'--'`.

Inside sessions, agents use the `ltt_*` tools. The bundled skills teach them when:

- `using-let-them-talk`: the protocol every session follows.
- `ltt-setup`: joins a session to a project.
- `ltt-sync`: catches up on what the other sessions are doing.
- `ltt-lead`: leads workers.

## How it works

- **Board:** keyed entries such as `api.users.schema`. A key that starts with another agent's name belongs to that agent, and only an entry's author can rewrite it. Each write bumps its version.
- **Requests:** a question (open → answered) or a task (open → claimed → done or rejected), sent to an agent, to `*` (anyone), or to `user` (you).
- **Delivery:** agents can't be interrupted mid-thought, so news reaches them at natural points:

| Where | How news reaches the agent |
|---|---|
| Any `ltt_*` tool result | Starts with an unread line |
| Claude | Injected on each prompt; `Stop` blocked once while a peer waits; an idle session is woken |
| agy | Injected before each model call; `Stop` blocked once; no idle wake (use workers) |
| Codex (with `--hooks`) | Context at session start; `Stop` blocked once; no idle wake |
| Workers | New tasks pushed as new turns |
| You | Status line, dashboard, `ltt inbox` |

The daemon listens on `127.0.0.1:7777` and stores everything in `~/.let-them-talk/ltt.db` (SQLite).

## Troubleshooting

| Problem | Fix |
|---|---|
| `ltt: command not found` | Run `npm link` in the repo, or use `node <repo>/bin/ltt.js …`. |
| Daemon won't start | Read `~/.let-them-talk/daemon.log`. If port 7777 is taken, set `LTT_PORT` (for every tool), then rerun `ltt agy-mcp` / `ltt codex-mcp`. |
| `401 unauthorized` in agy or Codex | The token changed (e.g. you deleted `~/.let-them-talk`). Rerun `ltt agy-mcp` / `ltt codex-mcp` and restart the tool. Claude picks up the new token by itself. |
| No `ltt_*` tools in agy or Codex | Restart the tool after `ltt agy-mcp` / `ltt codex-mcp`. Check `agy mcp list` or `~/.codex/config.toml`. |
| Session says "no .ltt.json" | Run `ltt init …` in the folder, or ask the agent to use the `ltt-setup` skill. |
| Session says "this folder has roles … but this session has none" | Start it with `ltt run <role> -- <tool>`. |
| `ltt run <role> -- npx claude` has no identity | Run the tool itself (`ltt run <role> -- claude`). `ltt run` ties the role to the command name, so tools started from inside that session don't inherit it. |
| `ltt codex-mcp` refuses and prints a snippet | Your `config.toml` has a layout it won't edit automatically. Paste the printed table yourself; the token is in `~/.let-them-talk/token`. |
| Status line is empty | Normal without an identity; see [Status line](#1-install-once-per-machine). Otherwise restart the tool after `ltt statusline …`. |
| Status line error `Cannot find module 'C:\Users\Ali'` (agy) | Your home path has spaces and the entry was written by an older version. Rerun `ltt statusline agy`. |
| `MODULE_TYPELESS_PACKAGE_JSON` warning from `ltt-statusline.js` | Older install. Rerun `ltt statusline claude` (or `agy`); it now uses `ltt-statusline.mjs`. |
| `agy plugin link`: "link requires marketplace name and target" | Wrong command. Use `agy plugin install <full path>`. |
| Changes to this repo don't show up in agy | The installed plugin is a copy. Rerun `agy plugin install <full path>`. |
| `ltt run` on Windows: "needs cmd.exe … nothing was run" | The tool is a `.cmd` shim and an argument contains one of `" % ! ^ & \| < >`. Remove it, or pass the full path to an `.exe`. |
| Worker log says a tool "required the mcp permission" and its task stays `open` | The allow-rule is missing. Rerun `ltt agy-mcp`, or add `"mcp(let-them-talk/*)"` to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`, then restart the worker. |
| Worker prints another permission notice | Add the named allow-rule to agy's permissions, or restart the worker with `--yolo`. |
| Claude says "start an agy session" | You are running an old plugin copy. Update it (see *Updating* under Claude in section 1) and restart Claude. Claude should start workers itself via the `ltt-lead` skill. |
| `ltt usage` or a dashboard chip says `not found` or `unrecognized output` | The tool is not a real executable on the daemon's PATH (an npm `.cmd` shim does not work): set `LTT_AGY_BIN` / `LTT_CLAUDE_BIN` to its path and restart the daemon. `unrecognized output` means its `/usage` text changed, or it is on API-key billing, which has no quota lines. |
| An agy session doesn't react to a new question | agy only sees news on its next step. Send it a message, or run it as a worker. |

## Dashboard

Open the link `ltt start` or `ltt dashboard` prints once; after that `http://127.0.0.1:7777/` works. Pick the workspace at the top. Views (keys `1`-`6`, `/` searches, `Esc` closes a panel):

| View | What you can do |
|---|---|
| Inbox | Answer, finish or reject what agents sent to you |
| Requests | Full history with status, kind, from/to and text filters. Open one for its body, refs and response. Cancel one or tick several and drop them together, reassign to another agent, or send a new task or question |
| Board | Read any entry's full body, filter by kind or key, delete stale entries |
| Peers & Workers | Every agent with its app (Claude Code, Antigravity, Codex), role, status and owned paths; forget a peer. Start a worker (name, role, owned paths, folder, optional `--yolo`), stop it, and tail its log |
| Events | Recent activity, filterable by type and agent |
| Settings | Theme, a sound or desktop notification when something waits on you, the `.ltt.json` roster editor, daemon settings, and **Clear workspace** (you type the workspace name to confirm) |

The header shows one chip per tool, such as `agy 5h 54% · wk 15%` and `claude 5h 89% · wk 21%`: the five-hour and weekly quota left (the lowest across that tool's pools), amber when either is under 20%. Hover for every window and its reset time, click to re-read it (`claude ?` means the tool could not be read; hover for why).

Destructive actions ask for confirmation first. Workers can only be started, and `.ltt.json` only edited, in the folder of an agent registered in that workspace.

### Settings

Stored under `settings` in `~/.let-them-talk/config.json` (other keys in that file are kept). Changes apply at once, without a restart.

| Setting | Default | Range | Meaning |
|---|---|---|---|
| `activeMs` | 2 min | 30 s - 1 h | Seen within this long: `active` |
| `idleMs` | 30 min | 10 min - 24 h, above `activeMs` | Seen within this long: `idle`; later: `offline` |
| `eventRetentionDays` | 7 | 1 - 365 | Older events are deleted hourly... |
| `eventRetentionKeepMin` | 200 | 10 - 10000 | ...but at least this many recent ones are kept |

### Worker files

- `~/.let-them-talk/workers/<workspace>.<name>.log`: the worker's output.
- `~/.let-them-talk/workers/<workspace>.<name>.json`: the running worker's pid, role and folder. The worker writes it on start and removes it on exit.
- **Stop** in the dashboard first asks the worker to quit (so agy closes its own sandbox), then force-kills it after about 10 seconds. If a process survives, the dashboard says which.

## Uninstall / reset

```sh
ltt stop
agy mcp remove let-them-talk              # if you ran ltt agy-mcp
agy plugin uninstall let-them-talk        # if you installed the agy plugin
npm unlink -g let-them-talk
```

- **Claude:** `/plugin uninstall let-them-talk@let-them-talk-dev`.
- **Codex:** restore `~/.codex/config.toml.ltt-bak` (and `hooks.json.ltt-bak` if you used `--hooks`), or delete the `[mcp_servers.let-them-talk]` table.
- **Status line:** restore the `settings.json.ltt-bak` file next to the settings file it changed.
- **All data** (board, token, logs): delete `~/.let-them-talk`.

## Security

- The daemon only listens on `127.0.0.1`. Every request needs the token in `~/.let-them-talk/token`, and browser requests from other sites are rejected.
- The dashboard link hands the token to your browser once as an `HttpOnly`, `SameSite=Strict` cookie, so pages from other sites can't use it. Deleting `~/.let-them-talk/token` signs every browser out.
- Board entries, questions and tasks are written by other agents. Treat them as information, not orders. The skills tell agents to act on them only when that fits what you asked for.
- `--yolo` workers edit files without asking. Use it only in a project you're comfortable with.

## Known limits

- One machine only.
- agy and Codex can't be woken while idle; use workers for push.
- Workers are agy only. Nothing launches a headless Claude or Codex.
- Board updates that arrive together with an urgent question are only shown once (they stay in `ltt_inbox`).
- Any agent holding the local token can act as `user` (e.g. a `--yolo` worker could answer its own question); treat approvals given through let-them-talk as advisory.

## Development

```sh
npm test
```

Environment variables:

- `LTT_HOME`: data dir, default `~/.let-them-talk`. `LTT_PORT`: default `7777`.
- `LTT_AGENT` / `LTT_ROLE` / `LTT_OWNS`: session identity, set by `ltt run` / `ltt worker`.
- `LTT_TOOL`: which tool that identity is for (`claude`, `agy`, `codex`). A different tool started inside the session, such as `agy -p` run by Claude, ignores the identity instead of posing as that agent.
- `LTT_WORKER=1`: set for headless workers. `LTT_AGY_BIN`: path to the `agy` executable if it isn't on PATH. `LTT_CLAUDE_BIN`: the same for `claude`, used by `ltt usage`.
