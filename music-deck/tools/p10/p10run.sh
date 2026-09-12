#!/bin/bash
# P10 on the rig, headless only (test windows never go on the main monitor).
# The rig's scenes are copied aside and put back after; shots and the Chrome
# profile live in the rig's scratch folder. A fake camera for the templates'
# camera layers.
N="$(cd "$(dirname "$0")" && pwd)"
O="$(cd "$N/../../.." && pwd)/.rig"   # the rig and its scratch files, beside the repo (git-ignored)
OW="$(cygpath -w "$O")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
B=http://127.0.0.1:8799
SCENES="$O/testrig/cache/scenes"
mkdir -p "$O/p10shots"
powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$N/../rig/rigrestart.ps1")"
sleep 3
rm -rf "$O/scenes_backup10" && cp -r "$SCENES" "$O/scenes_backup10" && echo "scenes backed up: $(ls "$O/scenes_backup10" | wc -l) files"
cp "$O/testrig/config.json" "$O/config_backup10.json" 2>/dev/null
"$CHROME" --headless=new --remote-debugging-port=9350 "--user-data-dir=$OW\\prof-p10" --no-first-run --window-size=1600,900 \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --disable-features=CalculateNativeWinOcclusion --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
  about:blank > /dev/null 2>&1 &
sleep 5
node "$N/p10test.js" 9350 "$OW\\p10shots" 8799
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-p10*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'python.exe' -and \$_.CommandLine -like '*server.py*' -and \$_.CommandLine -notlike '*streaming stuff\\music-deck*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 2
rm -rf "$SCENES" && cp -r "$O/scenes_backup10" "$SCENES" && echo "scenes restored: $(ls "$SCENES" | wc -l) files"
[ -f "$O/config_backup10.json" ] && cp "$O/config_backup10.json" "$O/testrig/config.json" && echo "rig config restored"
echo "== p10run done"
