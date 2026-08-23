# Operations

## Private configuration

Copy `service/config.example.json` to `service/config.json`. Set the receiver
coordinates after rounding both values to two decimal places. Set
`allowedOrigin` to the GitHub Pages origin; do not include the repository path.

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

## Private HTTPS

Once the API is healthy on loopback, expose only that listener to the tailnet:

```powershell
tailscale serve --bg 8788
tailscale serve status
```

Do not use `tailscale funnel`.

## Recovery

The private backup directory under `backups/bladeRF/` contains firmware,
calibration, FPGA, and complete 4 MiB flash images plus SHA-256 hashes and flash
logs. Do not use a full-flash restore unless component-level firmware or FPGA
recovery fails.
