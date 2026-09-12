#!/bin/bash
# P9 on the rig, headless only (test windows never go on the main monitor).
# The rig's scenes are copied aside and put back after; the goldens live in
# tools/p9/golden (pass "update" to rewrite them), everything else in the
# rig's scratch folder. Chrome gets a fake camera, so the camera layer's
# live indicator can be tested without touching a real one.
N="$(cd "$(dirname "$0")" && pwd)"
O="$(cd "$N/../../.." && pwd)/.rig"   # the rig and its scratch files, beside the repo (git-ignored)
OW="$(cygpath -w "$O")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
B=http://127.0.0.1:8799
SCENES="$O/testrig/cache/scenes"
mkdir -p "$O/p9shots" "$N/golden"
powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$N/../rig/rigrestart.ps1")"
sleep 3
rm -rf "$O/scenes_backup9" && cp -r "$SCENES" "$O/scenes_backup9" && echo "scenes backed up: $(ls "$O/scenes_backup9" | wc -l) files"
cp "$O/testrig/config.json" "$O/config_backup9.json" 2>/dev/null
SID="$(curl -s -X POST -H "Content-Type: application/json" -d '{"name": "P9 inspectors test", "format": "horizontal"}' $B/api/scenes | python -c "import json,sys; print(json.load(sys.stdin)['scene']['id'])")"
echo "test scene: $SID"
"$CHROME" --headless=new --remote-debugging-port=9349 "--user-data-dir=$OW\\prof-p9" --no-first-run --window-size=1600,900 \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --disable-features=CalculateNativeWinOcclusion --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
  about:blank > /dev/null 2>&1 &
sleep 5
node "$N/p9test.js" 9349 "$SID" "$OW\\p9shots" "$(cygpath -w "$N/golden")" 8799 "$1"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-p9*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
curl -s -X POST -H "Content-Type: application/json" -d '{}' "$B/api/scenes/$SID/delete" > /dev/null
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'python.exe' -and \$_.CommandLine -like '*server.py*' -and \$_.CommandLine -notlike '*streaming stuff\\music-deck*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 2
rm -rf "$SCENES" && cp -r "$O/scenes_backup9" "$SCENES" && echo "scenes restored: $(ls "$SCENES" | wc -l) files"
[ -f "$O/config_backup9.json" ] && cp "$O/config_backup9.json" "$O/testrig/config.json" && echo "rig config restored"
echo "== p9run done"
