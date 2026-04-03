// src/components/DeviceConfig.tsx — Dedicated firmware configuration screen

import { useState } from 'react';
import { useAppStore, selectIsConnected, selectDeviceStatus } from '../store';
import { api } from '../api/tauri';
import clsx from 'clsx';

// ─── helpers ──────────────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {subtitle && <p className="text-xs text-text-subtle mt-0.5">{subtitle}</p>}
    </div>
  );
}

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-surface-200 last:border-0">
      <div>
        <div className="text-sm text-text">{label}</div>
        {description && <div className="text-xs text-text-subtle mt-0.5 max-w-xs">{description}</div>}
      </div>
      <div className="flex items-center gap-2 flex-none ml-4">{children}</div>
    </div>
  );
}

function ToggleButton({
  active,
  onLabel = 'ON',
  offLabel = 'OFF',
  onClick,
  disabled,
}: {
  active: boolean | undefined;
  onLabel?: string;
  offLabel?: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      className={clsx(
        'btn btn-sm min-w-[56px]',
        active ? 'btn-success' : 'btn-ghost',
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {active ? onLabel : offLabel}
    </button>
  );
}

function Badge({ label, color }: { label: string; color?: string }) {
  return (
    <span
      className="rounded px-2 py-0.5 text-xs font-mono"
      style={{
        background: color ? color + '22' : 'rgba(137,220,235,0.12)',
        color: color ?? '#89dceb',
      }}
    >
      {label}
    </span>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export default function DeviceConfig() {
  const isConnected = useAppStore(selectIsConnected);
  const deviceStatus = useAppStore(selectDeviceStatus);
  const { appendStatusLog, setConnectionStatus, connectionStatus } = useAppStore();

  const [calibBusy, setCalibBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const send = async (cmd: string) => {
    if (!isConnected) return;
    try {
      await api.sendDeviceCommand(cmd);
    } catch (e) {
      appendStatusLog(`Error: ${e}`);
    }
  };

  // Send command + optimistically toggle a device status boolean
  const sendToggle = async (cmd: string, key: keyof typeof deviceStatus) => {
    if (!isConnected) return;
    try {
      await api.sendDeviceCommand(cmd);
      // Optimistic update for toggles that don't emit serial feedback
      const current = deviceStatus[key];
      if (typeof current === 'boolean' || current == null) {
        setConnectionStatus({
          ...connectionStatus,
          deviceStatus: { ...deviceStatus, [key]: !(current ?? false) },
        });
      }
    } catch (e) {
      appendStatusLog(`Error: ${e}`);
    }
  };

  const sendCalib = async (cmd: string, label: string) => {
    setCalibBusy(true);
    try {
      await send(cmd);
      appendStatusLog(`Calibration: ${label}`);
    } finally {
      setCalibBusy(false);
    }
  };

  const handleReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    await send('!');
    setConfirmReset(false);
  };

  const loggingFormatLabel = deviceStatus.loggingFormat ?? '—';
  const adcSpeedLabel = deviceStatus.adcSamplingSpeed ?? '—';
  const autoOffLabel = deviceStatus.autoOff ?? '—';
  const rangeLabel =
    deviceStatus.autorangeEnabled != null
      ? deviceStatus.autorangeEnabled
        ? 'AUTO'
        : '—'
      : '—';

  return (
    <div className="h-full overflow-y-auto px-6 py-5 flex flex-col gap-6 w-full">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-lg font-bold text-text">Device Configuration</h1>
          <p className="text-xs text-text-subtle mt-0.5">
            Settings are applied immediately and persisted to EEPROM on the device.
          </p>
        </div>
        <div className="flex-1" />
        {isConnected ? (
          <div className="flex items-center gap-2">
            {deviceStatus.firmwareVersion && (
              <Badge label={`fw ${deviceStatus.firmwareVersion}`} color="#a6e3a1" />
            )}
            <Badge label="Connected" color="#a6e3a1" />
            <button
              className="btn btn-ghost btn-sm text-xs"
              onClick={() => send('?')}
              title="Re-query device info"
            >
              ↺ Refresh
            </button>
          </div>
        ) : (
          <Badge label="Not connected" color="#f38ba8" />
        )}
      </div>

      {/* ── Measurement ─────────────────────────────────────────────────── */}
      <div className="panel">
        <SectionHeader
          title="Measurement"
          subtitle="Range selection and autoranging behaviour"
        />

        <Row
          label="Range"
          description="Force a specific current range or let the device autorange"
        >
          <div className="flex gap-1">
            {(['mA', 'µA', 'nA'] as const).map((r, i) => (
              <button
                key={r}
                className="btn btn-ghost btn-sm font-mono text-xs"
                onClick={() => send(String(i + 1))}
                disabled={!isConnected}
              >
                {r}
              </button>
            ))}
          </div>
        </Row>

        <Row
          label="Autoranging"
          description="Automatically switch range based on current level. Disables BIAS."
        >
          <span className="text-xs text-text-subtle font-mono">{rangeLabel}</span>
          <ToggleButton
            active={deviceStatus.autorangeEnabled}
            onClick={() => sendToggle('6', 'autorangeEnabled')}
            disabled={!isConnected}
          />
        </Row>

        <Row
          label="Low-Pass Filter (LPF)"
          description="Engage the hardware low-pass filter to reduce noise"
        >
          <ToggleButton
            active={deviceStatus.lpfEnabled}
            onClick={() => sendToggle('4', 'lpfEnabled')}
            disabled={!isConnected}
          />
        </Row>

        <Row
          label="BIAS Mode"
          description="Bidirectional / AC measurement mode. Disables autoranging."
        >
          <ToggleButton
            active={deviceStatus.biasEnabled}
            onClick={() => sendToggle('5', 'biasEnabled')}
            disabled={!isConnected}
          />
        </Row>
      </div>

      {/* ── Data logging ────────────────────────────────────────────────── */}
      <div className="panel">
        <SectionHeader
          title="Data Logging"
          subtitle="Configure what gets sent over USB/BT serial"
        />

        <Row
          label="USB Logging"
          description="Stream measurement data over the USB serial connection"
        >
          <ToggleButton
            active={deviceStatus.usbLogging}
            onClick={() => send('u')}
            disabled={!isConnected}
          />
        </Row>

        <Row
          label="BT Logging"
          description="Stream measurement data over Bluetooth (requires BT module)"
        >
          <ToggleButton
            active={deviceStatus.btLogging}
            onClick={() => send('b')}
            disabled={!isConnected}
          />
        </Row>

        <Row
          label="Logging Format"
          description="Output format for serial data. EXPONENT is recommended (self-describing)."
        >
          <span className="text-xs text-text-subtle font-mono">{loggingFormatLabel}</span>
          <button
            className="btn btn-ghost btn-sm text-xs font-mono"
            onClick={() => send('f')}
            disabled={!isConnected}
            title="Cycle: EXPONENT → NANOS → MICROS → MILLIS → ADC"
          >
            Cycle ↻
          </button>
        </Row>

        <Row
          label="ADC Sampling Speed"
          description="Trade-off between speed and noise. AVG is the default."
        >
          <span className="text-xs text-text-subtle font-mono">{adcSpeedLabel}</span>
          <button
            className="btn btn-ghost btn-sm text-xs font-mono"
            onClick={() => send('s')}
            disabled={!isConnected}
            title="Cycle: AVG → FAST → SLOW"
          >
            Cycle ↻
          </button>
        </Row>

        <Row
          label="GPIO Range Indication"
          description="Output the current range on the SCK/MISO/MOSI GPIO header pins"
        >
          <ToggleButton
            active={deviceStatus.gpioRangingEnabled}
            onClick={() => send('g')}
            disabled={!isConnected}
          />
        </Row>
      </div>

      {/* ── Power management ────────────────────────────────────────────── */}
      <div className="panel">
        <SectionHeader
          title="Power Management"
          subtitle="Auto-off settings for battery conservation"
        />

        <Row
          label="Auto-Off Mode"
          description="DEFAULT = 10 min · SMART = only when no logging active · DISABLED = never"
        >
          <span className="text-xs text-text-subtle font-mono">{autoOffLabel}</span>
          <button
            className="btn btn-ghost btn-sm text-xs font-mono"
            onClick={() => send('a')}
            disabled={!isConnected}
            title="Cycle: DEFAULT → DISABLED → SMART"
          >
            Cycle ↻
          </button>
        </Row>
      </div>

      {/* ── Calibration ─────────────────────────────────────────────────── */}
      <div className="panel">
        <SectionHeader
          title="Calibration"
          subtitle="Fine-tune ADC offset/gain and LDO reference voltage. Changes persist to EEPROM."
        />

        {/* Current calibration values */}
        <div className="flex gap-4 text-xs font-mono text-text-muted mb-4 p-3 bg-base-100 rounded border border-surface-200">
          <div>
            <span className="text-text-subtle">ADC Offset: </span>
            <span className="text-accent-blue">{deviceStatus.adcOffset ?? '—'}</span>
          </div>
          <div>
            <span className="text-text-subtle">ADC Gain: </span>
            <span className="text-accent-blue">{deviceStatus.adcGain ?? '—'}</span>
          </div>
          <div>
            <span className="text-text-subtle">LDO: </span>
            <span className="text-accent-blue">
              {deviceStatus.ldoVoltage != null ? `${deviceStatus.ldoVoltage.toFixed(3)} V` : '—'}
            </span>
          </div>
          <div className="flex-1" />
          <button
            className="btn btn-ghost btn-sm text-xs"
            onClick={() => send('?')}
            disabled={!isConnected}
          >
            ↺ Query
          </button>
        </div>

        <Row label="ADC Gain" description="Increment or decrement gain correction (+1 / −1)">
          <button
            className="btn btn-ghost btn-sm font-mono text-lg px-3"
            onClick={() => sendCalib('-', 'gain −1')}
            disabled={!isConnected || calibBusy}
            title="Gain −1 (writes to EEPROM)"
          >
            −
          </button>
          <button
            className="btn btn-ghost btn-sm font-mono text-lg px-3"
            onClick={() => sendCalib('+', 'gain +1')}
            disabled={!isConnected || calibBusy}
            title="Gain +1 (writes to EEPROM)"
          >
            +
          </button>
        </Row>

        <Row label="ADC Offset" description="Increment or decrement offset correction (+1 / −1)">
          <button
            className="btn btn-ghost btn-sm font-mono text-lg px-3"
            onClick={() => sendCalib('/', 'offset −1')}
            disabled={!isConnected || calibBusy}
            title="Offset −1 (writes to EEPROM)"
          >
            −
          </button>
          <button
            className="btn btn-ghost btn-sm font-mono text-lg px-3"
            onClick={() => sendCalib('*', 'offset +1')}
            disabled={!isConnected || calibBusy}
            title="Offset +1 (writes to EEPROM)"
          >
            +
          </button>
        </Row>

        <Row label="LDO Reference Voltage" description="Adjust LDO voltage ±1 mV per step">
          <button
            className="btn btn-ghost btn-sm font-mono text-lg px-3"
            onClick={() => sendCalib('<', 'LDO −1mV')}
            disabled={!isConnected || calibBusy}
            title="LDO −1mV (writes to EEPROM)"
          >
            −
          </button>
          <button
            className="btn btn-ghost btn-sm font-mono text-lg px-3"
            onClick={() => sendCalib('>', 'LDO +1mV')}
            disabled={!isConnected || calibBusy}
            title="LDO +1mV (writes to EEPROM)"
          >
            +
          </button>
        </Row>
      </div>

      {/* ── System ──────────────────────────────────────────────────────── */}
      <div className="panel">
        <SectionHeader title="System" />

        <Row
          label="Reset All Settings"
          description="Resets all runtime settings (logging, format, ADC speed, auto-off, range, LPF, BIAS) to firmware defaults"
        >
          <button
            className={clsx(
              'btn btn-sm',
              confirmReset ? 'btn-danger animate-pulse' : 'btn-ghost text-accent-red',
            )}
            onClick={handleReset}
            disabled={!isConnected}
          >
            {confirmReset ? 'Confirm Reset?' : '! Reset Defaults'}
          </button>
        </Row>

        <Row
          label="Serial Menu"
          description="Print the full firmware menu and calibration info to the serial log"
        >
          <button
            className="btn btn-ghost btn-sm text-xs"
            onClick={() => send('?')}
            disabled={!isConnected}
          >
            ? Print Menu
          </button>
        </Row>
      </div>

      {/* bottom padding */}
      <div className="h-4" />
    </div>
  );
}
