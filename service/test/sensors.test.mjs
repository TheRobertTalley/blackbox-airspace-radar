import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectSensor, readSensors, detectSensorTransitions, rfRise } from '../sensors.mjs';

const NOW = Date.parse('2026-11-17T12:00:00Z');
test('weather readings are projected with numeric telemetry only', () => {
  const v = projectSensor('weather', {
    observedAt: new Date(NOW).toISOString(), model: 'Outdoor-WX',
    temperatureC: 15.2, humidityPercent: 81, windKmh: 9
  }, NOW);
  assert.equal(v.status, 'online');
  assert.equal(v.data.temperatureC, 15.2);
  assert.equal(v.data.humidityPercent, 81);
  assert.equal(v.data.windKmh, 9);
  assert.equal(v.data.rainMm, null);
});
test('private water usage and meter ID never escape through the public projection', () => {
  const v = projectSensor('water', {
    observedAt: new Date(NOW).toISOString(), meterId: 'SENSITIVE-ID', consumptionRaw: 123456
  }, NOW);
  assert.equal(v.status, 'online');
  assert.equal(v.data.received, true);
  assert.ok(!JSON.stringify(v).includes('SENSITIVE-ID'));
  assert.ok(!JSON.stringify(v).includes('123456'));
});
test('RF and Remote ID cannot claim drone presence from generic RF activity', () => {
  const unverified = projectSensor('remoteid', { observedAt: new Date(NOW).toISOString(), validated: true, protocol: 'Bluetooth' }, NOW);
  assert.equal(unverified.status, 'invalid');
  const identified = projectSensor('remoteid', { observedAt: new Date(NOW).toISOString(), validated: true, protocol: 'OpenDroneID' }, NOW);
  assert.equal(identified.status, 'online');
  assert.equal(identified.data.verifiedAircraft, false);
  const rc = projectSensor('rc', { observedAt: new Date(NOW).toISOString(), validated: true, family: 'ELRS' }, NOW);
  assert.equal(rc.data.droneConfirmed, false);
});
test('stale RF samples cannot trigger a fresh alert', () => {
  const stale = projectSensor('rf', { observedAt: new Date(NOW - 5 * 60_000).toISOString(), validated: true, band: 'wifi', occupancyPercent: 89 }, NOW);
  assert.equal(stale.status, 'stale');
  const next = { remoteid: { status: 'online', data: { detection: 'REMOTE ID BROADCAST' } } };
  const previous = { remoteid: { status: 'online' } };
  assert.equal(detectSensorTransitions(previous, next, NOW).length, 0);
  assert.equal(detectSensorTransitions({}, next, NOW).length, 1);
});
test('Wi-Fi/BLE occupancy alert needs at least 20 independent observations and a persistent rise', () => {
  const samples = Array.from({ length: 17 }, (_, i) => ({ band: 'wifi', observedAt: NOW - (20 - i) * 10000, occupancyPercent: 10 }));
  assert.equal(rfRise(samples, NOW).length, 0);
  const elevated = [...samples, ...Array.from({ length: 3 }, (_, i) => ({
    band: 'wifi', observedAt: NOW - (3 - i) * 10000, occupancyPercent: 65
  }))];
  const result = rfRise(elevated, NOW);
  assert.equal(result.length, 1);
  assert.equal(result[0].band, 'wifi');
  assert.equal(result[0].baselinePercent, 10);
});
test('sensor file reader reports unavailable and preserves privacy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blkbox-sensors-'));
  try {
    const water = path.join(dir, 'water.json');
    fs.writeFileSync(water, JSON.stringify({ observedAt: new Date(NOW).toISOString(), meterId: 'PRIVATE', consumptionRaw: 9876 }));
    const result = readSensors({ water, weather: path.join(dir, 'missing.json') }, NOW);
    assert.equal(result.water.status, 'online');
    assert.equal(result.weather.status, 'offline');
    assert.equal(result.wifi.status, 'not-configured');
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('rtl_433 and own-meter stream bridge writes truthful locally-scoped observations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blkbox-bridge-'));
  const bridge = new URL('../../scripts/sensor-bridge.mjs', import.meta.url).pathname;
  try {
    const wx = spawnSync(process.execPath, [bridge, 'weather'], {
      env: { ...process.env, BLKBOX_SENSOR_DIR: dir, BLKBOX_WEATHER_SENSOR_ID: '42' },
      input: [
        JSON.stringify({ model: 'Nexus-TH', id: 42, temperature_C: 20.5, humidity: 83 }),
        JSON.stringify({ model: 'Other', id: 99, temperature_C: 22 })
      ].join('\n'), encoding: 'utf8'
    });
    assert.equal(wx.status, 0, wx.stderr);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'weather.json'), 'utf8'));
    assert.equal(record.temperatureC, 20.5);
    assert.equal(record.humidityPercent, 83);
    const water = spawnSync(process.execPath, [bridge, 'water'], {
      env: { ...process.env, BLKBOX_SENSOR_DIR: dir, BLKBOX_WATER_METER_ID: '192' },
      input: [JSON.stringify({ Message: { ID: 111, Consumption: 30 } }),
        JSON.stringify({ Message: { ID: 192, Consumption: 501 } })].join('\n'), encoding: 'utf8'
    });
    assert.equal(water.status, 0, water.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'water.json'), 'utf8')).consumptionRaw, 501);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
