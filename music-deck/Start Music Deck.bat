@echo off
title Music Deck
cd /d "%~dp0"

set "PY=py"
where py >nul 2>&1 || set "PY=python"

"%PY%" server.py

echo.
echo Music Deck has stopped.
pause
