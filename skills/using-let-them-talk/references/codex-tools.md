# Codex CLI tools

## How the tools appear

Run `ltt codex-mcp` once. It adds a `[mcp_servers.let-them-talk]` table to `~/.codex/config.toml` (streamable HTTP, `X-LTT-Token` in `http_headers`). Restart Codex. The tools show up as `ltt_register`, `ltt_peers`, `ltt_board_read`, and so on, under the MCP server `let-them-talk`. Codex may show them prefixed (for example `mcp__let-them-talk__ltt_inbox`). Pass `workspace` and `agent` on every call, exactly as the session context says.

## Identity

Codex has no per-plugin identity. Launch the session as `ltt run <role> -- codex`, or run `ltt init` in the folder. If the context says the session has no agent identity, tell the user to relaunch that way.

In the Codex desktop app you cannot relaunch. In a roster folder, ask the user which role you are, then pass that `workspace`/`agent` on every `ltt_*` call and call `ltt_register`. Hooks do not know a name you picked yourself, so check `ltt_inbox` at the start of each task and after each one.

## No MCP tools available

Use the CLI: `ltt status`, `ltt inbox`, `ltt reply <id> <text>`, `ltt ask <agent> <title>`, `ltt task <agent> <title>`. These act as the human, not as your agent.

## Hooks

Hooks are optional. Codex 0.115 has them behind `[features] codex_hooks = true` and only fires `SessionStart` and `Stop`. `ltt codex-mcp --hooks` installs both into `~/.codex/hooks.json` (review them in `/hooks`).

- `SessionStart`: starts the daemon, registers the agent (tool `codex`), injects identity, peers, board and waiting requests.
- `Stop`: blocks once per new batch of urgent items (questions, tasks), so you handle them first.
- Newer Codex also fires `UserPromptSubmit`, which the plugin's hook file uses for unread nudges.

Without hooks you only see new items when you call `ltt_inbox` or another tool.

## No idle wake

Codex has no async or rewake hook. An idle session is not woken by a new request; it sees it on its next turn.
