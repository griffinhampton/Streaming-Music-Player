"""Capture only, 30 Hz polling, no encoder: does the working set grow?
    python memcap.py <title part> <seconds>"""
import ctypes, sys, time
from ctypes import wintypes, byref
sys.path.insert(0, r"C:\Users\ghamp\streaming stuff\music-deck")
import capture

ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
title, seconds = sys.argv[1], float(sys.argv[2])
hwnd = capture.find_window(title)
d3d = capture.D3D()
cap = capture.WindowCapture(d3d, hwnd=hwnd)
cap.start()
t0 = time.perf_counter()
n = 0
while time.perf_counter() - t0 < seconds:
    cap.poll()
    n += 1
    time.sleep(1 / 30)
print(f"polls {n}, frames {cap.frames}")
cap.close()
