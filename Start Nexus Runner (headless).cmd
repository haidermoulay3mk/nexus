@echo off
title NEXUS RUNNER (headless)
cd /d "%~dp0"
echo.
echo   NEXUS Runner is starting WITHOUT the visual HUD.
echo   Scheduled jobs (scholarship sweep 08:30, course check 09:00,
echo   morning report 08:00) run as long as this window stays open.
echo.
echo   Open the full HUD any time with "Start Nexus.cmd".
echo   Minimize this window; close it to stop the Runner.
echo.
bun run dev:runner
