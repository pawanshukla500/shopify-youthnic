---
trigger: always_on
description: Bootstrap core agent tooling (Graphify, Ponytail) each session and keep the graph and docs current after every change.
---

## Project upkeep

- At the start of a session run `python scripts/agent_bootstrap.py`. It installs the pinned Graphify CLI, git hooks and graph when missing, and never blocks.
- Follow the Ponytail rules and the graphify rules in `AGENTS.md`.
- After every change, in the same change: run `graphify update .`, update `docs/HANDOFF.md` (Last Verified + what changed) and any doc the change touches. Full checklist: `AGENTS.md` > Project upkeep.
