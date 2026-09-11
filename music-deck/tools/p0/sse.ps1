# P0: Chrome's per-host connection cap vs our SSE feed. Fresh profile with a
# DevTools port so each page's own verdict (in its title) can be read back.
$S = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
$prof = "$S\prof-p0s"
$flags = @('--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,Translate', '--force-device-scale-factor=1',
  '--remote-debugging-port=9445', "--user-data-dir=$prof")
function Conns { @(Get-NetTCPConnection -RemotePort 8799 -State Established -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' }) }
function KillS { Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*prof-p0s*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 1 }
KillS
if (Test-Path $prof) { Remove-Item -Recurse -Force $prof }
$c0 = (Conns).Count
"established connections to 8799 before: $c0 (the rig's own open windows)"
"== one page with 8 EventSources"
Start-Process $chrome -ArgumentList (@('--app=http://127.0.0.1:8799/p0-sse.html?n=8', '--window-size=900,400', '--window-position=1300,900') + $flags)
Start-Sleep 9
& node "$S\cdp.js" 9445 x --titles
$c = Conns; "established connections to 8799 now: $($c.Count) (+$($c.Count - $c0))"
KillS; Start-Sleep 2
"== 8 windows, one EventSource each, same profile"
for ($i = 1; $i -le 8; $i++) {
  Start-Process $chrome -ArgumentList (@("--app=http://127.0.0.1:8799/p0-sse.html?n=1&w=$i", '--window-size=520,180', "--window-position=$(1300 + 30 * $i),$(700 + 24 * $i)") + $flags)
  Start-Sleep -Milliseconds 800
}
Start-Sleep 9
& node "$S\cdp.js" 9445 x --titles
$c = Conns; "established connections to 8799 now: $($c.Count) (+$($c.Count - $c0))"
"per owning process: " + (($c | Group-Object OwningProcess | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ' ')
KillS
