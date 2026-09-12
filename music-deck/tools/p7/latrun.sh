#!/bin/bash
# The profile and the scenes backup go in the rig's scratch folder, never in the repo.
N="$(cd "$(dirname "$0")" && pwd)"
O="$(cd "$N/../../.." && pwd)/.rig"   # the rig and its scratch files, beside the repo (git-ignored)
W="$(cygpath -w "$O")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
B=http://127.0.0.1:8799
SCENES="$O/testrig/cache/scenes"
powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$N/../rig/rigrestart.ps1")" > /dev/null
sleep 3
rm -rf "$O/scenes_backupL" && cp -r "$SCENES" "$O/scenes_backupL"
SID="$(curl -s -X POST -H "Content-Type: application/json" -d '{"template": "just_chatting", "name": "latency probe"}' $B/api/scenes | python -c "import json,sys; print(json.load(sys.stdin)['scene']['id'])")"
"$CHROME" --headless=new --remote-debugging-port=9348 "--user-data-dir=$W\prof-lat" --no-first-run --window-size=960,540 \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --disable-features=CalculateNativeWinOcclusion about:blank > /dev/null 2>&1 &
sleep 5
node "$N/latprobe.js" 9348 "$SID"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-lat*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
curl -s -X POST -H "Content-Type: application/json" -d '{}' "$B/api/scenes/$SID/delete" > /dev/null
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'python.exe' -and \$_.CommandLine -like '*server.py*' -and \$_.CommandLine -notlike '*streaming stuff\music-deck*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 2
rm -rf "$SCENES" && cp -r "$O/scenes_backupL" "$SCENES" && echo "scenes restored: $(ls "$SCENES" | wc -l) files"
echo "== latrun done"
