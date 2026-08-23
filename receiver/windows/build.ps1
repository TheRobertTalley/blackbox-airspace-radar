param(
    [string]$BladeRfRoot = 'C:\Program Files\bladeRF',
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'bladerf_adsb_rx.c'
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'runtime\receiver'
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$gcc = (Get-Command gcc.exe -ErrorAction Stop).Source
& $gcc -std=c17 -O2 -Wall -Wextra -Werror `
    -I (Join-Path $BladeRfRoot 'include') `
    $source `
    -L (Join-Path $BladeRfRoot 'x64') -lbladeRF -lws2_32 `
    -o (Join-Path $OutputDirectory 'bladerf_adsb_rx.exe')
if ($LASTEXITCODE -ne 0) { throw "Receiver build failed with exit code $LASTEXITCODE" }

Copy-Item -LiteralPath (Join-Path $BladeRfRoot 'x64\bladeRF.dll') -Destination $OutputDirectory -Force
Copy-Item -LiteralPath (Join-Path $BladeRfRoot 'x64\libusb-1.0.dll') -Destination $OutputDirectory -Force
$pthread = Join-Path $BladeRfRoot 'x64\pthreadVC2.dll'
if (Test-Path $pthread) {
    Copy-Item -LiteralPath $pthread -Destination $OutputDirectory -Force
}
Write-Host "Built receive-only bridge in $OutputDirectory"
