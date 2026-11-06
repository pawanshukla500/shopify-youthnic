---
trigger: always_on
description: Consult the graphify knowledge graph at graphify-out/ for codebase and architecture questions.
---

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- For codebase or architecture questions, when `graphify-out/graph.json` exists, first run `graphify query "<question>"` (CLI) or `query_graph` (MCP). Use `graphify path "<A>" "<B>"` / `shortest_path` for relationships and `graphify explain "<concept>"` / `get_node` for focused concepts. These return a scoped subgraph, usually much smaller than `GRAPH_REPORT.md` or raw grep output.
- If `graphify-out/graph.json` does not exist on a fresh checkout, first install Graphify following `.agents/skills/graphify/SKILL.md`, then run `python scripts/build_graphify.py` from the repository root to build `graphify-out/graph.json` and wiki. Graphify outputs are generated locally and intentionally not committed.
- If `graphify-out/wiki/index.md` exists, navigate it to locate relevant source files, then inspect the source files before answering source-level questions or making code changes.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code files, regenerate the graph with `python scripts/build_graphify.py` when the dependency is installed. Graphify is advisory and never replaces inspection of actual source and tests.
