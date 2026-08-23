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
  const configured = ['https://owner.github.io', 'https://blackbox.example.ts.net'];
  assert.equal(corsOriginAllowed('https://owner.github.io', configured), true);
  assert.equal(corsOriginAllowed('https://blackbox.example.ts.net', configured), true);
  assert.equal(corsOriginAllowed('http://localhost:5173', configured), true);
  assert.equal(corsOriginAllowed('https://attacker.example', configured), false);
});

test('groups historical rows into GeoJSON tracks', () => {
  const result = groupTracks([
    { icao: 'ABC123', callsign: 'TEST1', longitude: -75, latitude: 40, altitude_ft: 10000, observed_at: 1 },
    { icao: 'ABC123', callsign: 'TEST1', longitude: -74.9, latitude: 40.1, altitude_ft: 11000, observed_at: 2 }
  ]);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].geometry.type, 'LineString');
  assert.equal(result.features[0].geometry.coordinates.length, 2);
  assert.equal(result.features[0].properties.callsign, 'TEST1');
  assert.equal(result.features[0].properties.pointCount, 2);
  assert.equal(result.features[0].properties.altitudeFt, 11000);
});

test('splits repeated aircraft into separate flights and keeps singleton tracks visible', () => {
  const result = groupTracks([
    { icao: 'ABC123', callsign: 'FIRST1', longitude: -75, latitude: 40, altitude_ft: 10000, observed_at: 1 },
    { icao: 'ABC123', callsign: 'SECOND2', longitude: -74, latitude: 41, altitude_ft: 12000, observed_at: 20 * 60 * 1000 }
  ]);
  assert.equal(result.features.length, 2);
  assert.equal(result.features[0].properties.pointCount, 1);
  assert.equal(result.features[0].geometry.coordinates.length, 2);
  assert.equal(result.features[1].properties.callsign, 'SECOND2');
});
