import L, { Circle, Map as LeafletMap, Marker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import type { Aircraft, LivePayload, ReceiverStatus } from './types';
import { compareHistory, type HistorySortKey } from './history-sort';

const endpointKey = 'blackbox-airspace-api';
const receiverApiBase = 'https://blackbox.tailade622.ts.net';
const defaultApiBase = ['blackbox.tailade622.ts.net', '127.0.0.1', 'localhost'].includes(location.hostname) ? location.origin : receiverApiBase;
const lulaCityHall: L.LatLngExpression = [34.389096, -83.664491];
const receiverViewZoom = 10;
// Initial 275-position sample: 95% within 9.92 NM; farthest observed fix 10.85 NM.
const demonstratedRangeNm = 11;

interface HistoryTrack {
  trackId: string;
  icao: string;
  callsign: string;
  latitude: number;
  longitude: number;
  altitudeFt: number | null;
  groundSpeedMph: number | null;
  mach?: Aircraft['mach'];
  machSource?: Aircraft['machSource'];
  registration?: Aircraft['registration'];
  registrationSource?: Aircraft['registrationSource'];
  pointCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
}

const elements = {
  clock: document.querySelector<HTMLElement>('#clock')!,
  connectionButton: document.querySelector<HTMLButtonElement>('#connection-button')!,
  connectionLabel: document.querySelector<HTMLElement>('#connection-label')!,
  aircraftCount: document.querySelector<HTMLElement>('#aircraft-count')!,
  positionedCount: document.querySelector<HTMLElement>('#positioned-count')!,
  dataAge: document.querySelector<HTMLElement>('#data-age')!,
  receiverSource: document.querySelector<HTMLElement>('#receiver-source')!,
  historyCount: document.querySelector<HTMLElement>('#history-count')!,
  trafficMode: document.querySelector<HTMLElement>('#traffic-mode')!,
  list: document.querySelector<HTMLElement>('#aircraft-list')!,
  interestList: document.querySelector<HTMLElement>('#interest-list')!,
  interestCount: document.querySelector<HTMLElement>('#interest-count')!,
  filter: document.querySelector<HTMLInputElement>('#aircraft-filter')!,
  lastUpdate: document.querySelector<HTMLElement>('#last-update')!,
  windowLabel: document.querySelector<HTMLElement>('#window-label')!,
  dialog: document.querySelector<HTMLDialogElement>('#settings-dialog')!,
  form: document.querySelector<HTMLFormElement>('#settings-form')!,
  apiUrl: document.querySelector<HTMLInputElement>('#api-url')!,
  settingsError: document.querySelector<HTMLElement>('#settings-error')!,
  clearApi: document.querySelector<HTMLButtonElement>('#clear-api')!
};

const map: LeafletMap = L.map('map', { zoomControl: false, attributionControl: true }).setView(lulaCityHall, receiverViewZoom);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  referrerPolicy: 'strict-origin-when-cross-origin',
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const trackLayer = L.layerGroup().addTo(map);
const historyAircraftLayer = L.layerGroup().addTo(map);
const aircraftLayer = L.layerGroup().addTo(map);
const rangeLayer = L.layerGroup().addTo(map);
const markers = new Map<string, Marker>();
const historyMarkers = new Map<string, Marker>();
let currentAircraft: Aircraft[] = [];
let historyTracks: HistoryTrack[] = [];
let selectedIcao = '';
let selectedHistoryTrackId = '';
let eventSource: EventSource | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let connectionGeneration = 0;
let apiBase = localStorage.getItem(endpointKey)?.trim() || defaultApiBase;
let centeredOnReceiver = false;
let selectedHistoryHours = 0;
let selectedHistoryPoints = 0;
let storedHistoryRecords = 0;
let receiverOnline = false;
let interestOnly = false;
let latestAnalysis: Record<string, { kinds: string[]; identifier: string; durationSeconds: number }> = {};
let latestAlerts: { id: string; icao: string; identifier: string; kind: string; observedAt: string }[] = [];

function speedMph(item: { groundSpeedMph?: number | null; groundSpeedKt?: number | null }) {
  return item.groundSpeedMph ?? (item.groundSpeedKt == null ? null : item.groundSpeedKt * 1852 / 1609.344);
}

function formatSpeed(item: { groundSpeedMph?: number | null; groundSpeedKt?: number | null }) {
  const speed = speedMph(item);
  return speed === null ? '—' : speed.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function machDisplay(item: Pick<Aircraft, 'mach' | 'machSource'>) {
  if (item.mach == null || !Number.isFinite(item.mach)) return '<small class="mach-value" title="Mach unavailable: no usable speed and temperature or altitude">Mach —</small>';
  const estimated = item.machSource !== 'reported';
  const detail = item.machSource === 'ground-estimate' ? 'Estimate from ground speed and temperature/standard atmosphere; wind is not accounted for. Not measured airspeed Mach.'
    : item.machSource === 'tas-standard' ? 'Estimated from true airspeed and standard-atmosphere temperature at altitude.'
    : item.machSource === 'tas-temperature' ? 'Calculated from true airspeed and outside air temperature.' : 'Mach reported by the aircraft.';
  return `<small class="mach-value" title="${detail}">${estimated ? 'Est Mach' : 'Mach'} ${item.mach.toFixed(2)}</small>`;
}

function copyButton(item: { registration?: string | null; registrationSource?: string | null; callsign: string; icao: string }) {
  const value = item.registration || item.callsign || item.icao;
  const kind = item.registration ? 'tail number' : item.callsign ? 'callsign' : 'ICAO address';
  const detail = item.registrationSource === 'icao-derived' ? ' · derived from ICAO address' : item.registration ? '' : ' · tail number unavailable';
  return `<button type="button" class="copy-identifier" data-copy="${escapeHtml(value)}" data-copy-kind="${kind}" aria-label="Copy ${kind} ${escapeHtml(value)}" title="Copy ${kind}: ${escapeHtml(value + detail)}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></svg></button>`;
}

function identifierDetail(item: Aircraft) {
  if (item.registration) {
    const label = item.registration === item.callsign ? 'Tail number' : escapeHtml(item.registration);
    return `${label}${item.registrationSource === 'icao-derived' ? ' · derived' : ''}`;
  }
  return item.callsign ? `${escapeHtml(item.icao)} · tail unknown` : 'Tail number unknown';
}

// Compatibility for the public dashboard while BlackBox's local API is still on an older build.
// The server remains authoritative when it supplies classifications.
function withInterestFallback(item: Aircraft): Aircraft {
  if (item.interestReasons !== undefined) return item;
  const reasons: NonNullable<Aircraft['interestReasons']> = [];
  const add = (kind: NonNullable<Aircraft['interestReasons']>[number]['kind'], label: string, detail: string) => reasons.push({ kind, label, detail });
  const speed = speedMph(item);
  if (!item.callsign && !item.registration) add('unmarked', 'UNMARKED', 'No callsign or registration available');
  if (/^AE[0-9A-F]{4}$/i.test(item.icao)) add('military', 'MILITARY', 'Likely U.S. military ICAO block; not verified');
  if (item.category?.toUpperCase() === 'B7') add('space', 'SPACE', 'Reported space/transatmospheric category');
  if (speed !== null && speed > 550) add('speed', '>550 MPH', 'Ground speed');
  if (speed !== null && speed < 25) add('speed', '<25 MPH', 'Ground speed');
  if (item.altitudeFt !== null && item.altitudeFt > 42000) add('altitude', '>42K FT', 'Barometric altitude MSL');
  if (item.altitudeFt !== null && item.altitudeFt < 1000) add('altitude', '<1K FT', 'Barometric altitude MSL');
  if (item.emergency && item.emergency !== 'none') add('emergency', 'EMERGENCY', 'Aircraft-reported emergency');
  if (['7500', '7600', '7700'].includes(item.squawk)) add('emergency', 'SQUAWK ' + item.squawk, 'Special transponder code');
  return { ...item, interestReasons: reasons };
}

function renderInterest() {
  const interestFilter = document.querySelector<HTMLButtonElement>('#interest-filter')!;
  interestFilter.setAttribute('aria-pressed', String(interestOnly));
  interestFilter.textContent = interestOnly ? 'SHOW ALL' : 'FILTER INTEREST';
  const items = receiverOnline ? currentAircraft.filter((item) => item.seenSeconds <= 60 && item.interestReasons?.length)
    .sort((a, b) => Number(b.interestReasons!.some((r) => r.kind !== 'speed')) - Number(a.interestReasons!.some((r) => r.kind !== 'speed')) || (speedMph(b) ?? -1) - (speedMph(a) ?? -1)) : [];
  elements.interestCount.textContent = String(items.length);
  elements.interestList.innerHTML = items.length ? items.map((item) => `
    <div class="aircraft-entry"><button type="button" class="interest-row${selectedIcao === item.icao ? ' selected' : ''}" data-icao="${escapeHtml(item.icao)}">
      <span class="interest-ident"><strong>${escapeHtml(item.callsign || item.registration || item.icao)}</strong><small>${identifierDetail(item)}</small><small>${formatNumber(item.altitudeFt, ' ft')}${item.latitude === null || item.longitude === null ? ' · No position' : ''}</small></span>
      <span class="interest-speed">${formatSpeed(item)}<small>MPH</small>${machDisplay(item)}</span>
      <span class="interest-reasons">${item.interestReasons!.map((reason) => `<span class="interest-tag ${reason.kind}" title="${escapeHtml(reason.detail)}">${escapeHtml(reason.label)}</span>`).join('')}</span>
    </button>${copyButton(item)}</div>`).join('') : `<p class="interest-empty">${receiverOnline ? 'No matching aircraft in the live feed.' : 'Waiting for a healthy live feed.'}</p>`;
}

function aircraftIcon(item: Aircraft, selected = false) {
  const rotation = item.trackDeg ?? 0;
  const emergency = item.emergency && item.emergency !== 'none';
  return L.divIcon({
    className: 'aircraft-marker-wrap',
    html: `<div class="aircraft-marker${selected ? ' selected' : ''}${emergency ? ' emergency' : ''}" style="--track:${rotation}deg" aria-label="${escapeHtml(item.callsign || item.icao)}"><svg viewBox="0 0 24 24" role="img"><path d="M12 1.5l2.2 7.1 7.2 4.1v2l-7.2-1.8-.7 6 2.7 1.8v1.5L12 21l-4.2 1.2v-1.5l2.7-1.8-.7-6-7.2 1.8v-2l7.2-4.1L12 1.5z"/></svg></div>`,
    iconSize: [34, 34], iconAnchor: [17, 17]
  });
}

function historyAircraftIcon(item: HistoryTrack, selected = false) {
  return L.divIcon({
    className: 'history-aircraft-marker-wrap',
    html: `<div class="history-aircraft-marker${selected ? ' selected' : ''}" aria-label="Historical ${escapeHtml(item.callsign || item.icao)}"><svg viewBox="0 0 24 24" role="img"><path d="M12 1.5l2.2 7.1 7.2 4.1v2l-7.2-1.8-.7 6 2.7 1.8v1.5L12 21l-4.2 1.2v-1.5l2.7-1.8-.7-6-7.2 1.8v-2l7.2-4.1L12 1.5z"/></svg></div>`,
    iconSize: [26, 26], iconAnchor: [13, 13]
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

function formatNumber(value: number | null, suffix = '') {
  return value === null ? '—' : `${Math.round(value).toLocaleString()}${suffix}`;
}

function formatHistoryAge(observedAt: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(observedAt)) / 1000));
  if (seconds < 60) return { value: seconds, unit: 'SEC' };
  if (seconds < 3600) return { value: Math.floor(seconds / 60), unit: 'MIN' };
  if (seconds < 86400) return { value: Math.floor(seconds / 3600), unit: 'HR' };
  return { value: Math.floor(seconds / 86400), unit: 'DAY' };
}

function updateHistorySummary() {
  elements.historyCount.textContent = historyTracks.length
    ? `${historyTracks.length} TRACKS / ${selectedHistoryPoints.toLocaleString()} PTS`
    : `${storedHistoryRecords.toLocaleString()} POINTS`;
}

function renderAircraft(items: Aircraft[]) {
  currentAircraft = items;
  const positioned = items.filter((item) => item.latitude !== null && item.longitude !== null && (!interestOnly || Boolean(item.interestReasons?.length) || Boolean(latestAnalysis[item.icao])));
  const activeIds = new Set(positioned.map((item) => item.icao));
  for (const [icao, marker] of markers) {
    if (!activeIds.has(icao)) {
      aircraftLayer.removeLayer(marker);
      markers.delete(icao);
    }
  }
  for (const item of positioned) {
    const position: L.LatLngExpression = [item.latitude!, item.longitude!];
    const finding = latestAnalysis[item.icao];
    const tooltip = `${escapeHtml(item.registration || item.callsign || item.icao)} · ${formatSpeed(item)} mph · ${formatNumber(item.altitudeFt, ' ft')}${item.sourceBand === '978 UAT' ? ' · 978 UAT' : ''}${finding ? ' · ' + finding.kinds.join(', ') : ''}`;
    const existing = markers.get(item.icao);
    if (existing) {
      existing.setLatLng(position).setIcon(aircraftIcon(item, selectedIcao === item.icao));
      existing.setTooltipContent(tooltip);
    } else {
      const marker = L.marker(position, { icon: aircraftIcon(item) })
        .bindTooltip(tooltip, { direction: 'top', className: 'aircraft-speed-label', offset: [0, -12] })
        .on('click', () => selectLiveAircraft(item.icao))
        .addTo(aircraftLayer);
      markers.set(item.icao, marker);
    }
    if (selectedIcao === item.icao) markers.get(item.icao)?.openTooltip();
  }
  renderHistoricalAircraft();
  drawLiveTail();
  renderList();
  renderInterest();
}

function renderList() {
  const query = elements.filter.value.trim().toUpperCase();
  const liveItems = currentAircraft
    .filter((item) => !interestOnly || Boolean(item.interestReasons?.length) || Boolean(latestAnalysis[item.icao]))
    .filter((item) => !query || item.icao.includes(query) || item.callsign.toUpperCase().includes(query) || item.registration?.includes(query))
    .sort((left, right) => left.seenSeconds - right.seenSeconds || (right.altitudeFt ?? 0) - (left.altitudeFt ?? 0));
  const liveIds = new Set(currentAircraft.map((item) => item.icao));
  const historyItems = (interestOnly ? [] : historyTracks)
    .filter((item) => !(liveIds.has(item.icao) && Date.now() - Date.parse(item.lastObservedAt) < 120000))
    .filter((item) => !query || item.icao.includes(query) || item.callsign.toUpperCase().includes(query) || item.registration?.includes(query))
    .sort((left, right) => compareHistory(left, right, historySort.value as HistorySortKey, historyDirection.value === 'asc'));
  if (!liveItems.length && !historyItems.length) {
    const hasAnyAircraft = currentAircraft.length || historyTracks.length;
    elements.list.innerHTML = `<div class="empty-list"><strong>${hasAnyAircraft ? 'NO MATCHES' : 'NO TRAFFIC'}</strong><span>${hasAnyAircraft ? 'Adjust the aircraft filter.' : selectedHistoryHours ? 'No aircraft saved in this window.' : 'Waiting for live aircraft.'}</span></div>`;
    return;
  }
  const liveRows = liveItems.map((item) => `
    <div class="aircraft-entry"><button class="aircraft-row${selectedIcao === item.icao ? ' selected' : ''}" data-icao="${escapeHtml(item.icao)}" type="button">
      <span><strong>${escapeHtml(item.callsign || item.registration || item.icao)}</strong><small>${identifierDetail(item)}${item.sourceBand === '978 UAT' ? ' · 978 UAT' : ''}</small></span>
      <span>${formatNumber(item.altitudeFt)}<small>FT</small></span>
      <span title="Ground speed: ${formatNumber(item.groundSpeedKt, ' kt')}">${formatSpeed(item)}<small>MPH</small>${machDisplay(item)}</span>
      <span>${Math.round(item.seenSeconds)}<small>SEC</small></span>
    </button>${copyButton(item)}</div>`).join('');
  const historyRows = historyItems.map((item) => {
    const age = formatHistoryAge(item.lastObservedAt);
    return `<div class="aircraft-entry"><button class="aircraft-row history${selectedHistoryTrackId === item.trackId ? ' selected' : ''}" data-history-id="${escapeHtml(item.trackId)}" type="button">
      <span><strong>${escapeHtml(item.callsign || item.registration || item.icao)}</strong><small>${item.icao} · ${item.pointCount} PTS</small></span>
      <span>${formatNumber(item.altitudeFt)}<small>FT</small></span>
      <span title="Ground speed at the last saved point. Older records may have no speed.">${formatSpeed(item)}<small>MPH</small>${machDisplay(item)}</span>
      <span title="Last seen: ${escapeHtml(new Date(item.lastObservedAt).toLocaleString())}">${age.value}<small>${age.unit}</small></span>
    </button>${copyButton(item)}</div>`;
  }).join('');
  elements.list.innerHTML = (selectedHistoryHours && liveRows ? '<div class="list-section-label">LIVE NOW</div>' : '') + liveRows
    + (historyRows ? '<div class="list-section-label">SAVED TRACKS · LAST RECORDED VALUES</div>' : '') + historyRows;
  elements.list.querySelectorAll<HTMLButtonElement>('[data-icao]').forEach((button) => {
    button.addEventListener('click', () => selectLiveAircraft(button.dataset.icao || ''));
  });
  elements.list.querySelectorAll<HTMLButtonElement>('[data-history-id]').forEach((button) => {
    button.addEventListener('click', () => selectHistoryAircraft(button.dataset.historyId || ''));
  });
}

function selectLiveAircraft(icao: string) {
  selectedIcao = selectedIcao === icao ? '' : icao;
  selectedHistoryTrackId = '';
  const item = currentAircraft.find((candidate) => candidate.icao === selectedIcao);
  if (item && item.latitude !== null && item.longitude !== null) map.flyTo([item.latitude, item.longitude], Math.max(map.getZoom(), 9));
  renderAircraft(currentAircraft);
}

function selectHistoryAircraft(trackId: string) {
  selectedHistoryTrackId = selectedHistoryTrackId === trackId ? '' : trackId;
  selectedIcao = '';
  const item = historyTracks.find((candidate) => candidate.trackId === selectedHistoryTrackId);
  if (item) map.flyTo([item.latitude, item.longitude], Math.max(map.getZoom(), 9));
  renderAircraft(currentAircraft);
}

const liveTailLayer = L.layerGroup().addTo(map);
const tailRequested = new Set<string>();
const tailLines = new Map<string, L.Polyline>();
function drawLiveTail() {
  const active = new Set(Object.keys(latestAnalysis).filter(icao => currentAircraft.some(a => a.icao === icao)));
  for (const [icao, line] of tailLines) if (!active.has(icao)) {
    liveTailLayer.removeLayer(line); tailLines.delete(icao); tailRequested.delete(icao);
  }
  for (const icao of active) {
    if (tailRequested.has(icao) || !apiBase) continue;
    tailRequested.add(icao);
    const since = new Date(Date.now() - 2 * 3600000).toISOString();
    void fetch(`${apiBase}/api/v1/tracks?since=${encodeURIComponent(since)}&icao=${encodeURIComponent(icao)}`)
      .then(r => { if (!r.ok) throw new Error('history unavailable'); return r.json(); })
      .then((data: GeoJSON.FeatureCollection<GeoJSON.LineString>) => {
        const feature = data.features.at(-1);
        const coords = feature?.geometry?.coordinates;
        if (!coords || !coords.length || !latestAnalysis[icao]) return;
        const line = L.polyline(coords.map(c => [c[1], c[0]] as L.LatLngTuple), { color: '#f2c76e', weight: 2.5, opacity: 0.9, dashArray: '5 3' });
        const old = tailLines.get(icao);
        if (old) liveTailLayer.removeLayer(old);
        line.addTo(liveTailLayer).bindTooltip(latestAnalysis[icao].identifier + ' · ' + latestAnalysis[icao].kinds.join(', '));
        tailLines.set(icao, line);
      }).catch(() => {}).finally(() => { setTimeout(() => tailRequested.delete(icao), 30000); });
  }
}
function renderHistoricalAircraft() {
  const liveIds = new Set(currentAircraft.map((item) => item.icao));
  const visible = (interestOnly ? [] : historyTracks).filter((item) => !(liveIds.has(item.icao) && Date.now() - Date.parse(item.lastObservedAt) < 120000));
  const visibleIds = new Set(visible.map((item) => item.trackId));
  for (const [trackId, marker] of historyMarkers) {
    if (!visibleIds.has(trackId)) {
      historyAircraftLayer.removeLayer(marker);
      historyMarkers.delete(trackId);
    }
  }
  for (const item of visible) {
    const position: L.LatLngExpression = [item.latitude, item.longitude];
    const tooltip = `${escapeHtml(item.callsign || item.icao)} · HISTORY · ${formatSpeed(item)} mph · ${item.pointCount} PTS`;
    const existing = historyMarkers.get(item.trackId);
    if (existing) {
      existing.setLatLng(position).setIcon(historyAircraftIcon(item, selectedHistoryTrackId === item.trackId)).setTooltipContent(tooltip);
    } else {
      const marker = L.marker(position, { icon: historyAircraftIcon(item) })
        .bindTooltip(tooltip)
        .on('click', () => selectHistoryAircraft(item.trackId))
        .addTo(historyAircraftLayer);
      historyMarkers.set(item.trackId, marker);
    }
  }
}

function drawReceiver(status: ReceiverStatus) {
  const { latitude, longitude, label } = status.receiver;
  if (!latitude && !longitude) return;
  if (!centeredOnReceiver) {
    map.setView([latitude, longitude], receiverViewZoom);
    centeredOnReceiver = true;
  }
  rangeLayer.clearLayers();
  L.circleMarker([latitude, longitude], { radius: 5, color: '#72f1b8', weight: 2, fillColor: '#071015', fillOpacity: 1 })
    .bindTooltip(label || 'HOME RECEIVER').addTo(rangeLayer);
  [5, demonstratedRangeNm].forEach((nauticalMiles) => {
    new Circle([latitude, longitude], {
      radius: nauticalMiles * 1852,
      color: '#4aa8a0', weight: 1, opacity: 0.32, fillOpacity: 0, dashArray: '4 8'
    }).bindTooltip(nauticalMiles === demonstratedRangeNm ? `DEMONSTRATED RX · ${nauticalMiles} NM` : `${nauticalMiles} NM`).addTo(rangeLayer);
  });
}

type LocalSensor = { status: string; data?: Record<string, unknown> | null; lastSeenAt?: string | null };
type LocalAiStatus = { status: string; generatedAt: string | null; model: string | null; summary: string | null };
function renderLocalSensors(sensors?: Record<string, LocalSensor>, localAi?: LocalAiStatus) {
  if (sensors) {
    const labels = ['weather', 'water', 'remoteid', 'rc', 'wifi', 'ble'];
    for (const key of labels) {
      const node = document.querySelector<HTMLElement>('#sensor-' + key);
      if (!node) continue;
      const sensor = sensors[key];
      node.classList.toggle('is-online', sensor?.status === 'online');
      if (!sensor || sensor.status !== 'online') {
        node.textContent = sensor?.status === 'stale' ? 'STALE'
          : sensor?.status === 'offline' ? 'OFFLINE'
          : sensor?.status === 'invalid' ? 'INVALID DATA' : 'NOT CONNECTED';
        continue;
      }
      const data = sensor.data || {};
      if (key === 'weather') {
        const t = data.temperatureC;
        const h = data.humidityPercent;
        const w = data.windKmh;
        const parts: string[] = [];
        if (typeof t === 'number') parts.push((t * 9 / 5 + 32).toFixed(1) + '°F');
        if (typeof h === 'number') parts.push(h.toFixed(0) + '% RH');
        if (typeof w === 'number') parts.push((w / 1.609344).toFixed(1) + ' mph');
        node.textContent = parts.join(' · ') || 'RECEIVING';
      } else if (key === 'water') node.textContent = 'RECEIVING · PRIVATE';
      else if (key === 'remoteid') node.textContent = 'REMOTE ID SEEN';
      else if (key === 'rc') node.textContent = String(data.family || 'RC') + ' ACTIVITY';
      else {
        const occupancy = data.occupancyPercent;
        node.textContent = typeof occupancy === 'number' ? occupancy.toFixed(0) + '% OCCUPANCY' : 'RECEIVING';
      }
    }
  }
  if (localAi) {
    const status = document.querySelector<HTMLElement>('#local-ai-status');
    const summary = document.querySelector<HTMLElement>('#local-ai-summary');
    if (status) status.textContent = localAi.status === 'ready' ? 'READY' : localAi.status.toUpperCase();
    if (summary) summary.textContent = localAi.status === 'ready' && localAi.summary
      ? localAi.summary : 'No current local Ollama summary. AI does not determine alarms.';
  }
}

function applyPayload(payload: LivePayload & { analysis?: { flags?: typeof latestAnalysis; reception?: { averageSeconds: number | null; completedFlights: number } }; alerts?: typeof latestAlerts; sensors?: Record<string, LocalSensor>; localAi?: LocalAiStatus }) {
  renderLocalSensors(payload.sensors, payload.localAi);
  latestAnalysis = payload.analysis?.flags || latestAnalysis;
  latestAlerts = payload.alerts || latestAlerts;
  const reception = payload.analysis?.reception;
  const duration = document.querySelector<HTMLElement>('#reception-average')!;
  duration.textContent = reception?.averageSeconds != null ? `${Math.round(reception.averageSeconds / 60)} MIN / ${reception.completedFlights} FLIGHTS` : 'LEARNING';
  const notice = document.querySelector<HTMLElement>('#airspace-events')!;
  notice.textContent = latestAlerts.length ? latestAlerts.slice(-3).reverse().map(a => `${a.identifier}: ${a.kind}`).join(' | ') : 'NO BEHAVIOR ALERTS';
  renderAircraft(payload.aircraft.map(withInterestFallback));
  drawReceiver(payload.status);
  elements.aircraftCount.textContent = String(payload.status.aircraftCount);
  elements.positionedCount.textContent = String(payload.status.positionedCount);
  elements.dataAge.textContent = payload.status.dataAgeSeconds === null ? '--' : payload.status.dataAgeSeconds.toFixed(1);
  elements.dataAge.title = `Feed freshness. Decoder clock age: ${payload.status.decoderAgeSeconds?.toFixed(1) ?? 'unknown'} seconds`;
  elements.receiverSource.textContent = 'BLADERF X40 / 1090 MHZ RX';
  elements.receiverSource.title = payload.status.source;
  storedHistoryRecords = payload.status.historyRecords;
  updateHistorySummary();
  elements.lastUpdate.textContent = payload.status.generatedAt ? `UPDATED ${new Date(payload.status.generatedAt).toLocaleTimeString()}` : 'WAITING FOR DATA';
  setConnection(payload.status.ok, payload.status.lastError);
}

function setConnection(online: boolean, error: string | null = null) {
  receiverOnline = online;
  renderInterest();
  elements.connectionButton.classList.toggle('is-online', online);
  elements.connectionButton.classList.toggle('is-offline', !online);
  elements.connectionLabel.textContent = online ? 'RECEIVER ONLINE' : error ? 'RECEIVER DEGRADED' : 'RECEIVER OFFLINE';
  elements.connectionButton.title = online ? 'Feed is updating. Click for receiver settings.' : `${error || 'No connection'}. Click for receiver settings.`;
  document.querySelector<HTMLElement>('#receiver-health-detail')!.textContent = online ? '' : error || 'Receiver offline';
}

function connect() {
  const generation = ++connectionGeneration;
  if (fallbackTimer !== null) clearInterval(fallbackTimer);
  fallbackTimer = null;
  eventSource?.close();
  if (!apiBase) {
    setConnection(false);
    return;
  }
  eventSource = new EventSource(`${apiBase}/api/v1/stream`);
  eventSource.addEventListener('aircraft', (event) => {
    if (generation !== connectionGeneration) return;
    try {
      applyPayload(JSON.parse((event as MessageEvent).data) as LivePayload);
      if (fallbackTimer !== null) clearInterval(fallbackTimer);
      fallbackTimer = null;
    } catch { setConnection(false, 'invalid receiver data'); }
  });
  // Some embedded browsers and proxies cannot keep an event stream open.
  // Use bounded, non-overlapping reads until streaming resumes.
  let polling = false;
  const poll = async () => {
    if (polling || generation !== connectionGeneration) return;
    polling = true;
    try {
      const signal = AbortSignal.timeout(10000);
      const [statusResponse, aircraftResponse, analysisResponse, sensorsResponse, aiResponse] = await Promise.all([
        fetch(`${apiBase}/api/v1/status`, { signal, cache: 'no-store' }),
        fetch(`${apiBase}/api/v1/aircraft`, { signal, cache: 'no-store' }),
    fetch(`${apiBase}/api/v1/analysis`, { signal, cache: 'no-store' }),
        fetch(`${apiBase}/api/v1/sensors`, { signal, cache: 'no-store' }),
        fetch(`${apiBase}/api/v1/local-ai`, { signal, cache: 'no-store' })
      ]);
      if (!statusResponse.ok || !aircraftResponse.ok) throw new Error('receiver feed unavailable');
      const [status, snapshot] = await Promise.all([statusResponse.json(), aircraftResponse.json()]);
      const analysisPayload = analysisResponse.ok ? await analysisResponse.json() : {};
      const sensorsPayload = sensorsResponse.ok ? await sensorsResponse.json() : {};
      const aiPayload = aiResponse.ok ? await aiResponse.json() : {};
      if (generation === connectionGeneration && fallbackTimer !== null) applyPayload({ status, aircraft: snapshot.aircraft, ...analysisPayload, ...sensorsPayload, ...aiPayload } as LivePayload);
    } catch {
      if (generation === connectionGeneration && fallbackTimer !== null) setConnection(false, 'receiver feed unavailable');
    } finally { polling = false; }
  };
  eventSource.onerror = () => {
    if (generation !== connectionGeneration || fallbackTimer !== null) return;
    setConnection(false, 'receiver reconnecting');
    fallbackTimer = setInterval(() => void poll(), 5000);
    void poll();
  };
}

async function showHistory(hours: number) {
  const requestId = ++historyRequestId;
  selectedHistoryHours = hours;
  document.querySelector<HTMLElement>('#history-sort-controls')!.hidden = !hours;
  document.querySelectorAll<HTMLButtonElement>('.window-button').forEach((button) => button.classList.toggle('active', Number(button.dataset.hours) === hours));
  elements.windowLabel.textContent = hours === 0
    ? 'LIVE'
    : `LAST ${hours === 168 ? '7 DAYS' : `${hours} ${hours === 1 ? 'HOUR' : 'HOURS'}`}`;
  trackLayer.clearLayers();
  historyTracks = [];
  selectedHistoryPoints = 0;
  selectedHistoryTrackId = '';
  elements.trafficMode.textContent = hours ? `LIVE + ${hours === 168 ? '7D' : `${hours}H`} HISTORY` : 'LIVE TRAFFIC';
  renderHistoricalAircraft();
  renderList();
  updateHistorySummary();
  if (!hours || !apiBase) return;
  try {
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const response = await fetch(`${apiBase}/api/v1/tracks?since=${encodeURIComponent(since)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const geojson = await response.json() as GeoJSON.FeatureCollection<GeoJSON.LineString, {
      trackId?: string; icao?: string; callsign?: string; pointCount?: number;
      firstObservedAt?: string; lastObservedAt?: string; altitudeFt?: number | null;
      groundSpeedMph?: number | null; mach?: Aircraft['mach']; machSource?: Aircraft['machSource'];
      registration?: Aircraft['registration']; registrationSource?: Aircraft['registrationSource'];
    }>;
    if (requestId !== historyRequestId) return;
    historyTracks = geojson.features.flatMap((feature, index) => {
      const coordinates = feature.geometry?.coordinates;
      const last = coordinates?.at(-1);
      const longitude = last?.[0];
      const latitude = last?.[1];
      if (typeof longitude !== 'number' || !Number.isFinite(longitude) || typeof latitude !== 'number' || !Number.isFinite(latitude)) return [];
      const observedMilliseconds = last?.[3];
      const lastObservedAt = feature.properties?.lastObservedAt
        || (typeof observedMilliseconds === 'number' && Number.isFinite(observedMilliseconds) ? new Date(observedMilliseconds).toISOString() : '');
      if (!lastObservedAt) return [];
      const propertyAltitude = feature.properties?.altitudeFt;
      const coordinateAltitude = last?.[2];
      const propertyPointCount = feature.properties?.pointCount;
      return [{
        trackId: feature.properties?.trackId || `${feature.properties?.icao || 'UNKNOWN'}-${index}`,
        icao: (feature.properties?.icao || 'UNKNOWN').toUpperCase(),
        callsign: (feature.properties?.callsign || '').trim(),
        latitude, longitude,
        groundSpeedMph: typeof feature.properties?.groundSpeedMph === 'number' && Number.isFinite(feature.properties.groundSpeedMph) ? feature.properties.groundSpeedMph : null,
        mach: feature.properties?.mach, machSource: feature.properties?.machSource,
        registration: feature.properties?.registration, registrationSource: feature.properties?.registrationSource,
        altitudeFt: typeof propertyAltitude === 'number' && Number.isFinite(propertyAltitude)
          ? propertyAltitude
          : typeof coordinateAltitude === 'number' && Number.isFinite(coordinateAltitude) ? coordinateAltitude : null,
        pointCount: typeof propertyPointCount === 'number' && Number.isFinite(propertyPointCount) ? propertyPointCount : coordinates.length,
        firstObservedAt: feature.properties?.firstObservedAt || lastObservedAt,
        lastObservedAt
      }];
    });
    selectedHistoryPoints = historyTracks.reduce((sum, item) => sum + item.pointCount, 0);
    L.geoJSON(geojson, {
      style: { color: '#72f1b8', weight: 1.5, opacity: 0.65 },
      onEachFeature: (feature, layer) => {
        const icao = typeof feature.properties?.icao === 'string' ? feature.properties.icao.toUpperCase() : '';
        const callsign = typeof feature.properties?.callsign === 'string' ? feature.properties.callsign.trim().toUpperCase() : '';
        const points = Number(feature.properties?.pointCount) || 0;
        if (icao) layer.bindTooltip(`${callsign || icao} · HISTORY · ${points} PTS`);
      }
    }).addTo(trackLayer);
    renderHistoricalAircraft();
    renderList();
    updateHistorySummary();
  } catch {
    if (requestId === historyRequestId) elements.lastUpdate.textContent = 'HISTORY UNAVAILABLE';
  }
}

elements.connectionButton.addEventListener('click', () => {
  elements.apiUrl.value = apiBase;
  elements.settingsError.textContent = '';
  elements.dialog.showModal();
});
elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const candidate = elements.apiUrl.value.trim().replace(/\/$/, '');
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error('Use the HTTPS receiver address.');
    apiBase = parsed.origin;
    localStorage.setItem(endpointKey, apiBase);
    elements.dialog.close();
    connect();
  } catch (error) {
    elements.settingsError.textContent = error instanceof Error ? error.message : 'Enter a valid receiver URL.';
  }
});
elements.clearApi.addEventListener('click', () => {
  localStorage.removeItem(endpointKey);
  apiBase = defaultApiBase;
  elements.apiUrl.value = defaultApiBase;
  eventSource?.close();
  elements.dialog.close();
  connect();
  void showHistory(selectedHistoryHours);
});
const historySort = document.querySelector<HTMLSelectElement>('#history-sort')!;
const historyDirection = document.querySelector<HTMLSelectElement>('#history-direction')!;
let historyRequestId = 0;
historySort.addEventListener('change', renderList);
historyDirection.addEventListener('change', renderList);
elements.filter.addEventListener('input', renderList);
let copyNoticeTimer: ReturnType<typeof setTimeout>;
document.querySelector('.traffic-panel')!.addEventListener('click', async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-copy]');
  if (!button) return;
  const value = button.dataset.copy!;
  const notice = document.querySelector<HTMLElement>('#copy-status')!;
  clearTimeout(copyNoticeTimer);
  try {
    await navigator.clipboard.writeText(value);
    notice.textContent = `Copied ${button.dataset.copyKind}: ${value}`;
  } catch {
    notice.textContent = `Copy unavailable. ${button.dataset.copyKind}: ${value}`;
  }
  copyNoticeTimer = setTimeout(() => { notice.textContent = ''; }, 5000);
});
document.querySelector<HTMLButtonElement>('#interest-filter')!.addEventListener('click', () => {
  interestOnly = !interestOnly;
  if (interestOnly) map.removeLayer(trackLayer);
  else trackLayer.addTo(map);
  renderAircraft(currentAircraft);
});
elements.interestList.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-icao]');
  if (button) selectLiveAircraft(button.dataset.icao || '');
});
document.querySelectorAll<HTMLButtonElement>('.window-button').forEach((button) => button.addEventListener('click', () => void showHistory(Number(button.dataset.hours))));

setInterval(() => { elements.clock.textContent = new Date().toLocaleTimeString([], { hour12: false }); }, 250);
setInterval(() => { if (selectedHistoryHours) void showHistory(selectedHistoryHours); }, 60000);
connect();
void showHistory(selectedHistoryHours);
