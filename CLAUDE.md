@AGENTS.md

## Claude Code setup (automatic)

This repo's `.claude/settings.json` wires the core tooling into every Claude Code session:

- **Ponytail** (lazy senior dev rules) is enabled as the `ponytail@ponytail` plugin from the `DietrichGebert/ponytail` marketplace. Accept the install prompt the first time you open the repo. The same rules are in `AGENTS.md`, imported above, so they apply even before the plugin is installed.
- **Graphify** (code knowledge graph): the project skill is in `.claude/skills/graphify/`, the PreToolUse hooks steer searches toward `graphify query`, and the SessionStart hook runs `scripts/agent_bootstrap.py`, a fast check that sets up the pinned `graphifyy` CLI, the git hooks and the graph in the background when any is missing (log: `.git/agent-bootstrap.log`). The hooks call Graphify through the same script (`--guard`), so they use the same pinned CLI and skip cleanly if it isn't installed yet.

If hooks are turned off (for example `"disableAllHooks": true` in `~/.claude/settings.json`), run `python scripts/agent_bootstrap.py --setup` yourself at the start of a session.

Follow **Project upkeep** in `AGENTS.md` after every change: update the graph and the docs in the same change.
