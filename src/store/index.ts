// src/store/index.ts — Zustand global store for all application state

import { create } from 'zustand';
import {
  AppSettings,
  ConnectionStatus,
  IntegrationResult,
  Marker,
  MarkerCategory,
  MARKER_COLORS,
  PortInfo,
  Sample,
  SampleStats,
  generateId,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Sample ring buffer (frontend side for live chart)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FRONTEND_SAMPLES = 500_000;

export interface SampleBuffer {
  timestamps: Float64Array;
  amps: Float64Array;
  count: number;
  writeIdx: number; // ring pointer
}

function makeSampleBuffer(): SampleBuffer {
  return {
    timestamps: new Float64Array(MAX_FRONTEND_SAMPLES),
    amps: new Float64Array(MAX_FRONTEND_SAMPLES),
    count: 0,
    writeIdx: 0,
  };
}

function pushSample(buf: SampleBuffer, ts: number, a: number): SampleBuffer {
  buf.timestamps[buf.writeIdx] = ts;
  buf.amps[buf.writeIdx] = a;
  buf.writeIdx = (buf.writeIdx + 1) % MAX_FRONTEND_SAMPLES;
  if (buf.count < MAX_FRONTEND_SAMPLES) buf.count++;
  return buf; // mutated in place for performance
}

/**
 * Get a contiguous slice of the ring buffer in chronological order.
 * Returns typed array views (zero-copy where possible).
 */
export function getOrderedSlice(buf: SampleBuffer): { ts: Float64Array; amps: Float64Array } {
  if (buf.count === 0) {
    return { ts: new Float64Array(0), amps: new Float64Array(0) };
  }
  const n = buf.count;
  const cap = MAX_FRONTEND_SAMPLES;
  if (n < cap) {
    // Buffer not yet full — data is at [0, n)
    return {
      ts: buf.timestamps.subarray(0, n),
      amps: buf.amps.subarray(0, n),
    };
  }
  // Full ring buffer — oldest data starts at writeIdx
  const start = buf.writeIdx;
  const ts = new Float64Array(n);
  const am = new Float64Array(n);
  const part1 = cap - start;
  ts.set(buf.timestamps.subarray(start, cap), 0);
  ts.set(buf.timestamps.subarray(0, start), part1);
  am.set(buf.amps.subarray(start, cap), 0);
  am.set(buf.amps.subarray(0, start), part1);
  return { ts, amps: am };
}

// ─────────────────────────────────────────────────────────────────────────────
// Store state
// ─────────────────────────────────────────────────────────────────────────────

export interface AppStore {
  // Connection
  ports: PortInfo[];
  selectedPort: string;
  connectionStatus: ConnectionStatus;

  // Sample data (live ring buffer — NOT reactive for perf; updated via ref)
  sampleBuffer: SampleBuffer;
  totalSamples: number;
  lastSampleTs: number | null;

  // Chart view
  /** Incremented on explicit clearSamples() so the chart can react. */
  clearGeneration: number;
  paused: boolean;
  timeWindowS: number; // 0 = show all
  viewStats: SampleStats | null;
  selectionStats: SampleStats | null;
  selectionRange: [number, number] | null; // [t_start, t_end] absolute unix ts

  // Markers
  markers: Marker[];

  // Settings
  settings: AppSettings;

  // Integration
  integrationResult: IntegrationResult | null;

  // Status messages log
  statusLog: string[];

  // Navigation
  currentView: 'monitor' | 'device-config' | 'debug' | 'settings';
  /** Set by MarkersPanel to ask LiveChart to jump to a timestamp range. Cleared after consumption. */
  navigateTo: { tMin: number; tMax: number } | null;

  // Actions
  setPorts: (ports: PortInfo[]) => void;
  setSelectedPort: (port: string) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  pushSampleEvent: (sample: Sample) => void;
  pushSampleBatch: (timestamps: number[], amps: number[]) => void;
  loadSamplesFromBackend: (timestamps: number[], amps: number[]) => void;
  /** Insert a NaN gap so the chart draws a break between acquisitions. */
  markNewAcquisition: () => void;
  clearSamples: () => void;
  setPaused: (paused: boolean) => void;
  setTimeWindow: (seconds: number) => void;
  setViewStats: (stats: SampleStats | null) => void;
  setSelectionStats: (stats: SampleStats | null) => void;
  setSelectionRange: (range: [number, number] | null) => void;

  addMarker: (marker: Omit<Marker, 'id'>) => void;
  updateMarker: (id: string, updates: Partial<Marker>) => void;
  removeMarker: (id: string) => void;
  setMarkers: (markers: Marker[]) => void;

  navigateToMarker: (marker: Marker) => void;
  clearNavigateTo: () => void;
  setSettings: (s: Partial<AppSettings>) => void;
  setIntegrationResult: (r: IntegrationResult | null) => void;
  appendStatusLog: (msg: string) => void;
  setCurrentView: (view: 'monitor' | 'device-config' | 'debug' | 'settings') => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  // Connection
  ports: [],
  selectedPort: '',
  connectionStatus: {
    state: 'Disconnected',
    sampleCount: 0,
    deviceStatus: {},
  },

  // Samples
  sampleBuffer: makeSampleBuffer(),
  totalSamples: 0,
  lastSampleTs: null,

  // Chart
  clearGeneration: 0,
  paused: false,
  timeWindowS: 30,
  viewStats: null,
  selectionStats: null,
  selectionRange: null,

  // Markers
  markers: [],

  // Settings
  settings: {
    voltageV: 3.3,
    loggingFormat: 'EXPONENT',
    timeWindowS: 30,
    hideDeadTime: false,
  },

  integrationResult: null,
  statusLog: [],
  currentView: 'monitor',
  navigateTo: null,

  // ── Actions ──────────────────────────────────────────────────────────────

  setPorts: (ports) => set({ ports }),
  setSelectedPort: (port) => set({ selectedPort: port }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),

  pushSampleEvent: (sample) => {
    const state = get();
    // Mutate buffer directly for perf (no React re-render from this update)
    pushSample(state.sampleBuffer, sample.timestamp, sample.amps);
    set({ totalSamples: state.totalSamples + 1, lastSampleTs: sample.timestamp });
  },

  pushSampleBatch: (timestamps, amps) => {
    const state = get();
    const n = Math.min(timestamps.length, amps.length);
    for (let i = 0; i < n; i++) {
      pushSample(state.sampleBuffer, timestamps[i], amps[i]);
    }
    if (n > 0) {
      set({ totalSamples: state.totalSamples + n, lastSampleTs: timestamps[n - 1] });
    }
  },

  markNewAcquisition: () => {
    const state = get();
    // Only insert a gap if there is existing data (avoids leading NaN)
    if (state.sampleBuffer.count > 0) {
      const lastTs = state.lastSampleTs ?? Date.now() / 1000;
      // Push a NaN amps value at a tiny offset after the last timestamp.
      // uPlot's spanGaps:false will break the line at this point.
      pushSample(state.sampleBuffer, lastTs + 0.0001, NaN);
    }
  },

  loadSamplesFromBackend: (timestamps, amps) => {
    const newBuf = makeSampleBuffer();
    const n = Math.min(timestamps.length, amps.length, MAX_FRONTEND_SAMPLES);
    for (let i = 0; i < n; i++) {
      pushSample(newBuf, timestamps[i], amps[i]);
    }
    set({ sampleBuffer: newBuf, totalSamples: n, lastSampleTs: timestamps[n - 1] ?? null });
  },

  clearSamples: () => {
    set((s) => ({
      sampleBuffer: makeSampleBuffer(),
      totalSamples: 0,
      lastSampleTs: null,
      viewStats: null,
      selectionStats: null,
      selectionRange: null,
      integrationResult: null,
      clearGeneration: s.clearGeneration + 1,
    }));
  },

  setPaused: (paused) => set({ paused }),
  setTimeWindow: (seconds) => set({ timeWindowS: seconds }),
  setViewStats: (stats) => set({ viewStats: stats }),
  setSelectionStats: (stats) => set({ selectionStats: stats }),
  setSelectionRange: (range) => set({ selectionRange: range }),

  addMarker: (marker) => {
    const newMarker: Marker = { ...marker, id: generateId() };
    set((s) => ({ markers: [...s.markers, newMarker] }));
  },

  updateMarker: (id, updates) => {
    set((s) => ({
      markers: s.markers.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    }));
  },

  removeMarker: (id) => {
    set((s) => ({ markers: s.markers.filter((m) => m.id !== id) }));
  },

  setMarkers: (markers) => set({ markers }),

  navigateToMarker: (marker) => {
    const padding = 2; // seconds of context around the marker
    if (marker.endTimestamp != null) {
      const dur = marker.endTimestamp - marker.timestamp;
      const pad = Math.max(dur * 0.2, 0.5);
      set({ navigateTo: { tMin: marker.timestamp - pad, tMax: marker.endTimestamp + pad }, paused: true, currentView: 'monitor' });
    } else {
      set({ navigateTo: { tMin: marker.timestamp - padding, tMax: marker.timestamp + padding }, paused: true, currentView: 'monitor' });
    }
  },
  clearNavigateTo: () => set({ navigateTo: null }),

  setSettings: (s) => {
    set((prev) => ({ settings: { ...prev.settings, ...s } }));
  },

  setIntegrationResult: (r) => set({ integrationResult: r }),

  appendStatusLog: (msg) => {
    set((s) => ({
      statusLog: [...s.statusLog.slice(-199), msg],
    }));
  },

  setCurrentView: (view) => set({ currentView: view }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Convenience selectors
// ─────────────────────────────────────────────────────────────────────────────

export const selectIsConnected = (s: AppStore) =>
  s.connectionStatus.state === 'Connected';

export const selectDeviceStatus = (s: AppStore) =>
  s.connectionStatus.deviceStatus;

export function addQuickMarker(
  timestamp: number,
  category: MarkerCategory,
  label?: string,
) {
  useAppStore.getState().addMarker({
    timestamp,
    label: label ?? MARKER_COLORS[category],
    note: '',
    category,
    color: MARKER_COLORS[category],
  });
}
