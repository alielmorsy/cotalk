---
name: cotalk-setup
description: Use when the user wants this session to join cotalk, or when a session has no .cotalk.json identity — sets up the daemon, identity file, agy MCP entry and status line.
---

# Set up cotalk

1. Run `cotalk start`. If `cotalk` is not on PATH, use the fallback command in `using-cotalk/references/`.
2. Ask the user for:
   - the workspace name (shared by all sessions of the project),
   - this session's agent name,
   - its role,
   - its owned paths.

   Then run `cotalk init --workspace <w> --agent <a> --role "<role>" --owns "<glob>,<glob>"`. Names match `[a-z0-9][a-z0-9_-]{0,31}`. If `.cotalk.json` exists, ask before adding `--force`.
3. agy only: run `cotalk agy-mcp --dry-run` and show the output. After the user agrees, run `cotalk agy-mcp`. It registers the MCP server (`agy mcp add`) and adds the allow-rule `mcp(cotalk/*)` to `~/.gemini/antigravity-cli/settings.json` (backup kept); headless workers cannot call `cotalk_*` tools without it. Restart agy afterwards.
4. Status line (optional, ask first because it edits user settings; a backup is kept): `cotalk statusline claude` or `cotalk statusline agy`.
5. Verify: run `cotalk status`, then call `cotalk_register` with role and owns, then `cotalk_peers`.

## Several roles in one folder

Use a roster `.cotalk.json` when sessions share a folder:

```json
{"workspace":"engine","agents":{"lead":{"role":"architect","owns":["docs/**"]},"physics":{"role":"physics","owns":["src/physics/**"]}}}
```

- Start a session with a role: `cotalk run <role> -- claude`. `--role` and `--owns` override the roster.
- Start a headless agy worker: `cotalk worker <name> [--role R] [--owns "a/**"] [--detach]`. It launches agy itself; extra agy args go after `--`.
- Workers need `cotalk agy-mcp` once (step 3). Without it `cotalk worker` exits.
- A session in a roster folder without `COTALK_AGENT` has no identity and is told to relaunch with `cotalk run`.
