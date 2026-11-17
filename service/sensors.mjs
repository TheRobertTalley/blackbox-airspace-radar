// Data from *separate* receive-only adapters. Nothing here configures a radio.
// Public projections never include water meter IDs, BLE/Wi-Fi identifiers, or coordinates.
import fs from 'node:fs';

const VALID_KINDS = ['weather', 'water', 'remoteid', 'rc', 'rf'];
const SENSOR_CHANNELS = ['weather', 'water', 'remoteid', 'rc', 'wifi', 'ble'];
const MAX_AGE_MS = Object.freeze({
  weather: 20 * 60_000, water: 12 * 60 * 60_000,
  remoteid: 90_000, rc: 90_000, rf: 90_000
});
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clamp = (value, min, max) => value === null ? null : Math.max(min, Math.min(max, value));
const MAX_STRING = 80;
const shortText = value => typeof value === 'string' ? value.slice(0, MAX_STRING) : null;
const emptyState = kind => ({ kind, status: 'not-configured', lastSeenAt: null, data: null });

export function projectSensor(kind, raw, now = Date.now()) {
  if (!VALID_KINDS.includes(kind)) throw new Error('unknown adapter');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...emptyState(kind), status: 'invalid' };
  const observed = Date.parse(raw.observedAt);
  if (!Number.isFinite(observed) || observed > now + 10_000) return { ...emptyState(kind), status: 'invalid' };
  const fresh = now - observed <= MAX_AGE_MS[kind];
  const lastSeenAt = new Date(observed).toISOString();
  if (!fresh) return { kind, status: 'stale', lastSeenAt, data: null };
  let data;
  switch (kind) {
    case 'weather': {
      const temperatureC = clamp(finite(raw.temperatureC), -80, 85);
      const humidityPercent = clamp(finite(raw.humidityPercent), 0, 100);
      const windKmh = clamp(finite(raw.windKmh), 0, 400);
      const rainMm = clamp(finite(raw.rainMm), 0, 100000);
      if ([temperatureC, humidityPercent, windKmh, rainMm].every(v => v === null))
        return { kind, status: 'invalid', lastSeenAt, data: null };
      data = { temperatureC, humidityPercent, windKmh, rainMm, model: shortText(raw.model) };
      break;
    }
    case 'water':
      // Do not leak meter serial number, usage or water consumption to public web endpoints.
      return { kind, status: 'online', lastSeenAt, data: { received: true, private: true } };
    case 'remoteid':
      if (raw.protocol !== 'OpenDroneID' || raw.validated !== true)
        return { kind, status: 'invalid', lastSeenAt, data: null };
      data = { detection: 'REMOTE ID BROADCAST', verifiedAircraft: false };
      break;
    case 'rc': {
      const supported = ['ELRS', 'AFHDS', 'AFHDS2A', 'DSMX', 'DJI', 'OTHER'];
      const family = shortText(raw.family)?.toUpperCase();
      if (!supported.includes(family) || raw.validated !== true)
        return { kind, status: 'invalid', lastSeenAt, data: null };
      data = { family, detection: 'RC LINK ACTIVITY', droneConfirmed: false };
      break;
    }
    case 'rf': {
      const band = raw.band === 'wifi' || raw.band === 'ble' ? raw.band : null;
      const occupancyPercent = clamp(finite(raw.occupancyPercent), 0, 100);
      if (!band || occupancyPercent === null || raw.validated !== true)
        return { kind, status: 'invalid', lastSeenAt, data: null };
      data = { band, occupancyPercent, peopleDetected: false };
      break;
    }
    default: return emptyState(kind);
  }
  return { kind, status: 'online', lastSeenAt, data };
}

export function readSensors(paths = {}, now = Date.now()) {
  const sensors = {};
  for (const channel of SENSOR_CHANNELS) {
    const kind = channel === 'wifi' || channel === 'ble' ? 'rf' : channel;
    const filePath = paths[channel];
    if (typeof filePath !== 'string' || !filePath.trim()) {
      sensors[channel] = { ...emptyState(kind), kind: channel };
      continue;
    }
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      if (data.length > 64_000) throw new Error('oversized adapter payload');
      const projected = projectSensor(kind, JSON.parse(data), now);
      sensors[channel] = { ...projected, kind: channel };
      if (kind === 'rf' && projected.status === 'online' && projected.data.band !== channel) sensors[channel] = { ...emptyState(kind), kind: channel, status: 'invalid' };
    } catch (error) {
      sensors[channel] = { ...emptyState(kind), kind: channel, status: error.code === 'ENOENT' ? 'offline' : 'invalid' };
    }
  }
  return sensors;
}

export function detectSensorTransitions(previous = {}, next = {}, now = Date.now()) {
  const alerts = [];
  for (const kind of ['remoteid', 'rc']) {
    if (next[kind]?.status !== 'online' || previous[kind]?.status === 'online') continue;
    const detector = next[kind].data?.detection;
    if (detector) alerts.push({
      id: kind + ':' + now,
      kind: detector, source: kind, observedAt: new Date(now).toISOString(),
      detail: kind === 'rc' ? 'Protocol link activity; not confirmation of a drone' : 'OpenDroneID receiver broadcast'
    });
  }
  return alerts;
}

/** Only alert on persistent statistically elevated occupancy, never on device count/people. */
export function rfRise(history, now = Date.now()) {
  const recent = history.filter(p => p.observedAt >= now - 3600_000 && p.observedAt <= now);
  const bands = ['wifi', 'ble'];
  const results = [];
  for (const band of bands) {
    const points = recent.filter(p => p.band === band && Number.isFinite(p.occupancyPercent));
    if (points.length < 20) continue;
    const baseline = points.slice(0, -3).map(p => p.occupancyPercent).sort((a, b) => a - b);
    if (baseline.length < 17) continue;
    const middle = baseline[Math.floor(baseline.length / 2)];
    const latest = points.slice(-3);
    if (latest.length === 3 && latest.every(p => p.occupancyPercent >= Math.max(middle * 1.8, middle + 20)))
      results.push({ band, baselinePercent: middle, currentPercent: latest.at(-1).occupancyPercent });
  }
  return results;
}
