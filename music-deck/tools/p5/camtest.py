"""Standalone camera check: list devices, open one, read frames for a few
seconds and upload them into a texture; then read the texture back."""
import ctypes, sys, time, os
sys.path.insert(0, r"C:\Users\ghamp\streaming stuff\music-deck")
import capture, camera
hint = sys.argv[1] if len(sys.argv) > 1 else "IR"
print("cameras:", camera.list_cameras())
d3d = capture.D3D()
t0 = time.time()
cam = camera.Camera(d3d, hint=hint, width=640, height=480, fps=30, log=print)
print(f"opened in {time.time() - t0:.2f}s:", cam.status(), "stride", cam.stride)
ups = 0
t0 = time.time()
while time.time() - t0 < 4:
    if cam.upload():
        ups += 1
    time.sleep(1 / 30)
print(f"uploads {ups} in 4 s ({ups / 4:.1f}/s), frames {cam.frames}, error {cam.error!r}")
# read the Y plane back through a staging copy to see real picture data
stage = d3d.texture(cam.width, cam.height, bind=0, usage=3, cpu=0x20000, fmt=capture.DXGI_FORMAT_NV12)
d3d.copy(stage, cam.texture)
m = capture.MAPPED()
capture.check(capture.vcall(d3d.context, 14, ctypes.c_int32, [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int32, ctypes.c_uint, ctypes.POINTER(capture.MAPPED)], stage, 0, 1, 0, ctypes.byref(m)), "Map")
y = ctypes.string_at(m.pData, m.RowPitch * cam.height)
capture.vcall(d3d.context, 15, None, [ctypes.c_void_p, ctypes.c_uint], stage, 0)
vals = y[::97]
print("Y plane sample: min", min(vals), "max", max(vals), "mean", round(sum(vals) / len(vals), 1))
cam.close()
print("closed")
