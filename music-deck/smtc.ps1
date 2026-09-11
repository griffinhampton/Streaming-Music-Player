# Awesome Streaming Deck - Windows media-session bridge.
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
$artUntil = Get-Date
$artTried = [datetime]::MinValue
$lastSig = ''                          # what was last reported, minus the clock
$lastEmit = [datetime]::MinValue
$playingNow = $false

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

        $md5 = [System.Security.Cryptography.MD5]::Create()
        $safe = [System.BitConverter]::ToString(
            $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))).Replace('-', '').Substring(0, 12)
        # The picture's own hash is part of the name, so a cover that arrives
        # late - or replaces a stand-in - gets a new address, and every window
        # loads it instead of keeping the first picture it cached.
        $sum = [System.BitConverter]::ToString($md5.ComputeHash($bytes)).Replace('-', '').Substring(0, 8)

        $path = Join-Path $ArtDir "smtc_${safe}_$sum.$ext"
        if (-not (Test-Path $path)) {
            [System.IO.File]::WriteAllBytes($path, $bytes)

            # Keep the art folder from growing forever.
            $old = Get-ChildItem $ArtDir -Filter 'smtc_*' -ErrorAction SilentlyContinue |
                   Sort-Object LastWriteTime -Descending | Select-Object -Skip 40
            foreach ($f in $old) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }
        }

        return $path
    } catch {
        return ''
    }
}

# ---- Commands from the deck ----------------------------------------------
function Invoke-Command-File($session) {
    if (-not [System.IO.File]::Exists($CmdFile)) { return }
    try {
        $raw = [string](Get-Content $CmdFile -Raw -ErrorAction Stop)
        Remove-Item $CmdFile -Force -ErrorAction SilentlyContinue
        # One command per line: a press and a pace change can arrive together.
        foreach ($line in ($raw -split "`n")) {
            $cmd = $line.Trim().ToLower()
            if (-not $cmd) { continue }
            if ($cmd -match '^interval ([0-9]+)$') {
                # Ultra optimized reads Windows once a second while music plays.
                $script:IntervalMs = [Math]::Max(100, [int]$Matches[1])
                continue
            }
            if (-not $session) { continue }
            switch ($cmd) {
                'play'       { AwaitVoid ($session.TryPlayAsync()) }
                'pause'      { AwaitVoid ($session.TryPauseAsync()) }
                'playpause'  { AwaitVoid ($session.TryTogglePlayPauseAsync()) }
                'next'       { AwaitVoid ($session.TrySkipNextAsync()) }
                'prev'       { AwaitVoid ($session.TrySkipPreviousAsync()) }
            }
        }
    } catch { }
}

# ---- Main loop ------------------------------------------------------------
$statusNames = @{ 0 = 'Closed'; 1 = 'Opened'; 2 = 'Changing'; 3 = 'Stopped'; 4 = 'Playing'; 5 = 'Paused' }

while ($true) {
    # If the app that started us is gone - crashed, force-quit, whatever - go
    # too. Otherwise we orphan, keep polling forever, and hold the install
    # folder open so the next update cannot replace it.
    if ($ParentPid -gt 0) {
        $alive = $true
        try { [void][System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { $alive = $false }
        if (-not $alive) { break }
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
            $playingNow = $false
            if ($lastSig -ne 'none' -or ((Get-Date) - $lastEmit).TotalSeconds -ge 3) {
                Emit @{ ok = $true; has = $false }
                $lastSig = 'none'
                $lastEmit = Get-Date
            }
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
                $lastKey = $key
                $lastArt = ''
                $artUntil = (Get-Date).AddSeconds(15)
            }
            # Spotify often hands Windows the title first and the cover a
            # moment later - sometimes a stand-in picture first, then the real
            # one. Reading the cover only at the change left whole songs with
            # no cover, so keep looking for a while after each change.
            if ((Get-Date) -lt $artUntil -and ((Get-Date) - $artTried).TotalMilliseconds -ge 900) {
                $artTried = Get-Date
                $found = Save-Thumbnail $props $key
                if ($found) { $lastArt = $found }
            }

            $status = [int]$info.PlaybackStatus
            $controls = $info.Controls

            $pos = 0.0
            $dur = 0.0
            $age = 0.0
            try {
                $pos = [double]$tl.Position.TotalSeconds
                $dur = [double]($tl.EndTime.TotalSeconds - $tl.StartTime.TotalSeconds)
                # Spotify only refreshes the timeline every few seconds, and a
                # browser (YouTube in Chrome) only on play, pause or seek; report
                # how stale it is so the deck can extrapolate the progress bar.
                # Only a nonsense stamp (in the future, or older than a day - an
                # app that never set one) is thrown away: capping it at two
                # minutes snapped a YouTube video's clock back to its last seek.
                $age = [double]((Get-Date).ToUniversalTime() - $tl.LastUpdatedTime.UtcDateTime).TotalSeconds
                if ($age -lt 0 -or $age -gt 86400) { $age = 0 }
            } catch { }

            # Report only what changed, plus a heartbeat every 3 s. The
            # timeline's age grows on every poll but the server works that
            # out itself from when the last report arrived, so it is not a
            # change worth a report.
            $playingNow = ($status -eq 4)
            $sig = "$key|$status|$([math]::Round($pos, 1))|$([math]::Round($dur, 1))|$lastArt|$($controls.IsNextEnabled)|$($controls.IsPreviousEnabled)|$($controls.IsPauseEnabled)|$($controls.IsPlayEnabled)"
            if ($sig -ne $lastSig -or ((Get-Date) - $lastEmit).TotalSeconds -ge 3) {
            $lastSig = $sig
            $lastEmit = Get-Date
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
        }
    } catch {
        Emit @{ ok = $true; has = $false; warn = "$($_.Exception.Message)" }
    }

    # Poll briskly while music plays and gently otherwise, but look for a
    # command from the deck in between so a press never waits long: every
    # 100 ms, or every 250 in ultra optimized. Plain .NET calls rather than
    # Test-Path and Start-Sleep, whose cmdlet overhead was most of this
    # helper's CPU at ten checks a second.
    $wait = if ($playingNow) { $IntervalMs } else { 1000 }
    $slice = if ($IntervalMs -ge 1000) { 250 } else { 100 }
    for ($t = 0; $t -lt $wait; $t += $slice) {
        if ([System.IO.File]::Exists($CmdFile)) { break }
        [System.Threading.Thread]::Sleep($slice)
    }
}
