<#
.SYNOPSIS
  Prepares a Windows PC for pi-gui with Microsoft 365 Copilot.

.DESCRIPTION
  Default (for coworkers): makes sure Python 3.11+ is available, which the built-in
  Microsoft 365 Copilot connection needs. Installs Python 3.12 per user with winget
  when it is missing (no admin rights required).

  -Build (for whoever hands out the app): also installs Node.js LTS, enables pnpm,
  installs dependencies and builds the Windows installer into
  apps\desktop\release\.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Build
#>
[CmdletBinding()]
param(
  [switch]$Build
)

$ErrorActionPreference = "Stop"

function Write-Step($message) {
  Write-Host ""
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Test-Python {
  $candidates = @(
    @{ Exe = "py"; Pre = @("-3") },
    @{ Exe = "python"; Pre = @() },
    @{ Exe = "python3"; Pre = @() }
  )
  foreach ($candidate in $candidates) {
    $pyArgs = $candidate.Pre + @("-c", "import sys; print(int(sys.version_info >= (3, 11)))")
    try {
      $out = & $candidate.Exe @pyArgs 2>$null
      if ($LASTEXITCODE -eq 0 -and "$out".Trim() -eq "1") { return $true }
    } catch { }
  }
  return $false
}

function Require-Winget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget is not available. Install 'App Installer' from the Microsoft Store, then run this script again."
  }
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

Write-Step "Checking Python (needed for the Microsoft 365 Copilot connection)"
if (Test-Python) {
  Write-Host "Python 3.11+ found."
} else {
  Require-Winget
  Write-Host "Installing Python 3.12 for your user account..."
  winget install --exact --id Python.Python.3.12 --scope user --silent `
    --accept-package-agreements --accept-source-agreements
  Update-SessionPath
  if (-not (Test-Python)) {
    throw "Python was installed but is not on PATH yet. Sign out and back in, then run this script again."
  }
  Write-Host "Python installed."
}

Write-Step "Checking Microsoft Edge (used once to sign in to Copilot)"
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) { Write-Host "Edge found." } else { Write-Warning "Microsoft Edge was not found. Install it before connecting Copilot." }

if (-not $Build) {
  Write-Host ""
  Write-Host "All set. Open pi-gui, go to Settings > Microsoft 365 Copilot and click Connect." -ForegroundColor Green
  exit 0
}

$repoRoot = Split-Path -Parent $PSScriptRoot

Write-Step "Checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Require-Winget
  winget install --exact --id OpenJS.NodeJS.LTS --silent `
    --accept-package-agreements --accept-source-agreements
  Update-SessionPath
}
node --version

Write-Step "Enabling pnpm"
corepack enable
corepack prepare pnpm@10.25.0 --activate

Write-Step "Installing dependencies"
Push-Location $repoRoot
try {
  # OpenUI's install-time telemetry is opt-out; keep corporate installs quiet.
  $env:OPENUI_TELEMETRY_DISABLED = "1"
  pnpm install --frozen-lockfile

  Write-Step "Building the Windows installer"
  pnpm --filter @pi-gui/desktop run package:win
} finally {
  Pop-Location
}

$installer = Get-ChildItem -Path (Join-Path $repoRoot "apps\desktop\release") -Filter "*.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($installer) {
  Write-Host ""
  Write-Host "Installer ready: $($installer.FullName)" -ForegroundColor Green
  Write-Host "Share it with coworkers; they only need to run it and click Connect in Settings."
}
