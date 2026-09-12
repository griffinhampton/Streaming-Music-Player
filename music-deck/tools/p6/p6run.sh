#!/bin/bash
# P6 on the rig, headless only (one monitor: no visible test windows).
# Case A: no scenes (the music four + the two frames). Case B: four scenes
# (ten cards). The rig's own scenes are copied aside first and put back after.
N="$(cd "$(dirname "$0")" && pwd)"
O="$TEMP/claude/C--Users-ghamp-streaming-stuff/6719d1e9-d48e-4fa3-8759-ba9482cbef0d/scratchpad"
W="$(cygpath -w "$N")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
B=http://127.0.0.1:8799
SCENES="$O/testrig/cache/scenes"
mkdir -p "$N/p6shots"
powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$O/rigrestart.ps1")"
sleep 3
rm -rf "$N/scenes_backup" && cp -r "$SCENES" "$N/scenes_backup" && echo "scenes backed up: $(ls "$N/scenes_backup" | wc -l) files"
for id in $(curl -s $B/api/scenes | python -c "import json,sys; print(' '.join(s['id'] for s in json.load(sys.stdin)['scenes']))"); do
  curl -s -X POST -H "Content-Type: application/json" -d '{}' "$B/api/scenes/$id/delete" > /dev/null
done
echo "scenes now: $(curl -s $B/api/scenes | python -c "import json,sys; print(len(json.load(sys.stdin)['scenes']))")"

run_case() {
  "$CHROME" --headless=new --remote-debugging-port=9345 "--user-data-dir=$W\\prof-p6$1" --no-first-run --window-size=1400,900 about:blank > /dev/null 2>&1 &
  sleep 5
  curl -s -X PUT "http://127.0.0.1:9345/json/new?$B/deck.html" > /dev/null
  sleep 3
  echo "===== case $1"
  node "$N/p6test.js" 9345 "$1" "$W\\p6shots"
  powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-p6*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
  sleep 2
}

run_case none
for t in just_chatting gaming_landscape gaming_portrait music_lyrics; do
  curl -s -X POST -H "Content-Type: application/json" -d "{\"template\": \"$t\", \"name\": \"P6 $t\"}" $B/api/scenes > /dev/null
done
echo "scenes now: $(curl -s $B/api/scenes | python -c "import json,sys; print(len(json.load(sys.stdin)['scenes']))")"
run_case four

echo "===== frame pages"
"$CHROME" --headless=new --remote-debugging-port=9346 "--user-data-dir=$W\\prof-p6frame" --no-first-run --window-size=640,640 about:blank > /dev/null 2>&1 &
sleep 5
curl -s -X POST -H "Content-Type: application/json" -d '{"camframe": {"frame": {"hole": "key", "shape": "circle", "border": {"style": "glow", "width": 10, "color": "#ff7ab6"}, "badges": {"tr": "LIVE", "bl": "✨"}, "title": {"text": "cam", "place": "bottom"}}}, "screenframe": {"frame": {"loop": {"border": "sparkle"}, "title": {"text": "Ranked grind"}, "badges": {"tl": "1"}}}}' $B/api/config > /dev/null
node "$N/shotpage.js" 9346 "$B/frame.html?kind=camera&preview=1" 480 480 "$W\\p6shots\\frame_camera.png"
node "$N/shotpage.js" 9346 "$B/frame.html?kind=screen" 960 540 "$W\\p6shots\\frame_screen.png"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-p6frame*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo "===== restore"
for id in $(curl -s $B/api/scenes | python -c "import json,sys; print(' '.join(s['id'] for s in json.load(sys.stdin)['scenes']))"); do
  curl -s -X POST -H "Content-Type: application/json" -d '{}' "$B/api/scenes/$id/delete" > /dev/null
done
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'python.exe' -and \$_.CommandLine -like '*server.py*' -and \$_.CommandLine -notlike '*streaming stuff\\music-deck*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 2
rm -rf "$SCENES" && cp -r "$N/scenes_backup" "$SCENES" && echo "scenes restored: $(ls "$SCENES" | wc -l) files"
echo "== p6run done"
