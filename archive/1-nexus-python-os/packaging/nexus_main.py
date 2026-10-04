"""PyInstaller entry point for the packaged Nexus.exe.

Launches the native desktop window. Kept minimal so PyInstaller's import
analysis starts from a clean, explicit root.
"""

from nexus.interface.desktop.app import run

if __name__ == "__main__":
    run()
