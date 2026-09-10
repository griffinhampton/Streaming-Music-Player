@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Build Awesome Streaming Deck

rem ---------------------------------------------------------------------------
rem Builds a folder, not a single .exe, and that is deliberate.
rem
rem A --onefile build is one executable that unpacks itself into a temp folder
rem and runs what it just wrote. That is also, exactly, what a dropper does, so
rem antivirus heuristics flag it constantly - the false-positive reports against
rem PyInstaller onefile builds are endless. A --onedir build has nothing to
rem unpack and is dramatically less likely to be flagged. It also starts faster.
rem
rem The cost is that it is a folder rather than one file, which is what the
rem installer is for. See ANTIVIRUS.md for the rest of the story, including the
rem part no build flag can fix.
rem ---------------------------------------------------------------------------

set "ENV=%~dp0..\.build-env"
set "APP=Awesome Streaming Deck"

if not exist "%ENV%\Scripts\pyinstaller.exe" (
  echo Setting up the build environment ^(one time^)...
  python -m venv "%ENV%" || goto :fail
  "%ENV%\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check pyinstaller || goto :fail
)
rem The Whisper captions engine's libraries. Quick when already installed.
"%ENV%\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r "%~dp0requirements.txt" || goto :fail

rem The shipped artwork is optional - a fresh clone will not have it, and the
rem app works fine without any, since people add their own.
set "THEMES="
if exist "%~dp0..\built in themes" (
  set "THEMES=--add-data "%~dp0..\built in themes;builtin""
) else (
  echo Note: no "built in themes" folder found - building without shipped artwork.
)

echo.
echo Building "%APP%" ...
"%ENV%\Scripts\pyinstaller.exe" --noconfirm --clean --onedir --noconsole ^
  --name "%APP%" --icon "%~dp0music-deck.ico" ^
  --version-file "%~dp0version.txt" ^
  --add-data "%~dp0web;web" --add-data "%~dp0smtc.ps1;." --add-data "%~dp0captions.ps1;." ^
  --add-data "%~dp0music-deck.ico;." ^
  !THEMES! ^
  --hidden-import tkinter --hidden-import tkinter.filedialog --hidden-import tkinter.messagebox ^
  --collect-binaries ctranslate2 --collect-data faster_whisper ^
  --exclude-module av --exclude-module hf_xet ^
  --distpath "%~dp0..\dist" --workpath "%ENV%\work" --specpath "%ENV%" ^
  server.py || goto :fail

rem ---------------------------------------------------------------------------
rem An installer, if Inno Setup is around. Not required - the folder runs as it
rem is - but it is what makes this feel like software rather than a zip someone
rem sent you, and it puts the app somewhere Windows expects to find it.
rem   winget install JRSoftware.InnoSetup
rem ---------------------------------------------------------------------------
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"

if defined ISCC (
  echo.
  echo Building the installer ...
  "!ISCC!" /Q "%~dp0installer.iss" || goto :fail
  echo Installer:  %~dp0..\dist\Awesome-Streaming-Deck-Setup.exe
) else (
  echo.
  echo Inno Setup not found, so no installer was built. To make one:
  echo   winget install JRSoftware.InnoSetup
  echo Then run this again. The folder below works without it.
)

rem A checksum lets anyone verify the download matches what you published, and
rem is the thing to quote when reporting a false positive.
echo.
echo Checksums:
powershell -NoProfile -Command ^
  "Get-ChildItem '%~dp0..\dist' -Filter '*.exe' -Recurse -Depth 1 | ForEach-Object { '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0,32), $_.Name }" ^
  > "%~dp0..\dist\SHA256SUMS.txt" 2>nul
if exist "%~dp0..\dist\SHA256SUMS.txt" type "%~dp0..\dist\SHA256SUMS.txt"

echo.
echo Done:  %~dp0..\dist\%APP%\
echo Run "%APP%.exe" inside that folder, or hand people the installer.
pause
exit /b 0

:fail
echo.
echo Build failed - see the messages above.
pause
exit /b 1
