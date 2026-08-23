param(
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
$runtime = Join-Path $ProjectRoot 'runtime'
$receiver = Join-Path $runtime 'receiver\bladerf_adsb_rx.exe'
$fpga = Join-Path $runtime 'receiver\adsbx40.rbf'
$config = Join-Path $ProjectRoot 'service\config.json'
$apiLog = Join-Path $runtime 'api.log'
$apiErrorLog = Join-Path $runtime 'api-error.log'
$rxLog = Join-Path $runtime 'rx-frames.log'
$rxErrorLog = Join-Path $runtime 'rx-status.log'

if (-not (Test-Path $receiver)) { throw 'Receiver executable is missing. Run receiver/windows/build.ps1.' }
if (-not (Test-Path $fpga)) { throw 'ADS-B FPGA is missing. Run scripts/install-runtime.ps1.' }
if (-not (Test-Path $config)) { throw 'Private service/config.json is missing.' }

wsl.exe -d Ubuntu -u root -- systemctl start readsb-blackbox.service
if ($LASTEXITCODE -ne 0) { throw "readsb service failed to start (exit $LASTEXITCODE)." }
$env:RADAR_CONFIG = $config

$apiListener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort 8788 -ErrorAction SilentlyContinue
if ($apiListener) {
    Write-Host "API already listening (PID $($apiListener.OwningProcess))."
} else {
    $api = Start-Process -FilePath (Get-Command node.exe).Source `
        -ArgumentList @((Join-Path $ProjectRoot 'service\server.mjs')) `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $apiLog `
        -RedirectStandardError $apiErrorLog `
        -PassThru -WindowStyle Hidden
    Write-Host "API PID: $($api.Id)"
}

$receiverPath = (Resolve-Path $receiver).Path
$rxProcess = Get-CimInstance Win32_Process -Filter "Name = 'bladerf_adsb_rx.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $receiverPath } |
    Select-Object -First 1
if ($rxProcess) {
    Write-Host "RX bridge already running (PID $($rxProcess.ProcessId))."
} else {
    $rx = Start-Process -FilePath $receiver `
        -ArgumentList @($fpga, '127.0.0.1', '30001') `
        -WorkingDirectory (Split-Path $receiver) `
        -RedirectStandardOutput $rxLog `
        -RedirectStandardError $rxErrorLog `
        -PassThru -WindowStyle Hidden
    Write-Host "RX PID: $($rx.Id)"
}
