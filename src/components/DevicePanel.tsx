// src/components/DevicePanel.tsx — Serial connection and quick status

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppStore, selectIsConnected, selectDeviceStatus } from '../store';
import { api } from '../api/tauri';
import { logger } from '../lib/logger';
import clsx from 'clsx';

const SRC = 'DevicePanel';
const BAUD_OPTIONS = [230400, 115200, 57600, 9600];

function pickBestPort(ports: { name: string; description?: string; vid?: number }[]) {
  const scored = ports.map((p) => {
    const name = p.name.toLowerCase();
    const desc = (p.description ?? '').toLowerCase();
    let score = 0;
    if (desc.includes('currentranger')) score += 10;
    if (p.vid === 0x239a) score += 8;
    if (name.includes('usbmodem'))       score += 4;
    if (name.includes('cu.usb'))         score += 3;
    if (name.includes('ttyacm'))         score += 3;
    if (name.includes('ttyusb'))         score += 2;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].p : null;
}

export default function DevicePanel() {
  const {
    ports,
    selectedPort,
    setSelectedPort,
    setPorts,
    appendStatusLog,
    setCurrentView,
    connectionStatus,
    setConnectionStatus,
  } = useAppStore();

  const isConnected = useAppStore(selectIsConnected);
  const deviceStatus = useAppStore(selectDeviceStatus);
  const paused = useAppStore((s) => s.paused);
  const [baud, setBaud] = useState(230400);
  const [isBusy, setIsBusy] = useState(false);

  const refreshPorts = async () => {
    logger.debug(SRC, 'Refreshing port list');
    const ps = await api.listPorts();
    setPorts(ps);
    if (!isConnected) {
      const match = pickBestPort(ps);
      if (match) {
        logger.info(SRC, `Best port match after refresh: ${match.name}`);
        setSelectedPort(match.name);
      }
    }
  };

  const toggleConnect = async () => {
    setIsBusy(true);
    try {
      if (isConnected) {
        logger.info(SRC, 'User initiated disconnect');
        await api.disconnectDevice();
        appendStatusLog('Disconnected');
      } else {
        logger.info(SRC, `User initiated connect: port=${selectedPort}, baud=${baud}`);
        await api.connectDevice(selectedPort, baud);
        appendStatusLog(`Connected to ${selectedPort}`);
        // Query device config after connection settles
        setTimeout(async () => {
          logger.debug(SRC, 'Querying device config (delayed ? command)');
          try { await api.sendDeviceCommand('?'); } catch { /* ignore */ }
        }, 800);
      }
    } catch (e: unknown) {
      logger.error(SRC, `Connection toggle failed: ${e}`);
      appendStatusLog(`Error: ${e}`);
    } finally {
      setIsBusy(false);
    }
  };

  const send = async (cmd: string) => {
    logger.debug(SRC, `Sending command: ${JSON.stringify(cmd)}`);
    try { await api.sendDeviceCommand(cmd); } catch { /* ignore */ }
  };

  // Force a specific range and reflect it optimistically in the UI.
  // The firmware disables autoranging when a specific range is forced but
  // sends no USB confirmation, so we update the store directly.
  const sendRange = async (cmd: '1' | '2' | '3') => {
    const rangeMap = { '1': 'MA', '2': 'UA', '3': 'NA' } as const;
    logger.info(SRC, `Force range: cmd=${cmd} → ${rangeMap[cmd]} (optimistic)`);
    try {
      await api.sendDeviceCommand(cmd);
      setConnectionStatus({
        ...connectionStatus,
        deviceStatus: {
          ...deviceStatus,
          autorangeEnabled: false,
          currentRange: rangeMap[cmd],
        },
      });
    } catch { /* ignore */ }
  };

  // Optimistic toggle for commands with no serial feedback
  const sendToggle = async (cmd: string, key: string) => {
    const current = (deviceStatus as Record<string, unknown>)[key];
    logger.info(SRC, `Toggle ${key}: cmd=${cmd}, current=${current} → ${!(current ?? false)} (optimistic)`);
    try {
      await api.sendDeviceCommand(cmd);
      if (typeof current === 'boolean' || current == null) {
        setConnectionStatus({
          ...connectionStatus,
          deviceStatus: { ...deviceStatus, [key]: !(current ?? false) },
        });
      }
    } catch { /* ignore */ }
  };

  return (
    <div className="panel">
      <div className="panel-title">Connection</div>

      {/* Port select */}
      <div className="flex gap-1">
        <select
          className="select flex-1 text-xs"
          value={selectedPort}
          onChange={(e) => setSelectedPort(e.target.value)}
          disabled={isConnected}
        >
          {ports.length === 0 && <option value="">No ports found</option>}
          {ports.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}{p.description ? ` — ${p.description}` : ''}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost btn-sm" onClick={refreshPorts} title="Refresh ports">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Baud */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-subtle w-10">Baud</span>
        <select
          className="select flex-1 text-xs"
          value={baud}
          onChange={(e) => setBaud(Number(e.target.value))}
          disabled={isConnected}
        >
          {BAUD_OPTIONS.map((b) => (
            <option key={b} value={b}>{b.toLocaleString()}</option>
          ))}
        </select>
      </div>

      {/* Connect/disconnect */}
      <button
        className={clsx('btn w-full', isConnected ? 'btn-danger' : 'btn-success')}
        onClick={toggleConnect}
        disabled={isBusy || !selectedPort}
      >
        {isBusy ? '…' : isConnected ? 'Disconnect' : 'Connect'}
      </button>

      {/* Quick status badges */}
      {isConnected && (
        <div className="flex flex-wrap gap-1 pt-1">
          {/* USB logging + streaming indicator */}
          <span
            className={clsx(
              'text-xs px-1.5 py-0.5 rounded font-mono font-bold',
              deviceStatus.usbLogging && !paused
                ? 'bg-accent-green/20 text-accent-green ring-1 ring-accent-green/40'
                : deviceStatus.usbLogging
                ? 'bg-accent-yellow/15 text-accent-yellow'
                : 'bg-surface text-text-subtle',
            )}
          >
            {deviceStatus.usbLogging && !paused ? '▶ STREAM' : deviceStatus.usbLogging ? '⏸ PAUSED' : 'USB off'}
          </span>
          {deviceStatus.autorangeEnabled != null && (
            <span
              className={clsx(
                'text-xs px-1.5 py-0.5 rounded font-mono',
                deviceStatus.autorangeEnabled
                  ? 'bg-accent-blue/15 text-accent-blue font-bold'
                  : 'bg-surface text-text-subtle',
              )}
            >
              {deviceStatus.autorangeEnabled ? 'AUTO' : 'MAN'}
            </span>
          )}
          {deviceStatus.lpfEnabled != null && (
            <span
              className={clsx(
                'text-xs px-1.5 py-0.5 rounded font-mono',
                deviceStatus.lpfEnabled
                  ? 'bg-accent-yellow/15 text-accent-yellow font-bold'
                  : 'bg-surface text-text-subtle',
              )}
            >
              LPF{deviceStatus.lpfEnabled ? '' : ' off'}
            </span>
          )}
          {deviceStatus.biasEnabled != null && (
            <span
              className={clsx(
                'text-xs px-1.5 py-0.5 rounded font-mono',
                deviceStatus.biasEnabled
                  ? 'bg-accent-mauve/15 text-accent-mauve font-bold'
                  : 'bg-surface text-text-subtle',
              )}
            >
              BIAS{deviceStatus.biasEnabled ? '' : ' off'}
            </span>
          )}
          {deviceStatus.loggingFormat && (
            <span className="text-xs px-1.5 py-0.5 rounded font-mono bg-surface text-text-subtle">
              {deviceStatus.loggingFormat}
            </span>
          )}
        </div>
      )}

      {/* Quick controls */}
      {isConnected && (
        <>
          <div className="divider" />
          <div className="panel-title">Quick Controls</div>

          {/* USB logging toggle — chart pause/resume handled by event listener */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted">USB Logging</span>
            <button
              className={clsx('btn btn-sm', deviceStatus.usbLogging ? 'btn-success' : 'btn-ghost')}
              onClick={async () => {
                const willEnable = !deviceStatus.usbLogging;
                logger.info(SRC, `USB logging toggle: will ${willEnable ? 'enable' : 'disable'}`);
                await send('u');
              }}
            >
              {deviceStatus.usbLogging ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Range buttons */}
          <div className="flex gap-1">
            {(['mA', 'µA', 'nA'] as const).map((label, i) => {
              const cmd = String(i + 1) as '1' | '2' | '3';
              const rangeKey = (['MA', 'UA', 'NA'] as const)[i];
              const active = !deviceStatus.autorangeEnabled && deviceStatus.currentRange === rangeKey;
              return (
                <button
                  key={label}
                  className={clsx('btn btn-sm flex-1 font-mono text-xs', active ? 'btn-primary' : 'btn-ghost')}
                  onClick={() => sendRange(cmd)}
                  title={`Force ${label}`}
                >
                  {label}
                </button>
              );
            })}
            <button
              className={clsx('btn btn-sm flex-1 text-xs', deviceStatus.autorangeEnabled ? 'btn-primary' : 'btn-ghost')}
              onClick={() => sendToggle('6', 'autorangeEnabled')}
              title="Toggle autoranging"
            >
              Auto
            </button>
          </div>

          {/* LPF + BIAS */}
          <div className="flex gap-1">
            <button
              className={clsx('btn btn-sm flex-1 text-xs', deviceStatus.lpfEnabled ? 'btn-primary' : 'btn-ghost')}
              onClick={() => sendToggle('4', 'lpfEnabled')}
              title="Toggle LPF"
            >
              LPF
            </button>
            <button
              className={clsx('btn btn-sm flex-1 text-xs', deviceStatus.biasEnabled ? 'btn-primary' : 'btn-ghost')}
              onClick={() => sendToggle('5', 'biasEnabled')}
              title="Toggle BIAS"
            >
              BIAS
            </button>
          </div>

          {/* Config shortcut */}
          <button
            className="btn btn-ghost btn-sm text-xs w-full mt-1"
            onClick={() => setCurrentView('device-config')}
          >
            ⚙ Full Device Config →
          </button>
        </>
      )}
    </div>
  );
}
