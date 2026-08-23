import test from 'node:test';
import assert from 'node:assert/strict';
import { corsOriginAllowed, groupTracks, normalizeAircraft } from '../lib.mjs';

test('normalizes readsb aircraft without inventing missing values', () => {
  const item = normalizeAircraft({ hex: 'abc123', flight: ' TEST1 ', lat: 40, lon: -75, alt_baro: 12000, gs: 210, seen: 2 }, 10000);
  assert.equal(item.icao, 'ABC123');
  assert.equal(item.callsign, 'TEST1');
  assert.equal(item.altitudeFt, 12000);
  assert.equal(item.rssiDbfs, null);
  assert.equal(item.observedAt, new Date(8000).toISOString());
});

test('rejects unconfigured cross-origin callers', () => {
  assert.equal(corsOriginAllowed('https://owner.github.io', 'https://owner.github.io'), true);
  assert.equal(corsOriginAllowed('http://localhost:5173', 'https://owner.github.io'), true);
  assert.equal(corsOriginAllowed('https://attacker.example', 'https://owner.github.io'), false);
});

test('groups historical rows into GeoJSON tracks', () => {
  const result = groupTracks([
    { icao: 'ABC123', longitude: -75, latitude: 40, altitude_ft: 10000, observed_at: 1 },
    { icao: 'ABC123', longitude: -74.9, latitude: 40.1, altitude_ft: 11000, observed_at: 2 }
  ]);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].geometry.type, 'LineString');
  assert.equal(result.features[0].geometry.coordinates.length, 2);
});
