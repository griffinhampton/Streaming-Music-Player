# Awesome Music Streaming Deck - Windows media-session bridge.
#
# Reads the "now playing" info that Spotify (and Chrome, VLC, Apple Music,
# anything else) publishes to Windows itself. Everything stays on this machine:
# no Spotify login, no API keys, no network calls.
#
# Emits one compact JSON line per tick on stdout. Reads single-word commands
# (play / pause / next / prev) from a file so the deck can drive playback
# without spawning a new PowerShell for every button press.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File smtc.ps1 <artDir> <cmdFile>

param(
    [string]$ArtDir = "$PSScriptRoot\cache\art",
    [string]$CmdFile = "$PSScriptRoot\cache\command.txt",
    [int]$IntervalMs = 400,
    [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
    try {
        [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
        [Console]::Out.Flush()
    } catch { }
}

# ---- WinRT async plumbing -------------------------------------------------
# PowerShell can't 'await' a WinRT IAsyncOperation directly, so we reach for
# WindowsRuntimeSystemExtensions.AsTask via reflection and block on the Task.
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

    if (-not $asTaskGeneric) { throw "AsTask overload not found" }

    # The thumbnail stream comes back as a bare COM object that PowerShell's
    # parameter binder refuses to cast, so it gets handed to .NET by reflection.
    $asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1
    if (-not $asStreamForRead) { throw "AsStreamForRead not found" }
} catch {
    Emit @{ ok = $false; error = "WinRT unavailable: $($_.Exception.Message)" }
    exit 1
}

function Await($op, $type) {
    $asTask = $asTaskGeneric.MakeGenericMethod($type)
    $task = $asTask.Invoke($null, @($op))
    $task.Wait(4000) | Out-Null
    if ($task.IsFaulted) { throw $task.Exception }
    $task.Result
}

function AwaitVoid($op) {
    # IAsyncAction has no result; poll its status instead.
    $deadline = (Get-Date).AddSeconds(3)
    while ($op.Status -eq 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }
}

# ---- Session manager ------------------------------------------------------
try {
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
    $mgr = Await ($mgrType::RequestAsync()) ($mgrType)
} catch {
    Emit @{ ok = $false; error = "Media session API unavailable: $($_.Exception.Message)" }
    exit 1
}

New-Item -ItemType Directory -Force -Path $ArtDir | Out-Null
Emit @{ ok = $true; ready = $true }

$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]

$lastKey = ''
$lastArt = ''

# ---- Cover art ------------------------------------------------------------
function Save-Thumbnail($props, $key) {
    try {
        $ref = $props.Thumbnail
        if (-not $ref) { return '' }

        $stream = Await ($ref.OpenReadAsync()) ($streamType)
        if (-not $stream) { return '' }

        $netStream = $asStreamForRead.Invoke($null, @($stream))
        $ms = New-Object System.IO.MemoryStream
        $netStream.CopyTo($ms)
        $bytes = $ms.ToArray()
        $ms.Dispose()
        $netStream.Dispose()
        if ($bytes.Length -lt 100) { return '' }

        $ext = 'jpg'
        if ($bytes.Length -gt 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $ext = 'png' }

        $safe = [System.BitConverter]::ToString(
            [System.Security.Cryptography.MD5]::Create().ComputeHash(
                [System.Text.Encoding]::UTF8.GetBytes($key))).Replace('-', '').Substring(0, 12)

        $path = Join-Path $ArtDir "smtc_$safe.$ext"
        [System.IO.File]::WriteAllBytes($path, $bytes)

        # Keep the art folder from growing forever.
        $old = Get-ChildItem $ArtDir -Filter 'smtc_*' -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -Skip 40
        foreach ($f in $old) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }

        return $path
    } catch {
        return ''
    }
}

# ---- Commands from the deck ----------------------------------------------
function Invoke-Command-File($session) {
    if (-not (Test-Path $CmdFile)) { return }
    try {
        $cmd = (Get-Content $CmdFile -Raw -ErrorAction Stop).Trim().ToLower()
        Remove-Item $CmdFile -Force -ErrorAction SilentlyContinue
        if (-not $session -or -not $cmd) { return }
        switch ($cmd) {
            'play'       { AwaitVoid ($session.TryPlayAsync()) }
            'pause'      { AwaitVoid ($session.TryPauseAsync()) }
            'playpause'  { AwaitVoid ($session.TryTogglePlayPauseAsync()) }
            'next'       { AwaitVoid ($session.TrySkipNextAsync()) }
            'prev'       { AwaitVoid ($session.TrySkipPreviousAsync()) }
        }
    } catch { }
}

# ---- Main loop ------------------------------------------------------------
$statusNames = @{ 0 = 'Closed'; 1 = 'Opened'; 2 = 'Changing'; 3 = 'Stopped'; 4 = 'Playing'; 5 = 'Paused' }

while ($true) {
    # If the app that started us is gone - crashed, force-quit, whatever - go
    # too. Otherwise we orphan, keep polling forever, and hold the install
    # folder open so the next update cannot replace it.
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        break
    }
    try {
        $session = $null
        $preferred = $null

        try {
            foreach ($s in $mgr.GetSessions()) {
                if ($s.SourceAppUserModelId -match 'spotify') { $preferred = $s; break }
            }
        } catch { }

        $current = $null
        try { $current = $mgr.GetCurrentSession() } catch { }

        # Prefer whichever Spotify session exists, but let an actively playing
        # foreground session (a YouTube tab, say) win if Spotify is paused.
        $session = $current
        if ($preferred) {
            $session = $preferred
            if ($current -and $current.SourceAppUserModelId -ne $preferred.SourceAppUserModelId) {
                try {
                    if ($preferred.GetPlaybackInfo().PlaybackStatus -ne 4 -and
                        $current.GetPlaybackInfo().PlaybackStatus -eq 4) {
                        $session = $current
                    }
                } catch { }
            }
        }

        Invoke-Command-File $session

        if (-not $session) {
            Emit @{ ok = $true; has = $false }
        } else {
            $props = Await ($session.TryGetMediaPropertiesAsync()) ($propsType)
            $info = $session.GetPlaybackInfo()
            $tl = $session.GetTimelineProperties()

            $title = if ($props) { [string]$props.Title } else { '' }
            $artist = if ($props) { [string]$props.Artist } else { '' }
            $album = if ($props) { [string]$props.AlbumTitle } else { '' }
            $app = [string]$session.SourceAppUserModelId

            $key = "$app|$artist|$title|$album"
            if ($key -ne $lastKey) {
                $lastArt = Save-Thumbnail $props $key
                $lastKey = $key
            }

            $status = [int]$info.PlaybackStatus
            $controls = $info.Controls

            $pos = 0.0
            $dur = 0.0
            $age = 0.0
            try {
                $pos = [double]$tl.Position.TotalSeconds
                $dur = [double]($tl.EndTime.TotalSeconds - $tl.StartTime.TotalSeconds)
                # Spotify only refreshes the timeline every few seconds; report how
                # stale it is so the deck can extrapolate a smooth progress bar.
                $age = [double]((Get-Date).ToUniversalTime() - $tl.LastUpdatedTime.UtcDateTime).TotalSeconds
                if ($age -lt 0 -or $age -gt 120) { $age = 0 }
            } catch { }

            Emit @{
                ok       = $true
                has      = $true
                app      = $app
                title    = $title
                artist   = $artist
                album    = $album
                status   = $statusNames[$status]
                playing  = ($status -eq 4)
                position = [math]::Round($pos, 2)
                duration = [math]::Round($dur, 2)
                age      = [math]::Round($age, 2)
                art      = $lastArt
                canNext  = [bool]$controls.IsNextEnabled
                canPrev  = [bool]$controls.IsPreviousEnabled
                canPause = [bool]$controls.IsPauseEnabled
                canPlay  = [bool]$controls.IsPlayEnabled
            }
        }
    } catch {
        Emit @{ ok = $true; has = $false; warn = "$($_.Exception.Message)" }
    }

    Start-Sleep -Milliseconds $IntervalMs
}
