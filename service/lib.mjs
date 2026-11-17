import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyInterest, KNOTS_TO_MPH } from './airspace.mjs';

export function expandPath(value) {
  return value
    .replaceAll('%LOCALAPPDATA%', process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    .replaceAll('%USERPROFILE%', process.env.USERPROFILE || os.homedir());
}

export function normalizeAircraft(source, now = Date.now()) {
  if (!source || typeof source.hex !== 'string') return null;
  const number = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const altitudeValue = source.alt_baro === 'ground' ? 0 : number(source.alt_baro);
  const item = {
    icao: source.hex.trim().toUpperCase(),
    callsign: typeof source.flight === 'string' ? source.flight.trim() : '',
    registration: typeof source.r === 'string' ? source.r.trim().toUpperCase() : null,
    registrationSource: typeof source.r === 'string' && source.r.trim() ? 'receiver' : null,
    aircraftType: typeof source.t === 'string' ? source.t.trim().toUpperCase() : null,
    dbFlags: Number.isInteger(source.dbFlags) ? source.dbFlags : 0,
    sourceBand: source.sourceBand === '978 UAT' ? '978 UAT' : '1090 ADS-B',
    onGround: source.alt_baro === 'ground',
    latitude: number(source.lat),
    longitude: number(source.lon),
    altitudeFt: altitudeValue,
    groundSpeedKt: number(source.gs),
    groundSpeedMph: number(source.gs) === null ? null : number(source.gs) * KNOTS_TO_MPH,
    mach: number(source.mach),
    machSource: number(source.mach) === null ? null : 'reported',
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
  return { ...item, interestReasons: classifyInterest(item) };
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
        altitudeFt: null,
        groundSpeedMph: null, mach: null, machSource: null,
        registration: null, registrationSource: null,
        samples: []
      };
      tracks.push(current);
    }
    current.coordinates.push([row.longitude, row.latitude, row.altitude_ft, row.observed_at]);
    current.lastObservedAt = row.observed_at;
    if (typeof row.callsign === 'string' && row.callsign.trim()) current.callsign = row.callsign.trim();
    current.altitudeFt = Number.isFinite(row.altitude_ft) ? row.altitude_ft : null;
    current.groundSpeedMph = Number.isFinite(row.ground_speed_mph) ? row.ground_speed_mph : null;
    current.mach = Number.isFinite(row.mach) ? row.mach : null;
    current.machSource = row.mach_source ?? null;
    current.registration = row.registration ?? null;
    current.registrationSource = row.registration_source ?? null;
    current.samples.push({ observedAt: new Date(row.observed_at).toISOString(), groundSpeedMph: current.groundSpeedMph, mach: current.mach, machSource: current.machSource });
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
          altitudeFt: track.altitudeFt,
          groundSpeedMph: track.groundSpeedMph,
          mach: track.mach, machSource: track.machSource,
          registration: track.registration, registrationSource: track.registrationSource,
          samples: track.samples
        },
        geometry: { type: 'LineString', coordinates }
      };
    })
  };
}
