# Run from any directory after pairing. Stops when this user signs out.
$recorderRoot = Split-Path -Parent $PSScriptRoot
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$recorderScript = Join-Path $PSScriptRoot 'cli.mjs'
$recorderLogDirectory = if ($env:CASA_RECORDER_HOME) { [System.IO.Path]::GetFullPath($env:CASA_RECORDER_HOME) } else { Join-Path $recorderRoot '.local\recorder' }
if (-not (Test-Path -LiteralPath (Join-Path $recorderLogDirectory 'config.json'))) {
  throw 'Pair the recorder first with npm run recorder -- pair.'
}
Start-Process -FilePath $nodeExecutable -ArgumentList @(('"' + $recorderScript + '"'), 'start') -WorkingDirectory $recorderRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $recorderLogDirectory 'service.log') -RedirectStandardError (Join-Path $recorderLogDirectory 'service-error.log')
Write-Output 'Recorder started in the background. Use its agent.lock PID to identify the process when stopping it.'
