"""
Thin ctypes wrapper over the Win32 calls the Now Playing window needs:
find it by title, strip its frame, pin it on top, move and resize it.

Stripping the frame matters for streaming - TikTok Studio's window capture
grabs the whole window including Chrome's title bar, so a borderless window is
the difference between a clean overlay and a browser chrome sandwich.
"""

import ctypes
from ctypes import wintypes

try:
    user32 = ctypes.windll.user32
    _HAVE_WIN32 = True
except Exception:  # pragma: no cover - non-Windows
    user32 = None
    _HAVE_WIN32 = False

GWL_STYLE = -16
GWL_EXSTYLE = -20

WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000
WS_BORDER = 0x00800000
WS_DLGFRAME = 0x00400000

WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000

FRAME_BITS = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_FRAMECHANGED = 0x0020
SWP_SHOWWINDOW = 0x0040
SWP_NOACTIVATE = 0x0010

HWND_TOP = 0
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2

SW_SHOWMINNOACTIVE = 7
SW_RESTORE = 9
WM_CLOSE = 0x0010

if _HAVE_WIN32:
    _get_long = getattr(user32, "GetWindowLongPtrW", user32.GetWindowLongW)
    _set_long = getattr(user32, "SetWindowLongPtrW", user32.SetWindowLongW)
    _get_long.restype = ctypes.c_ssize_t
    _get_long.argtypes = [wintypes.HWND, ctypes.c_int]
    _set_long.restype = ctypes.c_ssize_t
    _set_long.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]

    _ENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def available():
    return _HAVE_WIN32


# Only ever adopt a window that is actually a browser window. Matching on title
# alone once grabbed an unrelated window that happened to be called the same
# thing, and we do not want to strip the frame off someone else's app.
BROWSER_CLASSES = ("Chrome_WidgetWin_1", "MozillaWindowClass")


def find_window(title, classes=BROWSER_CLASSES):
    """HWND of the first visible browser window with exactly this title."""
    if not _HAVE_WIN32:
        return None
    found = []

    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if buf.value != title:
            return True
        if classes:
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            if cls.value not in classes:
                return True
        found.append(hwnd)
        return False

    try:
        user32.EnumWindows(_ENUMPROC(cb), 0)
    except Exception:
        return None
    return found[0] if found else None


def get_rect(hwnd):
    if not _HAVE_WIN32 or not hwnd:
        return None
    rect = wintypes.RECT()
    if not user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
        return None
    return {"x": rect.left, "y": rect.top,
            "w": rect.right - rect.left, "h": rect.bottom - rect.top}


def set_borderless(hwnd, on=True):
    """Remove (or restore) the title bar and resize frame."""
    if not _HAVE_WIN32 or not hwnd:
        return False
    hwnd = wintypes.HWND(hwnd)
    style = _get_long(hwnd, GWL_STYLE)
    style = (style & ~FRAME_BITS) if on else (style | FRAME_BITS)
    _set_long(hwnd, GWL_STYLE, style)
    user32.SetWindowPos(hwnd, None, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER |
                        SWP_FRAMECHANGED | SWP_NOACTIVATE)
    return True


def set_topmost(hwnd, on=True):
    if not _HAVE_WIN32 or not hwnd:
        return False
    user32.SetWindowPos(wintypes.HWND(hwnd),
                        wintypes.HWND(HWND_TOPMOST if on else HWND_NOTOPMOST),
                        0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    return True


def move_resize(hwnd, x=None, y=None, w=None, h=None):
    if not _HAVE_WIN32 or not hwnd:
        return False
    rect = get_rect(hwnd) or {"x": 0, "y": 0, "w": 800, "h": 200}
    x = rect["x"] if x is None else int(x)
    y = rect["y"] if y is None else int(y)
    w = rect["w"] if w is None else max(120, int(w))
    h = rect["h"] if h is None else max(60, int(h))
    user32.SetWindowPos(wintypes.HWND(hwnd), None, x, y, w, h,
                        SWP_NOZORDER | SWP_NOACTIVATE)
    return True


def nudge(hwnd, dx, dy):
    rect = get_rect(hwnd)
    if not rect:
        return False
    return move_resize(hwnd, rect["x"] + int(dx), rect["y"] + int(dy))


def close_window(hwnd):
    if not _HAVE_WIN32 or not hwnd:
        return False
    user32.PostMessageW(wintypes.HWND(hwnd), WM_CLOSE, 0, 0)
    return True


def is_minimized(hwnd):
    """Minimized windows report where Windows parks them (-32000, -32000),
    not their real place and size, so callers need to know."""
    if not _HAVE_WIN32 or not hwnd:
        return False
    return bool(user32.IsIconic(wintypes.HWND(hwnd)))


def minimize(hwnd):
    """Minimize without activating, so focus never leaves the deck mid-stream."""
    if not _HAVE_WIN32 or not hwnd:
        return False
    user32.ShowWindow(wintypes.HWND(hwnd), SW_SHOWMINNOACTIVE)
    return True


def restore(hwnd):
    if not _HAVE_WIN32 or not hwnd:
        return False
    user32.ShowWindow(wintypes.HWND(hwnd), SW_RESTORE)
    return True


def focus(hwnd):
    if not _HAVE_WIN32 or not hwnd:
        return False
    user32.ShowWindow(wintypes.HWND(hwnd), SW_RESTORE)
    user32.SetForegroundWindow(wintypes.HWND(hwnd))
    return True


def make_dpi_aware():
    """Must run before any window exists.

    Without this, Windows virtualises every coordinate we pass and hands back
    scaled numbers, while Chrome (launched with --force-device-scale-factor=1)
    works in real pixels. Mixing the two puts the overlay in the wrong place and
    at the wrong size on any display that is not at 100%.
    """
    if not _HAVE_WIN32:
        return False
    try:  # per-monitor v2, the modern one
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return True
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return True
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
        return True
    except Exception:
        return False


def screen_size():
    if not _HAVE_WIN32:
        return (1920, 1080)
    return (user32.GetSystemMetrics(0), user32.GetSystemMetrics(1))
