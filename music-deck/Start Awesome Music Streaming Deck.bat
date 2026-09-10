@echo off
title Awesome Music Streaming Deck
cd /d "%~dp0"

set "PY=py"
where py >nul 2>&1 || set "PY=python"

"%PY%" server.py

echo.
echo Awesome Music Streaming Deck has stopped.
pause
