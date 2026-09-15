"""The TikTok reader itself - TikTokAdapter, exactly as it ships - on one real
public live. Counts only.

    python ttrealreader.py <username of someone live right now> [seconds]

tools/ui/ttreal.js asks whether the reader's page script still reads TikTok's
page, run in a Chrome of its own. It could not see the fault this was written
after (2026-09-15): the reader launched its Chrome in a way TikTok's page never
enters a room from, so the real reader read nothing on every real live while
that check passed. This runs the real thing - the real launch, the real
DevTools connection, the real gift path - and is the check to believe.

Headless (the rig's setting), muted, a throwaway profile in a temporary folder
that is deleted after, signed out: never your own profile, and it never signs
in. Prints counts and, for a gift, TikTok's catalog facts - its name, the
count, the coins. Never a user or a message. Stops at the first finished gift
(and ten seconds more, for the rest of a streak), or after [seconds] (120).
"""

import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import tiktok_chat as tt  # noqa: E402


def chrome():
    for base in ("ProgramFiles", "ProgramFiles(x86)", "LocalAppData"):
        p = os.path.join(os.environ.get(base, ""), "Google", "Chrome", "Application", "chrome.exe")
        if os.environ.get(base) and os.path.isfile(p):
            return p
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    channel = sys.argv[1].lstrip("@").lower()
    secs = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    browser = chrome()
    if not browser:
        print("Chrome was not found")
        return 2
    profile = tempfile.mkdtemp(prefix="asd-ttreal-")
    tt.TikTokAdapter.browser, tt.TikTokAdapter.profile, tt.TikTokAdapter.headless = browser, profile, True
    gifts, lines = [], [0]
    tt.TikTokAdapter.on_gift = gifts.append
    a = tt.TikTokAdapter(channel, lambda m: lines.__setitem__(0, lines[0] + 1))
    a.start()
    t0 = time.monotonic()
    try:
        while time.monotonic() - t0 < secs and not gifts:
            time.sleep(1)
        if gifts:
            time.sleep(10)
        st, r = a.status(), a.room
        report = {"state": st["state"], "failed": bool(st["error"]), "chatListFound": st["page"]["room"],
                  "signedIn": st["page"]["signed_in"], "roomSocket": st["page"]["socket"], "chatLines": lines[0],
                  "framesDecoded": r.frames, "framesBad": r.bad, "seconds": round(time.monotonic() - t0),
                  "gifts": [{"gift": g["gift"], "count": g["count"], "coins": g["coins"]} for g in gifts]}
    finally:
        a.stop()
        time.sleep(1)
        shutil.rmtree(profile, ignore_errors=True)
    print(json.dumps(report))
    ok = report["roomSocket"] and report["framesDecoded"] > 0 and report["framesBad"] == 0 and \
        (report["chatLines"] > 0 or report["gifts"])
    print("the reader reads this live: the room socket, and chat or a gift" if ok
          else "the reader does NOT read this live - the numbers above say which part")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
