"""Standalone memory check of the native audio mixer: mic + loopback ->
AAC into a fake engine for N minutes, this process's working set logged
every 30 s.

    python audiomem.py <minutes>
"""
import ctypes
import os
import sys
import time

S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(S, "testrig"))
import audio  # noqa: E402

minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 4
LOG = open(os.path.join(S, "live", "audiomem.log"), "w", buffering=1)


def say(*a):
    line = " ".join(str(x) for x in a)
    print(line, flush=True)
    LOG.write(line + "\n")


class _PMC(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_uint32), ("PageFaultCount", ctypes.c_uint32)] + \
        [(n, ctypes.c_size_t) for n in ("PeakWorkingSet", "WorkingSet", "QPeakPaged", "QPaged",
                                        "QPeakNonPaged", "QNonPaged", "Pagefile", "PeakPagefile")]


def working_set_mb():
    pmc = _PMC(); pmc.cb = ctypes.sizeof(_PMC)
    f = ctypes.windll.psapi.GetProcessMemoryInfo
    f.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32]
    f(ctypes.c_void_p(-1), ctypes.byref(pmc), pmc.cb)
    return round(pmc.WorkingSet / 1048576, 1), round(pmc.Pagefile / 1048576, 1)


class FakeEngine:
    def __init__(self):
        self.t0 = time.monotonic()
        self.n = 0
        self.bytes = 0

    def clock_ms(self):
        return int((time.monotonic() - self.t0) * 1000)

    def push(self, kind, ts, flags, payload):
        self.n += 1
        self.bytes += len(payload)


eng = FakeEngine()
mix = audio.AudioMixer(eng, mic=True, system=True, log=say)
mix.start()
time.sleep(5)
say("status:", mix.status())
t0 = time.time()
say("{:>5} {:>7} {:>8} {:>7} {:>7}".format("min", "ws MB", "priv MB", "frames", "drop"))
while time.time() - t0 < minutes * 60:
    time.sleep(30)
    ws, pv = working_set_mb()
    say("{:>5.1f} {:>7} {:>8} {:>7} {:>7}".format((time.time() - t0) / 60, ws, pv, mix.frames, mix.dropped))
mix.stop()
say("stopped:", mix.status(), "pushed", eng.n, "bytes", eng.bytes)
time.sleep(2)
say("after stop:", working_set_mb())
