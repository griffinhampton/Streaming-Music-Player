#!/bin/bash
# A/B: the new loop (2 ms poll only while a frame waits) against the old
# always-2ms poll, back to back, same conditions, 1080p30.
S="$(dirname "$0")"; cd "$S"
PY="/c/Users/ghamp/streaming stuff/.build-env/Scripts/python.exe"
RR="$(cygpath -w "$S/rigrestart.ps1")"
for v in new old new old; do
  if [ "$v" = new ]; then
    powershell -NoProfile -ExecutionPolicy Bypass -File "$RR" > /dev/null
  else
    cp "/c/Users/ghamp/streaming stuff/music-deck/nativelive.py" testrig/nativelive.py
    sed -i 's/time.sleep(min(wait, 0.002 if pending is not None else 0.05))/time.sleep(min(wait, 0.002))/' testrig/nativelive.py
    grep -c "min(wait, 0.002))" testrig/nativelive.py
    powershell -NoProfile -ExecutionPolicy Bypass -File "$RR" -NoSync > /dev/null
  fi
  sleep 3
  echo "== $v"; "$PY" p5threads.py 1080p30 2>&1 | grep "preset\|server total\|%  Thread" | head -5
done
powershell -NoProfile -ExecutionPolicy Bypass -File "$RR" > /dev/null
echo "== done (rig back on the repo code)"
