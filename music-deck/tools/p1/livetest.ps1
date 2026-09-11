param([string]$Preset = '720p30', [int]$Seconds = 60, [string]$Source = 'pattern', [int]$Mic = 1, [int]$Sys = 0, [switch]$Baseline, [switch]$Fresh, [switch]$Native)
$KBPS = @{ '1080p60' = 7600; '1080p30' = 6000; '720p60' = 4400; '720p30' = 3400; '480p30' = 2000 }
$FPS = @{ '1080p60' = 60; '1080p30' = 30; '720p60' = 60; '720p30' = 30; '480p30' = 30 }
# P1 rig test: the spike page streams to a local ffmpeg RTMP sink; CPU of
# Chrome (capture + encode) and of the rig's server (mux + socket) are read
# separately; the recording is probed afterwards.
$S = Split-Path -Parent $MyInvocation.MyCommand.Path
$ff = 'C:\Users\ghamp\Downloads\ffmpeg-8.0-essentials_build\bin'
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
$dir = "$S\live"; New-Item -ItemType Directory -Force $dir | Out-Null
$out = "$dir\out_${Preset}_$Source.flv"
if (Test-Path $out) { Remove-Item $out -Force }
$prof = "$S\prof-live"; $src = "$S\prof-srcwin"
function Kill-Chromes { Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and ($_.CommandLine -like '*prof-live*' -or $_.CommandLine -like '*prof-srcwin*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 1 }
function Ev($expr, $gesture) { $a = @('9447', 'Stream spike', $expr); if ($gesture) { $a += 'gesture' }; & node "$S\cdp.js" @a }
function ServerPid { (Get-NetTCPConnection -State Listen -LocalPort 8799 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1 }
function ChromeMB { $t = 0; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like "*prof-live*" } | ForEach-Object { try { $t += (Get-Process -Id $_.ProcessId -ErrorAction Stop).WorkingSet64 } catch {} }; [math]::Round($t / 1MB) }
Kill-Chromes
Get-Process ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if ($Fresh -and (Test-Path $prof)) { Remove-Item -Recurse -Force $prof }
if (-not (Test-Path "$prof\Default\Preferences")) {
  # Camera and mic allowed for our origin up front (the P0 method), or
  # getUserMedia sits behind a prompt nobody can click from here. The
  # profile is kept between runs so first-run work does not pollute CPU.
  New-Item -ItemType Directory -Force "$prof\Default" | Out-Null
  @{ profile = @{ content_settings = @{ exceptions = @{
    media_stream_camera = @{ 'http://127.0.0.1:8799,*' = @{ setting = 1 } }
    media_stream_mic    = @{ 'http://127.0.0.1:8799,*' = @{ setting = 1 } } } } } } | ConvertTo-Json -Depth 8 | Set-Content "$prof\Default\Preferences" -Encoding ascii
}
$srcW = 1280; $srcH = 720
if ($Preset -like '1080*') { $srcW = 1920; $srcH = 1080 }
$sink = Start-Process -FilePath "$ff\ffmpeg.exe" -ArgumentList @('-hide_banner', '-loglevel', 'warning', '-y', '-listen', '1', '-timeout', '60', '-i', 'rtmp://127.0.0.1:1935/live/test', '-c', 'copy', '-f', 'flv', $out) -PassThru -NoNewWindow -RedirectStandardError "$dir\sink_$Preset.err"
Start-Sleep 1
"sink: ffmpeg pid $($sink.Id) listening on rtmp://127.0.0.1:1935/live/test"
$flags = @('--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,Translate', '--autoplay-policy=no-user-gesture-required',
  '--force-device-scale-factor=1', '--remote-debugging-port=9447', "--user-data-dir=$prof",
  '--disable-component-update', '--disable-background-networking', '--disable-sync', '--disable-extensions',
  '--disable-default-apps', '--auto-select-window-capture-source-by-title=P0 Anim Source')
if ($Source -eq 'window' -or $Native) {
  # The captured window is exactly the output size, so no frame is rescaled.
  # WGC trims a plain window's invisible 6 px borders, so the native path
  # gets a window 12 px wider and 6 px taller.
  $ow = $srcW; $oh = $srcH
  if ($Native) { $ow += 12; $oh += 6 }
  Start-Process $chrome -ArgumentList @('--app=http://127.0.0.1:8799/p0-anim.html?title=P0%20Anim%20Source&label=SRC&fps=30', "--window-size=$ow,$oh", '--window-position=40,80', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--disable-component-update', '--disable-background-networking', '--disable-sync', '--disable-extensions', "--user-data-dir=$src")
  Start-Sleep 3
}
if ($Native) { $Source = 'none' }
$page = "http://127.0.0.1:8799/stream-spike.html?preset=$Preset&source=$Source&mic=$Mic&sys=$Sys&url=rtmp://127.0.0.1:1935/live&key=test"
$winSize = '760,700'
if ($Source -eq 'tab') {
  # The page's viewport is the capture, so it must be exactly the preset size.
  $winSize = "$($srcW + 16),$($srcH + 39)"
  $flags += @('--auto-accept-this-tab-capture', '--auto-select-tab-capture-source-by-title=Stream spike')
}
Start-Process $chrome -ArgumentList (@("--app=$page", "--window-size=$winSize", '--window-position=1200,120') + $flags)
Start-Sleep 4
$spid = ServerPid
if ($Baseline) {
  # The source alone: the pattern drawing, or the captured window shown in
  # a <video>, with no encoder and no socket.
  "draw only: " + (Ev 'drawOnly()' $true)
  Start-Sleep 4
  "--- CPU over $($Seconds - 10) s, source only ($Preset, $Source)"
  & "$S\cpuby.ps1" -Match 'prof-live' -Seconds ($Seconds - 10)
  if ($Source -eq 'window') { "--- the captured window's own Chrome (15 s)"; & "$S\cpuby.ps1" -Match 'prof-srcwin' -Seconds 15 }
  Kill-Chromes
  Get-Process ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  exit
}
"server pid $spid; chrome $(ChromeMB) MB; server $([math]::Round((Get-Process -Id $spid).WorkingSet64 / 1MB)) MB before"
"start: " + (Ev 'startLive()' $true)
if ($Native) {
  Start-Sleep 1
  $body = @{ action = 'start'; title = 'P0 Anim Source'; fps = $FPS[$Preset]; kbps = $KBPS[$Preset] } | ConvertTo-Json -Compress
  "native start: " + ((Invoke-RestMethod -Method Post 'http://127.0.0.1:8799/api/live/native' -ContentType 'application/json' -Body $body -TimeoutSec 15) | ConvertTo-Json -Compress)
}
Start-Sleep 6
"status after 6 s: " + ((Invoke-RestMethod 'http://127.0.0.1:8799/api/live/status' -TimeoutSec 5) | ConvertTo-Json -Compress)
"page: " + (Ev 'JSON.stringify(liveInfo())' $false)
$c0 = (Get-Process -Id $spid).TotalProcessorTime.TotalSeconds
$sw = [Diagnostics.Stopwatch]::StartNew()
if ($Seconds -gt 120) {
  # A soak: memory and stream health every 30 s, CPU totals over the whole run.
  function ChromeCpu { $t = 0.0; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-live*' } | ForEach-Object { try { $t += (Get-Process -Id $_.ProcessId -ErrorAction Stop).TotalProcessorTime.TotalSeconds } catch {} }; $t }
  $cc0 = ChromeCpu
  "--- soak $($Seconds - 10) s ($Preset, $Source, mic=$Mic, native=$Native)"
  "{0,6} {1,10} {2,10} {3,8} {4,6} {5,6} {6,8} {7,8} {8,8}" -f 't(s)', 'server MB', 'chrome MB', 'kbps', 'vfps', 'afps', 'dropped', 'nat fps', 'nat drop'
  while ($sw.Elapsed.TotalSeconds -lt ($Seconds - 10)) {
    Start-Sleep 30
    $st = Invoke-RestMethod 'http://127.0.0.1:8799/api/live/status' -TimeoutSec 5
    "{0,6:N0} {1,10} {2,10} {3,8} {4,6} {5,6} {6,8} {7,8} {8,8}" -f $sw.Elapsed.TotalSeconds, [math]::Round((Get-Process -Id $spid).WorkingSet64 / 1MB), (ChromeMB), $st.stats.kbps, $st.stats.vfps, $st.stats.afps, $st.stats.dropped, $st.native.fps, $st.native.dropped
  }
  $el = $sw.Elapsed.TotalSeconds
  "  {0,-24} {1,5:N1} % of one core" -f 'chrome (all processes)', (100 * ((ChromeCpu) - $cc0) / $el)
} else {
  "--- CPU over $($Seconds - 10) s while streaming ($Preset, $Source, mic=$Mic)"
  & "$S\cpuby.ps1" -Match 'prof-live' -Seconds ($Seconds - 10)
  $el = $sw.Elapsed.TotalSeconds
}
$c1 = (Get-Process -Id $spid).TotalProcessorTime.TotalSeconds
"  {0,-24} {1,5:N1} % of one core" -f 'rig server (python)', (100 * ($c1 - $c0) / $el)
if ($Source -eq 'window' -or $Native) { "--- the captured window's own Chrome (15 s, still streaming)"; & "$S\cpuby.ps1" -Match 'prof-srcwin' -Seconds 15 }
"status at end: " + ((Invoke-RestMethod 'http://127.0.0.1:8799/api/live/status' -TimeoutSec 5) | ConvertTo-Json -Compress)
"page: " + (Ev 'JSON.stringify(liveInfo())' $false)
"chrome $(ChromeMB) MB; server $([math]::Round((Get-Process -Id $spid).WorkingSet64 / 1MB)) MB after"
"stop: " + (Ev 'stopLive()' $false)
Start-Sleep 3
"status after stop: " + ((Invoke-RestMethod 'http://127.0.0.1:8799/api/live/status' -TimeoutSec 5) | ConvertTo-Json -Compress)
if (-not $sink.WaitForExit(15000)) { "sink still running - killing"; $sink.Kill() }
"sink stderr: " + ((Get-Content "$dir\sink_$Preset.err" -ErrorAction SilentlyContinue) -join ' | ')
"--- ffprobe"
& "$ff\ffprobe.exe" -v error -show_entries 'format=duration,bit_rate,size:stream=codec_type,codec_name,profile,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels,bit_rate' -of default=nw=1 $out
$frames = & "$ff\ffprobe.exe" -v error -select_streams v:0 -show_entries frame=key_frame,pts_time -of csv=p=0 $out
$keys = @($frames | Where-Object { $_ -like '1,*' } | ForEach-Object { [double]($_ -split ',')[1] })
$all = @($frames)
"video frames $($all.Count), keyframes $($keys.Count) at: " + (($keys | Select-Object -First 8 | ForEach-Object { '{0:N2}' -f $_ }) -join ' ')
$apts = & "$ff\ffprobe.exe" -v error -select_streams a:0 -show_entries packet=pts_time -of csv=p=0 $out
$vpts = & "$ff\ffprobe.exe" -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 $out
if ($apts) { "first audio pts {0}, first video pts {1}, last audio {2}, last video {3}, audio packets {4}" -f (@($apts)[0]), (@($vpts)[0]), (@($apts)[-1]), (@($vpts)[-1]), (@($apts).Count) }
Kill-Chromes
