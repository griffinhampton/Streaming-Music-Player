"""The tools reach for each other by path, and nothing that runs has ever
checked those paths. This is that check.

What it was written for: `p5min.py` and `p5park.py` looked for `wgc.py` beside
themselves, and so did `p2rig.py`, `p3rig.py`, `p5rig.py` and `p5switch.py` -
thirteen references to four helpers (`wgc.py`, `windiag2.py`, `cdp.js`,
`cpuby.ps1`) that only ever lived in `tools/p0`. They worked while the rig and
the tools sat together in one flat scratch folder; when the rig was gathered
into `<repo>/.rig` the runner .sh files were moved over to the two anchors
(their own folder, and `.rig`) and the Python ones were not.

Nothing said so, because of how it fails: python against a file that is not
there exits 2 and writes to stderr, every one of these callers reads only
`.stdout`, and an empty string means "no frames" rather than "no such file".
A capture check would have gone red; a printed measurement would just have
been blank.

What this does not cover: the scratch folders those same tools write into
(`live/`, `apps/`), which are directories rather than scripts and are created
on demand now. Only literal script paths are checked here.
"""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.dirname(HERE)
TOOLS = os.path.join(DECK, "tools")
REPO = os.path.dirname(DECK)

# os.path.join(ANCHOR, "name.py") and the node/python scripts handed to it.
PY_REF = re.compile(r'os\.path\.join\((\w+), ["\']([^"\']+\.(?:py|js))["\']\)')
# f'& "{ANCHOR}\\name.ps1" ...' - the powershell helpers.
PS_REF = re.compile(r'\{(\w+)\}\\{1,2}([A-Za-z0-9_.-]+\.ps1)')
# "$N/name.js", including "$N/../rig/name.ps1".
SH_REF = re.compile(r'\$(\w+)/([A-Za-z0-9_./-]+\.(?:py|js|ps1))')
# A path that names this repo instead of working itself out from the script.
REPO_ABS = re.compile(r'(?:[A-Za-z]:[\\/]|/[a-z]/)[^"\'\s]*(?:streaming stuff|music-deck)', re.I)


def sources(ext):
    for root, dirs, files in os.walk(TOOLS):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in sorted(files):
            if f.endswith(ext):
                path = os.path.join(root, f)
                with open(path, encoding="utf-8") as fh:
                    yield path, fh.read()


def rel(path):
    return os.path.relpath(path, REPO).replace("\\", "/")


class HelpersAreWhereTheyAreLookedFor(unittest.TestCase):
    """`O` is deliberately absent from both anchor maps: it is <repo>/.rig,
    which is git-ignored and need not exist on a fresh clone. Nothing under it
    is a script - it holds the rig, the scratch shots and the Chrome profiles -
    so skipping it costs this check nothing."""

    def test_every_helper_a_python_tool_runs_exists(self):
        missing = []
        for path, src in sources(".py"):
            anchors = {"S": os.path.dirname(path), "P0": os.path.join(TOOLS, "p0")}
            for pattern in (PY_REF, PS_REF):
                for anchor, name in pattern.findall(src):
                    if anchor not in anchors:
                        continue
                    target = os.path.join(anchors[anchor], name)
                    if not os.path.isfile(target):
                        missing.append(f"{rel(path)} runs {anchor}/{name}, which is not there")
        self.assertEqual(missing, [], "\n" + "\n".join(missing))

    def test_every_helper_a_runner_script_calls_exists(self):
        missing = []
        for path, src in sources(".sh"):
            anchors = {"N": os.path.dirname(path), "S": os.path.dirname(path)}
            for anchor, name in SH_REF.findall(src):
                if anchor not in anchors:
                    continue
                target = os.path.join(anchors[anchor], name)
                if not os.path.isfile(target):
                    missing.append(f"{rel(path)} calls ${anchor}/{name}, which is not there")
        self.assertEqual(missing, [], "\n" + "\n".join(missing))

    def test_no_tool_finds_this_repo_by_absolute_path(self):
        # The repo has been moved once already (the rig went into .rig, and a
        # Chrome profile split at the space in "streaming stuff"). A tool that
        # writes the path out is a tool that breaks the next time it moves, and
        # it will not work on anyone else's machine either. Absolute paths to
        # things outside the repo - Chrome, ffmpeg - are fine and stay.
        hardcoded = []
        for ext in (".py", ".sh", ".ps1", ".js"):
            for path, src in sources(ext):
                for line_no, line in enumerate(src.splitlines(), 1):
                    if REPO_ABS.search(line):
                        hardcoded.append(f"{rel(path)}:{line_no}: {line.strip()[:90]}")
        self.assertEqual(hardcoded, [], "\n" + "\n".join(hardcoded))


if __name__ == "__main__":
    unittest.main()
