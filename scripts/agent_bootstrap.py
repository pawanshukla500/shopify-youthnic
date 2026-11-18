"""Agent bootstrap: make sure every agent session has the project's core tooling.

Run at session start (Claude Code runs it via the SessionStart hook in .claude/settings.json;
other agents are told to run it in AGENTS.md):

    python scripts/agent_bootstrap.py            # check + install what is missing
    python scripts/agent_bootstrap.py --self-test

It is idempotent and never fails the session: every step reports and moves on.
What it prints is added to the agent's context, so keep it short.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAPHIFY_PIN = "graphifyy==0.9.112"  # pinned so every agent builds the same graph; bump deliberately
HOOK_MARKER = "Installed by: graphify hook install"  # the one line all four graphify git hooks share
GIT_HOOKS = ("post-commit", "post-checkout", "post-merge", "post-rewrite")


def graphify_cmd():
    """Return a command list for the graphify CLI, or None if it is not installed."""
    exe = shutil.which("graphify")
    if exe:
        return [exe]
    # Installed as a module but its scripts dir is not on PATH (common right after `pip install --user`).
    # Probe in a subprocess: this process's sys.path predates the install.
    try:
        probe = subprocess.run([sys.executable, "-m", "graphify", "--version"], capture_output=True, text=True, timeout=60)
        return [sys.executable, "-m", "graphify"] if probe.returncode == 0 else None
    except Exception:
        return None


def hooks_installed(hooks_dir: Path) -> bool:
    return all((hooks_dir / h).is_file() and HOOK_MARKER in (hooks_dir / h).read_text(errors="ignore") for h in GIT_HOOKS)


def run(cmd, timeout):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)


def main() -> None:
    notes = []

    cmd = graphify_cmd()
    if cmd is None:
        try:
            in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)  # pip refuses --user inside a virtualenv
            r = run([sys.executable, "-m", "pip", "install", "--quiet", GRAPHIFY_PIN] + ([] if in_venv else ["--user"]), timeout=240)
            cmd = graphify_cmd()
            notes.append(f"graphify: installed {GRAPHIFY_PIN}" if cmd else f"graphify: install failed ({r.stderr.strip()[-200:]}); run `pip install {GRAPHIFY_PIN}`")
        except Exception as e:  # never block the session
            notes.append(f"graphify: install failed ({e}); run `pip install {GRAPHIFY_PIN}`")
    else:
        notes.append("graphify: ready")

    if cmd:
        git_dir = ROOT / ".git"
        if git_dir.is_dir() and not hooks_installed(git_dir / "hooks"):
            try:
                run(cmd + ["hook", "install"], timeout=60)
                notes.append("graphify: git hooks installed (graph rebuilds after commit/checkout/merge)")
            except Exception as e:
                notes.append(f"graphify: hook install failed ({e}); run `graphify hook install`")
        if not (ROOT / "graphify-out" / "graph.json").is_file():
            try:
                r = run(cmd + ["update", "."], timeout=240)
                notes.append("graphify: graph built" if r.returncode == 0 else "graphify: graph build failed; run `python scripts/build_graphify.py`")
            except Exception as e:
                notes.append(f"graphify: graph build skipped ({e}); run `python scripts/build_graphify.py`")

    print("Project tooling check - " + "; ".join(notes))
    print("Rules: follow AGENTS.md (Ponytail lazy-senior-dev rules + graphify-first code search).")
    print("After every change: run `graphify update .`, then update docs/HANDOFF.md and any doc the change touches (see AGENTS.md > Project upkeep).")


def self_test() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        hooks = Path(d)
        assert not hooks_installed(hooks), "empty hooks dir must not count as installed"
        for h in GIT_HOOKS[:-1]:
            (hooks / h).write_text(f"#!/bin/sh\n# {HOOK_MARKER}\n")
        assert not hooks_installed(hooks), "a missing hook must not count as installed"
        (hooks / GIT_HOOKS[-1]).write_text("#!/bin/sh\necho other tool\n")
        assert not hooks_installed(hooks), "a hook without the graphify marker must not count"
        (hooks / GIT_HOOKS[-1]).write_text(f"#!/bin/sh\n# {HOOK_MARKER}\n")
        assert hooks_installed(hooks), "all four marked hooks count as installed"
    assert GRAPHIFY_PIN.startswith("graphifyy=="), "PyPI package is graphifyy (double y), pinned"
    print("agent_bootstrap self-test: ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        try:
            main()
        except Exception as e:  # the session must start even if something unexpected breaks
            print(f"Project tooling check failed: {e}. Run `python scripts/agent_bootstrap.py` manually.")
        sys.exit(0)
