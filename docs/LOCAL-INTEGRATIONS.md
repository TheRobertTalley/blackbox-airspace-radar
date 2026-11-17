# BLKBOX local sensor and Ollama integrations

This release does not take receive time from the 1090 MHz bladeRF. All other RF signals require an independent compatible receiver and a working protocol-specific decoder. Missing hardware reports NOT CONNECTED instead of fake detections. The public radar API is receive-only and has no remote Kasa control endpoints.

## Local deployment

Updating GitHub Pages does not update the Node service on BlackBox. Use the existing controlled local deployment process to pull/restart service/server.mjs. Confirm /api/v1/sensors and /api/v1/local-ai after restart. Existing Windows/WSL2 bladeRF/readsb configuration must remain unchanged.

## Ollama offloading

From your local checkout on BlackBox, start:

    node scripts/local-ai-worker.mjs

The worker auto-selects a locally installed 8B/9B-sized model, preferring Ministral and Qwen when available. Set BLKBOX_LOCAL_MODEL to select an exact installed tag; BLKBOX_OLLAMA_URL defaults to http://127.0.0.1:11434. It never downloads a model, accesses an external cloud AI API, or changes radio/lamp settings. It uses a low-priority, 5-minute process to summarize deterministic aircraft events and verified local sensors into a bounded JSON summary at %LOCALAPPDATA%/BlackBoxAirspaceRadar/ai-summary.json. Public UI labels it AI COMMENTARY, not fact detection. You can use the older one-shot scripts/local-ai-summary.mjs as a CLI alternative.

## Laurens Lamp: Kasa local smart switch

Install with:

    py -m pip install python-kasa httpx
    py scripts/laurens-lamp.py

It discovers the *single* Kasa device whose alias is Laurens Lamp (case-insensitive; apostrophe ignored). Alternatively set BLKBOX_LAMP_HOST to the switch LAN IP. Some devices require KASA_USERNAME and KASA_PASSWORD in the local process environment. The script starts in DRY RUN and logs matching new events. After verifying the correct switch and that the lamp restores its prior on/off state, set BLKBOX_LAMP_ARM=1 to allow actual flashes. There is a 5-minute cooldown, an ignore-existing-events startup gate, and no public lamp-control route.

Alert kinds include prolonged aircraft reception, circling, possible hover, repeat visits, valid Remote ID broadcast, validated RC link activity, or sustained elevated Wi-Fi/BLE channel occupancy. RC link activity does NOT establish a drone, and Wi-Fi/BLE activity does NOT establish visitors or people moving toward the house.

## Weather station telemetry

Use a second SDR compatible with the weather station band and a decoder such as rtl_433 (https://github.com/merbanan/rtl_433). Set BLKBOX_WEATHER_SENSOR_ID to the identifier of your own weather station to avoid mixing neighbors' data. Then pipe the receiver's line-oriented JSON:

    rtl_433 -F json | node scripts/sensor-bridge.mjs weather

The bridge accepts real temperature_C, humidity, wind_avg_km_h, wind_km_h and rain_mm fields, and writes to the private BlackBoxAirspaceRadar/sensors/weather.json directory. After 20 minutes without a reading the dashboard indicates STALE.

## Water meter telemetry

If the actual water meter protocol is unencrypted and supported, use an independent compatible receiver with rtlamr (https://github.com/bemasher/rtlamr). Set BLKBOX_WATER_METER_ID to the identifier on your own meter. The bridge refuses to ingest unfiltered neighborhood meters.

    rtlamr -format=json | node scripts/sensor-bridge.mjs water

The reading remains local, including meter ID and native consumption count. The public radar only shows RECEIVING / PRIVATE. Native consumption units must be verified against the actual meter model before converting to gallons. Encrypted or incompatible meters cannot be decoded by this adapter.

## Drone Remote ID, RC links, Wi-Fi and BLE

The adapter requires another receiver and verified decoder output; it does not implement a universal DJI/ELRS/DSMX/AFHDS protocol sniffer.

For an external OpenDroneID decoder that has actually parsed a broadcast, pass newline-delimited JSON with protocol OpenDroneID and validated true to:

    node scripts/sensor-bridge.mjs remoteid

For separately validated RC protocol detectors, a JSON record must supply family ELRS, AFHDS, AFHDS2A, DSMX, DJI or OTHER and validated true:

    node scripts/sensor-bridge.mjs rc

Those are schemas, not claims that compatible hardware/software is already present. RC link activity may represent ground vehicles or RC toys.

For independently measured channel occupancy from appropriate Wi-Fi and BLE hardware, provide band wifi or ble, occupancyPercent numeric 0-100, and validated true, then pipe to:

    node scripts/sensor-bridge.mjs wifi
    node scripts/sensor-bridge.mjs ble

Separate source processes write distinct files. An RF occupancy alert requires at least 20 samples and a persistent three-sample rise above both 1.8x and 20 percentage points over the rolling reference median. No device MAC addresses, people counts, tracking IDs or private home coordinates are published.

## Acceptance checks

- npm ci in web, then npm run test:service and npm run build from repo root.
- Check syntax of scripts/local-ai-worker.mjs, scripts/sensor-bridge.mjs and Alexa handler.
- Verify Kasa in dry-run mode before explicitly arming physical flashing.
- Verify real station, own-meter and drone-receiver packets before showing online status.
- Verify the radar still reports stale/offline when readsb's aircraft.json stops changing.
- Never publish local LAN IPs, water-meter IDs, passwords, or private observation-point coordinates to GitHub.
