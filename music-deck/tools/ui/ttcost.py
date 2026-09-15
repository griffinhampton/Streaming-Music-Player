"""What the TikTok reader costs this PC on one real public live. Counts only.

    python ttcost.py <username of someone live right now> [seconds] [--pair]

The reader as it ships (TikTokAdapter), headless - the rig's setting; the
user's own window is drawn, so this is its floor, not its ceiling - with a
throwaway profile in a temporary folder that is deleted after, signed out.
After 20 s to settle it measures, for [seconds] (60): the reader's Chrome,
every one of its processes found by the profile in its command line, as CPU
time over wall time per kind of process (the page's renderer, the GPU process,
utility processes, the browser); this Python process, which is only the
reader's thread; and Chrome's memory.

--pair runs a second reader beside it, on the same live at the same moment,
without the reduced-motion request (DECISIONS, "What the reader costs"). A
live's activity changes minute to minute, so only readers side by side can be
compared: two measured one after the other once told a flattering story that
the pairs did not bear out.

Prints a name for neither the live nor anyone in it.
"""

import collections
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import tiktok_chat as tt  # noqa: E402

REDUCED = "prefers-reduced-motion"


def chrome_path():
    for base in ("ProgramFiles", "ProgramFiles(x86)", "LocalAppData"):
        p = os.path.join(os.environ.get(base, ""), "Google", "Chrome", "Application", "chrome.exe")
        if os.environ.get(base) and os.path.isfile(p):
            return p
    return None


def chrome_cost(tag):
    """({kind of process: cpu seconds}, memory MB) for Chrome processes whose
    command line holds `tag` - the reader's own temporary profile."""
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*" + tag
          + "*' } | ForEach-Object { $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'browser' };"
          " Write-Output ('{0} {1} {2}' -f $t, ($_.KernelModeTime + $_.UserModeTime), $_.WorkingSetSize) }")
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True).stdout
    cpu, mem = collections.Counter(), 0.0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 3:
            cpu[parts[0]] += int(parts[1]) / 1e7
            mem += int(parts[2]) / 1048576
    return cpu, mem


def measure(channel, secs, reduced):
    tag = f"asd-ttcost-{os.getpid()}-"
    profile = tempfile.mkdtemp(prefix=tag)
    tt.TikTokAdapter.browser, tt.TikTokAdapter.profile, tt.TikTokAdapter.headless = chrome_path(), profile, True
    tt.TikTokAdapter.on_gift = lambda g: None
    if not reduced:                              # the pair's other half: the reader without it
        real = tt.Cdp.send

        def send(self, method, params=None):
            if method == "Emulation.setEmulatedMedia":
                self.id += 1
                return self.id
            return real(self, method, params)
        tt.Cdp.send = send
    lines = [0]
    a = tt.TikTokAdapter(channel, lambda m: lines.__setitem__(0, lines[0] + 1))
    a.start()
    try:
        time.sleep(20)
        w0, p0, (c0, _m) = time.monotonic(), time.process_time(), chrome_cost(tag)
        l0, f0 = lines[0], a.room.frames
        time.sleep(secs)
        w1, p1, (c1, mem) = time.monotonic(), time.process_time(), chrome_cost(tag)
        st = a.status()
    finally:
        a.stop()
        time.sleep(1)
        shutil.rmtree(profile, ignore_errors=True)
    wall = w1 - w0
    kinds = {k: round((c1[k] - c0.get(k, 0)) / wall * 100, 1) for k in c1}
    chrome = sum(kinds.values())
    return {"reducedMotion": reduced, "seconds": round(wall), "chatFrom": st["page"]["chat_from"],
            "chatLines": lines[0] - l0, "framesDecoded": a.room.frames - f0,
            "chrome_pctOfOneCore": round(chrome, 1), "byProcess_pctOfOneCore": kinds,
            "reader_pctOfOneCore": round((p1 - p0) / wall * 100, 1),
            "pctOfThisPC": round((chrome + (p1 - p0) / wall * 100) / os.cpu_count(), 2),
            "chromeMemoryMB": round(mem)}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    if not chrome_path():
        print("Chrome was not found")
        return 2
    channel = args[0].lstrip("@").lower()
    secs = int(args[1]) if len(args) > 1 else 60
    if "--one-without" in sys.argv:              # the pair's other half, run by --pair
        print(json.dumps(measure(channel, secs, reduced=False)))
        return 0
    other = None
    if "--pair" in sys.argv:
        other = subprocess.Popen([sys.executable, os.path.abspath(__file__), channel, str(secs), "--one-without"],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    print(json.dumps(measure(channel, secs, reduced=True)))
    if other:
        out = other.communicate(timeout=secs + 120)[0].strip().splitlines()
        print(out[-1] if out else "the other reader said nothing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
