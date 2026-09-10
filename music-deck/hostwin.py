"""
A borderless host window that Chrome gets tucked inside.

Chrome draws its own title bar as part of its client area, so no amount of
Win32 style-stripping removes it - and a capture source would grab that bar
along with the overlay. So we make our own frameless window, reparent Chrome
into it, and shift Chrome up and left until only its web viewport lines up with
our client area. The title bar still exists; it just lives outside the window
that TikTok Studio captures.

Everything here is ctypes against user32 - no packages.
"""

import ctypes
import os
import threading
from ctypes import wintypes

import paths

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_CHILD = 0x40000000
WS_CLIPCHILDREN = 0x02000000
WS_CLIPSIBLINGS = 0x04000000
WS_EX_APPWINDOW = 0x00040000

SW_HIDE = 0
SW_SHOW = 5
WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_SIZE = 0x0005
WM_ERASEBKGND = 0x0014
GWL_STYLE = -16

HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010

WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, ctypes.c_uint,
                             wintypes.WPARAM, wintypes.LPARAM)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint),
        ("style", ctypes.c_uint),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", wintypes.HICON),
    ]


user32.DefWindowProcW.restype = ctypes.c_ssize_t
user32.DefWindowProcW.argtypes = [wintypes.HWND, ctypes.c_uint,
                                  wintypes.WPARAM, wintypes.LPARAM]
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
user32.SetParent.restype = wintypes.HWND
user32.SetParent.argtypes = [wintypes.HWND, wintypes.HWND]

# Handles are pointer-sized. Without these, ctypes assumes a C int return and
# lops the top half off every handle on 64-bit Windows.
user32.LoadImageW.restype = wintypes.HANDLE
user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
                              ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.SendMessageW.restype = ctypes.c_ssize_t
user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT,
                                wintypes.WPARAM, wintypes.LPARAM]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.GetSystemMetrics.argtypes = [ctypes.c_int]

_set_long = getattr(user32, "SetWindowLongPtrW", user32.SetWindowLongW)
_set_long.restype = ctypes.c_ssize_t
_set_long.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]

CLASS_NAME = "MusicDeckOverlayHost"

WM_SETICON = 0x0080
ICON_SMALL, ICON_BIG = 0, 1
_ICON_CACHE = None


def _load_icons():
    """The app icon as (big, small) HICONs, loaded once.

    LoadImage picks the frame nearest the size asked for, which is why the .ico
    ships several: a 16px title-bar icon scaled down from 256 looks like mud.
    Returns (None, None) if the file is missing, which just leaves the default.
    """
    global _ICON_CACHE
    if _ICON_CACHE is not None:
        return _ICON_CACHE
    path = paths.resource("music-deck.ico")
    big = small = None
    try:
        if os.path.isfile(path):
            cx = user32.GetSystemMetrics(11), user32.GetSystemMetrics(12)   # SM_CXICON/CYICON
            sm = user32.GetSystemMetrics(49), user32.GetSystemMetrics(50)   # SM_CXSMICON/CYSMICON
            big = user32.LoadImageW(None, path, 1, cx[0], cx[1], 0x00000010)   # IMAGE_ICON, LR_LOADFROMFILE
            small = user32.LoadImageW(None, path, 1, sm[0], sm[1], 0x00000010)
    except Exception:
        pass
    _ICON_CACHE = (big, small)
    return _ICON_CACHE

_ENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def viewport_rect(chrome_hwnd):
    """Screen rect of Chrome's web content: the largest render-widget child
    under the browser window. This is where the page really is, whatever the
    frame around it is doing."""
    best = {}

    def cb(h, _l):
        cls = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(h, cls, 64)
        if cls.value == "Chrome_RenderWidgetHostHWND":
            r = wintypes.RECT()
            user32.GetWindowRect(wintypes.HWND(h), ctypes.byref(r))
            area = (r.right - r.left) * (r.bottom - r.top)
            if area > best.get("area", -1):
                best.update(area=area, x=r.left, y=r.top,
                            w=r.right - r.left, h=r.bottom - r.top)
        return True

    user32.EnumChildWindows(wintypes.HWND(chrome_hwnd), _ENUMPROC(cb), 0)
    return best if best.get("w", 0) >= 10 else None


class HostWindow:
    """Frameless window that owns the Chrome overlay window."""

    def __init__(self, title):
        self.title = title
        self.hwnd = None
        self.child = None
        self._offset = (0, 0)       # where Chrome sits relative to our client area
        self._child_size = (0, 0)
        self._ready = threading.Event()
        self._proc = None           # keep the callback alive
        self._thread = None
        self._closed_cb = None
        self._frame = None          # Chrome outer size minus its viewport
        self._align_timer = None
        # 2px, not 1: Chrome can leave its outermost row and column unpainted,
        # and this keeps that artifact outside the host window entirely.
        self.margin = 2             # viewport overhang past every edge, px
        self._brush = None
        self._backdrop = 0x000000   # COLORREF (BGR), repainted on demand

    # ------------------------------------------------------------- lifecycle

    def start(self, x, y, w, h, on_closed=None):
        self._closed_cb = on_closed
        self._thread = threading.Thread(
            target=self._run, args=(x, y, w, h), daemon=True)
        self._thread.start()
        return self._ready.wait(5)

    def _wndproc(self, hwnd, msg, wparam, lparam):
        if msg == WM_ERASEBKGND:
            # Paint the sliver Chrome leaves bare in the chosen margin colour.
            rect = wintypes.RECT()
            user32.GetClientRect(hwnd, ctypes.byref(rect))
            if not self._brush:
                self._brush = gdi32.CreateSolidBrush(self._backdrop)
            user32.FillRect(wintypes.HDC(wparam), ctypes.byref(rect), self._brush)
            return 1
        if msg == WM_SIZE and self.child:
            # However the host came to be resized, Chrome has to follow.
            self.schedule_align(0.12)
        if msg == WM_CLOSE:
            if self.child:
                user32.PostMessageW(wintypes.HWND(self.child), WM_CLOSE, 0, 0)
            user32.DestroyWindow(wintypes.HWND(hwnd))
            return 0
        if msg == WM_DESTROY:
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _run(self, x, y, w, h):
        hinst = kernel32.GetModuleHandleW(None)
        self._proc = WNDPROC(self._wndproc)

        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.style = 0x0002 | 0x0001          # CS_HREDRAW | CS_VREDRAW
        wc.lpfnWndProc = self._proc
        wc.hInstance = hinst
        wc.hCursor = user32.LoadCursorW(None, 32512)   # IDC_ARROW
        wc.hbrBackground = gdi32.CreateSolidBrush(0x000000)
        wc.lpszClassName = CLASS_NAME
        # The host window is a bare popup with no frame, but Windows still uses
        # its icon in the taskbar and in Alt-Tab, and TikTok Studio shows it in
        # the window picker - so it is worth setting properly.
        icon_big, icon_small = _load_icons()
        wc.hIcon = icon_big
        wc.hIconSm = icon_small
        user32.RegisterClassExW(ctypes.byref(wc))      # harmless if already there

        self.hwnd = user32.CreateWindowExW(
            WS_EX_APPWINDOW, CLASS_NAME, self.title,
            WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN,
            int(x), int(y), int(w), int(h),
            None, None, hinst, None)
        if self.hwnd and (icon_big or icon_small):
            # RegisterClassExW is a no-op if the class already exists from an
            # earlier window, and it would keep that first icon. WM_SETICON is
            # per-window, so it works however many times we have been here.
            user32.SendMessageW(self.hwnd, WM_SETICON, ICON_BIG, icon_big or icon_small)
            user32.SendMessageW(self.hwnd, WM_SETICON, ICON_SMALL, icon_small or icon_big)
        self._ready.set()
        if not self.hwnd:
            return

        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

        self.hwnd = None
        self.child = None
        if self._closed_cb:
            try:
                self._closed_cb()
            except Exception:
                pass

    def alive(self):
        return bool(self.hwnd and user32.IsWindow(wintypes.HWND(self.hwnd)))

    def close(self):
        if self.alive():
            user32.PostMessageW(wintypes.HWND(self.hwnd), WM_CLOSE, 0, 0)

    # ------------------------------------------------------------- adoption

    def adopt(self, child_hwnd, offset_x, offset_y, child_w, child_h):
        """Pull Chrome inside and slide its chrome-junk out of view."""
        if not self.alive() or not child_hwnd:
            return False
        child = wintypes.HWND(child_hwnd)

        # A child window must not carry popup/frame styles.
        style = (WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN)
        _set_long(child, GWL_STYLE, style)
        if not user32.SetParent(child, wintypes.HWND(self.hwnd)):
            return False

        self.child = child_hwnd
        self._offset = (offset_x, offset_y)
        self._child_size = (child_w, child_h)
        user32.MoveWindow(child, -int(offset_x), -int(offset_y),
                          int(child_w), int(child_h), True)
        user32.ShowWindow(child, SW_SHOW)
        return True

    def resize_content(self, w, h, child_w=None, child_h=None):
        """Set the visible overlay size; Chrome is resized to match underneath.

        Once the viewport has been measured (align_child), Chrome's outer size
        follows from that measurement; before then the caller's estimate is
        used. Either way an alignment pass runs once Chrome has settled.
        """
        if not self.alive():
            return False
        ox, oy = self._offset
        user32.SetWindowPos(wintypes.HWND(self.hwnd), None, 0, 0,
                            int(w), int(h), SWP_NOMOVE | SWP_NOACTIVATE)
        if self.child:
            if self._frame:
                cw = int(w + 2 * self.margin + self._frame[0])
                ch = int(h + 2 * self.margin + self._frame[1])
            else:
                cw = int(child_w) if child_w else int(w + ox * 2)
                ch = int(child_h) if child_h else int(h + oy + ox)
            user32.MoveWindow(wintypes.HWND(self.child), -int(ox), -int(oy), cw, ch, True)
            self._child_size = (cw, ch)
            self.schedule_align()
        return True

    def align_child(self):
        """Put Chrome's viewport exactly over our client area.

        Size is arithmetic: host + overhang + the frame measured once at
        adoption. A live reading is only ever allowed to nudge the *position*
        by a few pixels, because Chrome reports nonsense sizes while it is
        re-laying out and trusting those readings is what used to corrupt the
        window when a theme changed.
        """
        if not self.alive() or not self.child:
            return False
        host = self.rect()
        if not host:
            return False
        m = self.margin
        want_w, want_h = host["w"] + 2 * m, host["h"] + 2 * m

        self._force_child_size(want_w, want_h)

        vp = viewport_rect(self.child)
        if vp and abs(want_w - vp["w"]) <= 4 and abs(want_h - vp["h"]) <= 4:
            dx = (host["x"] - m) - vp["x"]
            dy = (host["y"] - m) - vp["y"]
            if (dx or dy) and abs(dx) <= 60 and abs(dy) <= 60:
                ox, oy = self._offset
                self._offset = (ox - dx, oy - dy)
                cw, ch = self._child_size
                user32.MoveWindow(wintypes.HWND(self.child), -int(ox - dx), -int(oy - dy),
                                  int(cw), int(ch), True)
        return True

    def _force_child_size(self, want_w, want_h):
        """Size Chrome from the frame measured at adoption, never from a reading."""
        frame = self._frame or (16, 80)
        ox, oy = self._offset
        cw, ch = int(want_w + frame[0]), int(want_h + frame[1])
        if (cw, ch) != self._child_size:
            self._child_size = (cw, ch)
            user32.MoveWindow(wintypes.HWND(self.child), -int(ox), -int(oy), cw, ch, True)

    def learn_frame(self):
        """Measure Chrome's frame once, while the page is known to be settled."""
        if not self.alive() or not self.child:
            return False
        host, vp = self.rect(), viewport_rect(self.child)
        if not host or not vp or vp["w"] < 40 or vp["h"] < 40:
            return False
        cw, ch = self._child_size
        m = self.margin
        self._frame = (cw - vp["w"], ch - vp["h"])
        self._offset = (host["x"] - m - vp["x"] + self._offset[0],
                        host["y"] - m - vp["y"] + self._offset[1])
        return True

    def set_backdrop(self, hex_color):
        """Colour behind Chrome, given as #rrggbb."""
        try:
            n = int((hex_color or "#000000").lstrip("#"), 16)
        except ValueError:
            n = 0
        # Win32 wants BGR, CSS gives RGB.
        colorref = ((n & 0xFF) << 16) | (n & 0xFF00) | ((n >> 16) & 0xFF)
        if colorref == self._backdrop and self._brush:
            return
        self._backdrop = colorref
        old, self._brush = self._brush, gdi32.CreateSolidBrush(colorref)
        if old:
            gdi32.DeleteObject(old)
        if self.alive():
            user32.InvalidateRect(wintypes.HWND(self.hwnd), None, True)

    def aligned(self):
        """Is Chrome's viewport still covering the host exactly?"""
        if not self.alive() or not self.child:
            return True
        host, vp = self.rect(), viewport_rect(self.child)
        if not host or not vp:
            return True
        m = self.margin
        return (abs((host["x"] - m) - vp["x"]) <= 1 and abs((host["y"] - m) - vp["y"]) <= 1
                and abs((host["w"] + 2 * m) - vp["w"]) <= 1
                and abs((host["h"] + 2 * m) - vp["h"]) <= 1)

    def schedule_align(self, delay=0.35):
        """Align once Chrome has finished re-laying out (debounced)."""
        if self._align_timer:
            self._align_timer.cancel()
        self._align_timer = threading.Timer(delay, self.align_child)
        self._align_timer.daemon = True
        self._align_timer.start()

    def trim_child(self, dx, dy, dw, dh):
        """Shift Chrome by (dx, dy) and grow it by (dw, dh).

        Used once after adoption: shedding its frame moves Chrome's viewport a
        pixel or two, and this pulls it back into exact alignment.
        """
        if not self.alive() or not self.child:
            return False
        ox, oy = self._offset
        cw, ch = self._child_size
        self._offset = (ox - dx, oy - dy)
        self._child_size = (cw + dw, ch + dh)
        user32.MoveWindow(wintypes.HWND(self.child), -int(ox - dx), -int(oy - dy),
                          int(cw + dw), int(ch + dh), True)
        return True

    # ------------------------------------------------------------- geometry

    def rect(self):
        if not self.alive():
            return None
        r = wintypes.RECT()
        user32.GetWindowRect(wintypes.HWND(self.hwnd), ctypes.byref(r))
        return {"x": r.left, "y": r.top,
                "w": r.right - r.left, "h": r.bottom - r.top}

    def move(self, x, y):
        if not self.alive():
            return False
        user32.SetWindowPos(wintypes.HWND(self.hwnd), None, int(x), int(y), 0, 0,
                            SWP_NOSIZE | SWP_NOACTIVATE)
        return True

    def set_topmost(self, on=True):
        if not self.alive():
            return False
        user32.SetWindowPos(wintypes.HWND(self.hwnd),
                            wintypes.HWND(HWND_TOPMOST if on else HWND_NOTOPMOST),
                            0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
        return True


def chrome_insets(child_hwnd, inner_w, inner_h):
    """How far Chrome's web viewport sits inside its own window.

    Returns (offset_x, offset_y, window_w, window_h): the offset is what we have
    to shift Chrome by so its viewport lands at our client origin.
    """
    r = wintypes.RECT()
    user32.GetWindowRect(wintypes.HWND(child_hwnd), ctypes.byref(r))
    win_w, win_h = r.right - r.left, r.bottom - r.top

    c = wintypes.RECT()
    user32.GetClientRect(wintypes.HWND(child_hwnd), ctypes.byref(c))
    client_w, client_h = c.right - c.left, c.bottom - c.top

    pt = wintypes.POINT(0, 0)
    user32.ClientToScreen(wintypes.HWND(child_hwnd), ctypes.byref(pt))
    border_x = pt.x - r.left
    border_y = pt.y - r.top

    # Whatever the client area has that the viewport does not is Chrome's own
    # title bar (above) and side padding.
    offset_x = border_x + max(0, (client_w - inner_w) // 2)
    offset_y = border_y + max(0, client_h - inner_h)
    return offset_x, offset_y, win_w, win_h
