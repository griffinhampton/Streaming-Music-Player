# Awesome Streaming Deck - text to speech helper (T7).
#
# Windows' own on-device voices (System.Speech): no download, no account, and
# nothing leaves this machine. It reads one JSON request per line on stdin and
# answers each with one JSON line on stdout.
#
# It never plays anything itself. Each utterance comes back as a WAV, and the
# Voice layer on the scene on air plays it - so the layer's volume, Stop
# effects and Skip all apply to it, which they could not to sound made here.
#
#   {"op":"voices"}                                      -> {"ok":true,"op":"voices","voices":[...]}
#   {"op":"say","id":"x","text":"...","voice":"","rate":0} -> {"ok":true,"op":"say","id":"x","wav":"<base64>"}
#
# Speak() is the plain-text call, never SpeakSsml(): the text is a viewer's,
# and markup in it is read out as the characters it is, not obeyed.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tts.ps1 <parentPid>

param(
    [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
    try {
        [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
        [Console]::Out.Flush()
    } catch { }
}

try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
} catch {
    Emit @{ ok = $false; ready = $false; error = "Windows text to speech is not available on this PC: $($_.Exception.Message)" }
    exit 1
}

# What an empty voice means: whatever Windows was set to when this started,
# so a request that names no voice goes back to it after one that did.
$default = $synth.Voice.Name
Emit @{ ok = $true; ready = $true; voice = $default }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { exit 0 }            # the app closed our stdin: it has gone
    if (-not $line.Trim()) { continue }
    try { $req = $line | ConvertFrom-Json } catch { continue }

    if ($req.op -eq 'voices') {
        $list = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
            @{ name = $_.VoiceInfo.Name; culture = [string]$_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender }
        })
        Emit @{ ok = $true; op = 'voices'; voices = $list; default = $default }
        continue
    }

    if ($req.op -eq 'say') {
        $ms = New-Object System.IO.MemoryStream
        try {
            $want = if ($req.voice) { [string]$req.voice } else { $default }
            # An unknown name keeps the current voice rather than failing the line.
            try { $synth.SelectVoice($want) } catch { }
            $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$req.rate))
            $synth.SetOutputToWaveStream($ms)
            $synth.Speak([string]$req.text)
            $synth.SetOutputToNull()
            Emit @{ ok = $true; op = 'say'; id = [string]$req.id; wav = [Convert]::ToBase64String($ms.ToArray()) }
        } catch {
            try { $synth.SetOutputToNull() } catch { }
            Emit @{ ok = $false; op = 'say'; id = [string]$req.id; error = $_.Exception.Message }
        } finally {
            $ms.Dispose()
        }
    }
}
