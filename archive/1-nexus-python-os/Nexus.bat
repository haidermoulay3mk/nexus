@echo off
title Nexus
cd /d "%~dp0"

rem 1) Start the Nexus engine (local server) in a minimized window.
start "Nexus engine" /min ".venv\Scripts\python.exe" -m nexus.interface.cli.main dashboard

rem 2) Give the engine a moment to come up.
timeout /t 3 >nul

set "URL=http://127.0.0.1:8765"
set "PROFILE=%LOCALAPPDATA%\Nexus\appwindow"
set "EDGE1=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "EDGE2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "CHROME1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

rem 3) Open Nexus as its OWN app window (no tabs, no address bar).
if exist "%EDGE1%"   ( start "" "%EDGE1%"   --app=%URL% --user-data-dir="%PROFILE%" & goto done )
if exist "%EDGE2%"   ( start "" "%EDGE2%"   --app=%URL% --user-data-dir="%PROFILE%" & goto done )
if exist "%CHROME1%" ( start "" "%CHROME1%" --app=%URL% --user-data-dir="%PROFILE%" & goto done )
if exist "%CHROME2%" ( start "" "%CHROME2%" --app=%URL% --user-data-dir="%PROFILE%" & goto done )

rem 4) Fallback: open in the default browser.
start "" %URL%

:done
exit
