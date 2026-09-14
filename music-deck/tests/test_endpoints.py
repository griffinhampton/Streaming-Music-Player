"""Every endpoint the app or its tools calls has to be one the server answers,
by the method it is called with.

`test_tools.py` checks the paths tools use to find *each other*;
`test_harness_urls.py` checks how they encode a URL. Neither asks whether the
URL leads anywhere, and nothing asked whether it leads anywhere *by GET*.

Written after `tools/p5/framenative.py` was read line by line before being
handed back: it was built against S5's server, and S9 to S18 moved a great deal
of that. It was fine, but reading one caller by hand does not scale, and a
caller that names a renamed route - or the right route by the wrong verb -
fails only when somebody runs it. A wrong method is not a loud failure either:
`server.py` ends both handlers with `self._send(404, "not found")`, at 2344 for
GET and 2857 for POST, so it looks exactly like a missing page.

The pages matter more than the tools here: a tool that breaks wastes a
debugging session, a page that breaks is the app.

Four traps this hit while being written, all worth keeping:

  It passed everything on its first run. `server.py` has
  `if not path.startswith("/api/")` as a guard against static files, and the
  scan collected that as though it were a route prefix - so every path in the
  world matched and the check could not fail.

  It could not read fourteen paths. An f-string like
  f"/api/scenes/{ALL[0]['id']}" carries quotes inside its braces, and the
  extractor stopped at the first one. Interpolations are collapsed before
  paths are pulled out, not after.

  Pointed at `web/`, it reported seven faults that were not faults. The tools
  write their paths whole; the pages build them. `windowctl.js` is handed
  '/api/window' and appends '/close' itself, and `reqpanel.js` posts to
  `/api/requests/${which}`. Hence the two weaker rules in `is_served`.

  Then it reported one method fault that was not one either: `canvas.js` calls
  fetch('/api/components/' + id + '/open'), and stripping the trailing slash
  off that base leaves `/api/components`, which really is GET-only. A literal
  ending in "/" is a base, and is counted as such rather than as a path.

What it does not see, so a pass is not proof of everything: under the two
weaker rules, a renamed sibling - if `/api/requests/approve` became
`/api/requests/allow`, `reqpanel.js` would still match through
`/api/requests/recent`. And the method classifier knows only the verbs this
codebase uses today; a new helper name would leave its calls unclassified
rather than wrong, which is why the floor below counts *classified* calls.
"""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.dirname(HERE)
SERVER = os.path.join(DECK, "server.py")

REF = re.compile(r'''["'`](/api/[^"'`\s]*)''')
SOURCES = {"web": (".js", ".html"), "tools": (".py", ".js", ".sh", ".ps1")}
# Seen today: 113 distinct paths under web/, 72 under tools/, 651 classified
# call sites. A scan that suddenly sees a handful has lost its way.
FLOORS = {"web": 90, "tools": 60}
CLASSIFIED_FLOOR = 600

# Not a call: a mock matching on a path, an assertion about one, an <img src>,
# a base being assigned. These are counted apart, never guessed at.
NOTCALL = re.compile(r'===|\.includes\(|pathname|const API =|\bstartsWith\('
                     r'|src=|thumb:|\?\s*`/api|:\s*`/api')


def _split_routes():
    """Routes as the server actually files them: GET ones live in do_GET, POST
    ones in do_POST, and four paths are served by both."""
    with open(SERVER, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    src = "\n".join(lines)
    g0 = next(i for i, l in enumerate(lines, 1) if re.match(r'\s*def do_GET\(', l))
    p0 = next(i for i, l in enumerate(lines, 1) if re.match(r'\s*def do_POST\(', l))

    def between(lo, hi):
        lits, routers = set(), []
        for i, line in enumerate(lines, 1):
            if lo <= i < hi:
                lits |= set(re.findall(r'path == "(/api/[^"]*)"', line))
                routers += re.findall(r're\.match\(r"(\^[^"]*)"', line)
        return lits, [re.compile(r) for r in routers]

    get_l, get_r = between(g0, p0)
    post_l, post_r = between(p0, len(lines) + 1)
    for m in re.finditer(r'path in \(([^)]*?)\)', src, re.S):
        at = src[:m.start()].count("\n") + 1
        (get_l if at < p0 else post_l).update(re.findall(r'"(/api/[^"]*)"', m.group(1)))
    # "/api/" itself is the static-file guard, not a route. Kept, it matches
    # every path there is and this whole file passes for nothing.
    raw = set(re.findall(r'path\.startswith\("(/api/[^"]*)"', src))
    prefixes = tuple(sorted(p for p in raw if p.rstrip("/") != "/api"))
    return {"GET": (get_l, get_r, prefixes), "POST": (post_l, post_r, prefixes),
            "ANY": (get_l | post_l, get_r + post_r, prefixes)}


def is_served(path, routes):
    literals, routers, prefixes = routes
    probe = path.replace("<id>", "x")
    if probe in literals or path in literals:
        return True
    if any(r.match(probe) for r in routers):
        return True
    if prefixes and probe.startswith(prefixes):
        return True
    # A base its caller appends to: windowctl.js is given '/api/window'.
    if any(l.startswith(path + "/") for l in literals):
        return True
    if any(r.match(path + "/x") for r in routers):
        return True
    # An interpolated segment: post(`/api/requests/${which}`).
    if "<id>" in path:
        pattern = "^" + "/".join(r"[^/]+" if seg == "<id>" else re.escape(seg)
                                 for seg in path.split("/")) + "$"
        if any(re.match(pattern, l) for l in literals):
            return True
    return False


def collapse(line):
    line = re.sub(r'\$\{[^{}]*\}', 'IDID', line)
    return re.sub(r'\{[^{}]*\}', 'IDID', line)


def normalise(path):
    """Returns (path, is_base). A literal ending in "/" is a base a caller
    appends to, not a path anybody requests."""
    path = path.split("?")[0].split("#")[0]
    base = path.endswith("/")
    segs = path.rstrip("/").split("/")
    return "/".join("<id>" if "IDID" in s else s for s in segs), base


def method_of(line, window):
    """The verb this call uses, or None. None is reported, never assumed - a
    default would invent GETs for every helper this list has not met."""
    if re.search(r'method:\s*[\'"]POST', window) or re.search(r'method="POST"', window):
        return "POST"
    if re.search(r'sendBeacon\s*\(', line):
        return "POST"                                  # always a POST
    if re.search(r'new EventSource\s*\(', line):
        return "GET"                                   # SSE is a GET
    if re.search(r'Invoke-WebRequest|Invoke-RestMethod', window):
        return "GET"
    if re.search(r'\bpost\w*\s*\(', line):
        return "POST"
    if re.search(r'\b(getJSON|getJ|ask)\s*\(', line):
        return "GET"
    if re.search(r'\bfetch\s*\(', line):
        return "GET"
    if re.search(r'urlopen\s*\(', line):
        return "GET"
    if re.search(r'\bget\s*\(\s*f?[\'"`]/api', line):
        return "GET"
    return None


def scan(folder):
    """Every /api reference under a tree, sorted into what it actually is."""
    root = os.path.join(DECK, folder)
    out = {"paths": {}, "calls": [], "unclassified": [], "notcall": 0, "bases": 0}
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in sorted(files):
            if not name.endswith(SOURCES[folder]):
                continue
            full = os.path.join(dirpath, name)
            with open(full, encoding="utf-8", errors="replace") as fh:
                lines = fh.read().splitlines()
            for i, line in enumerate(lines):
                if line.strip().startswith(("//", "*", "/*", "#", "<!--")):
                    continue                      # prose, including this rule's own
                hits = REF.findall(collapse(line))
                if not hits:
                    continue
                where = f"{os.path.relpath(full, DECK)}:{i + 1}".replace("\\", "/")
                if NOTCALL.search(line):
                    out["notcall"] += len(hits)
                    continue
                verb = method_of(line, "\n".join(lines[i:i + 4]))
                for hit in hits:
                    path, base = normalise(hit)
                    if base:
                        out["bases"] += 1
                        continue
                    out["paths"].setdefault(path, []).append(where)
                    if verb is None:
                        out["unclassified"].append(f"{path}  {where}")
                    else:
                        out["calls"].append((path, verb, where))
    return out


class CallersNameEndpointsThatExist(unittest.TestCase):
    def test_every_endpoint_the_shipped_pages_call_is_served(self):
        """web/ first: a page naming a dead route is the app being broken, not
        a test being broken."""
        routes = _split_routes()["ANY"]
        wrong = [f"{p}  <- {', '.join(sorted(set(w))[:3])}"
                 for p, w in sorted(scan("web")["paths"].items()) if not is_served(p, routes)]
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))

    def test_every_endpoint_a_tool_calls_is_served(self):
        routes = _split_routes()["ANY"]
        wrong = [f"{p}  <- {', '.join(sorted(set(w))[:3])}"
                 for p, w in sorted(scan("tools")["paths"].items()) if not is_served(p, routes)]
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))

    def test_no_caller_uses_the_wrong_method(self):
        """A GET to a POST-only route answers 404, the same as a route that is
        not there at all, so this fails the same way a typo would."""
        routes = _split_routes()
        wrong = []
        for folder in SOURCES:
            for path, verb, where in scan(folder)["calls"]:
                if is_served(path, routes[verb]):
                    continue
                other = "POST" if verb == "GET" else "GET"
                note = "served by " + other if is_served(path, routes[other]) else "not served at all"
                wrong.append(f"{verb} {path}  {where}  <- {note}")
        self.assertEqual(sorted(set(wrong)), [], "\n" + "\n".join(sorted(set(wrong))))

    def test_the_scan_can_actually_fail(self):
        """One control per rule. This scan passed everything on its first run
        because a static-file guard was read as a route prefix; the weaker
        rules added since could go the same way in silence."""
        routes = _split_routes()
        for path, rule in (("/api/definitely-not-a-route-xyz", "exact, router or prefix"),
                           ("/api/nope", "the base rule"),
                           ("/api/nope/<id>", "the wildcard rule")):
            self.assertFalse(is_served(path, routes["ANY"]),
                             f"{path} is reported served, so {rule} cannot report a miss")
        # And the method split: a POST-only route must not look GET-reachable.
        self.assertTrue(is_served("/api/live/start", routes["POST"]))
        self.assertFalse(is_served("/api/live/start", routes["GET"]),
                         "a POST-only route looks reachable by GET, so the method test cannot fail")

    def test_the_scan_actually_looked(self):
        """The other way a green can be empty: seeing almost nothing. The
        classified floor matters most - an unmet helper name costs coverage
        without costing a failure."""
        classified = 0
        for folder, floor in FLOORS.items():
            found = scan(folder)
            seen = len(found["paths"])
            classified += len(found["calls"])
            self.assertGreaterEqual(
                seen, floor,
                f"only {seen} distinct paths found under {folder}/, below the {floor} floor - "
                "the extractor stopped working rather than the callers stopping calling")
        self.assertGreaterEqual(
            classified, CLASSIFIED_FLOOR,
            f"only {classified} calls could be given a method, below the {CLASSIFIED_FLOOR} "
            "floor - method_of has fallen behind the helpers in use")


if __name__ == "__main__":
    unittest.main()
