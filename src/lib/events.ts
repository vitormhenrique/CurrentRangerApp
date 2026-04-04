// src/lib/events.ts — Module-scope Tauri event wiring.
// Runs exactly ONCE on import — no React effects, no Strict Mode duplication.

import { useAppStore } from '../store';
import type { DeviceStatus } from '../types';
import {
  api,
  onSerialSampleBatch,
  onSerialStatus,
  onSerialDeviceStatus,
  onSerialStatusMessage,
  onSerialInfo,
  onSerialError,
} from '../api/tauri';
import { logger } from './logger';

/** Remove null-valued keys so Rust Option::None doesn't overwrite frontend state. */
function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key in obj) {
    if (obj[key] !== null) {
      result[key] = obj[key];
    }
  }
  return result;
}

/** Score ports — higher = better match for CurrentRanger */
function pickBestPort(ports: { name: string; description?: string; vid?: number }[]) {
  const scored = ports.map((p) => {
    const name = p.name.toLowerCase();
    const desc = (p.description ?? '').toLowerCase();
    let score = 0;
    if (desc.includes('currentranger')) score += 10;
    if (p.vid === 0x239a) score += 8;
    if (name.includes('usbmodem')) score += 4;
    if (name.includes('cu.usb')) score += 3;
    if (name.includes('ttyacm')) score += 3;
    if (name.includes('ttyusb')) score += 2;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].p : null;
}

let _initialized = false;

/** Call once from main.tsx to wire all Tauri event listeners. Idempotent. */
export function initEventListeners() {
  if (_initialized) return;
  _initialized = true;

  logger.info('app', 'Wiring Tauri event listeners (module scope)');

  const store = useAppStore.getState;

  // Discover ports
  api.listPorts().then((ports) => {
    store().setPorts(ports);
    logger.info('app', `Port discovery: found ${ports.length} ports`);
    ports.forEach((p) =>
      logger.debug('app', `  Port: ${p.name} desc="${p.description}" vid=${p.vid ?? 'N/A'} pid=${p.pid ?? 'N/A'}`),
    );
    const firstPort = pickBestPort(ports);
    if (firstPort) {
      logger.info('app', `Auto-selected port: ${firstPort.name} (best match)`);
      store().setSelectedPort(firstPort.name);
    } else if (ports[0]) {
      logger.info('app', `Auto-selected port: ${ports[0].name} (first available, no match)`);
      store().setSelectedPort(ports[0].name);
    } else {
      logger.warn('app', 'No serial ports found');
    }
  });

  // Sample batches
  onSerialSampleBatch((batch) => {
    store().pushSampleBatch(batch.timestamps, batch.amps);
  });

  // Connection status
  onSerialStatus((status) => {
    const prev = store().connectionStatus.state;
    logger.info('serial', `Status: ${prev} → ${status.state}${status.port ? ` (${status.port})` : ''}${status.error ? ` error: ${status.error}` : ''}`);
    if (status.state === 'Connected' && prev !== 'Connected') {
      logger.info('serial', 'New connection established — marking acquisition, resuming chart');
      store().markNewAcquisition();
      store().setPaused(false);
      store().setSelectionRange(null);
      store().setSelectionStats(null);
    }
    store().setConnectionStatus(status);
  });

  // Device status
  onSerialDeviceStatus((ds) => {
    const prev = store().connectionStatus.deviceStatus;
    logger.debug('serial', `DeviceStatus update: ${JSON.stringify(ds)}`);
    if (ds.usbLogging === true && prev.usbLogging !== true) {
      logger.info('serial', 'USB logging enabled — resuming chart');
      store().setPaused(false);
    }
    if (ds.usbLogging === false && prev.usbLogging === true) {
      logger.info('serial', 'USB logging disabled — pausing chart');
      store().setPaused(true);
    }
    const merged = { ...prev, ...stripNulls(ds as unknown as Record<string, unknown>) } as DeviceStatus;
    store().setConnectionStatus({
      ...store().connectionStatus,
      deviceStatus: merged,
    });
  });

  // Status messages
  onSerialStatusMessage((msg) => {
    logger.debug('serial', `StatusMessage: ${msg}`);
    store().appendStatusLog(msg);
  });

  // Info messages
  onSerialInfo((msg) => {
    logger.debug('serial', `Info: ${msg}`);
    store().appendStatusLog(msg);
  });

  // Errors
  onSerialError((err) => {
    logger.error('serial', `Error event: ${err}`);
    store().appendStatusLog(`⚠ Serial error: ${err}`);
    store().setConnectionStatus({
      ...store().connectionStatus,
      state: 'Error',
      error: err,
    });
  });

  logger.info('app', 'All event listeners wired');
}
