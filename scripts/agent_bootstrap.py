"""Agent bootstrap: make sure every agent session has the project's core tooling (Graphify; Ponytail rules are in AGENTS.md).

    python scripts/agent_bootstrap.py              # fast check at session start; slow setup runs in the background
    python scripts/agent_bootstrap.py --setup      # install pinned Graphify, git hooks and graph now (slow)
    python scripts/agent_bootstrap.py --guard search|read|compact   # Claude Code hook entry: runs `graphify hook-guard`
    python scripts/agent_bootstrap.py --self-test

Claude Code runs the fast check from the SessionStart hook and the guard from the PreToolUse/compact hooks
(.claude/settings.json). Other agents are told to run it in AGENTS.md. Nothing here ever fails a session.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAPHIFY_VERSION = "0.9.112"  # pinned so every agent builds the same graph; bump deliberately
GRAPHIFY_PIN = f"graphifyy=={GRAPHIFY_VERSION}"
HOOK_MARKER = "Installed by: graphify hook install"  # the one line all four graphify git hooks share
GIT_HOOKS = ("post-commit", "post-checkout", "post-merge", "post-rewrite")
LOG = ROOT / ".git" / "agent-bootstrap.log"
# Startup does at most two `--version` probes plus one git call, so it stays far inside the 60s SessionStart timeout.
STARTUP_PROBE_TIMEOUT = 8
SETUP_PROBE_TIMEOUT = 60  # first run after a fresh install can be slow (bytecode compile)


def _version_of(cmd, timeout=STARTUP_PROBE_TIMEOUT):
    try:
        out = subprocess.run(cmd + ["--version"], capture_output=True, text=True, timeout=timeout)
        return parse_version(out.stdout + out.stderr) if out.returncode == 0 else None
    except Exception:
        return None


def parse_version(text: str):
    """'graphify 0.9.112' -> '0.9.112'; anything else -> None."""
    parts = text.strip().split()
    return parts[1] if len(parts) >= 2 and parts[0] == "graphify" else None


def _module_version():
    """Version of the graphifyy package importable by this interpreter, read from its metadata (no subprocess)."""
    from importlib import metadata, util
    try:
        return metadata.version("graphifyy") if util.find_spec("graphify") else None
    except Exception:
        return None


def graphify_cmd(require_pin: bool = True, probe_timeout: int = STARTUP_PROBE_TIMEOUT):
    """The graphify CLI, or None. One resolver for bootstrap and the hook guard.

    Both prefer this interpreter's module when its metadata shows the pinned version (instant, and an older
    `graphify` earlier on PATH can't win after a pinned install).
    require_pin=True (bootstrap): otherwise only a pinned PATH executable or module counts (verified by probe).
    require_pin=False (hook guard, runs before every tool call): no subprocess probes; falls back to any available
    CLI, because `hook-guard` only prints search guidance and never writes the graph. When a pinned CLI exists,
    both modes select it."""
    module = [sys.executable, "-m", "graphify"]
    mod = _module_version()
    if mod == GRAPHIFY_VERSION:
        return module
    exe = shutil.which("graphify")
    if require_pin:
        if exe and _version_of([exe], probe_timeout) == GRAPHIFY_VERSION:
            return [exe]
        # Installed during this process (e.g. a fresh user site-packages): metadata can't see it yet, so probe.
        return module if _version_of(module, probe_timeout) == GRAPHIFY_VERSION else None
    return [exe] if exe else (module if mod else None)


def active_hooks_dir():
    """The hooks directory git actually uses (respects core.hooksPath), or None outside a git checkout."""
    try:
        out = subprocess.run(["git", "rev-parse", "--git-path", "hooks"], cwd=ROOT, capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return (ROOT / out.stdout.strip()).resolve()
    except Exception:
        pass
    # `git` not on PATH: a plain checkout still uses .git/hooks (core.hooksPath can't be read without git)
    return ROOT / ".git" / "hooks" if (ROOT / ".git").is_dir() else None


def hooks_state(hooks_dir: Path) -> str:
    """'installed', 'missing', or 'unknown' (a hook file exists but can't be read: don't treat it as safe to replace)."""
    try:
        for h in GIT_HOOKS:
            f = hooks_dir / h
            if not f.exists() or HOOK_MARKER not in f.read_text(errors="ignore"):
                return "missing"
        return "installed"
    except OSError:
        return "unknown"


def needs_setup():
    """What is missing, as short notes. Fast: version probes and file checks only."""
    missing = []
    if not graphify_cmd():
        missing.append(f"graphify {GRAPHIFY_VERSION} not installed")
    hooks = active_hooks_dir()
    if hooks and hooks_state(hooks) != "installed":
        missing.append("graphify git hooks")
    if not (ROOT / "graphify-out" / "graph.json").is_file():
        missing.append("code graph")
    return missing


def run(cmd, timeout):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)


def setup() -> list:
    """Slow path: install pinned Graphify, git hooks and graph. Each step reports and moves on."""
    notes = []
    cmd = graphify_cmd(probe_timeout=SETUP_PROBE_TIMEOUT)
    if not cmd:
        in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)  # pip refuses --user inside a virtualenv
        try:
            r = run([sys.executable, "-m", "pip", "install", "--quiet", GRAPHIFY_PIN] + ([] if in_venv else ["--user"]), timeout=600)
            cmd = graphify_cmd(probe_timeout=SETUP_PROBE_TIMEOUT)
            notes.append(f"installed {GRAPHIFY_PIN}" if cmd else f"install failed: {r.stderr.strip()[-300:]}")
        except Exception as e:
            notes.append(f"install failed: {e}")
    if not cmd:
        return notes + [f"run `pip install {GRAPHIFY_PIN}` by hand"]

    hooks = active_hooks_dir()
    if hooks:
        state = hooks_state(hooks)
        if state == "unknown":
            notes.append(f"git hooks in {hooks} could not be read; left untouched")
        elif state == "missing":
            try:
                r = run(cmd + ["hook", "install"], timeout=120)
                if r.returncode == 0 and hooks_state(hooks) == "installed":
                    notes.append("git hooks installed")
                else:
                    notes.append(f"git hook install did not take effect in {hooks} (exit {r.returncode}); if core.hooksPath is set, install the hooks there by hand")
            except Exception as e:
                notes.append(f"git hook install failed: {e}")

    if not (ROOT / "graphify-out" / "graph.json").is_file():
        try:
            r = run(cmd + ["update", "."], timeout=1800)
            notes.append("code graph built" if r.returncode == 0 else "graph build failed; run `python scripts/build_graphify.py`")
        except Exception as e:
            notes.append(f"graph build failed ({e}); run `python scripts/build_graphify.py`")
    return notes


def start_background_setup():
    """Detach `--setup` so the session starts now; its log lands in .git/agent-bootstrap.log."""
    log = open(LOG, "a", encoding="utf-8") if LOG.parent.is_dir() else subprocess.DEVNULL
    # Windows: DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP so the setup outlives the hook process
    kwargs = {"creationflags": 0x00000008 | 0x00000200} if os.name == "nt" else {"start_new_session": True}
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--setup"], cwd=ROOT, stdout=log, stderr=log, stdin=subprocess.DEVNULL, **kwargs)


def guard(kind: str) -> int:
    """Claude Code hook entry: same resolver as bootstrap; hook stdin, stdout and exit code passed straight through."""
    cmd = graphify_cmd(require_pin=False)  # same resolver without subprocess probes: this runs before every tool call
    if not cmd:
        return 0  # graphify not available yet: no guidance, never block the tool call
    r = subprocess.run(cmd + ["hook-guard", kind], stdin=sys.stdin, capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    return r.returncode


def main() -> None:
    missing = needs_setup()
    if missing:
        start_background_setup()
        status = f"setting up in the background ({', '.join(missing)}); log: .git/agent-bootstrap.log"
    else:
        hooks_note = "git hooks" if active_hooks_dir() else "git hooks unchecked (not a git checkout)"
        status = f"graphify {GRAPHIFY_VERSION} ready, {hooks_note} and code graph present"
    print(f"Project tooling check - {status}.")
    print("Rules: follow AGENTS.md (Ponytail lazy-senior-dev rules + graphify-first code search).")
    print("After every change: run `graphify update .`, and update docs per AGENTS.md > Project upkeep.")


def self_test() -> None:
    import tempfile

    assert parse_version("graphify 0.9.112\n") == "0.9.112"
    assert parse_version("command not found") is None
    with tempfile.TemporaryDirectory() as d:
        hooks = Path(d)
        assert hooks_state(hooks) == "missing", "empty hooks dir"
        for h in GIT_HOOKS[:-1]:
            (hooks / h).write_text(f"#!/bin/sh\n# {HOOK_MARKER}\n")
        assert hooks_state(hooks) == "missing", "one hook missing"
        (hooks / GIT_HOOKS[-1]).write_text("#!/bin/sh\necho other tool\n")
        assert hooks_state(hooks) == "missing", "hook without the graphify marker"
        (hooks / GIT_HOOKS[-1]).write_text(f"#!/bin/sh\n# {HOOK_MARKER}\n")
        assert hooks_state(hooks) == "installed", "all four marked hooks"
        (hooks / GIT_HOOKS[0]).unlink()
        (hooks / GIT_HOOKS[0]).mkdir()  # reading a directory as a file raises OSError
        assert hooks_state(hooks) == "unknown", "unreadable hook is unknown, not safe to replace"
    assert GRAPHIFY_PIN == "graphifyy==" + GRAPHIFY_VERSION, "PyPI package is graphifyy (double y), pinned"

    # Resolver: bootstrap and guard agree whenever a pinned CLI exists; guard never runs a version probe.
    g = globals()
    saved = (g["_module_version"], g["_version_of"], shutil.which)
    module = [sys.executable, "-m", "graphify"]
    probes = []
    try:
        def fake(mod_ver, exe, exe_ver, mod_probe=None):
            g["_module_version"] = lambda: mod_ver
            shutil.which = lambda name: exe
            def probe(cmd, timeout=STARTUP_PROBE_TIMEOUT):
                probes.append(cmd)
                return exe_ver if cmd == [exe] else mod_probe
            g["_version_of"] = probe
        fake(GRAPHIFY_VERSION, "/bin/graphify", "0.1.0")
        assert graphify_cmd() == module and graphify_cmd(require_pin=False) == module, "pinned module wins in both modes"
        fake("0.1.0", "/bin/graphify", GRAPHIFY_VERSION)
        assert graphify_cmd() == ["/bin/graphify"] and graphify_cmd(require_pin=False) == ["/bin/graphify"], "pinned exe chosen by both"
        fake("0.1.0", None, None, mod_probe="0.1.0")
        assert graphify_cmd() is None, "no pinned CLI: bootstrap installs"
        probes.clear()
        assert graphify_cmd(require_pin=False) == module and not probes, "guard falls back without probing"
        fake(None, None, None)
        assert graphify_cmd(require_pin=False) is None, "nothing installed: guard skips"
    finally:
        g["_module_version"], g["_version_of"], shutil.which = saved
    print("agent_bootstrap self-test: ok")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--self-test"]:
        self_test()
    elif args[:1] == ["--guard"] and len(args) == 2:
        try:
            sys.exit(guard(args[1]))
        except Exception:
            sys.exit(0)  # a broken guard must never block a tool call
    elif args[:1] == ["--setup"]:
        print("\n".join(["agent_bootstrap --setup:"] + setup()), flush=True)
    else:
        try:
            main()
        except Exception as e:  # the session must start even if something unexpected breaks
            print(f"Project tooling check failed: {e}. Run `python scripts/agent_bootstrap.py --setup` manually.")
        sys.exit(0)
