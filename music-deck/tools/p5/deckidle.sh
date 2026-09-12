#!/bin/bash
# The deck's idle still, on the real window (second monitor): moving right
# after it opens, still after 15 s without input, moving again after one
# synthetic pointer move. Then the real Now Playing pop-out through the rig
# Chrome's DevTools port 9360.
O="$TEMP/claude/C--Users-ghamp-streaming-stuff/6719d1e9-d48e-4fa3-8759-ba9482cbef0d/scratchpad"
N="$(cd "$(dirname "$0")" && pwd)"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PROF="$(cygpath -w "$O/testrig/cache/prof-deck")"
cpu() { powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$O/cpuby.ps1")" -Match "$1" -Seconds "$2" | grep -i "gpu-process\|renderer \|browser\|TOTAL" | tr -s ' ' | tr '\n' ';'; echo; }
"$CHROME" "--user-data-dir=$PROF" --remote-debugging-port=9350 --app=http://127.0.0.1:8799/deck.html --window-size=1180,820 \
  --window-position=2860,640 --no-first-run --no-default-browser-check --disable-component-update --disable-background-networking \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion > /dev/null 2>&1 &
sleep 3
LINE="$(PYTHONIOENCODING=utf-8 python "$O/wins.py" | grep 'Awesome Streaming Deck  ')"
echo "deck: $LINE"
if ! echo "$LINE" | grep -q " second "; then
  echo "deck not on the second monitor - stopping"
else
  echo "== deck focused, just opened (preview moving), 6 s:"; cpu prof-deck 6
  sleep 12
  echo "== deck focused, 20 s without input (should be still), 10 s:"; cpu prof-deck 10
  node "$N/nudge.js" 9350 deck.html
  echo "== right after one pointer move (moving again), 6 s:"; cpu prof-deck 6
  node "$N/perfprobe.js" 9350 deck.html 4 | grep -c "running" | sed 's/^/running animation lines after the move: /'
fi
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-deck*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo "== deck closed"
curl -s -X POST -H "Content-Type: application/json" -d '{}' http://127.0.0.1:8799/api/components/np/open > /dev/null
sleep 12
echo "== Now Playing pop-out, real window, 12 s:"
node "$N/perfprobe.js" 9360 nowplaying.html 12 &
cpu testrig 12
wait
curl -s -X POST -H "Content-Type: application/json" -d '{}' http://127.0.0.1:8799/api/components/np/close > /dev/null
echo "== done"
