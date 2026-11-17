// Optional local-only Ollama interpretation of deterministic radar facts.
// Run with Node 22+ on BlackBox; no AI output controls alarms or switches.
const RADAR = 'http://127.0.0.1:8788';
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL = process.env.BLKBOX_LOCAL_MODEL;
if (!MODEL) {
  console.error('Specify BLKBOX_LOCAL_MODEL matching an installed local Ollama model.');
  process.exit(2);
}
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(OLLAMA)) {
  console.error('Only a loopback Ollama endpoint is allowed.');
  process.exit(2);
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  return response.json();
}
const [live, analysis] = await Promise.all([
  json(RADAR + '/api/v1/aircraft'),
  json(RADAR + '/api/v1/analysis')
]);
const aircraft = (live.aircraft || []).filter(a => a.interestReasons?.length).slice(0, 20).map(a => ({
  icao: a.icao, callsign: a.callsign, registration: a.registration, category: a.category,
  groundSpeedMph: a.groundSpeedMph, altitudeFt: a.altitudeFt,
  reasons: a.interestReasons?.map(r => r.label)
}));
const facts = { aircraft, alerts: (analysis.alerts || []).slice(-20), reception: analysis.analysis?.reception };
const prompt = 'Summarize this receive-only ADS-B airspace snapshot in no more than 130 words. Only describe provided facts. Clearly distinguish aircraft identifiers from verified identity. Never infer hostile intent, people, or aircraft type from speed alone. Do not invent weather or sensor readings. Raw input: ' + JSON.stringify(facts);
const result = await json(OLLAMA + '/api/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature: 0.15, num_predict: 230 } })
});
console.log(result.response || 'No summary returned');
