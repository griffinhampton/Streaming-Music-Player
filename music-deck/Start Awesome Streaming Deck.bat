@echo off
title Awesome Streaming Deck
cd /d "%~dp0"

set "PY=py"
where py >nul 2>&1 || set "PY=python"

"%PY%" server.py

echo.
echo Awesome Streaming Deck has stopped.
pause
