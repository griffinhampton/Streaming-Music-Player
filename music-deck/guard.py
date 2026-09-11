"""
Who may talk to the server: its own pages, and tools on this machine.

It listens on 127.0.0.1 alone, but any web page open in any browser can
still send requests to 127.0.0.1 - and a DNS name pointed at 127.0.0.1
makes them same-origin. So the Host must be this server by its own name
(which defeats DNS rebinding), and an Origin, when a browser sends one,
must be ours (which stops another site's page from posting here - opening
the microphone, say, or quitting). Requests from tools that send no Origin,
like curl, still work. WebSocket upgrades go through the same door.
"""


def trusted(host, origin, port):
    ours = {f"127.0.0.1:{port}", f"localhost:{port}"}
    if (host or "").strip().lower() not in ours:
        return False
    origin = (origin or "").strip().lower()
    return not origin or origin in {f"http://{h}" for h in ours}
