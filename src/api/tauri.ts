// src/api/tauri.ts — Typed wrappers around Tauri invoke + event listeners

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { logger } from '../lib/logger';
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

const SRC = 'api';

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

export const api = {
  async listPorts(): Promise<PortInfo[]> {
    logger.debug(SRC, 'listPorts() called');
    const ports = await invoke<PortInfo[]>('list_ports');
    logger.info(SRC, `listPorts() → ${ports.length} ports: ${ports.map((p) => p.name).join(', ')}`);
    return ports;
  },

  async connectDevice(port: string, baud?: number): Promise<void> {
    logger.info(SRC, `connectDevice(port=${port}, baud=${baud ?? 'default'})`);
    try {
      await invoke('connect_device', { port, baud });
      logger.info(SRC, `connectDevice() → success`);
    } catch (e) {
      logger.error(SRC, `connectDevice() → error: ${e}`);
      throw e;
    }
  },

  async disconnectDevice(): Promise<void> {
    logger.info(SRC, 'disconnectDevice() called');
    try {
      await invoke('disconnect_device');
      logger.info(SRC, 'disconnectDevice() → success');
    } catch (e) {
      logger.error(SRC, `disconnectDevice() → error: ${e}`);
      throw e;
    }
  },

  async sendDeviceCommand(command: string): Promise<void> {
    logger.debug(SRC, `sendDeviceCommand(${JSON.stringify(command)})`);
    try {
      await invoke('send_device_command', { request: { command } });
      logger.debug(SRC, `sendDeviceCommand(${JSON.stringify(command)}) → success`);
    } catch (e) {
      logger.error(SRC, `sendDeviceCommand(${JSON.stringify(command)}) → error: ${e}`);
      throw e;
    }
  },

  async getSamples(): Promise<{ timestamps: number[]; amps: number[]; total: number }> {
    logger.debug(SRC, 'getSamples() called');
    const result = await invoke<{ timestamps: number[]; amps: number[]; total: number }>('get_samples');
    logger.debug(SRC, `getSamples() → ${result.total} total samples`);
    return result;
  },

  async getStats(tStart?: number, tEnd?: number): Promise<SampleStats> {
    logger.debug(SRC, `getStats(tStart=${tStart}, tEnd=${tEnd})`);
    const stats = await invoke<SampleStats>('get_stats', { tStart, tEnd });
    logger.debug(SRC, `getStats() → count=${stats.count}, avg=${stats.avgAmps}`);
    return stats;
  },

  async clearSamples(): Promise<void> {
    logger.info(SRC, 'clearSamples() called');
    await invoke('clear_samples');
    logger.info(SRC, 'clearSamples() → done');
  },

  async saveWorkspace(
    path: string,
    appSettings: AppSettings,
    markers: Marker[],
  ): Promise<void> {
    logger.info(SRC, `saveWorkspace(path=${path}, markers=${markers.length})`);
    await invoke('save_workspace', { request: { path, appSettings, markers } });
    logger.info(SRC, 'saveWorkspace() → done');
  },

  async loadWorkspace(path: string): Promise<{
    appSettings: AppSettings;
    markers: Marker[];
    sampleCount: number;
    timestamps: number[];
    amps: number[];
  }> {
    logger.info(SRC, `loadWorkspace(path=${path})`);
    const result = await invoke<{
      appSettings: AppSettings;
      markers: Marker[];
      sampleCount: number;
      timestamps: number[];
      amps: number[];
    }>('load_workspace', { path });
    logger.info(SRC, `loadWorkspace() → ${result.sampleCount} samples, ${result.markers.length} markers`);
    return result;
  },

  async exportCsv(path: string, voltageV?: number): Promise<void> {
    logger.info(SRC, `exportCsv(path=${path}, voltage=${voltageV})`);
    await invoke('export_csv', { path, voltageV });
    logger.info(SRC, 'exportCsv() → done');
  },

  async exportJson(path: string, voltageV?: number): Promise<void> {
    logger.info(SRC, `exportJson(path=${path}, voltage=${voltageV})`);
    await invoke('export_json', { path, voltageV });
    logger.info(SRC, 'exportJson() → done');
  },

  async computeIntegration(input: {
    timestamps: number[];
    amps: number[];
    voltage: number;
  }): Promise<IntegrationResult> {
    logger.debug(SRC, `computeIntegration(samples=${input.timestamps.length}, voltage=${input.voltage})`);
    const result = await invoke<IntegrationResult>('compute_integration', { input });
    logger.debug(SRC, `computeIntegration() → charge=${result.chargeMah}mAh`);
    return result;
  },

  async computeBatteryRuntime(input: {
    capacityMah: number;
    avgCurrentAmps: number;
    efficiency: number;
    depthOfDischarge: number;
    agingMargin: number;
  }): Promise<BatteryRuntimeResult> {
    logger.debug(SRC, `computeBatteryRuntime(capacity=${input.capacityMah}mAh, current=${input.avgCurrentAmps}A)`);
    const result = await invoke<BatteryRuntimeResult>('compute_battery_runtime', { input });
    logger.debug(SRC, `computeBatteryRuntime() → ${result.runtimeHours}h`);
    return result;
  },

  async computeRequiredCapacity(input: {
    desiredRuntimeHours: number;
    avgCurrentAmps: number;
    efficiency: number;
    depthOfDischarge: number;
    agingMargin: number;
  }): Promise<RequiredCapacityResult> {
    logger.debug(SRC, `computeRequiredCapacity(runtime=${input.desiredRuntimeHours}h, current=${input.avgCurrentAmps}A)`);
    const result = await invoke<RequiredCapacityResult>('compute_required_capacity', { input });
    logger.debug(SRC, `computeRequiredCapacity() → ${result.requiredCapacityMah}mAh`);
    return result;
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
