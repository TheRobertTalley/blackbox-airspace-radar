# BlackBox Airspace Radar

A receive-only home-airspace display for a Nuand bladeRF Classic x40. The
bladeRF runs Nuand's ADS-B FPGA image in RAM, forwards raw Mode-S messages to
`readsb`, and exposes decoded aircraft through a private, read-only API. The
static dashboard is safe to publish on GitHub Pages; live observations remain
on BlackBox behind Tailscale.

## Safety boundary

- RX only. The Windows receiver contains no TX module configuration or TX API.
- The ADS-B FPGA is loaded into RAM and is never written to flash.
- No cellular stack, public feed, arbitrary radio command, or remote shell is
  included.
- Exact receiver coordinates, live observations, tailnet names, and recovery
  images are never committed.

## Architecture

1. `receiver/windows/bladerf_adsb_rx.exe` loads the official ADS-B x40 FPGA and
   forwards Mode-S frames to `127.0.0.1:30001`.
2. Ubuntu WSL2 runs `readsb` in network-only mode and writes `aircraft.json`.
3. `service/server.mjs` reads that JSON, retains seven days of downsampled
   tracks in SQLite, and serves the read-only API on `127.0.0.1:8788`.
4. Tailscale Serve provides private HTTPS. GitHub Pages hosts only the frontend.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for setup, verification, and
recovery commands.

## bladeRF compatibility note

The Classic x40 ADS-B image is older than the current hosted FPGA line. This
installation therefore uses the official firmware 2.4.0 compatibility point
and Nuand's signed 2018.08 Windows runtime for the receiver bridge. The board's
ordinary hosted FPGA remains in SPI flash; `adsbx40.rbf` is loaded only into
volatile RAM while the RX bridge runs.
