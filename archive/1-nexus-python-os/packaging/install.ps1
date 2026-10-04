# Installs the built Nexus app for the current user:
#   - copies dist\Nexus -> %LOCALAPPDATA%\Programs\Nexus
#   - creates Start Menu + Desktop shortcuts (with the Nexus icon)
#   - registers an entry in Settings > Apps > Installed apps (with uninstall)
#
# Run after building:  pyinstaller packaging\Nexus.spec ; powershell -File packaging\install.ps1

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $repo 'dist\Nexus'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Nexus'
$exe  = Join-Path $dest 'Nexus.exe'

if (-not (Test-Path (Join-Path $src 'Nexus.exe'))) {
    throw "Build not found at $src. Run: pyinstaller packaging\Nexus.spec"
}

Write-Host "Closing any running Nexus..."
Stop-Process -Name Nexus -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

Write-Host "Installing to $dest ..."
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item (Join-Path $src '*') $dest -Recurse -Force

# --- write the uninstaller -----------------------------------------------------
$uninstall = Join-Path $dest 'uninstall.ps1'
@'
$ErrorActionPreference = "SilentlyContinue"
Stop-Process -Name Nexus -Force
$ws = New-Object -ComObject WScript.Shell
foreach ($p in @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Nexus.lnk"),
    (Join-Path "$env:USERPROFILE\Desktop" "Nexus.lnk"),
    (Join-Path "$env:OneDrive\Desktop" "Nexus.lnk"),
    (Join-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" "Nexus.lnk")
)) { Remove-Item $p -Force }
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nexus" -Recurse -Force
$dest = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Process powershell -WindowStyle Hidden -ArgumentList ("-Command `"Start-Sleep 2; Remove-Item '$dest' -Recurse -Force`"")
'@ | Set-Content -Path $uninstall -Encoding UTF8

# --- shortcuts -----------------------------------------------------------------
$ws = New-Object -ComObject WScript.Shell
$links = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nexus.lnk'),
    (Join-Path "$env:USERPROFILE\Desktop" 'Nexus.lnk'),
    (Join-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" 'Nexus.lnk')
) | Select-Object -Unique
foreach ($lnkPath in $links) {
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $dest
    $lnk.IconLocation = "$exe,0"
    $lnk.Description = 'Nexus - personal AI'
    $lnk.Save()
    Write-Host "  shortcut: $lnkPath"
}

# --- Installed apps entry ------------------------------------------------------
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nexus'
New-Item -Path $key -Force | Out-Null
$size = [int]((Get-ChildItem $dest -Recurse | Measure-Object -Property Length -Sum).Sum / 1024)
Set-ItemProperty $key 'DisplayName'     'Nexus'
Set-ItemProperty $key 'DisplayVersion'  '0.1.0'
Set-ItemProperty $key 'Publisher'       'Haidar'
Set-ItemProperty $key 'DisplayIcon'     $exe
Set-ItemProperty $key 'InstallLocation' $dest
Set-ItemProperty $key 'EstimatedSize'   $size -Type DWord
Set-ItemProperty $key 'NoModify'        1 -Type DWord
Set-ItemProperty $key 'NoRepair'        1 -Type DWord
Set-ItemProperty $key 'UninstallString' ('powershell -ExecutionPolicy Bypass -File "' + $uninstall + '"')

Write-Host ""
Write-Host "Nexus installed. Find it in the Start menu, on your Desktop, and in"
Write-Host "Settings > Apps > Installed apps."
