# Plex Discord Presence - one-line installer for Windows (PowerShell 5.1+).
#
#   irm https://INSTALLER_HOST/install.ps1 | iex
#
# What it does, step by step (nothing else):
#   1. Uses your Node.js if it is version 18 or newer. Otherwise it downloads
#      the official Node.js LTS zip from https://nodejs.org into
#      %USERPROFILE%\.plex-discord-presence\node and checks its SHA-256 checksum.
#   2. Downloads presence.js (a single file, no npm packages) from GitHub at a
#      pinned commit and checks its SHA-256 checksum.
#   3. Runs `presence.js setup` (Plex sign-in in your browser), `install`
#      (hidden Scheduled Task for your user) and `status`.
#
# No admin rights, no system-wide changes, no telemetry. Remove with:
#   & "$env:USERPROFILE\.plex-discord-presence\node\node.exe" "$env:USERPROFILE\.plex-discord-presence\src\presence.js" uninstall --purge
#
# Environment options:
#   $env:PDP_SKIP_SETUP = "1"   skip the interactive Plex sign-in

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # much faster Invoke-WebRequest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- Pinned versions and checksums ------------------------------------------
$NodeVersion = 'v24.22.2'
$AppCommit   = '909b9556e04b5ce9c0d7a66865596958a9292e0b'   # release 2.1.0
$AppSha256   = '534e88c1a359e0a8dcf91481dee0285158798ce84bb0f4ae6dc46b4f74558dbd'
$AppUrl      = "https://raw.githubusercontent.com/zeroXmrcl/plex-discord-presence/$AppCommit/presence.js"

$BaseDir = Join-Path $env:USERPROFILE '.plex-discord-presence'
$NodeDir = Join-Path $BaseDir 'node'
$SrcDir  = Join-Path $BaseDir 'src'

function Say($msg) { Write-Host "==> $msg" }

function Get-File($Url, $OutFile) {
  if (-not $Url.StartsWith('https://')) { throw "Refusing non-HTTPS URL: $Url" }
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

function Test-Checksum($File, $Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $File).Hash.ToLower()
  if ($actual -ne $Expected.ToLower()) {
    throw "Checksum mismatch for $(Split-Path -Leaf $File) (expected $Expected, got $actual)"
  }
  Say "Checksum OK: $(Split-Path -Leaf $File)"
}

function Test-NodeOk($NodeExe) {
  try {
    $major = & $NodeExe -p 'process.versions.node.split(".")[0]' 2>$null
    return ([int]$major -ge 18)
  } catch { return $false }
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("pdp-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp, $SrcDir | Out-Null
try {
  # --- 1. Node.js --------------------------------------------------------------
  $Node = $null
  $found = Get-Command node -ErrorAction SilentlyContinue
  $local = Join-Path $NodeDir 'node.exe'
  if ($found -and (Test-NodeOk $found.Source)) {
    $Node = $found.Source
    Say "Using your Node.js $(& $Node -v) ($Node)"
  } elseif ((Test-Path $local) -and (Test-NodeOk $local)) {
    $Node = $local
    Say "Using previously installed Node.js $(& $Node -v)"
  } else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $name = "node-$NodeVersion-win-$arch"
    Say "Node.js 18+ not found; downloading official $name.zip"
    Get-File "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" (Join-Path $Tmp 'SHASUMS256.txt')
    Get-File "https://nodejs.org/dist/$NodeVersion/$name.zip" (Join-Path $Tmp "$name.zip")
    $line = Get-Content (Join-Path $Tmp 'SHASUMS256.txt') | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))$" }
    if (-not $line) { throw "No checksum listed for $name.zip" }
    Test-Checksum (Join-Path $Tmp "$name.zip") (($line -split '\s+')[0])
    Expand-Archive -Path (Join-Path $Tmp "$name.zip") -DestinationPath $Tmp -Force
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Move-Item (Join-Path $Tmp $name) $NodeDir
    $Node = $local
    Say "Installed Node.js $(& $Node -v) to $NodeDir"
  }

  # --- 2. App ------------------------------------------------------------------
  Say "Downloading presence.js (commit $($AppCommit.Substring(0, 7)))"
  $tmpApp = Join-Path $Tmp 'presence.js'
  Get-File $AppUrl $tmpApp
  Test-Checksum $tmpApp $AppSha256
  Move-Item -Force $tmpApp (Join-Path $SrcDir 'presence.js')
  $App = Join-Path $SrcDir 'presence.js'

  # --- 3. Setup, autostart, status -------------------------------------------
  if ($env:PDP_SKIP_SETUP -eq '1') {
    Say "Skipping setup (PDP_SKIP_SETUP=1). Later run:"
    Write-Host "  & `"$Node`" `"$App`" setup"
    return
  }
  & $Node $App setup
  if ($LASTEXITCODE -ne 0) { throw "Setup failed (exit code $LASTEXITCODE)" }
  & $Node $App install
  if ($LASTEXITCODE -ne 0) { throw "Install failed (exit code $LASTEXITCODE)" }
  & $Node $App status
  Say 'Done. Start a video on Plex and check your Discord profile.'
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
