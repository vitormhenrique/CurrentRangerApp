// src/App.tsx — Root component with layout and event wiring

import { useEffect, type ReactNode } from 'react';
import { LineChart, Settings } from 'lucide-react';
import { useAppStore, selectIsConnected, selectDeviceStatus } from './store';
import {
  api,
  onSerialSample,
  onSerialStatus,
  onSerialDeviceStatus,
  onSerialStatusMessage,
  onSerialInfo,
  onSerialError,
} from './api/tauri';
import clsx from 'clsx';

import DevicePanel from './components/DevicePanel';
import DeviceConfig from './components/DeviceConfig';
import LiveChart from './components/LiveChart';
import StatsPanel from './components/StatsPanel';
import MarkersPanel from './components/MarkersPanel';
import BatteryTools from './components/BatteryTools';
import WorkspacePanel from './components/WorkspacePanel';
import IntegrationPanel from './components/IntegrationPanel';
import StatusBar from './components/StatusBar';

export default function App() {
  const {
    setPorts,
    setConnectionStatus,
    pushSampleEvent,
    appendStatusLog,
    currentView,
    setCurrentView,
  } = useAppStore();

  const isConnected = useAppStore(selectIsConnected);
  const deviceStatus = useAppStore(selectDeviceStatus);
  const connectionStatus = useAppStore((s) => s.connectionStatus);

  // Wire up Tauri event listeners on mount
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    (async () => {
      const ports = await api.listPorts();
      setPorts(ports);
      const firstPort = ports.find(
        (p) =>
          p.name.toLowerCase().includes('usbmodem') ||
          (p.description || '').toLowerCase().includes('currentranger'),
      );
      if (firstPort) {
        useAppStore.getState().setSelectedPort(firstPort.name);
      } else if (ports[0]) {
        useAppStore.getState().setSelectedPort(ports[0].name);
      }

      unlisteners.push(
        await onSerialSample((s) => pushSampleEvent(s)),
        await onSerialStatus((status) => setConnectionStatus(status)),
        await onSerialDeviceStatus((ds) => {
          setConnectionStatus({
            ...useAppStore.getState().connectionStatus,
            deviceStatus: ds,
          });
        }),
        await onSerialStatusMessage((msg) => appendStatusLog(msg)),
        await onSerialInfo((msg) => appendStatusLog(msg)),
        await onSerialError((err) => {
          appendStatusLog(`⚠ Serial error: ${err}`);
          setConnectionStatus({
            ...useAppStore.getState().connectionStatus,
            state: 'Error',
            error: err,
          });
        }),
      );
    })();

    return () => unlisteners.forEach((fn) => fn());
  }, []);

  const stateColor =
    connectionStatus.state === 'Connected'
      ? 'text-accent-green'
      : connectionStatus.state === 'Error'
      ? 'text-accent-red'
      : connectionStatus.state === 'Connecting'
      ? 'text-accent-yellow'
      : 'text-text-subtle';

  const NavTab = ({
    view,
    label,
    icon,
  }: {
    view: 'monitor' | 'device-config';
    label: string;
    icon: ReactNode;
  }) => (
    <button
      className={clsx(
        'flex items-center gap-1.5 px-3 py-1 rounded text-sm font-medium transition-colors',
        currentView === view
          ? 'bg-surface text-text'
          : 'text-text-muted hover:text-text hover:bg-surface/50',
      )}
      onClick={() => setCurrentView(view)}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-base-100 text-text select-none">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header className="flex-none bg-base-200 border-b border-surface-200 px-3 h-11 flex items-center gap-3">
        {/* Logo */}
        <div className="flex items-center gap-2 flex-none">
          <img src="/icon.svg" className="w-5 h-5" alt="" />
          <span className="font-mono font-bold text-text text-sm tracking-tight">
            CurrentRanger
          </span>
        </div>

        <div className="h-5 w-px bg-surface-200 flex-none" />

        {/* Navigation tabs */}
        <nav className="flex items-center gap-1">
          <NavTab view="monitor" label="Monitor" icon={<LineChart size={14} />} />
          <NavTab view="device-config" label="Device Config" icon={<Settings size={14} />} />
        </nav>

        <div className="flex-1" />

        {/* Connection status pill */}
        <div className="flex items-center gap-2">
          {isConnected && deviceStatus.firmwareVersion && (
            <span className="text-xs text-text-subtle font-mono hidden sm:block">
              fw {deviceStatus.firmwareVersion}
            </span>
          )}
          <div
            className={clsx(
              'flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 rounded',
              connectionStatus.state === 'Connected'
                ? 'bg-accent-green/10'
                : connectionStatus.state === 'Error'
                ? 'bg-accent-red/10'
                : 'bg-surface-200',
            )}
          >
            <span
              className={clsx(
                'w-1.5 h-1.5 rounded-full',
                connectionStatus.state === 'Connected'
                  ? 'bg-accent-green'
                  : connectionStatus.state === 'Error'
                  ? 'bg-accent-red'
                  : connectionStatus.state === 'Connecting'
                  ? 'bg-accent-yellow animate-pulse'
                  : 'bg-surface',
              )}
            />
            <span className={stateColor}>{connectionStatus.state}</span>
            {connectionStatus.port && (
              <span className="text-text-subtle hidden md:block">
                · {connectionStatus.port.replace('/dev/tty.', '').replace('/dev/', '')}
              </span>
            )}
          </div>
        </div>

        <div className="h-5 w-px bg-surface-200 flex-none" />

        {/* Workspace actions */}
        <WorkspacePanel />
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {currentView === 'monitor' ? (
        <div className="flex flex-1 overflow-hidden">
          {/* Left sidebar */}
          <aside className="flex-none w-60 flex flex-col gap-2 p-2 border-r border-surface-200 overflow-y-auto">
            <DevicePanel />
            <div className="divider" />
            <IntegrationPanel />
            <div className="divider" />
            <BatteryTools />
          </aside>

          {/* Centre: chart + stats */}
          <main className="flex-1 flex flex-col overflow-hidden p-2 gap-2">
            <LiveChart />
            <StatsPanel />
          </main>

          {/* Right sidebar */}
          <aside className="flex-none w-60 flex flex-col p-2 border-l border-surface-200 overflow-y-auto">
            <MarkersPanel />
          </aside>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <DeviceConfig />
        </div>
      )}

      {/* Status bar */}
      <StatusBar />
    </div>
  );
}
