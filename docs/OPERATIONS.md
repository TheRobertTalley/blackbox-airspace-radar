# Operations

## Private configuration

Copy `service/config.example.json` to `service/config.json`. Set the receiver
coordinates after rounding both values to two decimal places. Set
`allowedOrigin` to the GitHub Pages origin; do not include the repository path.

## Receiver lifecycle

The Windows bridge loads `adsbx40.rbf` into volatile FPGA memory. It cannot
configure or enable the transmitter. It forwards raw frames only to the
loopback `readsb` input. Use the signed Nuand 2018.08 runtime when building the
bridge; current libbladeRF releases do not stream reliably with the legacy x40
ADS-B FPGA image. The board firmware is pinned to official version 2.4.0.

```powershell
pwsh -File scripts/install-runtime.ps1 -BladeRfRoot C:\path\to\bladeRF-2018.08
wsl -d Ubuntu -- bash ./scripts/setup-readsb.sh
pwsh -File scripts/start-radar.ps1
```

Verify that the bridge has no transmit symbols:

```powershell
rg -n "BLADERF_MODULE_TX|BLADERF_CHANNEL_TX|bladerf_(sync_tx|set_tx|set_txvga)" receiver/windows/bladerf_adsb_rx.c
```

The expected result is no match in the C source.

The receiver is currently USB Hi-Speed. Replace the cable with a verified USB
3.x data cable if live frame reception is intermittent or absent; a blue port
alone does not prove the negotiated link is SuperSpeed.

## Private HTTPS

Once the API is healthy on loopback, expose only that listener to the tailnet:

```powershell
tailscale serve --bg 8788
tailscale serve status
```

Do not use `tailscale funnel`.

## Recovery

The hardware recovery archive is intentionally outside this repository. It
contains component and complete-flash images for serial
`776be5f34509847ee14f4745e728b59d`, restoration tooling, hashes, and an
unchanged pre-install Ubuntu export. Do not use a full-flash restore unless
component-level firmware/FPGA recovery fails.
