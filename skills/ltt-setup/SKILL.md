---
name: ltt-setup
description: Use when the user wants this session to join let-them-talk, or when a session has no .ltt.json identity — sets up the daemon, identity file, agy MCP entry and status line.
---

# Set up let-them-talk

1. Run `ltt start`. If `ltt` is not on PATH, use the fallback command in `using-let-them-talk/references/`.
2. Ask the user for:
   - the workspace name (shared by all sessions of the project),
   - this session's agent name,
   - its role,
   - its owned paths.

   Then run `ltt init --workspace <w> --agent <a> --role "<role>" --owns "<glob>,<glob>"`. Names match `[a-z0-9][a-z0-9_-]{0,31}`. If `.ltt.json` exists, ask before adding `--force`.
3. agy only: run `ltt agy-mcp --dry-run` and show the output. After the user agrees, run `ltt agy-mcp`. It registers the MCP server (`agy mcp add`) and adds the allow-rule `mcp(let-them-talk/*)` to `~/.gemini/antigravity-cli/settings.json` (backup kept); headless workers cannot call `ltt_*` tools without it. Restart agy afterwards.
4. Status line (optional, ask first because it edits user settings; a backup is kept): `ltt statusline claude` or `ltt statusline agy`.
5. Verify: run `ltt status`, then call `ltt_register` with role and owns, then `ltt_peers`.

## Several roles in one folder

Use a roster `.ltt.json` when sessions share a folder:

```json
{"workspace":"engine","agents":{"lead":{"role":"architect","owns":["docs/**"]},"physics":{"role":"physics","owns":["src/physics/**"]}}}
```

- Start a session with a role: `ltt run <role> -- claude`. `--role` and `--owns` override the roster.
- Start a headless agy worker: `ltt worker <name> [--role R] [--owns "a/**"] [--detach]`. It launches agy itself; extra agy args go after `--`.
- Workers need `ltt agy-mcp` once (step 3). Without it `ltt worker` exits.
- A session in a roster folder without `LTT_AGENT` has no identity and is told to relaunch with `ltt run`.
