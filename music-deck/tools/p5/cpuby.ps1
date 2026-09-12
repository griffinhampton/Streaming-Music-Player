param([string]$Match, [int]$Seconds = 10)
# CPU of every process whose command line contains $Match, grouped by Chrome
# process type (browser, renderer, gpu-process, utility ...), plus dwm.exe for
# the whole system - measured over $Seconds, in % of one core.
#   powershell -File cpuby.ps1 -Match prof-deck -Seconds 10
# Used by deckidle.sh / deckstill.sh. Numbers mean nothing while the screen is off.
$ids = @{}
foreach ($p in Get-CimInstance Win32_Process) {
  $cl = [string]$p.CommandLine
  if ($cl -and $cl.Contains($Match) -and $p.ProcessId -ne $PID) {
    $t = 'browser'
    if ($cl -match '--type=([a-z-]+)') {
      $t = $Matches[1]
      if ($cl -match '--utility-sub-type=([A-Za-z.]+)') { $t = "$t " + $Matches[1].Split('.')[-1] }
    }
    if ($p.Name -ne 'chrome.exe') { $t = $p.Name }
    $ids[[int]$p.ProcessId] = $t
  }
}
$c0 = @{}
foreach ($id in $ids.Keys) { try { $c0[$id] = (Get-Process -Id $id -ErrorAction Stop).TotalProcessorTime.TotalSeconds } catch {} }
$d0 = $null
try { $d0 = (Get-Process dwm -ErrorAction Stop | Select-Object -First 1).TotalProcessorTime.TotalSeconds } catch {}
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$el = $sw.Elapsed.TotalSeconds
$by = @{}; $tot = 0.0
foreach ($id in $ids.Keys) {
  try { $c1 = (Get-Process -Id $id -ErrorAction Stop).TotalProcessorTime.TotalSeconds } catch { continue }
  if ($c0.ContainsKey($id)) { $d = $c1 - $c0[$id]; $by[$ids[$id]] = [double]$by[$ids[$id]] + $d; $tot += $d }
}
foreach ($k in ($by.Keys | Sort-Object)) { "  {0,-24} {1,5:N1} % of one core" -f $k, (100 * $by[$k] / $el) }
"  {0,-24} {1,5:N1} % of one core" -f 'TOTAL', (100 * $tot / $el)
if ($null -ne $d0) {
  try { $d1 = (Get-Process dwm | Select-Object -First 1).TotalProcessorTime.TotalSeconds; "  {0,-24} {1,5:N1} % of one core" -f 'dwm.exe (whole system)', (100 * ($d1 - $d0) / $el) } catch {}
}
