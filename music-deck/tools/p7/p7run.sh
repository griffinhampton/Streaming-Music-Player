#!/bin/bash
# P7 on the rig, headless only (test windows never go on the main monitor).
# The rig's own scenes are copied aside first and put back after. The
# profile, the backup and the pictures go in the rig's scratch folder, never
# in the repo.
N="$(cd "$(dirname "$0")" && pwd)"
O="$(cd "$N/../../.." && pwd)/.rig"   # the rig and its scratch files, beside the repo (git-ignored)
W="$(cygpath -w "$O")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
B=http://127.0.0.1:8799
SCENES="$O/testrig/cache/scenes"
mkdir -p "$O/p7shots"
powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$N/../rig/rigrestart.ps1")"
sleep 3
rm -rf "$O/scenes_backup7" && cp -r "$SCENES" "$O/scenes_backup7" && echo "scenes backed up: $(ls "$O/scenes_backup7" | wc -l) files"
SID="$(curl -s -X POST -H "Content-Type: application/json" -d '{"template": "just_chatting", "name": "P7 editor test"}' $B/api/scenes | python -c "import json,sys; print(json.load(sys.stdin)['scene']['id'])")"
echo "test scene: $SID"
# The same no-throttling flags the app's own windows run with: a page that is
# not the front tab (the output here) must not be slowed down as a background tab.
"$CHROME" --headless=new --remote-debugging-port=9347 "--user-data-dir=$W\\prof-p7" --no-first-run --window-size=1600,900 \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --disable-features=CalculateNativeWinOcclusion about:blank > /dev/null 2>&1 &
sleep 5
node "$N/p7test.js" 9347 "$SID" "$W\\p7shots"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-p7*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
curl -s -X POST -H "Content-Type: application/json" -d '{}' "$B/api/scenes/$SID/delete" > /dev/null
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'python.exe' -and \$_.CommandLine -like '*server.py*' -and \$_.CommandLine -notlike '*streaming stuff\\music-deck*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 2
rm -rf "$SCENES" && cp -r "$O/scenes_backup7" "$SCENES" && echo "scenes restored: $(ls "$SCENES" | wc -l) files"
echo "== p7run done"
