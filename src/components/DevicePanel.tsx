// src/components/DevicePanel.tsx — Serial connection and quick status

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppStore, selectIsConnected, selectDeviceStatus } from '../store';
import { api } from '../api/tauri';
import clsx from 'clsx';

const BAUD_OPTIONS = [230400, 115200, 57600, 9600];

export default function DevicePanel() {
  const {
    ports,
    selectedPort,
    setSelectedPort,
    setPorts,
    appendStatusLog,
    setCurrentView,
  } = useAppStore();

  const isConnected = useAppStore(selectIsConnected);
  const deviceStatus = useAppStore(selectDeviceStatus);
  const [baud, setBaud] = useState(230400);
  const [isBusy, setIsBusy] = useState(false);

  const refreshPorts = async () => {
    const ps = await api.listPorts();
    setPorts(ps);
  };

  const toggleConnect = async () => {
    setIsBusy(true);
    try {
      if (isConnected) {
        await api.disconnectDevice();
        appendStatusLog('Disconnected');
      } else {
        await api.connectDevice(selectedPort, baud);
        appendStatusLog(`Connected to ${selectedPort}`);
      }
    } catch (e: unknown) {
      appendStatusLog(`Error: ${e}`);
    } finally {
      setIsBusy(false);
    }
  };

  const send = async (cmd: string) => {
    try { await api.sendDeviceCommand(cmd); } catch { /* ignore */ }
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
          {deviceStatus.usbLogging != null && (
            <span
              className={clsx(
                'text-xs px-1.5 py-0.5 rounded font-mono',
                deviceStatus.usbLogging
                  ? 'bg-accent-green/10 text-accent-green'
                  : 'bg-surface text-text-subtle',
              )}
            >
              USB {deviceStatus.usbLogging ? 'LOG' : 'off'}
            </span>
          )}
          {deviceStatus.autorangeEnabled != null && (
            <span
              className={clsx(
                'text-xs px-1.5 py-0.5 rounded font-mono',
                deviceStatus.autorangeEnabled
                  ? 'bg-accent-blue/10 text-accent-blue'
                  : 'bg-surface text-text-subtle',
              )}
            >
              {deviceStatus.autorangeEnabled ? 'AUTO' : 'MAN'}
            </span>
          )}
          {deviceStatus.lpfEnabled && (
            <span className="text-xs px-1.5 py-0.5 rounded font-mono bg-accent-yellow/10 text-accent-yellow">
              LPF
            </span>
          )}
          {deviceStatus.biasEnabled && (
            <span className="text-xs px-1.5 py-0.5 rounded font-mono bg-accent-mauve/10 text-accent-mauve">
              BIAS
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

          {/* USB logging toggle */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted">USB Logging</span>
            <button
              className={clsx('btn btn-sm', deviceStatus.usbLogging ? 'btn-success' : 'btn-ghost')}
              onClick={() => send('u')}
            >
              {deviceStatus.usbLogging ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Range buttons */}
          <div className="flex gap-1">
            <button className="btn btn-ghost btn-sm flex-1 font-mono text-xs" onClick={() => send('1')} title="Force mA">mA</button>
            <button className="btn btn-ghost btn-sm flex-1 font-mono text-xs" onClick={() => send('2')} title="Force µA">µA</button>
            <button className="btn btn-ghost btn-sm flex-1 font-mono text-xs" onClick={() => send('3')} title="Force nA">nA</button>
            <button
              className={clsx('btn btn-sm flex-1 text-xs', deviceStatus.autorangeEnabled ? 'btn-primary' : 'btn-ghost')}
              onClick={() => send('6')}
              title="Toggle autoranging"
            >
              Auto
            </button>
          </div>

          {/* LPF + BIAS */}
          <div className="flex gap-1">
            <button
              className={clsx('btn btn-sm flex-1 text-xs', deviceStatus.lpfEnabled ? 'btn-primary' : 'btn-ghost')}
              onClick={() => send('4')}
              title="Toggle LPF"
            >
              LPF
            </button>
            <button
              className={clsx('btn btn-sm flex-1 text-xs', deviceStatus.biasEnabled ? 'btn-primary' : 'btn-ghost')}
              onClick={() => send('5')}
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
