# BLKBOX Airspace intelligence and sensor integration

## Implemented on this branch
- Live map and list show **all received aircraft** by default. The **FILTER INTEREST** button filters both to aircraft with interest tags or behavior findings; **SHOW ALL** restores everything.
- Interest rules: ground speed **> 550 mph** or **< 25 mph**, barometric altitude **> 42,000 ft** or **< 1,000 ft**, unmarked aircraft (missing identity), database-flagged military, space/transatmospheric category, and emergency/squawk 7500/7600/7700.
- Classifications are evidence labels, not proof of hostile or malicious activity. Altitudes are barometric MSL, not AGL.
- The analysis engine uses seven-day received history to estimate typical completed flight duration; at least 10 completed local sessions are required to learn a baseline, and dwell alert threshold is the larger of 8 minutes, 2× mean duration, or 1.3× p90.
- A behavioral alert may identify **LONG STAY**, **CIRCLING**, **POSSIBLE HOVER**, or **REPEAT VISIT**; detections require multiple observed positions and/or track duration. Repeated alerts of the same kind for the same aircraft are suppressed for 30 minutes. These are heuristic indications, not definitive classifications.
- Current behavior alerts are exposed on read-only `GET /api/v1/analysis`, and recent aircraft near the *public reference point* on `GET /api/v1/what-was-that`. Event and reception data also travels in the live SSE payload.
- `scripts/laurens-lamp.py` is a separate opt-in **local-only** python-kasa consumer. It listens for *new* behavior alerts and flashes the switch twice, then restores its previous on/off state. It ignores all alerts existing when started and enforces at least a five-minute cooldown. It does not auto-start, and no LAN address/credentials are committed.

## Lauren's Lamp installation, on BlackBox only

```powershell
py -m pip install "python-kasa" "httpx"
$env:BLKBOX_LAMP_HOST = "LOCAL_KASA_IP"
# If required by your Kasa model:
$env:KASA_USERNAME = "KASA_ACCOUNT_EMAIL"
$env:KASA_PASSWORD = "KASA_ACCOUNT_PASSWORD"
py scripts/laurens-lamp.py
```

This is a setup example, not a claim the user's smart switch has already been found or tested. Use local environment variables or OS secrets rather than storing credentials in GitHub. Some Kasa models require supported authentication. Verify the exact switch, its current state, and manual recovery before enabling regular flashing. The script only consumes the local API `127.0.0.1:8788`; it does not accept remote control requests.

## Optional 978 MHz UAT ingestion

Configure `uatJsonPath` in the local `service/config.json` with a second decoder's fresh, readsb-compatible JSON snapshot. This is an **optional adapter**. It cannot synthesize a 978 MHz receiver. A second appropriately tuned SDR and compatible UAT decoder are required because the existing bladeRF is continuously receiving 1090 MHz ADS-B.

Receivers are merged by ICAO address, preferring the freshest candidate. UAT reports carry the `sourceBand: "978 UAT"` provenance, while the existing feed remains `1090 ADS-B`. If the UAT feed is unavailable, it fails closed and only real 1090 observations appear. A converter may be required if the decoder does not output readsb-compatible JSON.

## Alexa custom skill

The `alexa/` folder provides an ASK SDK Lambda handler and custom interaction model:
- "Alexa, ask Black Box what plane was that."
- "Alexa, ask Black Box what's interesting nearby."

Provision a private skill and Lambda in the Alexa Developer Console; set Lambda `BLKBOX_API_URL` to the working HTTPS radar endpoint and `ALEXA_SKILL_ID` to its registered ID. `/api/v1/what-was-that` currently searches recent received tracks near the **public, deliberately approximate receiver reference**. It must not be described as an exact home flyover. User/house-specific answers require a private authenticated, access-controlled internal endpoint, *not* an exact home coordinate published in the public GitHub Pages or API payload. Amazon skill enablement, AWS setup and Echo account linking have not been performed.

## Remaining integrations and physical constraints

| Requested integration | Hardware/data needed | Safe next step |
|---|---|---|
| Local weather sensors | SDR covering the sensor's modulation and band, or vendor-local integration | Identify weather station make/model and use existing rtl_433 or vendor interface |
| Drone ELRS | Independent 868/915 MHz or 2.4 GHz wideband capture and protocol-specific detection | First identify supported frequency and hardware; do not equate generic RF energy with a drone |
| AFHDS / AFHDS 2A / DSMX | 2.4 GHz receiver/spectrum monitor with adequate dwell/channel scanning | Detect sustained occupancy as provisional, verify against controlled RC transmitter tests |
| DJI / digital drone links | Suitable dedicated RF monitor/Remote ID receiver | Prefer broadcast Remote ID for supported aircraft; encrypted/private RC/video traffic cannot generically be decoded |
| Water meter | Verify meter manufacturer, radio band, modulation and your lawful access | Support receive-only decoding of your own meter via compatible utilities; no unsupported decryption |
| Wi-Fi and BLE | Independent Wi-Fi/BLE hardware, ideally local receiver(s) with well-defined coverage | Monitor anonymized RF activity changes; **do not claim a group of people is approaching** from signal count alone |
| Local AI | Existing Ollama/Hermes if installed on BlackBox | Use only for optional natural-language summaries of validated stored events; keep classification and lamp alerts deterministic |

**Do not use the single bladeRF's frequency hopping to steal receive time from 1090 MHz ADS-B.** Unavailable integrations must show unavailable/not connected instead of fabricated detections. BLE/Wi-Fi signals can be carried by stationary or randomized devices, travel through walls, and vary with transmit power; they are not reliable evidence of people or group size. The public API remains RX-only and read-only.

## Validation
- `npm --prefix web ci`
- `npm test`
- `npm run build`
- Review AWS Lambda ASK request validation and Kasa pairing on the actual hardware before deployment.
- Simulate >550 mph, <25 mph, >42k ft, <1k ft, repeated visits, and receiver offline conditions before enabling any physical alert.
