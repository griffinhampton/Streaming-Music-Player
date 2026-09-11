"""Keep the display on while capture tests run (WGC only delivers frames
while DWM composes, and DWM stops when the screen is off). Holds
ES_DISPLAY_REQUIRED for <minutes>, then lets the display time out again."""
import ctypes, sys, time
minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 180
k = ctypes.windll.kernel32; u = ctypes.windll.user32
ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED = 0x80000000, 0x00000001, 0x00000002
k.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
u.SendMessageW(0xFFFF, 0x0112, 0xF170, -1)          # WM_SYSCOMMAND SC_MONITORPOWER on
t0 = time.time()
while time.time() - t0 < minutes * 60:
    k.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
    time.sleep(30)
k.SetThreadExecutionState(ES_CONTINUOUS)
