#!/bin/bash
# P12 release QA on the rig, headless only (no test window on any monitor).
# The rig's scenes and config are copied aside and put back after. Two scene
# files are damaged on purpose before the rig starts (one with a good backup,
# one without); exports go to the rig's scratch folder, never to Downloads.
# Part two streams for real to a local ffmpeg listener, which the test kills
# and brings back to make the stream reconnect; the live output window is
# parked off screen and not on top, the scene is plain and the sound is off.
N="$(cd "$(dirname "$0")" && pwd)"
O="$(cd "$N/../../.." && pwd)/.rig"   # the rig and its scratch files, beside the repo (git-ignored)
OW="$(cygpath -w "$O")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
FF="/c/Users/ghamp/Downloads/ffmpeg-8.0-essentials_build/bin/ffmpeg.exe"
PY="C:\\Users\\ghamp\\streaming stuff\\.build-env\\Scripts\\python.exe"
B=http://127.0.0.1:8799
SCENES="$O/testrig/cache/scenes"
rm -rf "$O/p12" && mkdir -p "$O/p12"
powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$N/../rig/rigrestart.ps1")"
sleep 3
rm -rf "$O/scenes_backup12" && cp -r "$SCENES" "$O/scenes_backup12" && echo "scenes backed up: $(ls "$O/scenes_backup12" | wc -l) files"
cp "$O/testrig/config.json" "$O/config_backup12.json"
# Damaged on purpose, then the rig restarted so it reads them.
printf '{"name": "half a sce' > "$SCENES/p12damaged.json"
printf '{"version": 1, "id": "p12damaged", "name": "P12 restored", "format": "horizontal", "layers": []}' > "$SCENES/p12damaged.json.1"
printf 'garbage, not a scene' > "$SCENES/p12corrupt.json"
powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$N/../rig/rigrestart.ps1")"
sleep 3
mk() { curl -s -X POST -H "Content-Type: application/json" -d "{\"name\": \"$1\", \"format\": \"horizontal\"}" $B/api/scenes | python -c "import json,sys; print(json.load(sys.stdin)['scene']['id'])"; }
SQ="$(mk 'P12 QA scene')"
SL="$(mk 'P12 LIVE')"
echo "test scenes: $SQ $SL"
EXP="$(printf '%s' "$OW\\p12\\exports" | python -c "import json,sys; print(json.dumps(sys.stdin.read()))")"
curl -s -X POST -H "Content-Type: application/json" -d "{\"canvas\": {\"export_dir\": $EXP, \"outputs\": {\"live\": {\"x\": -4000, \"y\": -4000, \"topmost\": false, \"width\": 1920, \"height\": 1080}}}}" $B/api/config > /dev/null
"$CHROME" --headless=new --remote-debugging-port=9352 "--user-data-dir=$OW\\prof-p12" --no-first-run --window-size=1600,900 \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --disable-features=CalculateNativeWinOcclusion --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
  about:blank > /dev/null 2>&1 &
sleep 5
echo "== P12 QA"
node "$N/p12test.js" 9352 "$SQ" "$OW\\p12" "$PY" 8799 p12corrupt p12damaged
echo "== P12 LIVE"
node "$N/p12live.js" 9352 "$SL" "$OW\\p12" "$(cygpath -w "$FF")" 8799
curl -s -X POST -H "Content-Type: application/json" -d '{}' $B/api/live/stop > /dev/null
curl -s -X POST -H "Content-Type: application/json" -d '{}' $B/api/components/live/close > /dev/null
sleep 1
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'ffmpeg.exe' -and \$_.CommandLine -like '*live/p12*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-p12*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'python.exe' -and \$_.CommandLine -like '*server.py*' -and \$_.CommandLine -notlike '*streaming stuff\\music-deck*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 2
rm -rf "$SCENES" && cp -r "$O/scenes_backup12" "$SCENES" && echo "scenes restored: $(ls "$SCENES" | wc -l) files"
cp "$O/config_backup12.json" "$O/testrig/config.json" && echo "rig config restored"
echo "== p12run done"
