# BlackBox Airspace Radar

A receive-only home-airspace display for a Nuand bladeRF Classic x40. The
bladeRF runs Nuand's supported hosted FPGA, forwards 1090 MHz IQ samples to
`readsb` for software decoding, and exposes decoded aircraft through a public,
read-only API. GitHub Pages hosts the dashboard while Tailscale Funnel relays
only the radar web service from BlackBox.

## Safety boundary

- RX only. The Windows receiver contains no TX module configuration or TX API.
- The current Nuand hosted FPGA is installed for normal board operation.
- No cellular stack, arbitrary radio command, mutation endpoint, or remote shell
  is included.
- The published receiver reference is Lula City Hall. Home-location data and
  recovery images are never committed.

## Architecture

1. `receiver/windows/bladerf_adsb_rx.exe` streams receive-only 2.4 MS/s SC16Q11
   samples centered on 1090 MHz to `127.0.0.1:30005`.
2. Ubuntu WSL2 runs `readsb` as the software decoder and writes `aircraft.json`.
3. `service/server.mjs` reads that JSON, retains seven days of downsampled
   tracks in SQLite, and serves the read-only API on `127.0.0.1:8788`.
4. Tailscale Funnel provides public HTTPS for the read-only API. GitHub Pages
   hosts the public frontend.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for setup, verification, and
recovery commands.

## bladeRF compatibility note

This installation uses official FX3 firmware 2.6.0, hosted x40 FPGA 0.16.0,
libbladeRF 2.6.0, and bladeRF-cli 1.10.0. The retired Classic ADS-B FPGA is not
loaded because it is incompatible with the current supported stack.
