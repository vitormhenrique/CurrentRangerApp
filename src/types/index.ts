// src/types/index.ts — Shared TypeScript types matching Rust serde structs

export type ConnectionState = 'Disconnected' | 'Connecting' | 'Connected' | 'Error';

export interface PortInfo {
  name: string;
  description: string;
  vid?: number;
  pid?: number;
}

export type LoggingFormat =
  | 'EXPONENT'
  | 'NANOS'
  | 'MICROS'
  | 'MILLIS'
  | 'ADC';

export type AdcSamplingSpeed = 'AVG' | 'FAST' | 'SLOW';
export type AutoOff = 'DEFAULT' | 'DISABLED' | 'SMART';

export interface DeviceStatus {
  firmwareVersion?: string;
  usbLogging?: boolean;
  btLogging?: boolean;
  loggingFormat?: LoggingFormat;
  adcSamplingSpeed?: AdcSamplingSpeed;
  autoOff?: AutoOff;
  lpfEnabled?: boolean;
  biasEnabled?: boolean;
  autorangeEnabled?: boolean;
  gpioRangingEnabled?: boolean;
  adcOffset?: number;
  adcGain?: number;
  ldoVoltage?: number;
  /** Current forced range — only set optimistically by the UI (firmware doesn't report over USB). */
  currentRange?: 'MA' | 'UA' | 'NA';
}

export interface ConnectionStatus {
  state: ConnectionState;
  port?: string;
  baud?: number;
  error?: string;
  lastSampleTs?: number;
  sampleCount: number;
  deviceStatus: DeviceStatus;
}

export interface Sample {
  timestamp: number; // unix seconds (float)
  amps: number;
}

export type MarkerCategory =
  | 'note'
  | 'boot'
  | 'idle'
  | 'sleep'
  | 'radioTx'
  | 'sensorSample'
  | 'custom';

export interface Marker {
  id: string;
  timestamp: number;
  endTimestamp?: number;  // undefined = point marker; set = range marker
  label: string;
  note: string;
  category: MarkerCategory;
  color: string;
}

export interface SampleStats {
  count: number;
  minAmps: number;
  maxAmps: number;
  avgAmps: number;
  durationS: number;
  rateHz: number;
}

export interface IntegrationResult {
  chargeCoulombs: number;
  chargeMah: number;
  chargeAh: number;
  energyJoules: number;
  energyWh: number;
  energyMwh: number;
  durationS: number;
  avgAmps: number;
  sampleCount: number;
}

export interface BatteryRuntimeResult {
  runtimeHours: number;
  runtimeMinutes: number;
  runtimeSeconds: number;
  effectiveCapacityMah: number;
  effectiveCurrentMa: number;
}

export interface RequiredCapacityResult {
  requiredCapacityMah: number;
  requiredCapacityAh: number;
  ratedCapacityMah: number;
}

export interface AppSettings {
  voltageV: number;
  loggingFormat: LoggingFormat;
  timeWindowS: number;
  hideDeadTime: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

export function formatCurrent(amps: number): string {
  const a = Math.abs(amps);
  if (a >= 1.0) return `${amps.toFixed(4)} A`;
  if (a >= 1e-3) return `${(amps * 1e3).toFixed(4)} mA`;
  if (a >= 1e-6) return `${(amps * 1e6).toFixed(3)} µA`;
  if (a >= 1e-9) return `${(amps * 1e9).toFixed(2)} nA`;
  return `${amps.toExponential(3)} A`;
}

export function formatCurrentShort(amps: number): string {
  const a = Math.abs(amps);
  if (a >= 1.0) return `${amps.toFixed(3)} A`;
  if (a >= 1e-3) return `${(amps * 1e3).toFixed(3)} mA`;
  if (a >= 1e-6) return `${(amps * 1e6).toFixed(2)} µA`;
  return `${(amps * 1e9).toFixed(1)} nA`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(2)} h`;
}

export function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const MARKER_COLORS: Record<MarkerCategory, string> = {
  note: '#89b4fa',
  boot: '#a6e3a1',
  idle: '#89dceb',
  sleep: '#cba6f7',
  radioTx: '#fab387',
  sensorSample: '#f9e2af',
  custom: '#f38ba8',
};

export const MARKER_LABELS: Record<MarkerCategory, string> = {
  note: 'Note',
  boot: 'Boot',
  idle: 'Idle',
  sleep: 'Sleep',
  radioTx: 'Radio TX',
  sensorSample: 'Sensor',
  custom: 'Custom',
};
