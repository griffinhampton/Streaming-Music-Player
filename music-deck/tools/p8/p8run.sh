#!/bin/bash
# P8 on the rig, headless only (test windows never go on the main monitor).
# The rig's own scenes are copied aside first and put back after; the shots,
# the scene backup and the Chrome profile live in the rig's scratch folder.
N="$(cd "$(dirname "$0")" && pwd)"
O="$(cd "$N/../../.." && pwd)/.rig"   # the rig and its scratch files, beside the repo (git-ignored)
OW="$(cygpath -w "$O")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
B=http://127.0.0.1:8799
SCENES="$O/testrig/cache/scenes"
mkdir -p "$O/p8shots"
node "$N/snaptest.js" | tail -1 || exit 1
powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$N/../rig/rigrestart.ps1")"
sleep 3
rm -rf "$O/scenes_backup8" && cp -r "$SCENES" "$O/scenes_backup8" && echo "scenes backed up: $(ls "$O/scenes_backup8" | wc -l) files"
mk() { curl -s -X POST -H "Content-Type: application/json" -d "{\"name\": \"$1\", \"format\": \"$2\"}" $B/api/scenes | python -c "import json,sys; print(json.load(sys.stdin)['scene']['id'])"; }
SID="$(mk 'P8 tools test' horizontal)"
SID2="$(mk 'P8 paste target' phone)"
echo "test scenes: $SID $SID2"
"$CHROME" --headless=new --remote-debugging-port=9348 "--user-data-dir=$OW\\prof-p8" --no-first-run --window-size=1600,900 \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --disable-features=CalculateNativeWinOcclusion about:blank > /dev/null 2>&1 &
sleep 5
node "$N/p8test.js" 9348 "$SID" "$SID2" "$OW\\p8shots"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-p8*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
for s in "$SID" "$SID2"; do curl -s -X POST -H "Content-Type: application/json" -d '{}' "$B/api/scenes/$s/delete" > /dev/null; done
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'python.exe' -and \$_.CommandLine -like '*server.py*' -and \$_.CommandLine -notlike '*streaming stuff\\music-deck*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 2
rm -rf "$SCENES" && cp -r "$O/scenes_backup8" "$SCENES" && echo "scenes restored: $(ls "$SCENES" | wc -l) files"
echo "== p8run done"
