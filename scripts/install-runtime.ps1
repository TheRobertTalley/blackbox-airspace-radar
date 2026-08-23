param(
    [string]$BladeRfRoot = 'C:\Program Files\bladeRF'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$receiverRoot = Join-Path $projectRoot 'runtime\receiver'
$fpgaPath = Join-Path $receiverRoot 'adsbx40.rbf'
$fpgaUrl = 'https://www.nuand.com/fpga/adsbx40.rbf'

New-Item -ItemType Directory -Path $receiverRoot -Force | Out-Null
Invoke-WebRequest -Uri $fpgaUrl -OutFile $fpgaPath
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fpgaPath).Hash
Set-Content -LiteralPath (Join-Path $receiverRoot 'adsbx40.rbf.sha256') -Value "$hash  adsbx40.rbf"
Write-Host "Downloaded official Nuand ADS-B x40 FPGA: $hash"

& (Join-Path $projectRoot 'receiver\windows\build.ps1') -BladeRfRoot $BladeRfRoot
