#!/bin/bash
# P11 on the rig: a real stream to a local ffmpeg RTMP listener, driven from
# the UI in headless Chrome. The live output window (the one thing that must
# be a real window, since the stream captures it) is parked off screen and
# not on top - nothing appears on the monitor. The test scenes have no
# camera or capture, and the test turns the microphone and desktop sound off
# in the LIVE panel, so nothing of this PC's is recorded. The rig's scenes
# and config are copied aside and put back after.
N="$(cd "$(dirname "$0")" && pwd)"
O="$(cd "$N/../../.." && pwd)/.rig"   # the rig and its scratch files, beside the repo (git-ignored)
OW="$(cygpath -w "$O")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
FF="/c/Users/ghamp/Downloads/ffmpeg-8.0-essentials_build/bin/ffmpeg.exe"
B=http://127.0.0.1:8799
SCENES="$O/testrig/cache/scenes"
rm -rf "$O/p11" && mkdir -p "$O/p11"
powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$N/../rig/rigrestart.ps1")"
sleep 3
rm -rf "$O/scenes_backup11" && cp -r "$SCENES" "$O/scenes_backup11" && echo "scenes backed up: $(ls "$O/scenes_backup11" | wc -l) files"
cp "$O/testrig/config.json" "$O/config_backup11.json"
mk() { curl -s -X POST -H "Content-Type: application/json" -d "{\"name\": \"$1\", \"format\": \"horizontal\"}" $B/api/scenes | python -c "import json,sys; print(json.load(sys.stdin)['scene']['id'])"; }
SA="$(mk 'P11 Scene A')"
SB="$(mk 'P11 Scene B')"
echo "test scenes: $SA $SB"
# The live output: off screen, not on top.
curl -s -X POST -H "Content-Type: application/json" -d '{"canvas": {"outputs": {"live": {"x": -4000, "y": -4000, "topmost": false, "width": 1920, "height": 1080}}}}' $B/api/config > /dev/null
"$FF" -hide_banner -loglevel error -y -listen 1 -timeout 180 -i rtmp://127.0.0.1:1935/live/p11 -c copy -f flv "$OW\\p11\\stream.flv" > "$O/p11/sink.log" 2>&1 &
SINK=$!
"$CHROME" --headless=new --remote-debugging-port=9351 "--user-data-dir=$OW\\prof-p11" --no-first-run --window-size=1600,900 \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --disable-features=CalculateNativeWinOcclusion about:blank > /dev/null 2>&1 &
sleep 5
node "$N/p11test.js" 9351 "$SA" "$SB" "$OW\\p11" "$(cygpath -w "$FF")" 8799
curl -s -X POST -H "Content-Type: application/json" -d '{}' $B/api/live/stop > /dev/null
curl -s -X POST -H "Content-Type: application/json" -d '{}' $B/api/components/live/close > /dev/null
sleep 1
kill $SINK 2>/dev/null
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-p11*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'python.exe' -and \$_.CommandLine -like '*server.py*' -and \$_.CommandLine -notlike '*streaming stuff\\music-deck*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 2
rm -rf "$SCENES" && cp -r "$O/scenes_backup11" "$SCENES" && echo "scenes restored: $(ls "$SCENES" | wc -l) files"
cp "$O/config_backup11.json" "$O/testrig/config.json" && echo "rig config restored"
echo "== p11run done"
