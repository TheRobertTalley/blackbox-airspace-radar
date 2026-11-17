import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { prepareHistory } from '../history.mjs';
import { groupTracks, normalizeAircraft } from '../lib.mjs';
import { compareHistory } from '../../web/src/history-sort.ts';

test('migrates legacy history without inventing speeds and persists normalized speed in SQLite', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE observations (icao TEXT, bucket INTEGER, observed_at INTEGER, latitude REAL, longitude REAL, altitude_ft REAL, callsign TEXT, PRIMARY KEY(icao,bucket));
      INSERT INTO observations VALUES ('ABC123',1,1000,34,-83,NULL,'OLD');`);
    const save = prepareHistory(db);
    prepareHistory(db); // Repeat migration safely.
    const aircraft = normalizeAircraft({ hex: 'abc123', flight: 'NEW', lat: 34, lon: -83, alt_baro: 30000, gs: 400, mach: 0.7, r: 'N12345' });
    save(aircraft, 20000, 10000);
    const rows = db.prepare('SELECT * FROM observations ORDER BY observed_at').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ground_speed_mph, null);
    assert.ok(Math.abs(rows[1].ground_speed_mph - 400 * 1852 / 1609.344) < 0.000001);
    assert.equal(rows[1].mach, 0.7);
    assert.equal(rows[1].registration, 'N12345');
    const track = groupTracks(rows).features[0];
    assert.equal(track.properties.groundSpeedMph, aircraft.groundSpeedMph);
    assert.equal(track.properties.samples[0].groundSpeedMph, null);
    assert.equal(track.properties.samples[1].groundSpeedMph, aircraft.groundSpeedMph);
    assert.equal(track.properties.machSource, 'reported');
    const old = groupTracks([rows[0]]).features[0].properties;
    assert.equal(old.groundSpeedMph, null);
    assert.equal(old.altitudeFt, null);
    save({ ...aircraft, groundSpeedMph: 0, mach: 0 }, 30000, 10000);
    assert.equal(groupTracks(db.prepare('SELECT * FROM observations').all()).features[0].properties.groundSpeedMph, 0);
  } finally { db.close(); }
});

test('history sorting is numeric, chronological, stable, and puts unavailable values last both ways', () => {
  const base = { callsign: '', icao: 'ABC123', altitudeFt: null, groundSpeedMph: null, mach: null, pointCount: 2, firstObservedAt: '2026-11-01T00:00:00Z', lastObservedAt: '2026-11-01T00:00:00Z' };
  const rows = [{ ...base, trackId: 'missing' }, { ...base, trackId: 'slow', groundSpeedMph: 90, callsign: 'A2' }, { ...base, trackId: 'fast', groundSpeedMph: 400, callsign: 'A10', lastObservedAt: '2026-11-02T00:00:00Z' }];
  const ids = (key, asc) => [...rows].sort((a,b) => compareHistory(a,b,key,asc)).map(r => r.trackId);
  assert.deepEqual(ids('groundSpeedMph', false), ['fast', 'slow', 'missing']);
  assert.deepEqual(ids('groundSpeedMph', true), ['slow', 'fast', 'missing']);
  assert.equal(ids('identifier', true)[0], 'slow');
  assert.equal(ids('lastObservedAt', false)[0], 'fast');
  assert.deepEqual(ids('mach', true), ids('mach', false));
});
