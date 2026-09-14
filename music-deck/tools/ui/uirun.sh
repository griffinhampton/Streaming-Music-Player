#!/bin/bash
# Runs one of the tools/ui probes (or tools/capture/pickertest.js) on the rig:
#
#     ./uirun.sh soundpanel          one probe
#     ./uirun.sh all                 every probe, in turn
#
# Why this exists. Every P-suite has a committed runner, so P6 to P12 get run.
# These probes had none - they were driven once from a scratch folder and never
# again - and an entire eighteen-step plan went by without any of them running.
# Six of them cover Group A and B work (icon centering, scrollbars, frame layers,
# preview gating, voice triggers, the sound panel, the window picker) that no
# P-suite touches, so nothing else would have caught a regression in it.
#
# Headless only: the user has one monitor and test windows never go on it.
# Each probe gets its own rig restart on purpose rather than sharing one -
# voicetrig's header warns that a voice left pinned to "speaking" would poison
# every later run, so these must not share server state.
#
# The probes are NOT interchangeable, which is the trap this table exists to
# close:
#   * soundpanel needs --use-fake-device-for-media-stream and
#     --use-fake-ui-for-media-stream (its own header says so); without them the
#     microphone is denied and three checks fail on an empty analyser.
#   * inkcenter's third argument is a TOLERANCE, not an output directory.
#     Passing a path there quietly changes what it measures.
#   * pickertest lives in tools/capture, not tools/ui.
#   * keyleak needs no browser at all - it samples /api/state for drift, then
#     counts HUB.sends over three timed windows - and takes about 50 s. Chrome
#     is still started for it, at about:blank, which costs a moment and
#     touches nothing it measures.
#   * --autoplay-policy=no-user-gesture-required is in the flags for fxsound,
#     which asks whether a clip actually played. Without it play() is rejected
#     and that probe reports a broken feature that works. It is the same flag
#     overlay.py gives the app's own windows, so the probes match the app.
#   * capcheck, fxgif, fxsound and addpalette each make what they need on the
#     rig and take it away again - a picture, a clip, a scene, a command list.
#     A run killed part way leaves one behind; they are named for the probe
#     that made them, so they are easy to spot.
#   * fxsound builds its own WAV rather than pointing at a file. An .mp3 of
#     zeros uploads happily and then fails to decode, which would look exactly
#     like the layer refusing to play it.
#   * Never pipe this script (| grep, | tail). The rig's server is started
#     detached and inherits the pipe's write end, so the reader never sees
#     end-of-file: the run finishes and the pipe hangs, holding the output.
#   * fxflood makes three pictures, a clip, a scene and a command list, and
#     changes the effects budget - all put back at the end. It needs the
#     autoplay flag too: one of its checks is that stop silences a clip that
#     was really playing, and a clip that never started proves nothing.
#   * scenebeacon imports a scene into the rig and deletes it again, and is the
#     only probe here that writes to the scene store: a run killed between the
#     two leaves one behind, named "beacon probe". It also watches the network
#     rather than the page, so it enables Network on a blank target and only
#     then navigates - opening straight at the URL misses the early requests,
#     which are the ones it exists to catch.
set -u
N="$(cd "$(dirname "$0")" && pwd)"                 # this folder
O="$(cd "$N/../../.." && pwd)/.rig"                # the rig, beside the repo (git-ignored)
OW="$(cygpath -w "$O")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
RIGPORT=8799
mkdir -p "$O/uishots"

ALL="chatui onair onstream ctlgate scrollprobe inkcenter framelayer voicetrig soundpanel pickertest keyleak scenebeacon capcheck t1shot fxgif fxsound addpalette fxflood layercmd"

run_one() {
  name="$1"
  case "$name" in
    chatui)      js="$N/chatui.js";              port=9380; extra="$O/uishots"; win=1400,1000 ;;
    onair)       js="$N/onair.js";               port=9381; extra="$O/uishots"; win=1600,1000 ;;
    onstream)    js="$N/onstream.js";            port=9382; extra="$O/uishots"; win=1600,900 ;;
    ctlgate)     js="$N/ctlgate.js";             port=9383; extra="";           win=1400,900 ;;
    scrollprobe) js="$N/scrollprobe.js";         port=9384; extra="";           win=1400,900 ;;
    inkcenter)   js="$N/inkcenter.js";           port=9385; extra="";           win=1600,1000 ;;
    framelayer)  js="$N/framelayer.js";          port=9386; extra="$O/uishots"; win=1400,900 ;;
    voicetrig)   js="$N/voicetrig.js";           port=9387; extra="$O/uishots"; win=1400,900 ;;
    soundpanel)  js="$N/soundpanel.js";          port=9388; extra="$O/uishots"; win=1400,1000 ;;
    pickertest)  js="$N/../capture/pickertest.js"; port=9389; extra="";         win=1600,900 ;;
    keyleak)     js="$N/keyleak.js";            port=9390; extra="";           win=800,600 ;;
    scenebeacon) js="$N/scenebeacon.js";        port=9391; extra="";           win=1200,800 ;;
    capcheck)    js="$N/capcheck.js";           port=9392; extra="";           win=1200,800 ;;
    t1shot)      js="$N/t1shot.js";             port=9393; extra="$O/uishots"; win=1280,880 ;;
    fxgif)       js="$N/fxgif.js";              port=9394; extra="$O/uishots"; win=1600,900 ;;
    fxsound)     js="$N/fxsound.js";            port=9395; extra="";           win=1200,800 ;;
    addpalette)  js="$N/addpalette.js";         port=9396; extra="$O/uishots"; win=1440,900 ;;
    fxflood)     js="$N/fxflood.js";            port=9397; extra="";           win=1600,900 ;;
    layercmd)    js="$N/layercmd.js";           port=9398; extra="";           win=1600,900 ;;
    *) echo "unknown probe: '$name'"; echo "one of: $ALL"; return 2 ;;
  esac

  echo "== restarting the rig"
  powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$N/../rig/rigrestart.ps1")"
  sleep 2

  "$CHROME" --headless=new --remote-debugging-port=$port "--user-data-dir=$OW\\prof-ui-$name" --no-first-run \
    --window-size=$win --disable-background-timer-throttling --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion \
    --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
    --autoplay-policy=no-user-gesture-required \
    about:blank > /dev/null 2>&1 &
  sleep 5

  echo "== $name"
  if [ -n "$extra" ]; then node "$js" "$port" "$RIGPORT" "$extra"; else node "$js" "$port" "$RIGPORT"; fi
  code=$?

  powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*prof-ui-$name*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
  echo "== $name exit $code"
  return $code
}

want="${1:-}"
if [ -z "$want" ]; then echo "usage: uirun.sh <probe|all>"; echo "one of: $ALL"; exit 2; fi

if [ "$want" = "all" ]; then
  bad=""
  for p in $ALL; do
    echo "=================================== $p"
    run_one "$p" || bad="$bad $p"
  done
  echo
  if [ -n "$bad" ]; then echo "== probes that did not pass:$bad"; exit 1; fi
  echo "== every probe passed"
else
  run_one "$want"
fi
