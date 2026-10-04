"""Native Nexus window.

    nexus desktop          # or run the packaged Nexus.exe

Starts uvicorn on a loopback port in a daemon thread, waits for it, then opens a
native window pointed at it. Closing the window stops the server and exits.
"""

from __future__ import annotations

import socket
import threading
import time


def _free_port(preferred: int = 8765) -> int:
    """Use the preferred port if free, else let the OS pick one."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_until_up(host: str, port: int, timeout: float = 20.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            try:
                s.connect((host, port))
                return True
            except OSError:
                time.sleep(0.2)
    return False


def run(host: str = "127.0.0.1", port: int | None = None,
        *, auto_close_after: float | None = None) -> None:
    import uvicorn
    import webview

    from nexus.interface.api.server import create_app

    port = port or _free_port()
    config = uvicorn.Config(create_app(), host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()

    if not _wait_until_up(host, port):
        raise RuntimeError("Nexus engine did not start in time")

    window = webview.create_window(
        "Nexus",
        f"http://{host}:{port}",
        width=1180,
        height=820,
        min_size=(900, 600),
        background_color="#0f1115",
    )

    if auto_close_after:
        def _closer() -> None:
            time.sleep(auto_close_after)
            try:
                window.destroy()
            except Exception:  # noqa: BLE001
                pass
        threading.Thread(target=_closer, daemon=True).start()

    try:
        webview.start()
    finally:
        server.should_exit = True


if __name__ == "__main__":
    run()
