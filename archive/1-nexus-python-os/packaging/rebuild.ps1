# Clean rebuild + reinstall of Nexus.exe.
# ALWAYS use --clean: PyInstaller's incremental cache can otherwise ship stale
# modules into the exe even after source changes.
#
#   powershell -ExecutionPolicy Bypass -File packaging\rebuild.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host "Stopping any running Nexus..."
Get-Process -Name Nexus -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

Write-Host "Clean rebuild (cache wiped)..."
& "$repo\.venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean `
    --distpath "$repo\dist" --workpath "$repo\build\pyi" "$repo\packaging\Nexus.spec"

Write-Host "Installing..."
& powershell -NoProfile -ExecutionPolicy Bypass -File "$repo\packaging\install.ps1"
Write-Host "Done."
