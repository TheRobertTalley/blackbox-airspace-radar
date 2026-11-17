#!/usr/bin/env node
// Adapt an independent receiver's newline-delimited JSON records to BLKBOX.
// Example: rtl_433 -F json | node scripts/sensor-bridge.mjs weather
// Never controls the bladeRF or transmits. Meter identifiers stay in a local file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const channel = process.argv[2];
const allowed = ['weather', 'water', 'remoteid', 'rc', 'wifi', 'ble'];
if (!allowed.includes(channel)) {
  console.error('Usage: node scripts/sensor-bridge.mjs weather|water|remoteid|rc|wifi|ble');
  process.exit(2);
}
const dir = process.env.BLKBOX_SENSOR_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'BlackBoxAirspaceRadar', 'sensors');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const target = path.join(dir, channel + '.json');
const wantedId = (channel === 'water' ? process.env.BLKBOX_WATER_METER_ID : process.env.BLKBOX_WEATHER_SENSOR_ID) || '';
if (channel === 'water' && !wantedId) {
  console.error('Set BLKBOX_WATER_METER_ID to your own meter ID. Unfiltered neighborhood meters are not ingested.');
  process.exit(2);
}
const takeNumber = (...values) => {
  for (const v of values) if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const idFor = raw => String(raw?.Message?.ID ?? raw?.ID ?? raw?.id ?? raw?.meter_id ?? '');
const utcNow = () => new Date().toISOString();
function normalize(raw) {
  if (channel === 'weather') {
    if (wantedId && idFor(raw) !== wantedId) return null;
    const temperatureC = takeNumber(raw.temperature_C, raw.temperature_c);
    const humidityPercent = takeNumber(raw.humidity, raw.humidityPercent);
    const windKmh = takeNumber(raw.wind_avg_km_h, raw.wind_km_h, raw.windKmh);
    const rainMm = takeNumber(raw.rain_mm, raw.rainMm);
    if ([temperatureC, humidityPercent, windKmh, rainMm].every(v => v === null)) return null;
    return { observedAt: utcNow(), model: String(raw.model || '').slice(0, 80),
      temperatureC, humidityPercent, windKmh, rainMm };
  }
  if (channel === 'water') {
    if (idFor(raw) !== wantedId) return null;
    const reading = takeNumber(raw?.Message?.Consumption, raw.Consumption, raw.consumption);
    if (reading === null) return null;
    return { observedAt: utcNow(), meterId: wantedId, consumptionRaw: reading,
      protocol: String(raw?.Type || raw?.Message?.Type || raw.model || 'unknown').slice(0, 80),
      units: 'meter-native (unverified)' };
  }
  if (channel === 'remoteid') {
    // The supplying OpenDroneID decoder must explicitly mark a validated packet.
    if (raw.protocol !== 'OpenDroneID' || raw.validated !== true) return null;
    return { observedAt: utcNow(), protocol: 'OpenDroneID', validated: true };
  }
  if (channel === 'rc') {
    const family = String(raw.family || '').toUpperCase();
    if (!['ELRS', 'AFHDS', 'AFHDS2A', 'DSMX', 'DJI', 'OTHER'].includes(family) || raw.validated !== true) return null;
    return { observedAt: utcNow(), family, validated: true };
  }
  if (channel === 'wifi' || channel === 'ble') {
    if (raw.band !== channel || raw.validated !== true) return null;
    const value = takeNumber(raw.occupancyPercent);
    if (value === null || value < 0 || value > 100) return null;
    return { observedAt: utcNow(), band: channel, occupancyPercent: value, validated: true };
  }
  return null;
}
let accepted = 0, rejected = 0;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.length > 65536) { rejected++; continue; }
  try {
    const normalized = normalize(JSON.parse(line));
    if (!normalized) { rejected++; continue; }
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(normalized) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, target);
    accepted++;
    if (accepted % 100 === 0) console.error('BLKBOX', channel, 'records accepted', accepted, 'ignored', rejected);
  } catch (error) {
    rejected++;
    if (rejected % 100 === 1) console.error('BLKBOX sensor input ignored:', error.message);
  }
}
console.error('BLKBOX', channel, 'finished; accepted', accepted, 'ignored', rejected);
