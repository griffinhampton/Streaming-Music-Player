# The test rig: an isolated copy of the app on port 8799, in <repo>\.rig\testrig
# (git-ignored, beside the repo - not in a temp folder a cleanup can empty).
# Every restart copies the repo's *.py and web\ in (-NoSync keeps what is
# there), keeps the rig's windows off the main monitor (rigpos.py), and starts
# the server detached, so a test tool's time limit cannot kill it. A missing
# rig is made: a folder with a config.json on port 8799.
# Stops first: a rig server, the rig's and the tests' Chrome, and the tests'
# local RTMP listeners (ffmpeg on 127.0.0.1:1935) - nothing else.
param([switch]$NoSync)
$R = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)     # music-deck
$root = Split-Path -Parent $R                                    # the repository
$S = Join-Path $root '.rig'
$rig = Join-Path $S 'testrig'
$py = Join-Path $root '.build-env\Scripts\python.exe'
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -notlike '*Get-CimInstance*' -and (
    ($_.Name -eq 'python.exe' -and $_.CommandLine -like '*server.py*' -and $_.CommandLine -notlike '*streaming stuff\music-deck*') -or
    ($_.Name -eq 'chrome.exe' -and ($_.CommandLine -like '*testrig*' -or $_.CommandLine -like '*prof-*')) -or
    ($_.Name -eq 'ffmpeg.exe' -and $_.CommandLine -like '*rtmp://127.0.0.1:1935*')) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2
if (-not (Test-Path (Join-Path $rig 'config.json'))) {
    New-Item -ItemType Directory -Force (Join-Path $rig 'web') | Out-Null
    Set-Content -Encoding ascii (Join-Path $rig 'config.json') '{"port": 8799}'
    "made a new rig in $rig"
}
if (-not $NoSync) {
    Get-ChildItem "$R\*.py" | ForEach-Object { Copy-Item $_.FullName (Join-Path $rig $_.Name) -Force }
    Copy-Item "$R\web\*" (Join-Path $rig 'web') -Recurse -Force
}
& $py (Join-Path $PSScriptRoot 'rigpos.py') $rig
$p = Start-Process $py -ArgumentList '-u', 'server.py', '--no-open' -WorkingDirectory $rig -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $S 'rig.log') -RedirectStandardError (Join-Path $S 'rig.err') -PassThru
for ($i = 0; $i -lt 30; $i++) { Start-Sleep 1; try { Invoke-RestMethod 'http://127.0.0.1:8799/api/live/status' -TimeoutSec 2 | Out-Null; "rig up (launcher pid $($p.Id)) after $($i+1)s"; exit 0 } catch {} }
"rig did not come up"; Get-Content (Join-Path $S 'rig.err') -Tail 20
