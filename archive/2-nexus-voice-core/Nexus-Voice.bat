@echo off
REM Double-click this to talk to Nexus out loud (hold SPACE to speak).
cd /d "%~dp0"
".venv\Scripts\python.exe" -m nexus --voice
echo.
pause
