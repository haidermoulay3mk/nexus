# Installs (or removes) a Windows Startup shortcut for the headless Nexus
# Runner, so daily schedules fire whenever the PC is on — no HUD needed.
#
#   Install:  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   Remove:   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
param([switch]$Remove)

$startup = [Environment]::GetFolderPath("Startup")
$link = Join-Path $startup "Nexus Runner.lnk"

if ($Remove) {
    if (Test-Path $link) { Remove-Item $link; Write-Host "Removed $link" }
    else { Write-Host "No autostart shortcut found." }
    exit 0
}

$repo = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repo "Start Nexus Runner (headless).cmd"
if (-not (Test-Path $target)) { Write-Error "Cannot find $target"; exit 1 }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = $target
$sc.WorkingDirectory = $repo
$sc.WindowStyle = 7  # minimized
$sc.Description = "Nexus Runner (headless) — scheduled sweeps and reports"
$sc.Save()
Write-Host "Installed: $link"
Write-Host "The Runner will start minimized at every login. Remove with -Remove."
