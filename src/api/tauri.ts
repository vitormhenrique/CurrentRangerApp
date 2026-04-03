// src/api/tauri.ts — Typed wrappers around Tauri invoke + event listeners

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  AppSettings,
  BatteryRuntimeResult,
  ConnectionStatus,
  DeviceStatus,
  IntegrationResult,
  Marker,
  PortInfo,
  RequiredCapacityResult,
  Sample,
  SampleStats,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

export const api = {
  listPorts(): Promise<PortInfo[]> {
    return invoke('list_ports');
  },

  connectDevice(port: string, baud?: number): Promise<void> {
    return invoke('connect_device', { port, baud });
  },

  disconnectDevice(): Promise<void> {
    return invoke('disconnect_device');
  },

  sendDeviceCommand(command: string): Promise<void> {
    return invoke('send_device_command', { request: { command } });
  },

  getSamples(): Promise<{ timestamps: number[]; amps: number[]; total: number }> {
    return invoke('get_samples');
  },

  getStats(tStart?: number, tEnd?: number): Promise<SampleStats> {
    return invoke('get_stats', { tStart, tEnd });
  },

  clearSamples(): Promise<void> {
    return invoke('clear_samples');
  },

  saveWorkspace(
    path: string,
    appSettings: AppSettings,
    markers: Marker[],
  ): Promise<void> {
    return invoke('save_workspace', { request: { path, appSettings, markers } });
  },

  loadWorkspace(path: string): Promise<{
    appSettings: AppSettings;
    markers: Marker[];
    sampleCount: number;
    timestamps: number[];
    amps: number[];
  }> {
    return invoke('load_workspace', { path });
  },

  exportCsv(path: string, voltageV?: number): Promise<void> {
    return invoke('export_csv', { path, voltageV });
  },

  exportJson(path: string, voltageV?: number): Promise<void> {
    return invoke('export_json', { path, voltageV });
  },

  computeIntegration(input: {
    timestamps: number[];
    amps: number[];
    voltage: number;
  }): Promise<IntegrationResult> {
    return invoke('compute_integration', { input });
  },

  computeBatteryRuntime(input: {
    capacityMah: number;
    avgCurrentAmps: number;
    efficiency: number;
    depthOfDischarge: number;
    agingMargin: number;
  }): Promise<BatteryRuntimeResult> {
    return invoke('compute_battery_runtime', { input });
  },

  computeRequiredCapacity(input: {
    desiredRuntimeHours: number;
    avgCurrentAmps: number;
    efficiency: number;
    depthOfDischarge: number;
    agingMargin: number;
  }): Promise<RequiredCapacityResult> {
    return invoke('compute_required_capacity', { input });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────────────────────

export interface SampleBatchEvent {
  timestamps: number[];
  amps: number[];
}

export function onSerialSampleBatch(cb: (batch: SampleBatchEvent) => void): Promise<UnlistenFn> {
  return listen<SampleBatchEvent>('serial:samples_batch', (e) => cb(e.payload));
}

export function onSerialSample(cb: (sample: Sample) => void): Promise<UnlistenFn> {
  return listen<Sample>('serial:sample', (e) => cb(e.payload));
}

export function onSerialStatus(cb: (status: ConnectionStatus) => void): Promise<UnlistenFn> {
  return listen<ConnectionStatus>('serial:status', (e) => cb(e.payload));
}

export function onSerialDeviceStatus(cb: (status: DeviceStatus) => void): Promise<UnlistenFn> {
  return listen<DeviceStatus>('serial:device_status', (e) => cb(e.payload));
}

export function onSerialStatusMessage(cb: (msg: string) => void): Promise<UnlistenFn> {
  return listen<string>('serial:status_message', (e) => cb(e.payload));
}

export function onSerialInfo(cb: (msg: string) => void): Promise<UnlistenFn> {
  return listen<string>('serial:info', (e) => cb(e.payload));
}

export function onSerialError(cb: (err: string) => void): Promise<UnlistenFn> {
  return listen<string>('serial:error', (e) => cb(e.payload));
}

// ─────────────────────────────────────────────────────────────────────────────
// File dialogs
// ─────────────────────────────────────────────────────────────────────────────

export async function pickSaveWorkspace(): Promise<string | null> {
  return save({
    defaultPath: `session_${Date.now()}.crws`,
    filters: [{ name: 'CurrentRanger Workspace', extensions: ['crws'] }],
  });
}

export async function pickOpenWorkspace(): Promise<string | null> {
  const result = await open({
    multiple: false,
    filters: [{ name: 'CurrentRanger Workspace', extensions: ['crws'] }],
  });
  return typeof result === 'string' ? result : null;
}

export async function pickSaveCsv(): Promise<string | null> {
  return save({
    defaultPath: `current_log_${Date.now()}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
}

export async function pickSaveJson(): Promise<string | null> {
  return save({
    defaultPath: `current_export_${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
}
