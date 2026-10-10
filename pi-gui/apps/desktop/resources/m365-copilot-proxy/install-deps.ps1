$ErrorActionPreference = 'Stop'
$python = (Get-Command python -ErrorAction Stop).Source
$sitePackages = Join-Path $env:LOCALAPPDATA 'M365CopilotProxy\Python314\site-packages'

New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
& $python -m pip install --disable-pip-version-check --only-binary=cryptography --target $sitePackages -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed with exit code $LASTEXITCODE" }
Write-Host "Dependencies installed under LOCALAPPDATA: $sitePackages"
