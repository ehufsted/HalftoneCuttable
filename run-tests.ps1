# Runs the verification harness headless, with no installs: serves the repo
# with serve.ps1, loads verify.html in headless Chrome (or Edge), and prints
# the results as text.
#
#   powershell -ExecutionPolicy Bypass -File run-tests.ps1
#   powershell -ExecutionPolicy Bypass -File run-tests.ps1 -Only core.relief,pipeline
#
# Exits 0 when every check passes, 1 when any fails or a section throws, 2
# when it cannot run (no browser, or the server did not start).
#
#   -Only     sections to run, comma-separated (as verify.html?only=...)
#   -Port     port for the local server (default 8091, so it does not clash
#             with a serve.ps1 already running on 8080)
#   -Browser  path to chrome.exe or msedge.exe, if not in a usual place

param(
  [string]$Only = '',
  [int]$Port = 8091,
  [string]$Browser = ''
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Browser) {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  $Browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $Browser -or -not (Test-Path $Browser)) {
  Write-Host 'No Chrome or Edge found; pass -Browser <path to chrome.exe or msedge.exe>.'
  exit 2
}

$server = Start-Job -ScriptBlock {
  param($r, $p) powershell -NoProfile -ExecutionPolicy Bypass -File "$r\serve.ps1" -Port $p
} -ArgumentList $root, $Port
$profileDir = Join-Path $env:TEMP ("hc-tests-" + [guid]::NewGuid().ToString('N'))
$code = 2
try {
  # wait until the server answers, up to 15 s
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$Port/verify.html" | Out-Null
      $up = $true
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $up) { Write-Host "The test server did not start on port $Port."; exit 2 }

  $url = "http://localhost:$Port/verify.html"
  if ($Only) { $url += "?only=$Only" }
  # virtual time runs the page's work to completion before the DOM is dumped
  $html = & $Browser --headless=new --disable-gpu --no-first-run --no-default-browser-check `
    "--user-data-dir=$profileDir" --virtual-time-budget=900000 --dump-dom $url 2>$null | Out-String

  $m = [regex]::Match($html, '(?s)<div id="out">(.*?)</div>\s*<script')
  $body = if ($m.Success) { $m.Groups[1].Value } else { $html }
  $text = $body -replace '</(p|h2|pre)>', "`n" -replace '<[^>]+>', '' `
    -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&amp;', '&'
  # (the page's own "N sections in T s" line is left out: under virtual time
  # its clock reads 0)
  $lines = $text -split "`n" | ForEach-Object { $_.TrimEnd() } |
    Where-Object { $_ -and $_ -notmatch '^\d+ sections in [\d.]+ s\.$' }
  $lines | ForEach-Object { Write-Host $_ }

  $summary = $lines | Where-Object { $_ -match '^(\d+) passed, (\d+) failed$' } | Select-Object -Last 1
  if (-not $summary) {
    Write-Host 'No summary: a section threw, or the page did not finish.'
    $code = 1
  } elseif ($summary -eq '0 passed, 0 failed') {
    Write-Host "No checks ran: is '$Only' a section name? See tests/index.js."
    $code = 2
  } elseif ($summary -match ', 0 failed$') {
    $code = 0
  } else {
    $code = 1
  }
} finally {
  Stop-Job $server -ErrorAction SilentlyContinue
  Remove-Job $server -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}
exit $code
