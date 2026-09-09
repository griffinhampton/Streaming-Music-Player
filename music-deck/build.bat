@echo off
setlocal
cd /d "%~dp0"
title Build Music Deck

rem The build tools live outside the music-deck folder so this folder stays
rem clean enough to zip up and share as-is.
set "ENV=%~dp0..\.build-env"

if not exist "%ENV%\Scripts\pyinstaller.exe" (
  echo Setting up the build environment ^(one time^)...
  python -m venv "%ENV%" || goto :fail
  "%ENV%\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check pyinstaller || goto :fail
)

echo Building "Music Deck.exe" ...
rem Paths must be absolute: PyInstaller resolves them against the spec folder.
"%ENV%\Scripts\pyinstaller.exe" --noconfirm --clean --onefile --noconsole ^
  --name "Music Deck" --icon "%~dp0music-deck.ico" ^
  --add-data "%~dp0web;web" --add-data "%~dp0smtc.ps1;." ^
  --add-data "%~dp0..\built in themes;builtin" ^
  --hidden-import tkinter --hidden-import tkinter.filedialog --hidden-import tkinter.messagebox ^
  --distpath "%~dp0..\dist" --workpath "%ENV%\work" --specpath "%ENV%" ^
  server.py || goto :fail

echo.
echo Done:  %~dp0..\dist\Music Deck.exe
echo Send that one file to your friends.
pause
exit /b 0

:fail
echo.
echo Build failed - see the messages above.
pause
exit /b 1
