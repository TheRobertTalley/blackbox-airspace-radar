import L, { Circle, Map as LeafletMap, Marker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import type { Aircraft, LivePayload, ReceiverStatus } from './types';

const endpointKey = 'blackbox-airspace-api';
const receiverApiBase = 'https://blackbox.tailade622.ts.net';
const defaultApiBase = location.hostname === 'blackbox.tailade622.ts.net' ? location.origin : receiverApiBase;
const elements = {
  clock: document.querySelector<HTMLElement>('#clock')!,
  connectionButton: document.querySelector<HTMLButtonElement>('#connection-button')!,
  connectionLabel: document.querySelector<HTMLElement>('#connection-label')!,
  aircraftCount: document.querySelector<HTMLElement>('#aircraft-count')!,
  positionedCount: document.querySelector<HTMLElement>('#positioned-count')!,
  dataAge: document.querySelector<HTMLElement>('#data-age')!,
  receiverSource: document.querySelector<HTMLElement>('#receiver-source')!,
  historyCount: document.querySelector<HTMLElement>('#history-count')!,
  list: document.querySelector<HTMLElement>('#aircraft-list')!,
  filter: document.querySelector<HTMLInputElement>('#aircraft-filter')!,
  lastUpdate: document.querySelector<HTMLElement>('#last-update')!,
  windowLabel: document.querySelector<HTMLElement>('#window-label')!,
  dialog: document.querySelector<HTMLDialogElement>('#settings-dialog')!,
  form: document.querySelector<HTMLFormElement>('#settings-form')!,
  apiUrl: document.querySelector<HTMLInputElement>('#api-url')!,
  settingsError: document.querySelector<HTMLElement>('#settings-error')!,
  clearApi: document.querySelector<HTMLButtonElement>('#clear-api')!
};

const map: LeafletMap = L.map('map', { zoomControl: false, attributionControl: true }).setView([39.5, -98.35], 4);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd', maxZoom: 20,
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
}).addTo(map);

const aircraftLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const rangeLayer = L.layerGroup().addTo(map);
const markers = new Map<string, Marker>();
let currentAircraft: Aircraft[] = [];
let selectedIcao = '';
let eventSource: EventSource | null = null;
let apiBase = localStorage.getItem(endpointKey)?.trim() || defaultApiBase;
let centeredOnReceiver = false;
let selectedHistoryHours = 24;

function aircraftIcon(item: Aircraft, selected = false) {
  const rotation = item.trackDeg ?? 0;
  const emergency = item.emergency && item.emergency !== 'none';
  return L.divIcon({
    className: 'aircraft-marker-wrap',
    html: `<div class="aircraft-marker${selected ? ' selected' : ''}${emergency ? ' emergency' : ''}" style="--track:${rotation}deg" aria-label="${escapeHtml(item.callsign || item.icao)}"><svg viewBox="0 0 24 24" role="img"><path d="M12 1.5l2.2 7.1 7.2 4.1v2l-7.2-1.8-.7 6 2.7 1.8v1.5L12 21l-4.2 1.2v-1.5l2.7-1.8-.7-6-7.2 1.8v-2l7.2-4.1L12 1.5z"/></svg></div>`,
    iconSize: [34, 34], iconAnchor: [17, 17]
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

function formatNumber(value: number | null, suffix = '') {
  return value === null ? '—' : `${Math.round(value).toLocaleString()}${suffix}`;
}

function renderAircraft(items: Aircraft[]) {
  currentAircraft = items;
  const positioned = items.filter((item) => item.latitude !== null && item.longitude !== null);
  const activeIds = new Set(positioned.map((item) => item.icao));
  for (const [icao, marker] of markers) {
    if (!activeIds.has(icao)) {
      aircraftLayer.removeLayer(marker);
      markers.delete(icao);
    }
  }
  for (const item of positioned) {
    const position: L.LatLngExpression = [item.latitude!, item.longitude!];
    const existing = markers.get(item.icao);
    if (existing) {
      existing.setLatLng(position).setIcon(aircraftIcon(item, selectedIcao === item.icao));
    } else {
      const marker = L.marker(position, { icon: aircraftIcon(item) })
        .on('click', () => selectAircraft(item.icao))
        .addTo(aircraftLayer);
      markers.set(item.icao, marker);
    }
  }
  renderList();
}

function renderList() {
  const query = elements.filter.value.trim().toUpperCase();
  const items = currentAircraft
    .filter((item) => !query || item.icao.includes(query) || item.callsign.toUpperCase().includes(query))
    .sort((left, right) => left.seenSeconds - right.seenSeconds || (right.altitudeFt ?? 0) - (left.altitudeFt ?? 0));
  if (!items.length) {
    elements.list.innerHTML = `<div class="empty-list"><strong>${currentAircraft.length ? 'NO MATCHES' : 'NO LIVE TRAFFIC'}</strong><span>${currentAircraft.length ? 'Adjust the aircraft filter.' : 'Waiting for aircraft received by BlackBox.'}</span></div>`;
    return;
  }
  elements.list.innerHTML = items.map((item) => `
    <button class="aircraft-row${selectedIcao === item.icao ? ' selected' : ''}" data-icao="${item.icao}" type="button">
      <span><strong>${escapeHtml(item.callsign || item.icao)}</strong><small>${item.callsign ? item.icao : 'ICAO ADDRESS'}</small></span>
      <span>${formatNumber(item.altitudeFt)}<small>FT</small></span>
      <span>${formatNumber(item.groundSpeedKt)}<small>KT</small></span>
      <span>${Math.round(item.seenSeconds)}<small>SEC</small></span>
    </button>`).join('');
  elements.list.querySelectorAll<HTMLButtonElement>('.aircraft-row').forEach((button) => {
    button.addEventListener('click', () => selectAircraft(button.dataset.icao || ''));
  });
}

function selectAircraft(icao: string) {
  selectedIcao = selectedIcao === icao ? '' : icao;
  const item = currentAircraft.find((candidate) => candidate.icao === selectedIcao);
  if (item && item.latitude !== null && item.longitude !== null) map.flyTo([item.latitude, item.longitude], Math.max(map.getZoom(), 9));
  renderAircraft(currentAircraft);
}

function drawReceiver(status: ReceiverStatus) {
  const { latitude, longitude, label } = status.receiver;
  if (!latitude && !longitude) return;
  if (!centeredOnReceiver) {
    map.setView([latitude, longitude], 8);
    centeredOnReceiver = true;
  }
  rangeLayer.clearLayers();
  L.circleMarker([latitude, longitude], { radius: 5, color: '#72f1b8', weight: 2, fillColor: '#071015', fillOpacity: 1 })
    .bindTooltip(label || 'HOME RECEIVER').addTo(rangeLayer);
  [10, 25, 50, 100].forEach((nauticalMiles) => {
    new Circle([latitude, longitude], {
      radius: nauticalMiles * 1852,
      color: '#4aa8a0', weight: 1, opacity: 0.32, fillOpacity: 0, dashArray: '4 8'
    }).bindTooltip(`${nauticalMiles} NM`).addTo(rangeLayer);
  });
}

function applyPayload(payload: LivePayload) {
  renderAircraft(payload.aircraft);
  drawReceiver(payload.status);
  elements.aircraftCount.textContent = String(payload.status.aircraftCount);
  elements.positionedCount.textContent = String(payload.status.positionedCount);
  elements.dataAge.textContent = payload.status.dataAgeSeconds === null ? '--' : payload.status.dataAgeSeconds.toFixed(1);
  elements.receiverSource.textContent = 'BLADERF X40 / 1090 MHZ RX';
  elements.receiverSource.title = payload.status.source;
  elements.historyCount.textContent = `${payload.status.historyRecords.toLocaleString()} POINTS`;
  elements.lastUpdate.textContent = payload.status.generatedAt ? `UPDATED ${new Date(payload.status.generatedAt).toLocaleTimeString()}` : 'WAITING FOR DATA';
  setConnection(payload.status.ok, payload.status.lastError);
}

function setConnection(online: boolean, error: string | null = null) {
  elements.connectionButton.classList.toggle('is-online', online);
  elements.connectionButton.classList.toggle('is-offline', !online);
  elements.connectionLabel.textContent = online ? 'RECEIVER ONLINE' : error ? 'RECEIVER DEGRADED' : 'RECEIVER OFFLINE';
}

function connect() {
  eventSource?.close();
  if (!apiBase) {
    setConnection(false);
    return;
  }
  eventSource = new EventSource(`${apiBase}/api/v1/stream`);
  eventSource.addEventListener('aircraft', (event) => {
    try { applyPayload(JSON.parse((event as MessageEvent).data) as LivePayload); } catch { setConnection(false, 'invalid receiver data'); }
  });
  eventSource.onerror = () => setConnection(false, 'private link unavailable');
}

async function showHistory(hours: number) {
  selectedHistoryHours = hours;
  document.querySelectorAll<HTMLButtonElement>('.window-button').forEach((button) => button.classList.toggle('active', Number(button.dataset.hours) === hours));
  elements.windowLabel.textContent = hours === 0
    ? 'LIVE'
    : `LAST ${hours === 168 ? '7 DAYS' : `${hours} ${hours === 1 ? 'HOUR' : 'HOURS'}`}`;
  trackLayer.clearLayers();
  if (!hours || !apiBase) return;
  try {
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const response = await fetch(`${apiBase}/api/v1/tracks?since=${encodeURIComponent(since)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const geojson = await response.json() as GeoJSON.FeatureCollection;
    L.geoJSON(geojson, {
      style: { color: '#72f1b8', weight: 1.5, opacity: 0.65 },
      onEachFeature: (feature, layer) => {
        const icao = typeof feature.properties?.icao === 'string' ? feature.properties.icao.toUpperCase() : '';
        if (icao) layer.bindTooltip(`ICAO ${icao}`);
      }
    }).addTo(trackLayer);
  } catch {
    elements.lastUpdate.textContent = 'HISTORY UNAVAILABLE';
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
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error('Use the private HTTPS address from Tailscale Serve.');
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
elements.filter.addEventListener('input', renderList);
document.querySelectorAll<HTMLButtonElement>('.window-button').forEach((button) => button.addEventListener('click', () => void showHistory(Number(button.dataset.hours))));

setInterval(() => { elements.clock.textContent = new Date().toLocaleTimeString([], { hour12: false }); }, 250);
setInterval(() => { if (selectedHistoryHours) void showHistory(selectedHistoryHours); }, 60000);
connect();
void showHistory(selectedHistoryHours);
