// Additive migration keeps existing position history intact. Old speeds remain NULL.
export function prepareHistory(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(observations)').all().map((row) => row.name));
  for (const [name, type] of Object.entries({ ground_speed_mph: 'REAL', mach: 'REAL', mach_source: 'TEXT', registration: 'TEXT', registration_source: 'TEXT' })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE observations ADD COLUMN ${name} ${type}`);
  }
  const insert = db.prepare(`INSERT OR REPLACE INTO observations
    (icao, bucket, observed_at, latitude, longitude, altitude_ft, callsign,
     ground_speed_mph, mach, mach_source, registration, registration_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return (item, now, interval) => insert.run(item.icao, Math.floor(now / interval), now,
    item.latitude, item.longitude, item.altitudeFt, item.callsign,
    item.groundSpeedMph ?? null, item.mach ?? null, item.machSource ?? null,
    item.registration ?? null, item.registrationSource ?? null);
}
