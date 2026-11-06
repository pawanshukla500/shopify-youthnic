---
name: graphify
description: Turn any folder of files into a navigable knowledge graph
---

# Workflow: graphify

Follow the graphify skill located at `.agents/skills/graphify/SKILL.md` to run the full pipeline.

If no path argument is given, use `.` (current directory).
To query the graph:
`python -m graphify query "<question>"`
To update code changes:
`python -m graphify update .`
