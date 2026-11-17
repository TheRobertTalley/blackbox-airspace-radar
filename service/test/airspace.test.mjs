import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInterest, distanceNm, analyzeAirspace, recentOverhead } from '../airspace.mjs';

function craft(overrides = {}) {
  return {
    icao: 'ABC123', callsign: 'TEST', registration: null, category: 'A3', dbFlags: 0,
    groundSpeedKt: 200, altitudeFt: 2000, emergency: 'none', squawk: '1200', ...overrides
  };
}
test('user-defined speed thresholds are strict mph, not knots', () => {
  assert.ok(classifyInterest(craft({ groundSpeedKt: 480 })).some(r => r.label === '>550 MPH'));
  assert.ok(!classifyInterest(craft({ groundSpeedKt: 300 })).some(r => r.label === '>550 MPH'));
  assert.ok(classifyInterest(craft({ groundSpeedKt: 10 })).some(r => r.label === '<25 MPH'));
  assert.ok(!classifyInterest(craft({ groundSpeedKt: null })).some(r => r.kind === 'speed'));
});
test('user-defined altitude thresholds and unmarked/military labels', () => {
  const labels = classifyInterest(craft({ callsign: '', altitudeFt: 43000, dbFlags: 1 })).map(r => r.label);
  assert.ok(labels.includes('>42K FT'));
  assert.ok(labels.includes('MILITARY'));
  assert.ok(labels.includes('UNMARKED'));
  assert.ok(classifyInterest(craft({ altitudeFt: 900 })).some(r => r.label === '<1K FT'));
  assert.ok(!classifyInterest(craft({ altitudeFt: null })).some(r => r.kind === 'altitude'));
});
test('interest includes emergencies', () => {
  assert.ok(classifyInterest(craft({ squawk: '7700' })).some(r => r.kind === 'emergency'));
});
test('actual track durations, not arbitrary dwell threshold, establish baseline', () => {
  const now = 1_000_000_000;
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const icao = 'A' + String(i).padStart(5, '0');
    const start = now - (i + 2) * 500_000;
    for (let j = 0; j < 8; j++) rows.push({
      icao, observed_at: start + j * 10000, latitude: 34 + j * 0.001, longitude: -83, altitude_ft: 3500
    });
  }
  const result = analyzeAirspace(rows, [], now);
  assert.equal(result.reception.completedFlights, 10);
  assert.equal(result.reception.averageSeconds, 70);
  assert.equal(result.reception.learning, false);
  assert.equal(result.reception.dwellThresholdSeconds, 480);
});
test('returns no duration threshold without enough completed flights', () => {
  const result = analyzeAirspace([], [{ icao: 'ABC123' }], Date.now());
  assert.equal(result.reception.learning, true);
  assert.equal(result.reception.dwellThresholdSeconds, null);
});
test('recent overhead selects actual closest position within cutoff', () => {
  const now = 1000000;
  const rows = [
    { icao: 'NEAR', latitude: 34.4, longitude: -83.65, observed_at: now - 10000 },
    { icao: 'FAR', latitude: 36, longitude: -83, observed_at: now - 5000 },
    { icao: 'OLD', latitude: 34.4, longitude: -83.65, observed_at: now - 600000 }
  ];
  assert.equal(recentOverhead(rows, { latitude: 34.4, longitude: -83.65 }, now)?.icao, 'NEAR');
  assert.equal(distanceNm({ latitude: 34.4, longitude: -83.65 }, { latitude: 34.4, longitude: -83.65 }), 0);
});
