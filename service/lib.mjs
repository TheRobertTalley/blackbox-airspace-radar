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

export function groupTracks(rows, segmentGapMs = 15 * 60 * 1000) {
  const tracks = [];
  const sorted = [...rows].sort((left, right) => left.icao.localeCompare(right.icao) || left.observed_at - right.observed_at);
  let current = null;
  for (const row of sorted) {
    const beginsNewTrack = !current
      || current.icao !== row.icao
      || row.observed_at - current.lastObservedAt > segmentGapMs;
    if (beginsNewTrack) {
      current = {
        icao: row.icao,
        callsign: '',
        coordinates: [],
        firstObservedAt: row.observed_at,
        lastObservedAt: row.observed_at,
        altitudeFt: null
      };
      tracks.push(current);
    }
    current.coordinates.push([row.longitude, row.latitude, row.altitude_ft, row.observed_at]);
    current.lastObservedAt = row.observed_at;
    if (typeof row.callsign === 'string' && row.callsign.trim()) current.callsign = row.callsign.trim();
    if (Number.isFinite(Number(row.altitude_ft))) current.altitudeFt = Number(row.altitude_ft);
  }
  return {
    type: 'FeatureCollection',
    features: tracks.map((track, index) => {
      const coordinates = track.coordinates.length === 1
        ? [track.coordinates[0], track.coordinates[0]]
        : track.coordinates;
      return {
        type: 'Feature',
        properties: {
          trackId: `${track.icao}-${track.firstObservedAt}-${index}`,
          icao: track.icao,
          callsign: track.callsign,
          pointCount: track.coordinates.length,
          firstObservedAt: new Date(track.firstObservedAt).toISOString(),
          lastObservedAt: new Date(track.lastObservedAt).toISOString(),
          altitudeFt: track.altitudeFt
        },
        geometry: { type: 'LineString', coordinates }
      };
    })
  };
}
