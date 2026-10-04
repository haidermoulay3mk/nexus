"""Native desktop window for Nexus.

Runs the FastAPI server inside the same process (a background thread) and shows
the UI in a native OS window via pywebview / WebView2 — no browser, no second
window. This is what makes Nexus feel like its own app.
"""
