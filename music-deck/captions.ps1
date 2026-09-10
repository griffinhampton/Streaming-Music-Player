# Awesome Streaming Deck - live captions bridge.
#
# Listens to the default microphone with Windows' own on-device speech
# recognizer (System.Speech, English) and emits what it hears as JSON lines on
# stdout: a "partial" line while a phrase is still being spoken, then a "final"
# line once it settles. Nothing leaves this machine - no cloud speech service,
# no account, no key. English only, by construction.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File captions.ps1 <parentPid>

param(
    [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
    try {
        [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 3))
        [Console]::Out.Flush()
    } catch { }
}

try {
    Add-Type -AssemblyName System.Speech
} catch {
    Emit @{ ok = $false; error = "Windows speech recognition is not available on this PC: $($_.Exception.Message)" }
    exit 1
}

# English only. Windows ships an English recognizer with the English language
# pack; if it is missing, say exactly where to add it.
$info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
        Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1
if (-not $info) {
    Emit @{ ok = $false; error = "No English speech recognizer is installed. Windows Settings > Time & Language > Speech > add English (United States)." }
    exit 1
}

try {
    $eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
    $eng.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $eng.SetInputToDefaultAudioDevice()
} catch {
    Emit @{ ok = $false; error = "No microphone: $($_.Exception.Message)" }
    exit 1
}

# Settle a phrase soon after the speaker pauses, so the captions keep up
# instead of arriving a sentence late.
$eng.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(500)
$eng.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(900)

# Each handler runs in its own runspace, so it writes to the console itself
# rather than through a function defined out here.
$null = Register-ObjectEvent -InputObject $eng -EventName SpeechHypothesized -Action {
    try {
        $t = [string]$Event.SourceEventArgs.Result.Text
        [Console]::Out.WriteLine((@{ t = 'partial'; text = $t } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    } catch { }
}
$null = Register-ObjectEvent -InputObject $eng -EventName SpeechRecognized -Action {
    try {
        $r = $Event.SourceEventArgs.Result
        [Console]::Out.WriteLine((@{ t = 'final'; text = [string]$r.Text; conf = [math]::Round([double]$r.Confidence, 2) } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    } catch { }
}
$null = Register-ObjectEvent -InputObject $eng -EventName SpeechRecognitionRejected -Action {
    try {
        # The engine gave up on that phrase: clear whatever partial was showing.
        [Console]::Out.WriteLine((@{ t = 'partial'; text = '' } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    } catch { }
}
$null = Register-ObjectEvent -InputObject $eng -EventName AudioStateChanged -Action {
    try {
        $names = @{ 0 = 'stopped'; 1 = 'silence'; 2 = 'speech' }
        [Console]::Out.WriteLine((@{ t = 'audio'; state = $names[[int]$Event.SourceEventArgs.AudioState] } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    } catch { }
}

$eng.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
Emit @{ ok = $true; ready = $true; recognizer = $info.Name; culture = $info.Culture.Name }

# Stay alive while the app that started us is, and leave with it otherwise, so
# a crash or force-quit never orphans a listening microphone.
while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
}
try { $eng.RecognizeAsyncCancel(); $eng.Dispose() } catch { }
