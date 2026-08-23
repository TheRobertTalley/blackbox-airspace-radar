import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandPath(value) {
  return value
    .replaceAll('%LOCALAPPDATA%', process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    .replaceAll('%USERPROFILE%', process.env.USERPROFILE || os.homedir());
}

export function normalizeAircraft(source, now = Date.now()) {
  if (!source || typeof source.hex !== 'string') return null;
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const altitudeValue = source.alt_baro === 'ground' ? 0 : number(source.alt_baro);
  return {
    icao: source.hex.trim().toUpperCase(),
    callsign: typeof source.flight === 'string' ? source.flight.trim() : '',
    latitude: number(source.lat),
    longitude: number(source.lon),
    altitudeFt: altitudeValue,
    groundSpeedKt: number(source.gs),
    trackDeg: number(source.track),
    verticalRateFpm: number(source.baro_rate ?? source.geom_rate),
    squawk: typeof source.squawk === 'string' ? source.squawk : '',
    category: typeof source.category === 'string' ? source.category : '',
    seenSeconds: number(source.seen) ?? 999,
    rssiDbfs: number(source.rssi),
    messages: number(source.messages) ?? 0,
    emergency: typeof source.emergency === 'string' ? source.emergency : 'none',
    observedAt: new Date(now - ((number(source.seen) ?? 0) * 1000)).toISOString()
  };
}

export function loadConfig(configPath) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  raw.readsbJsonPath = expandPath(raw.readsbJsonPath);
  raw.databasePath = expandPath(raw.databasePath);
  raw.allowedOrigins = Array.isArray(raw.allowedOrigins)
    ? raw.allowedOrigins
    : [raw.allowedOrigin].filter(Boolean);
  return raw;
}

export function corsOriginAllowed(origin, configured) {
  if (!origin) return true;
  const allowed = Array.isArray(configured) ? configured : [configured];
  if (allowed.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function groupTracks(rows) {
  const tracks = new Map();
  for (const row of rows) {
    if (!tracks.has(row.icao)) tracks.set(row.icao, []);
    tracks.get(row.icao).push([row.longitude, row.latitude, row.altitude_ft, row.observed_at]);
  }
  return {
    type: 'FeatureCollection',
    features: [...tracks.entries()].map(([icao, coordinates]) => ({
      type: 'Feature',
      properties: { icao },
      geometry: { type: 'LineString', coordinates }
    }))
  };
}
