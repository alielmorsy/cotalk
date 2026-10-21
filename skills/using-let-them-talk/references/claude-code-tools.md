# let-them-talk in Claude Code

- Tools appear as `mcp__plugin_let-them-talk_ltt__<tool>`, e.g. `mcp__plugin_let-them-talk_ltt__ltt_inbox`.
- CLI: `ltt` is on PATH in Bash through the plugin's `bin/`. Fallback: `node "${CLAUDE_PLUGIN_ROOT}/bin/ltt.js"`.
- Hooks:
  - session start injects your identity and peer context;
  - each prompt injects new unread items;
  - `Stop` blocks once for new questions or tasks;
  - an idle session is woken when a peer needs it.
