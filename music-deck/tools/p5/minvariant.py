"""Rig only: make the testrig copy's Overlay.minimize/restore a real host
minimize again (the pre-P5 behavior), keeping everything else - the page
idle on the minimized flag and the aligned() guard - so the two can be
compared with the screen on."""
import io, os, re
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testrig", "overlay.py")
s = io.open(p, encoding="utf-8").read()
start = s.index("    def minimize(self):")
end = s.index("    def nudge(self, dx, dy):")
s = s[:start] + '''    def minimize(self):
        if self.host and self.host.alive():
            return self.host.minimize()
        hwnd = winwin.find_window(self.page_title)
        if hwnd:
            return winwin.minimize(hwnd)
        return False

    def restore(self):
        if self.host and self.host.alive():
            return self.host.restore()
        hwnd = winwin.find_window(self.page_title)
        if hwnd:
            return winwin.restore(hwnd)
        return False

''' + s[end:]
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("testrig overlay.py: real minimize")
