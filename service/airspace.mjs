// Deterministic, receive-only airspace classification. No AI or network dependence.
export const KNOTS_TO_MPH = 1.150779448;
const NM_RADIUS_M = 1852;
const radians = value => value * Math.PI / 180;

export function distanceNm(a, b) {
  if (!Number.isFinite(a?.latitude) || !Number.isFinite(a?.longitude) || !Number.isFinite(b?.latitude) || !Number.isFinite(b?.longitude)) return null;
  const p1 = radians(a.latitude), p2 = radians(b.latitude);
  const dp = p2 - p1, dl = radians(b.longitude - a.longitude);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h))) / NM_RADIUS_M;
}
function bearing(a, b) {
  const p1 = radians(a.latitude), p2 = radians(b.latitude);
  const dl = radians(b.longitude - a.longitude);
  return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI;
}
function angleDelta(a, b) { return ((b - a + 540) % 360) - 180; }

export function classifyInterest(item) {
  const reasons = [];
  const add = (kind, label, detail) => reasons.push({ kind, label, detail });
  const speed = item.groundSpeedKt === null ? null : item.groundSpeedKt * KNOTS_TO_MPH;
  const flags = Number.isInteger(item.dbFlags) ? item.dbFlags : 0;
  if ((flags & 1) !== 0 || /^AE[0-9A-F]{4}$/i.test(item.icao)) add('military', 'MILITARY', 'Receiver database flag or likely U.S. military ICAO block; not independently verified');
  if (flags & 2) add('other', 'FLAGGED', 'Aircraft database marks this address as interesting');
  if (item.category?.toUpperCase() === 'B7') add('space', 'SPACE', 'Aircraft reports space/transatmospheric category; not a launch confirmation');
  if (!item.callsign && !item.registration) add('unmarked', 'UNMARKED', 'No callsign or registration available; does not imply malicious activity');
  if (speed !== null && speed > 550) add('speed', '>550 MPH', 'Reported ground speed, not airspeed');
  if (speed !== null && speed < 25) add('speed', '<25 MPH', 'Reported ground speed; may be on ground or inaccurate');
  if (item.altitudeFt !== null && item.altitudeFt > 42000) add('altitude', '>42K FT', 'Reported barometric altitude (MSL), not AGL');
  if (item.altitudeFt !== null && item.altitudeFt < 1000) add('altitude', '<1K FT', 'Reported barometric altitude (MSL), not AGL');
  if (item.emergency && item.emergency !== 'none') add('emergency', 'EMERGENCY', 'Aircraft-reported emergency');
  if (['7500', '7600', '7700'].includes(item.squawk)) add('emergency', `SQUAWK ${item.squawk}`, 'Emergency/special-purpose transponder code');
  return reasons;
}

function segmentObservations(rows, now, gapMs = 120000) {
  const byIcao = new Map();
  const ordered = [...rows].filter(row => Number.isFinite(row.observed_at) && typeof row.icao === 'string')
    .sort((a, b) => a.icao.localeCompare(b.icao) || a.observed_at - b.observed_at);
  for (const row of ordered) {
    let flights = byIcao.get(row.icao);
    if (!flights) { flights = []; byIcao.set(row.icao, flights); }
    let latest = flights[flights.length - 1];
    if (!latest || row.observed_at - latest.last > gapMs) {
      latest = { icao: row.icao, first: row.observed_at, last: row.observed_at, rows: [] };
      flights.push(latest);
    }
    latest.last = row.observed_at;
    latest.rows.push(row);
  }
  const completed = [...byIcao.values()].flat().filter(flight =>
    flight.last < now - gapMs && flight.rows.length >= 4 && flight.last - flight.first >= 30000
  );
  return { byIcao, completed };
}
function circulation(flight) {
  const points = flight.rows.filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  let pathNm = 0;
  const headings = [];
  for (let i = 1; i < points.length; i++) {
    const delta = distanceNm(points[i - 1], points[i]);
    if (delta !== null && delta >= 0.04 && delta <= 6) {
      pathNm += delta;
      headings.push(bearing(points[i - 1], points[i]));
    }
  }
  let totalTurn = 0, consistentLeft = 0, consistentRight = 0;
  for (let i = 1; i < headings.length; i++) {
    const turn = angleDelta(headings[i - 1], headings[i]);
    if (Math.abs(turn) > 90) continue; // Position glitches are not circles.
    totalTurn += turn;
    if (turn > 3) consistentRight += turn;
    if (turn < -3) consistentLeft -= turn;
  }
  const displacementNm = points.length >= 2 ? distanceNm(points[0], points[points.length - 1]) : null;
  const loop = headings.length >= 9 && pathNm >= 1 && Math.abs(totalTurn) >= 300
    && Math.max(consistentRight, consistentLeft) > 300 && (displacementNm ?? Infinity) < pathNm * 0.7;
  return { loop, pathNm, displacementNm, pointCount: points.length };
}

/** Analyze actual received track sessions, never invent positions or aircraft. */
export function analyzeAirspace(rows, liveAircraft, now = Date.now()) {
  const { byIcao, completed } = segmentObservations(rows, now);
  const durations = completed.map(f => (f.last - f.first) / 1000).sort((a, b) => a - b);
  const count = durations.length;
  const averageSeconds = count ? durations.reduce((sum, n) => sum + n, 0) / count : null;
  const p90Seconds = count ? durations[Math.ceil(count * 0.9) - 1] : null;
  const ready = count >= 10;
  // No dwell alert without a representative local baseline. Minimum eight minutes.
  const dwellThresholdSeconds = ready ? Math.max(480, averageSeconds * 2, p90Seconds * 1.3) : null;
  const flags = {};
  for (const item of liveAircraft) {
    const flights = byIcao.get(item.icao) || [];
    const flight = flights[flights.length - 1];
    if (!flight || flight.last < now - 90000) continue;
    const seconds = (flight.last - flight.first) / 1000;
    const shape = circulation(flight);
    const kinds = [];
    if (dwellThresholdSeconds !== null && seconds > dwellThresholdSeconds) kinds.push('LONG STAY');
    if (seconds >= 90 && shape.loop) kinds.push('CIRCLING');
    if (seconds >= 120 && shape.pointCount >= 8 && (shape.displacementNm ?? Infinity) < 0.3
      && item.groundSpeedKt !== null && item.groundSpeedKt * KNOTS_TO_MPH < 25
      && item.altitudeFt !== null && item.altitudeFt > 0) kinds.push('POSSIBLE HOVER');
    const recentVisits = flights.filter(f => f.last >= now - 2 * 3600000).length;
    if (recentVisits >= 3 && seconds >= 30) kinds.push('REPEAT VISIT');
    if (kinds.length) flags[item.icao] = {
      kinds, identifier: item.registration || item.callsign || item.icao,
      firstSeenAt: new Date(flight.first).toISOString(),
      durationSeconds: seconds, recentVisits
    };
  }
  return {
    reception: { averageSeconds, p90Seconds, completedFlights: count, dwellThresholdSeconds, learning: !ready },
    flags
  };
}

export function recentOverhead(rows, observationPoint, now = Date.now(), maxAgeMs = 5 * 60000) {
  if (!Number.isFinite(observationPoint?.latitude) || !Number.isFinite(observationPoint?.longitude)) return null;
  const candidates = rows
    .filter(row => row.observed_at >= now - maxAgeMs)
    .map(row => ({ ...row, distanceNm: distanceNm(row, observationPoint) }))
    .filter(row => row.distanceNm !== null && row.distanceNm <= 15)
    .sort((a, b) => a.distanceNm - b.distanceNm || b.observed_at - a.observed_at);
  return candidates[0] || null;
}
