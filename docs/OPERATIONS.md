# Operations

## Local configuration

Copy `service/config.example.json` to `service/config.json`. Set the receiver
to a public reference point instead of a home address. Set `allowedOrigins` to
the GitHub Pages and BlackBox HTTPS origins; do not include repository paths.

## Receiver lifecycle

The board boots official FX3 firmware 2.6.0 and hosted x40 FPGA 0.16.0 from
flash. The Windows bridge cannot configure or enable the transmitter. It sends
2.4 MS/s SC16Q11 receive samples centered on 1090 MHz to the loopback software
decoder on TCP port 30005. Build it against libbladeRF 2.6.0.

```powershell
pwsh -File scripts/install-runtime.ps1 -BladeRfRoot 'C:\Program Files\bladeRF'
wsl -d Ubuntu -- bash ./scripts/setup-readsb.sh
pwsh -File scripts/start-radar.ps1
```

Verify that the bridge has no transmit symbols:

```powershell
rg -n "BLADERF_MODULE_TX|BLADERF_CHANNEL_TX|bladerf_(sync_tx|set_tx|set_txvga)" receiver/windows/bladerf_adsb_rx.c
```

The expected result is no match in the C source.

The receiver currently negotiates USB Hi-Speed. That is sufficient for the
verified 2.4 MS/s receive stream; a SuperSpeed cable is not required for this
ADS-B configuration.

## Public HTTPS

Once the API is healthy on loopback, expose only that read-only listener through
Tailscale Funnel:

```powershell
tailscale funnel --bg --yes 8788
tailscale funnel status
```

Funnel must report `Available on the internet` and continue proxying only to
`http://127.0.0.1:8788`. The server has no mutation, transmitter, shell, or
arbitrary-file routes.

## Recovery

The private backup directory under `backups/bladeRF/` contains firmware,
calibration, FPGA, and complete 4 MiB flash images plus SHA-256 hashes and flash
logs. Do not use a full-flash restore unless component-level firmware or FPGA
recovery fails.
