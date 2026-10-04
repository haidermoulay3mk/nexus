@echo off
REM Double-click this to talk to Nexus by typing.
cd /d "%~dp0"
".venv\Scripts\python.exe" -m nexus
echo.
pause
