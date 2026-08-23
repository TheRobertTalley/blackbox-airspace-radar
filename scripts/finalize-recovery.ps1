param(
    [string]$WorkspaceRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$RecoveryRoot = 'C:\Users\Talley\Documents\HardwareBackups\bladeRF\776be5f34509847ee14f4745e728b59d\pre-adsb-2026-08-23'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $WorkspaceRoot 'blackbox-airspace-radar'
$boardRoot = Join-Path $WorkspaceRoot 'backups\776be5f34509847ee14f4745e728b59d'
$referencesRoot = Join-Path $WorkspaceRoot 'references\bladeRF-adsb-compatible'

if (-not (Test-Path $RecoveryRoot)) { throw "Recovery root does not exist: $RecoveryRoot" }

$finalBoard = Join-Path $RecoveryRoot 'backups\adsb-compatible-2026-08-23'
$finalReferences = Join-Path $RecoveryRoot 'references\bladeRF-adsb-compatible'
$projectCopy = Join-Path $RecoveryRoot 'project-source\blackbox-airspace-radar'
$privateConfig = Join-Path $RecoveryRoot 'private-config'

New-Item -ItemType Directory -Path $finalBoard,$finalReferences,$projectCopy,$privateConfig -Force | Out-Null
Copy-Item -Path (Join-Path $boardRoot 'adsb-compatible-2026-08-23\*') -Destination $finalBoard -Recurse -Force
Copy-Item -Path (Join-Path $referencesRoot '*') -Destination $finalReferences -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'service\config.json') -Destination (Join-Path $privateConfig 'service-config.json') -Force
Copy-Item -LiteralPath 'C:\Users\Talley\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\BlackBox Airspace Radar.cmd' -Destination (Join-Path $privateConfig 'BlackBox Airspace Radar.cmd') -Force

$robocopyArgs = @(
    $projectRoot, $projectCopy, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
    '/XD', '.git', 'node_modules', 'dist', 'runtime',
    '/XF', 'config.json'
)
& robocopy.exe @robocopyArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Project recovery copy failed with robocopy exit code $LASTEXITCODE" }

$tarPath = Join-Path $RecoveryRoot 'Ubuntu-pre-adsb-2026-08-23.tar'
$knownTarHash = '825FBAEEC090EE996042D179F1BA21762F624D661341282EB6131004F2A11138'
$entries = Get-ChildItem -LiteralPath $RecoveryRoot -Recurse -File |
    Where-Object { $_.Name -ne 'SHA256SUMS.txt' -and $_.FullName -ne $tarPath } |
    Sort-Object FullName |
    ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($RecoveryRoot, $_.FullName).Replace('\','/')
        "$(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 | Select-Object -ExpandProperty Hash)  $relative"
    }
$entries += "$knownTarHash  Ubuntu-pre-adsb-2026-08-23.tar"
$entries | Set-Content -LiteralPath (Join-Path $RecoveryRoot 'SHA256SUMS.txt') -Encoding utf8

Write-Host "Recovery set finalized at $RecoveryRoot"
Write-Host "Hashed $($entries.Count) files; preserved verified Ubuntu export hash $knownTarHash"
