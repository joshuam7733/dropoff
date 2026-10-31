# Restarts the local dev backend in the background (logs: devserver\.server.log / .server.err).
$here = $PSScriptRoot
$node = Join-Path $here '..\tools\node\node.exe'
if (Test-Path "$here\.server.pid") { try { Stop-Process -Id (Get-Content "$here\.server.pid") -Force -ErrorAction Stop } catch {} }
$p = Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $here -RedirectStandardOutput "$here\.server.log" -RedirectStandardError "$here\.server.err" -WindowStyle Hidden -PassThru
$p.Id | Set-Content "$here\.server.pid"
for ($i = 0; $i -lt 60; $i++) { Start-Sleep 1; if ((Get-Content "$here\.server.log" -ErrorAction SilentlyContinue) -match 'Drop Off app') { break } }
Get-Content "$here\.server.log"; Get-Content "$here\.server.err"
