export interface Aircraft {
  icao: string;
  callsign: string;
  latitude: number | null;
  longitude: number | null;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  groundSpeedMph?: number | null;
  registration?: string | null;
  registrationSource?: 'receiver' | 'icao-derived' | null;
  mach?: number | null;
  machSource?: 'reported' | 'tas-temperature' | 'tas-standard' | 'ground-estimate' | null;
  interestReasons?: { kind: 'military' | 'space' | 'speed'; label: string; detail: string }[];
  trackDeg: number | null;
  verticalRateFpm: number | null;
  squawk: string;
  category: string;
  seenSeconds: number;
  rssiDbfs: number | null;
  messages: number;
  emergency: string;
  observedAt: string;
}

export interface ReceiverStatus {
  ok: boolean;
  rxOnly: boolean;
  source: string;
  aircraftCount: number;
  positionedCount: number;
  dataAgeSeconds: number | null;
  decoderAgeSeconds?: number | null;
  generatedAt: string | null;
  lastError: string | null;
  historyRecords: number;
  receiver: { latitude: number; longitude: number; label: string };
  retention: { days: number; maxBytes: number };
}

export interface LivePayload {
  status: ReceiverStatus;
  aircraft: Aircraft[];
}
