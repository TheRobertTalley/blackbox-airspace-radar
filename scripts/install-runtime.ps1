param(
    [string]$BladeRfRoot = 'C:\Program Files\bladeRF'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$receiverRoot = Join-Path $projectRoot 'runtime\receiver'
New-Item -ItemType Directory -Path $receiverRoot -Force | Out-Null
& (Join-Path $projectRoot 'receiver\windows\build.ps1') -BladeRfRoot $BladeRfRoot
