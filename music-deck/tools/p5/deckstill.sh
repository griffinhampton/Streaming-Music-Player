#!/bin/bash
# What still draws in a deck whose preview is paused: open it (second
# monitor), wait 25 s without input, then list main-thread work, every
# animation's state, and whatever can draw without a CSS animation.
O="$TEMP/claude/C--Users-ghamp-streaming-stuff/6719d1e9-d48e-4fa3-8759-ba9482cbef0d/scratchpad"
N="$(cd "$(dirname "$0")" && pwd)"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PROF="$(cygpath -w "$O/testrig/cache/prof-deck")"
true
"$CHROME" "--user-data-dir=$PROF" --remote-debugging-port=9350 --app=http://127.0.0.1:8799/deck.html --window-size=1180,820 \
  --window-position=2860,640 --no-first-run --no-default-browser-check --disable-component-update --disable-background-networking \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion > /dev/null 2>&1 &
sleep 3
LINE="$(PYTHONIOENCODING=utf-8 python "$O/wins.py" | grep 'Awesome Streaming Deck  ')"
echo "deck: $LINE"
if echo "$LINE" | grep -q " second "; then
  sleep 25
  echo "== paused deck, 10 s:"
  node "$N/perfprobe.js" 9350 deck.html 10 &
  PROBE=$!
  powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$O/cpuby.ps1")" -Match prof-deck -Seconds 10 | grep -i "gpu-process\|renderer \|TOTAL" | tr -s ' ' | tr '\n' ';'
  echo
  wait $PROBE      # only the probe: a bare wait also waits for the deck's Chrome, which never exits
  echo "== what can draw without a CSS animation:"
  node "/c/Users/ghamp/streaming stuff/music-deck/tools/p0/cdp.js" 9350 deck.html '(async () => {
    const docs = [["top", document]];
    document.querySelectorAll("iframe").forEach((f, i) => { try { if (f.contentDocument) docs.push(["iframe " + i, f.contentDocument]); } catch (e) {} });
    const out = {};
    for (const [where, d] of docs) {
      const anim = {};
      for (const a of d.getAnimations()) { const k = (a.animationName || a.constructor.name) + ":" + a.playState; anim[k] = (anim[k] || 0) + 1; }
      const vids = [...d.querySelectorAll("video")].map(v => (v.paused ? "paused" : "PLAYING") + " " + (v.currentSrc || v.srcObject ? "src" : "none"));
      const imgs = [...d.querySelectorAll("img")].filter(i => /[.](gif|webp)/i.test(i.currentSrc || "")).map(i => i.currentSrc.slice(-40));
      const bg = [...d.querySelectorAll("*")].filter(e => /[.](gif|webp)/i.test(getComputedStyle(e).backgroundImage)).length;
      out[where] = { animations: anim, videos: vids, canvases: d.querySelectorAll("canvas").length, gifs: imgs, gifBackgrounds: bg,
                     filtered: [...d.querySelectorAll("*")].filter(e => { const s = getComputedStyle(e); return s.backdropFilter !== "none" || s.filter !== "none"; }).length };
    }
    let raf = 0; const r0 = window.requestAnimationFrame;
    window.requestAnimationFrame = f => { raf++; return r0.call(window, f); };
    await new Promise(r => setTimeout(r, 3000));
    window.requestAnimationFrame = r0;
    out.topFrameCallbacksPerSecond = +(raf / 3).toFixed(1);
    return out;
  })()'
else
  echo "deck not on the second monitor - stopping"
fi
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-deck*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo "== deckstill done"
