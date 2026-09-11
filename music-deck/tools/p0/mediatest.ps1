param([string]$Phase = 'A')
# P0: camera + screen share in a Chrome --app window on http://127.0.0.1:8799.
#   A: fresh profile. getDisplayMedia with the auto-select flag (no picker?),
#      CPU of the captured window in <video>, then getUserMedia (prompt expected).
#   B: profile pre-seeded with camera/mic ALLOW for our origin -> getUserMedia
#      without a prompt? Then CPU of a 1080p30 camera in <video>.
#   C: like A but with --use-fake-ui-for-media-stream.
$S = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
$prof = "$S\prof-p0m"
$base = 'http://127.0.0.1:8799'
$flags = @('--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,Translate', '--autoplay-policy=no-user-gesture-required',
  '--force-device-scale-factor=1', '--remote-debugging-port=9444', "--user-data-dir=$prof")
function Kill-Test { Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-p0m*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 1 }
function Ev($expr, $gesture) { $a = @('9444', 'P0 Media', $expr); if ($gesture) { $a += 'gesture' }; & node "$S\cdp.js" @a }
Kill-Test
if (Test-Path $prof) { Remove-Item -Recurse -Force $prof }
if ($Phase -eq 'B') {
  New-Item -ItemType Directory -Force "$prof\Default" | Out-Null
  $seed = @{ profile = @{ content_settings = @{ exceptions = @{
    media_stream_camera = @{ 'http://127.0.0.1:8799,*' = @{ setting = 1 } }
    media_stream_mic    = @{ 'http://127.0.0.1:8799,*' = @{ setting = 1 } } } } } }
  $seed | ConvertTo-Json -Depth 8 | Set-Content "$prof\Default\Preferences" -Encoding ascii
  "seeded Preferences with camera+mic ALLOW for $base"
}
$extra = @()
if ($Phase -eq 'C') { $extra = @('--use-fake-ui-for-media-stream') }
$auto = @('--auto-select-window-capture-source-by-title=P0 Anim Source')
if ($Phase -eq 'A2') {
  # The moving source lives in its own Chrome, so prof-p0m's numbers are the
  # capture + decode + <video> cost alone. 1280x720 window, 30 fps content.
  $src = "$S\prof-p0src"
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-p0src*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 1
  if (Test-Path $src) { Remove-Item -Recurse -Force $src }
  Start-Process $chrome -ArgumentList (@("--app=$base/p0-anim.html?title=P0%20Anim%20Source&label=SRC&fps=30", '--window-size=1296,759', '--window-position=50,100', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', "--user-data-dir=$src"))
  Start-Sleep 4
  "CPU of the source window alone (10 s):"
  & "$S\cpuby.ps1" -Match 'prof-p0src' -Seconds 10
  Start-Process $chrome -ArgumentList (@("--app=$base/p0-media.html", '--window-size=1296,760', '--window-position=1200,100') + $flags + $auto)
  Start-Sleep 4
  "CPU of the media page idle, before capture (10 s):"
  & "$S\cpuby.ps1" -Match 'prof-p0m' -Seconds 10
  "getDisplayMedia (gesture, auto-select flag): " + (Ev 'start(30)' $true)
  Start-Sleep 2
  "video: " + (Ev 'fps()' $false)
  "CPU while showing the captured 1280x720 window in <video> (15 s):"
  & "$S\cpuby.ps1" -Match 'prof-p0m' -Seconds 15
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-p0src*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Kill-Test
  exit
}
Start-Process $chrome -ArgumentList (@("--app=$base/p0-media.html", '--window-size=1296,760', '--window-position=1200,100') + $flags + $auto + $extra)
Start-Sleep 3
if ($Phase -ne 'B') {
  Start-Process $chrome -ArgumentList (@("--app=$base/p0-anim.html?title=P0%20Anim%20Source&label=SRC", '--window-size=1296,760', '--window-position=50,100') + $flags)
  Start-Sleep 3
  "getDisplayMedia (gesture, auto-select flag): " + (Ev 'start(30)' $true)
  Start-Sleep 2
  "video fps: " + (Ev 'fps()' $false)
  "CPU while showing the captured window in <video> (10 s):"
  & "$S\cpuby.ps1" -Match 'prof-p0m' -Seconds 10
  "getUserMedia camera 1080p30 (no seed, expect a prompt): " + (Ev 'cam(1920,1080,30)' $false)
} else {
  "getUserMedia camera 1080p30 (seeded profile): " + (Ev 'cam(1920,1080,30)' $false)
  Start-Sleep 2
  "video fps: " + (Ev 'fps()' $false)
  "CPU while showing the camera in <video> (10 s):"
  & "$S\cpuby.ps1" -Match 'prof-p0m' -Seconds 10
  "getUserMedia mic (seeded): " + (Ev 'navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{const t=s.getAudioTracks()[0];const r=t.label;t.stop();return r}).catch(e=>"ERROR "+e.name)' $false)
}
Kill-Test
