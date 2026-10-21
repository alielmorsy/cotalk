# cotalk

Multi-agent coordination on your local machine.

Lets Claude Code, Antigravity (`agy`), and Codex sessions share contracts and decisions, ask each other questions, and hand off tasks. Claude can orchestrate headless agy background workers, and any agent can ask you directly. Runs locally via a lightweight daemon and plugins—nothing leaves your machine.

## Features

- **Board:** Keyed contracts and architectural decisions (`api.users.schema`). Agents get notified when entries change.
- **Requests:** Ask peers questions or delegate tasks (open → claimed → done).
- **Human in the Loop:** Agents can route questions to `user` (you). Answer from your terminal or dashboard without burning agent tokens.
- **Headless Workers:** Run `cotalk worker` to spin up background agy instances that process tasks automatically.
- **Web Dashboard:** Real-time web UI (`http://127.0.0.1:7878/`) to monitor sessions, review requests, answer questions, and manage workers.

## Requirements

- **Node.js 22.13+** (`node --version`)
- At least one agent CLI: **Claude Code**, **Antigravity CLI (`agy`) 1.2.13+**, or **Codex CLI 0.115+**
- Windows, macOS, or Linux

---

## 1. Installation

### Automatic Setup (Recommended)

```sh
npx co-talk@latest setup
```

Options:
```sh
cotalk setup --dry-run              # Preview actions without changes
cotalk setup --only claude,agy      # Configure specific tools only
cotalk setup --statusline           # Install prompt status line
```

Verify your setup:
```sh
cotalk doctor
```

Open the dashboard link printed during setup to sign in, or run `cotalk dashboard`.

### Manual Setup

```sh
npm install -g co-talk
cotalk start
```

Configure your tools (`<path>` is `npm root -g`/co-talk or your clone):

- **Claude Code:**
  ```
  /plugin marketplace add <path>
  /plugin install cotalk@cotalk
  ```
- **Antigravity (`agy`):**
  ```sh
  agy plugin install <path>
  cotalk agy-mcp
  ```
- **Codex:**
  ```sh
  cotalk codex-mcp
  ```

### Updating

```sh
cotalk update            # install the latest release and refresh every tool
cotalk update --check    # only report whether a newer version exists
```

`update` stops the daemon, installs the new `co-talk` globally, then runs the new version's setup: it updates the Claude plugin, reinstalls the agy plugin, rewrites the MCP entries, refreshes the status line and restarts the daemon. Restart your tools afterwards. In a git clone it tells you to `git pull` instead.

### Status Line (Optional)

Displays `[agent@workspace] 📬2 ⏳1` (identity, unread news, requests waiting on you):

```sh
cotalk statusline claude     # updates ~/.claude/settings.json
cotalk statusline agy        # updates ~/.gemini/antigravity-cli/settings.json
```

---

## 2. Quick Start

### Separate Folders per Agent

Ideal when splitting services across directories (e.g. `api` and `web`):

```sh
# Terminal 1: API service
cd ~/shop/api
cotalk init --workspace shop --agent api --role "REST API" --owns "api/**"
claude

# Terminal 2: Web frontend
cd ~/shop/web
cotalk init --workspace shop --agent web --role "frontend" --owns "web/**"
agy
```

Prompt in **web**: *"Ask api how pagination works on the users endpoint."* The question routes directly to **api** on its next step.

### Shared Folder: Lead + Workers

Define a roster in the root `.cotalk.json`:

```json
{
  "workspace": "engine",
  "agents": {
    "lead":    { "role": "architect", "owns": ["docs/**"] },
    "physics": { "role": "physics",   "owns": ["src/physics/**"] },
    "audio":   { "role": "audio",     "owns": ["src/audio/**"] }
  }
}
```

Start the lead and workers:

```sh
cotalk run lead -- claude        # Interactive Claude lead
cotalk worker physics            # Headless agy worker
cotalk worker audio
```

Workers can also be spawned dynamically without a roster entry:
```sh
cotalk worker worker1 --role "tests" --owns "test/**" --detach
```

#### Workflow: Claude Leading agy Workers

1. Start lead: `cotalk run lead -- claude`.
2. Ask Claude: *"Have agy implement feature X in src/foo/. Use the cotalk-lead skill."*
3. Claude proposes a worker and launches it (`cotalk worker <name> --role ... --detach`). Use `--yolo` for unattended edits.
4. Claude delegates the task. The worker executes it and marks it done. Claude reviews the result.
5. If the worker needs guidance, answer it via `cotalk inbox` and `cotalk reply <id> <text>`.

---

## Commands

| Command | Description |
|---|---|
| `cotalk setup [--dry-run] [--only claude,agy,codex] [--statusline]` | Install the plugins and MCP entries into every tool found |
| `cotalk doctor [--json]` | Check the install and print a fix for each problem |
| `cotalk update [--check]` | Update to the latest release and refresh every tool |
| `cotalk --version` | Print the installed version |
| `cotalk status` | Show daemon status, identity, peers, and unread count |
| `cotalk dashboard` | Print dashboard sign-in link |
| `cotalk usage [--fresh]` | Check quota usage and reset times for agy and Claude |
| `cotalk init --workspace W --agent A` | Initialize `.cotalk.json` in the current folder |
| `cotalk run <role> [--yolo] -- <tool>` | Launch session with an assigned role |
| `cotalk worker <name> [--role R] [--detach] [--yolo]` | Launch headless agy background worker |
| `cotalk wait` | Block until a peer needs this agent, then exit (useful in scripts) |
| `cotalk inbox` | View pending requests and replies |
| `cotalk reply <id> <text> [--reject]` | Answer or reject a request sent to you |
| `cotalk ask <agent> <question>` | Ask an agent a question directly |
| `cotalk task <agent> <title>` | Assign a task directly to an agent |
| `cotalk start` / `cotalk stop` | Start or stop the daemon |

Inside sessions, agents use bundled skills (`using-cotalk`, `cotalk-setup`, `cotalk-sync`, `cotalk-lead`).

---

## How It Works

- **Board:** Key-value entries (`api.users.schema`). Only the author can update their entries. Updates notify interested peers.
- **Requests:** Questions or tasks sent to an agent, `*` (broadcast), or `user`.
- **Delivery:** News is delivered non-intrusively:
  - **Claude:** Injected on prompt; idle sessions wake automatically.
  - **agy:** Injected before model calls; runs tasks automatically via workers.
  - **Codex:** Injected at turn start.
  - **You:** Via status line, `cotalk inbox`, and the web dashboard.

Data is stored locally in SQLite at `~/.cotalk/cotalk.db`.

---

## Dashboard

Visit `http://127.0.0.1:7878/` (open link from `cotalk start` once to authenticate):

- **Inbox:** Answer or dismiss questions waiting on you.
- **Requests:** History and status of all tasks and questions across sessions.
- **Board:** Inspect and manage shared contracts and architecture decisions.
- **Peers & Workers:** View active agents, spawn/stop workers, and tail worker logs.
- **Settings:** Notifications, theme, retention policies, and `.cotalk.json` roster editor.

---

## Troubleshooting

| Issue | Resolution |
|---|---|
| `cotalk: command not found` | Run `npm install -g co-talk` or check PATH. |
| Anything misbehaving | Run `cotalk doctor` to inspect and see fix commands. |
| Daemon fails to start | Check `~/.cotalk/daemon.log` or set `COTALK_PORT` if 7878 is occupied. |
| `401 unauthorized` | Token changed: re-run `cotalk agy-mcp` / `cotalk codex-mcp` and restart tools. |
| Missing `cotalk_*` tools in agy | Re-run `cotalk agy-mcp` and restart agy. Check with `agy mcp list`. |
| Worker blocked on permissions | Run `cotalk agy-mcp` (adds `mcp(cotalk/*)` allow-rule) or launch with `--yolo`. |
| Session has no identity | Run `cotalk init` in the folder or start with `cotalk run <role> -- <tool>`. |

---

## Development

```sh
git clone https://github.com/alielmorsy/cotalk.git && cd cotalk
npm install          # Dev dependencies only (Vite)
npm link
npm test
```

- **Dashboard:** Source in `dashboard/`, built with `npm run build` into `daemon/public/`. Use `npm run dev` for dev server with live reload.
- **Config & Logs:** Stored in `~/.cotalk/`. Set `COTALK_HOME` or `COTALK_PORT` to override defaults.
