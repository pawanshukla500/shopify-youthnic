---
trigger: always_on
description: Bootstrap core agent tooling (Graphify, Ponytail) each session and keep the graph and docs current after every change.
---

## Project upkeep

- At the start of a session run `python scripts/agent_bootstrap.py` (fast check; missing tooling is set up in the background) or `python scripts/agent_bootstrap.py --setup` to set it up now. It never blocks.
- Follow the Ponytail rules and the graphify rules in `AGENTS.md`.
- After every change, in the same change: run `graphify update .` and update the docs that `AGENTS.md` > Project upkeep says the change needs (it defines when `docs/HANDOFF.md` must change).
