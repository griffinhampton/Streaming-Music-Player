# Rebuild the app from the repo, keeping everything the user owns in place.
#
# The build goes to a staging folder (dist-staging, git-ignored) while the app
# keeps running, and is tried there on its own port (8797) - pages, scenes,
# export and import - before it replaces anything. Only then is the app asked
# to quit and the new program files mirrored over the old ones. The app's
# config.json and cache\ (settings, scenes, the saved stream key, pictures,
# fonts, models, the Chrome profile) are never moved, copied over or deleted;
# a safety copy of the settings and the small parts of the cache is still
# made first, into <repo>\.rig\backups\<time>.
#
#   rebuild.ps1              build, try, swap in, relaunch
#   rebuild.ps1 -NoLaunch    build, try, swap in; the app is left closed (no window opens)
#   rebuild.ps1 -CheckOnly   build and try it; the app is not touched
param([switch]$CheckOnly, [switch]$NoLaunch)
$ErrorActionPreference = 'Continue'
$R = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)     # music-deck
$root = Split-Path -Parent $R                                    # the repository
$app = Join-Path $root 'dist\Awesome Streaming Deck'
$stage = Join-Path $root 'dist-staging'
$built = Join-Path $stage 'Awesome Streaming Deck'
$S = Join-Path $root '.rig'                                      # the Whisper model and cuBLAS wheel kept for seeding, the backups
$venv = Join-Path $root '.build-env'
$TRY = 8797

# 1. build into the staging folder (the app keeps running meanwhile)
Set-Location $R
# --no-index: never download here; a missing package fails this line, and the try-out below says so.
& "$venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check --no-index -r requirements.txt
$themes = @()
if (Test-Path (Join-Path $root 'built in themes')) { $themes = @('--add-data', "$root\built in themes;builtin") }
$sw = [Diagnostics.Stopwatch]::StartNew()
& "$venv\Scripts\pyinstaller.exe" --noconfirm --clean --onedir --noconsole `
    --name 'Awesome Streaming Deck' --icon "$R\music-deck.ico" --version-file "$R\version.txt" `
    --add-data "$R\web;web" --add-data "$R\smtc.ps1;." --add-data "$R\captions.ps1;." `
    --add-data "$R\music-deck.ico;." @themes `
    --hidden-import tkinter --hidden-import tkinter.filedialog --hidden-import tkinter.messagebox `
    --collect-binaries ctranslate2 --collect-data faster_whisper `
    --exclude-module av --exclude-module hf_xet `
    --distpath $stage --workpath "$venv\work" --specpath "$venv" server.py *>&1 |
    Select-String -Pattern 'ERROR|Traceback|completed successfully|Build complete' |
    Select-Object -Last 10 | ForEach-Object { $_.Line }
Write-Host ("BUILD EXIT {0} after {1:n0}s" -f $LASTEXITCODE, $sw.Elapsed.TotalSeconds)
if (-not (Test-Path (Join-Path $built 'Awesome Streaming Deck.exe'))) { throw 'no exe was built - the app was left as it was' }

# 2. what went in
foreach ($p in 'web\canvas.html', 'web\livepanel.js', 'web\remote.html', 'web\studio.js', 'web\newscene.js', 'web\scene.js',
               'smtc.ps1', 'captions.ps1', 'ctranslate2\ctranslate2.dll', 'faster_whisper\assets\silero_vad_v6.onnx', 'builtin') {
    Write-Host ("  {0,-44} {1}" -f $p, (Test-Path (Join-Path $built "_internal\$p")))
}

# 3. try the build before it replaces anything: on its own port, no windows
Set-Content -Encoding ascii (Join-Path $built 'config.json') "{`"port`": $TRY}"
$p = Start-Process (Join-Path $built 'Awesome Streaming Deck.exe') -ArgumentList '--no-browser', '--no-open' -WorkingDirectory $built -PassThru
$B = "http://127.0.0.1:$TRY"
foreach ($i in 1..40) { Start-Sleep 1; try { Invoke-WebRequest "$B/api/state" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { } }
$res = [ordered]@{}
foreach ($u in '/deck.html', '/canvas.html', '/remote.html', '/scene.html', '/api/scenes', '/api/scenes/templates', '/api/live/status', '/api/capture/sources', '/api/assets', '/fonts.css') {
    try { $res[$u] = (Invoke-WebRequest "$B$u" -UseBasicParsing -TimeoutSec 8).StatusCode } catch { $res[$u] = $_.Exception.Message }
}
try {
    # a scene made from a template, exported as a .zip and imported again - by the build itself
    $made = Invoke-RestMethod -Method Post "$B/api/scenes" -ContentType 'application/json' -Body '{"template": "just_chatting", "name": "Build check"}' -TimeoutSec 10
    $zip = (Invoke-WebRequest "$B/api/scenes/$($made.scene.id)/export" -UseBasicParsing -TimeoutSec 10).Content
    $body = @{ data = 'data:application/zip;base64,' + [Convert]::ToBase64String($zip); name = 'Build check (imported)' } | ConvertTo-Json
    $back = Invoke-RestMethod -Method Post "$B/api/scenes/import" -ContentType 'application/json' -Body $body -TimeoutSec 20
    $res['export + import'] = $(if ($back.ok -and $back.scene.layers.Count -eq $made.scene.layers.Count) { 200 } else { "import said: $($back.reason)" })
} catch { $res['export + import'] = $_.Exception.Message }
try { Invoke-WebRequest -Method Post "$B/api/quit" -UseBasicParsing -TimeoutSec 3 | Out-Null } catch { }
Start-Sleep 3
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dist-staging*' -and $_.CommandLine -notlike '*Get-CimInstance*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$res.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-26} {1}" -f $_.Key, $_.Value) }
$bad = @($res.Values | Where-Object { $_ -ne 200 })
if ($bad.Count) { throw 'the new build did not pass its try-out - the app was left as it was' }
Write-Host 'the new build passed its try-out'
if ($CheckOnly) { Write-Host 'check only: the app was not touched'; exit 0 }

# 4. a safety copy: the settings, and the cache but for what can be made again
$bk = Join-Path $S ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force (Join-Path $bk 'cache') | Out-Null
if (Test-Path (Join-Path $app 'config.json')) { Copy-Item (Join-Path $app 'config.json') $bk -Force }
Get-ChildItem (Join-Path $app 'cache') -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notin @('models', 'cuda') -and $_.Name -notlike 'chrome*' -and $_.Name -notlike 'prof*' } |
    ForEach-Object { Copy-Item $_.FullName (Join-Path $bk "cache\$($_.Name)") -Recurse -Force }
Write-Host "safety copy: $((Get-ChildItem $bk -Recurse -File).Count) files in $bk"

# 5. remember which overlay windows are open, to reopen them after the relaunch
$openWins = @()
foreach ($w in 'window', 'lyrics/window', 'queue/window', 'captions/window') {
    try { if ((Invoke-RestMethod "http://127.0.0.1:8713/api/$w/status" -TimeoutSec 3).open) { $openWins += $w } } catch { }
}
Write-Host ('open before rebuild: ' + $(if ($openWins.Count) { $openWins -join ' ' } else { 'none' }))

# 6. quit the app and anything it left behind
try {
    Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:8713/api/quit' -UseBasicParsing -TimeoutSec 3 | Out-Null
    Write-Host 'asked the app to quit'
} catch { Write-Host "quit: $($_.Exception.Message)" }
Start-Sleep 3
Get-Process -Name 'Awesome Streaming Deck' -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -notlike '*Get-CimInstance*' -and (
        ($_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*Awesome Streaming Deck\cache\chrome*') -or
        ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*dist\Awesome Streaming Deck*' -and ($_.CommandLine -like '*smtc.ps1*' -or $_.CommandLine -like '*captions.ps1*')))
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2

# 7. the new program files over the old; config.json and cache\ are left exactly where they are
#    (excluded by full path: a bare name would also skip package files called config.json)
New-Item -ItemType Directory -Force $app | Out-Null
robocopy $built $app /MIR /XD (Join-Path $built 'cache') (Join-Path $app 'cache') `
    /XF (Join-Path $built 'config.json') (Join-Path $app 'config.json') /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
$rc = $LASTEXITCODE
Write-Host "robocopy exit $rc (below 8 is success)"
if ($rc -ge 8) { throw "copying the new build failed - nothing of yours was touched; the safety copy is in $bk" }

# 8. the Whisper model and NVIDIA's cuBLAS, if the app had not got them yet (both approved before)
if (-not (Test-Path (Join-Path $app 'cache\models\base.en\manifest.json')) -and (Test-Path (Join-Path $S 'models\base.en'))) {
    New-Item -ItemType Directory -Force (Join-Path $app 'cache\models') | Out-Null
    Copy-Item (Join-Path $S 'models\base.en') (Join-Path $app 'cache\models\base.en') -Recurse -Force
}
$wheel = Join-Path $S 'cuda-wheels\nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl'
if ((Test-Path $wheel) -and -not (Test-Path (Join-Path $app 'cache\cuda\cublas-12.9.2.10\manifest.json'))) {
    $py = "import sys; sys.path.insert(0, r'$R'); import gpu; " +
          "s = gpu.GpuStore(r'$app\cache\cuda'); s.install_wheel(r'$wheel'); print('cuda ready:', s.path())"
    & "$venv\Scripts\python.exe" -c $py
}
$sz = (Get-ChildItem $app -Recurse -File | Where-Object { $_.FullName -notlike '*\cache\*' } | Measure-Object Length -Sum).Sum
Write-Host ("app folder without cache: {0:n0} MB" -f ($sz / 1MB))

# 9. relaunch, and reopen the overlay windows that were open before
if ($NoLaunch) { Write-Host 'no launch: the app is rebuilt and left closed'; exit 0 }
Start-Process -FilePath (Join-Path $app 'Awesome Streaming Deck.exe') -WorkingDirectory $app
$ok = $false
foreach ($i in 1..40) {
    Start-Sleep 1
    try { if ((Invoke-WebRequest 'http://127.0.0.1:8713/api/state' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ok = $true; break } } catch { }
}
Write-Host "app up: $ok after ${i}s"
foreach ($w in $openWins) {
    Start-Sleep -Milliseconds 800
    try { Invoke-RestMethod -Method Post "http://127.0.0.1:8713/api/$w/open" -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null; Write-Host "reopened $w" }
    catch { Write-Host "reopen $w failed: $($_.Exception.Message)" }
}
