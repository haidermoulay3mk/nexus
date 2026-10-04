@echo off
title NEXUS
cd /d "%~dp0"
echo.
echo   N.E.X.U.S. is starting...
echo   Your browser will open automatically in a few seconds.
echo   KEEP THIS WINDOW OPEN while using Nexus. Close it to stop Nexus.
echo.
start "" cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:1420"
bun run dev:web
