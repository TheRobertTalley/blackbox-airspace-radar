import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { corsOriginAllowed, groupTracks, loadConfig, normalizeAircraft } from './lib.mjs';

const configPath = process.env.RADAR_CONFIG || path.join(import.meta.dirname, 'config.json');
const config = loadConfig(configPath);
const webRoot = path.resolve(import.meta.dirname, '..', 'web', 'dist');
fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

const db = new DatabaseSync(config.databasePath);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  CREATE TABLE IF NOT EXISTS observations (
    icao TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    altitude_ft REAL,
    callsign TEXT,
    PRIMARY KEY (icao, bucket)
  );
  CREATE INDEX IF NOT EXISTS observations_time ON observations(observed_at);
`);

const insertObservation = db.prepare(`
  INSERT OR REPLACE INTO observations
  (icao, bucket, observed_at, latitude, longitude, altitude_ft, callsign)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const countHistory = db.prepare('SELECT COUNT(*) AS count FROM observations');
let aircraft = [];
let sourceGeneratedAt = null;
let sourceMessageCount = 0;
let lastReadAt = null;
let lastError = null;
const streams = new Set();

function responseJson(response, status, body, origin) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin || config.allowedOrigins[0],
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(JSON.stringify(body));
}

function serveWeb(pathname, response) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (relativePath !== 'index.html' && !/^assets\/[A-Za-z0-9._-]+$/.test(relativePath)) return false;
  const filePath = path.join(webRoot, relativePath);
  if (!filePath.startsWith(`${webRoot}${path.sep}`) || !fs.existsSync(filePath)) return false;
  const extension = path.extname(filePath);
  const contentType = extension === '.html'
    ? 'text/html; charset=utf-8'
    : extension === '.js'
      ? 'text/javascript; charset=utf-8'
      : extension === '.css'
        ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

function statusPayload() {
  const age = lastReadAt ? Math.max(0, (Date.now() - lastReadAt) / 1000) : null;
  return {
    ok: age !== null && age < 5 && !lastError,
    rxOnly: true,
    source: 'bladeRF x40 / hosted FPGA / readsb software decoder',
    aircraftCount: aircraft.length,
    positionedCount: aircraft.filter((item) => item.latitude !== null && item.longitude !== null).length,
    messageCount: sourceMessageCount,
    hasReceivedMessages: sourceMessageCount > 0,
    dataAgeSeconds: age,
    generatedAt: sourceGeneratedAt,
    lastError,
    historyRecords: Number(countHistory.get().count),
    receiver: config.receiver,
    retention: { days: config.historyDays, maxBytes: config.maxDatabaseBytes }
  };
}

function publish() {
  const payload = `event: aircraft\ndata: ${JSON.stringify({ status: statusPayload(), aircraft })}\n\n`;
  for (const response of streams) response.write(payload);
}

function pollReadsb() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.readsbJsonPath, 'utf8'));
    const now = Date.now();
    aircraft = (Array.isArray(raw.aircraft) ? raw.aircraft : [])
      .map((item) => normalizeAircraft(item, now))
      .filter(Boolean)
      .filter((item) => item.seenSeconds <= 60);
    sourceGeneratedAt = Number.isFinite(raw.now) ? new Date(raw.now * 1000).toISOString() : new Date(now).toISOString();
    sourceMessageCount = Number.isFinite(raw.messages) ? raw.messages : 0;
    lastReadAt = now;
    lastError = null;

    const interval = config.sampleIntervalSeconds * 1000;
    for (const item of aircraft) {
      if (item.latitude === null || item.longitude === null) continue;
      insertObservation.run(
        item.icao,
        Math.floor(now / interval),
        now,
        item.latitude,
        item.longitude,
        item.altitudeFt,
        item.callsign
      );
    }
    publish();
  } catch (error) {
    lastError = error.code === 'ENOENT' ? 'receiver data unavailable' : String(error.message || error);
  }
}

function enforceRetention() {
  const cutoff = Date.now() - config.historyDays * 86400000;
  db.prepare('DELETE FROM observations WHERE observed_at < ?').run(cutoff);
  try {
    while (fs.statSync(config.databasePath).size > config.maxDatabaseBytes) {
      const oldest = db.prepare('SELECT MIN(observed_at) AS value FROM observations').get().value;
      if (!oldest) break;
      db.prepare('DELETE FROM observations WHERE observed_at <= ?').run(oldest + 86400000);
      db.exec('PRAGMA incremental_vacuum(1000)');
    }
  } catch {
    // A missing database file cannot happen after DatabaseSync opens it.
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && serveWeb(url.pathname, response)) return;
  const origin = request.headers.origin;
  if (!corsOriginAllowed(origin, config.allowedOrigins)) {
    return responseJson(response, 403, { error: 'origin not allowed' }, config.allowedOrigins[0]);
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': origin || config.allowedOrigins[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin, Access-Control-Request-Private-Network'
    });
    return response.end();
  }
  if (request.method !== 'GET') return responseJson(response, 405, { error: 'read-only service' }, origin);

  if (url.pathname === '/health') return responseJson(response, statusPayload().ok ? 200 : 503, statusPayload(), origin);
  if (url.pathname === '/api/v1/status') return responseJson(response, 200, statusPayload(), origin);
  if (url.pathname === '/api/v1/aircraft') return responseJson(response, 200, { generatedAt: sourceGeneratedAt, aircraft }, origin);
  if (url.pathname === '/api/v1/tracks') {
    const minimum = Date.now() - config.historyDays * 86400000;
    const requested = Date.parse(url.searchParams.get('since') || '');
    const since = Number.isFinite(requested) ? Math.max(minimum, requested) : Date.now() - 86400000;
    const icao = (url.searchParams.get('icao') || '').trim().toUpperCase();
    const rows = icao
      ? db.prepare('SELECT * FROM observations WHERE observed_at >= ? AND icao = ? ORDER BY observed_at LIMIT 200000').all(since, icao)
      : db.prepare('SELECT * FROM observations WHERE observed_at >= ? ORDER BY icao, observed_at LIMIT 200000').all(since);
    return responseJson(response, 200, groupTracks(rows), origin);
  }
  if (url.pathname === '/api/v1/stream') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': origin || config.allowedOrigins[0],
      'Vary': 'Origin'
    });
    streams.add(response);
    response.write(`event: aircraft\ndata: ${JSON.stringify({ status: statusPayload(), aircraft })}\n\n`);
    request.on('close', () => streams.delete(response));
    return;
  }
  return responseJson(response, 404, { error: 'not found' }, origin);
});

pollReadsb();
setInterval(pollReadsb, 1000).unref();
setInterval(enforceRetention, 3600000).unref();
server.listen(config.port, config.host, () => {
  console.log(`BlackBox Airspace API listening on http://${config.host}:${config.port} (RX only)`);
});
