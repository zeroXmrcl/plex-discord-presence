# Windows helper, started by install-windows.bat / uninstall-windows.bat.
# Usage: install.ps1 [install|uninstall]
param([string]$Action = "install")
$root = Split-Path -Parent $PSScriptRoot
Set-Location -Path $root
function Stop-Here($msg, $code) {
  if ($msg) { Write-Host $msg -ForegroundColor Red }
  Read-Host "Press Enter to close"
  exit $code
}
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-Here "Node.js 18 or newer is required: https://nodejs.org" 1
  }
  if ($Action -eq "uninstall") {
    node presence.js uninstall
    if ($LASTEXITCODE -ne 0) { Stop-Here "Uninstall failed (exit code $LASTEXITCODE)." $LASTEXITCODE }
    Read-Host "Removed. Press Enter to close"
    exit 0
  }
  node presence.js setup
  if ($LASTEXITCODE -ne 0) { Stop-Here "Setup failed (exit code $LASTEXITCODE)." $LASTEXITCODE }
  node presence.js install
  if ($LASTEXITCODE -ne 0) { Stop-Here "Install failed (exit code $LASTEXITCODE)." $LASTEXITCODE }
  node presence.js status
  Read-Host "Done. Press Enter to close"
} catch {
  Stop-Here ("Error: " + $_.Exception.Message) 1
}
