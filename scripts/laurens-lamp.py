#!/usr/bin/env python3
"""Local-only Laurens Lamp alert consumer. Run on BlackBox, not the public server.

Requires: pip install python-kasa httpx
Set BLKBOX_LAMP_HOST and (optionally) KASA_USERNAME / KASA_PASSWORD.
The service's GET API remains read-only; this consumer never exposes Kasa LAN access.
"""
import asyncio
import os
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from kasa import Discover

API = os.getenv("BLKBOX_LAMP_API", "http://127.0.0.1:8788").rstrip("/")
HOST = os.getenv("BLKBOX_LAMP_HOST", "")
ALERT_KINDS = {kind.strip() for kind in os.getenv(
    "BLKBOX_LAMP_KINDS",
    "LONG STAY,CIRCLING,POSSIBLE HOVER,REPEAT VISIT,REMOTE ID BROADCAST,RC LINK ACTIVITY,RF ACTIVITY RISE"
).split(",") if kind.strip()}
ARMED = os.getenv("BLKBOX_LAMP_ARM", "0") == "1"
POLL_SECONDS = max(5, int(os.getenv("BLKBOX_LAMP_POLL_SECONDS", "10")))
COOLDOWN_SECONDS = max(60, int(os.getenv("BLKBOX_LAMP_COOLDOWN_SECONDS", "300")))


async def connect_lamp():
    username = os.getenv("KASA_USERNAME")
    password = os.getenv("KASA_PASSWORD")
    credentials = None
    if username and password:
        from kasa import Credentials
        credentials = Credentials(username, password)
    if HOST:
        device = await Discover.discover_single(HOST, credentials=credentials)
    else:
        discovered = await Discover.discover(credentials=credentials)
        matching = []
        for candidate in discovered.values():
            try:
                await candidate.update()
                label = str(candidate.alias or "").lower().replace("'", "")
                if "laurens lamp" in label:
                    matching.append(candidate)
            except Exception:
                continue
        if len(matching) != 1:
            raise RuntimeError(f"Expected exactly one Kasa switch named Laurens Lamp, found {len(matching)}. Set BLKBOX_LAMP_HOST explicitly if needed.")
        device = matching[0]
    if device is None:
        raise RuntimeError("Kasa device not found")
    await device.update()
    if not isinstance(device.is_on, bool):
        raise RuntimeError("Could not verify switch state")
    return device


async def flash(device):
    await device.update()
    originally_on = device.is_on
    try:
        for _ in range(2):
            if originally_on:
                await device.turn_off()
                await asyncio.sleep(0.7)
                await device.turn_on()
            else:
                await device.turn_on()
                await asyncio.sleep(0.7)
                await device.turn_off()
            await asyncio.sleep(0.5)
    finally:
        # Restore prior state even if the flash sequence fails.
        try:
            await (device.turn_on() if originally_on else device.turn_off())
        except Exception as exc:
            print(f"WARNING: Unable to restore Lauren's Lamp state: {exc}", flush=True)


async def main():
    parsed = urlparse(API)
    if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1"):
        raise RuntimeError("BLKBOX_LAMP_API must use a loopback HTTP address")
    lamp = await connect_lamp()
    print("Connected to Lauren's Lamp. Listening for new local aircraft behavior alerts.", flush=True)
    seen = set()
    armed = False  # Ignore pre-existing alerts on startup.
    last_flash = 0.0
    async with httpx.AsyncClient(timeout=5.0) as client:
        while True:
            try:
                response = await client.get(API + "/api/v1/analysis")
                response.raise_for_status()
                events = response.json().get("alerts", [])
                current = {event["id"] for event in events if "id" in event}
                if not armed:
                    seen.update(current)
                    armed = True
                else:
                    pending = [event for event in events
                               if event.get("id") not in seen and event.get("kind") in ALERT_KINDS]
                    seen.update(current)
                    if pending and time.monotonic() - last_flash >= COOLDOWN_SECONDS:
                        if ARMED:
                            await flash(lamp)
                        last_flash = time.monotonic()
                        print(f"{datetime.now(timezone.utc).isoformat()} {\'flashed\' if ARMED else \'would flash\'}: "
                              + "; ".join(f"{event.get('icao')}: {event.get('kind')}" for event in pending),
                              flush=True)
            except Exception as exc:
                print(f"Lamp monitoring issue: {exc}", flush=True)
            await asyncio.sleep(POLL_SECONDS)


if __name__ == "__main__":
    asyncio.run(main())
