# PyInstaller spec for Nexus.exe (native desktop app).
# Build from the repo root:  pyinstaller packaging/Nexus.spec
#
# Produces dist/Nexus/Nexus.exe (onedir: fast startup, reliable bundling).

import os

from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# Paths in a spec resolve relative to the spec file, so anchor everything to the
# repo root (the parent of this packaging/ directory). SPECPATH is the absolute
# directory that contains this spec.
ROOT = os.path.dirname(SPECPATH)

# Bundle the shipped config (agent YAML + prompts) and the logo assets so the
# packaged app finds them via paths.package_root() (which honors sys._MEIPASS).
datas = [
    (os.path.join(ROOT, "config"), "config"),
    (os.path.join(ROOT, "assets"), "assets"),
]
binaries = []
hiddenimports = []

# Pull in everything for the trickier runtime deps.
for pkg in ("webview", "uvicorn", "fastapi", "starlette", "anyio", "sounddevice",
            "speech_recognition"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

hiddenimports += collect_submodules("uvicorn")
# Bundle all of nexus, including modules imported lazily inside functions
# (e.g. nexus.speech.*), which PyInstaller's static analysis can miss.
hiddenimports += collect_submodules("nexus")
hiddenimports += ["clr"]  # pythonnet, used by the pywebview Windows backend
# Windows SAPI text-to-speech (server-side /api/speak) via pywin32.
hiddenimports += ["win32com", "win32com.client", "pythoncom", "pywintypes"]
hiddenimports += ["_cffi_backend"]  # sounddevice uses cffi


a = Analysis(
    [os.path.join(ROOT, "packaging", "nexus_main.py")],
    pathex=[os.path.join(ROOT, "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PIL"],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Nexus",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,                 # windowed app: no console
    icon=os.path.join(ROOT, "assets", "nexus.ico"),
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="Nexus",
)
