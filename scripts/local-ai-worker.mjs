#!/usr/bin/env node
// Low-priority, opt-in local Ollama analysis worker for BlackBox.
// It never controls the Kasa lamp, alters detector thresholds, or touches SDR capture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const RADAR = 'http://127.0.0.1:8788';
const OLLAMA = process.env.BLKBOX_OLLAMA_URL || 'http://127.0.0.1:11434';
const DATA_DIR = process.env.BLKBOX_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'BlackBoxAirspaceRadar');
const OUTPUT = path.join(DATA_DIR, 'ai-summary.json');
const POLL_MS = Math.max(60_000, Number(process.env.BLKBOX_AI_INTERVAL_SECONDS || 300) * 1000);
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(OLLAMA)) {
  console.error('Only local loopback Ollama endpoints are permitted.');
  process.exit(2);
}
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
async function readJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout || 90_000) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + new URL(url).pathname);
  return response.json();
}
async function pickModel() {
  const tags = await readJson(OLLAMA + '/api/tags');
  const installed = (tags.models || []).filter(m => typeof m.name === 'string');
  const forced = process.env.BLKBOX_LOCAL_MODEL;
  if (forced) {
    const selected = installed.find(m => m.name === forced || m.model === forced);
    if (!selected) throw new Error('BLKBOX_LOCAL_MODEL is not installed in Ollama: ' + forced);
    return selected.name;
  }
  const preferred = [/ministral.*8b/i, /qwen3\.5.*9b/i, /qwen3.*8b/i,
    /llama3\.1.*8b/i, /gemma3.*4b/i, /mistral.*7b/i];
  for (const pattern of preferred) {
    const selected = installed.find(m => pattern.test(m.name) && m.size <= 9_000_000_000);
    if (selected) return selected.name;
  }
  const fallback = installed.filter(m => m.size <= 8_000_000_000)
    .sort((a, b) => (a.size || Infinity) - (b.size || Infinity))[0];
  if (!fallback) throw new Error('No suitably sized local Ollama model installed. Set BLKBOX_LOCAL_MODEL.');
  return fallback.name;
}
function publicFacts(aircraft, alerts, sensors) {
  return {
    aircraft: aircraft.filter(a => (a.interestReasons || []).length).slice(0, 15).map(a => ({
      icao: a.icao, callsign: a.callsign, groundSpeedMph: a.groundSpeedMph,
      altitudeFt: a.altitudeFt, interestReasons: (a.interestReasons || []).map(r => r.label)
    })),
    events: (alerts || []).slice(-10).map(e => ({ kind: e.kind, icao: e.icao || '', observedAt: e.observedAt })),
    weather: sensors?.weather?.status === 'online' ? sensors.weather.data : null,
    sensors: Object.fromEntries(Object.entries(sensors || {}).map(([k, v]) => [k, v.status]))
  };
}
let model, previousHash = '', previousRun = 0, busy = false;
async function cycle() {
  if (busy) return;
  busy = true;
  try {
    if (!model) model = await pickModel();
    const [aircraft, analysis, sensors] = await Promise.all([
      readJson(RADAR + '/api/v1/aircraft'), readJson(RADAR + '/api/v1/analysis'),
      readJson(RADAR + '/api/v1/sensors')
    ]);
    const facts = publicFacts(aircraft.aircraft || [], analysis.alerts || [], sensors.sensors || {});
    const digest = crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    if (digest === previousHash && Date.now() - previousRun < 30 * 60_000) return;
    const prompt = [
      'You are BLKBOX local airspace analyst. Produce a factual short situational summary of at most 120 words.',
      'Only use JSON evidence below. No speculation, no command suggestions, no aircraft/people identification',
      'beyond explicitly provided IDs, and do not infer a drone from RC links or people from Wi-Fi/BLE activity.',
      'Weather numbers are local station observations, not a forecast. Do not invent missing readings.',
      'Return useful observations plainly; if there are none, say so. You have no control of alerts or switches.',
      'INPUT JSON:', JSON.stringify(facts)
    ].join('\n');
    const started = Date.now();
    const generated = await readJson(OLLAMA + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false,
        options: { temperature: 0.15, num_predict: 200, num_ctx: 4096 } })
    });
    const summary = String(generated.response || '').trim().slice(0, 1200);
    if (!summary) throw new Error('Local model returned an empty summary');
    const payload = { generatedAt: new Date().toISOString(), model, summary,
      inputHash: digest, latencyMs: Date.now() - started, advisoryOnly: true };
    const temp = OUTPUT + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(payload) + '\n', { mode: 0o600 });
    fs.renameSync(temp, OUTPUT);
    previousHash = digest;
    previousRun = Date.now();
    console.log(payload.generatedAt, 'AI analysis recorded via', model);
  } catch (error) {
    console.error('BLKBOX local AI unavailable:', error.message);
    if (/not installed|HTTP 404/.test(error.message)) model = null;
  } finally { busy = false; }
}
await cycle();
setInterval(() => void cycle(), POLL_MS);
// This background worker only polls the local read-only API and Ollama, never the SDR.
