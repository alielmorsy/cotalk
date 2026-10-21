# cotalk in Claude Code

- Tools appear as `mcp__plugin_cotalk_cotalk__<tool>`, e.g. `mcp__plugin_cotalk_cotalk__cotalk_inbox`.
- CLI: `cotalk` is on PATH in Bash through the plugin's `bin/`. Fallback: `node "${CLAUDE_PLUGIN_ROOT}/bin/cotalk.js"`.
- Hooks:
  - session start injects your identity and peer context;
  - each prompt injects new unread items;
  - `Stop` blocks once for new questions or tasks;
  - an idle session is woken when a peer needs it.
