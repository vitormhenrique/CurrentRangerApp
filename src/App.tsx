// src/App.tsx — Root component with layout and event wiring

import { useEffect, type ReactNode } from 'react';
import { LineChart, Settings, Bug } from 'lucide-react';
import { useAppStore, selectIsConnected, selectDeviceStatus } from './store';
import {
  api,
  onSerialSampleBatch,
  onSerialStatus,
  onSerialDeviceStatus,
  onSerialStatusMessage,
  onSerialInfo,
  onSerialError,
} from './api/tauri';
import { logger } from './lib/logger';
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
import DebugConsole from './components/DebugConsole';

const IS_DEV = import.meta.env.DEV;

// Score ports — higher = better match for CurrentRanger
function pickBestPort(ports: { name: string; description?: string; vid?: number }[]) {
  const scored = ports.map((p) => {
    const name = p.name.toLowerCase();
    const desc = (p.description ?? '').toLowerCase();
    let score = 0;
    if (desc.includes('currentranger')) score += 10;
    if (p.vid === 0x239a) score += 8;   // Adafruit VID used by CurrentRanger R3
    if (name.includes('usbmodem'))       score += 4;
    if (name.includes('cu.usb'))         score += 3;  // prefer cu.* over tty.* on macOS
    if (name.includes('ttyacm'))         score += 3;
    if (name.includes('ttyusb'))         score += 2;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].p : null;
}

export default function App() {
  const {
    setPorts,
    setConnectionStatus,
    pushSampleBatch,
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
    logger.info('app', 'App mounted, wiring event listeners');

    (async () => {
      const ports = await api.listPorts();
      setPorts(ports);
      logger.info('app', `Port discovery: found ${ports.length} ports`);
      ports.forEach((p) =>
        logger.debug('app', `  Port: ${p.name} desc="${p.description}" vid=${p.vid ?? 'N/A'} pid=${p.pid ?? 'N/A'}`),
      );
      const firstPort = pickBestPort(ports);
      if (firstPort) {
        logger.info('app', `Auto-selected port: ${firstPort.name} (best match)`);
        useAppStore.getState().setSelectedPort(firstPort.name);
      } else if (ports[0]) {
        logger.info('app', `Auto-selected port: ${ports[0].name} (first available, no match)`);
        useAppStore.getState().setSelectedPort(ports[0].name);
      } else {
        logger.warn('app', 'No serial ports found');
      }

      unlisteners.push(
        await onSerialSampleBatch((batch) => {
          pushSampleBatch(batch.timestamps, batch.amps);
        }),
        await onSerialStatus((status) => {
          const prev = useAppStore.getState().connectionStatus.state;
          logger.info('serial', `Status: ${prev} → ${status.state}${status.port ? ` (${status.port})` : ''}${status.error ? ` error: ${status.error}` : ''}`);
          if (status.state === 'Connected' && prev !== 'Connected') {
            logger.info('serial', 'New connection established — marking acquisition, resuming chart');
            useAppStore.getState().markNewAcquisition();
            useAppStore.getState().setPaused(false);
            useAppStore.getState().setSelectionRange(null);
            useAppStore.getState().setSelectionStats(null);
          }
          setConnectionStatus(status);
        }),
        await onSerialDeviceStatus((ds) => {
          const prev = useAppStore.getState().connectionStatus.deviceStatus;
          logger.debug('serial', `DeviceStatus update: ${JSON.stringify(ds)}`);
          // USB logging just turned on → insert a gap so chart lines break
          if (ds.usbLogging === true && prev.usbLogging !== true) {
            logger.info('serial', 'USB logging enabled — inserting acquisition gap');
            useAppStore.getState().markNewAcquisition();
          }
          setConnectionStatus({
            ...useAppStore.getState().connectionStatus,
            deviceStatus: ds,
          });
        }),
        await onSerialStatusMessage((msg) => {
          logger.debug('serial', `StatusMessage: ${msg}`);
          appendStatusLog(msg);
        }),
        await onSerialInfo((msg) => {
          logger.debug('serial', `Info: ${msg}`);
          appendStatusLog(msg);
        }),
        await onSerialError((err) => {
          logger.error('serial', `Error event: ${err}`);
          appendStatusLog(`⚠ Serial error: ${err}`);
          setConnectionStatus({
            ...useAppStore.getState().connectionStatus,
            state: 'Error',
            error: err,
          });
        }),
      );
      logger.info('app', 'All event listeners wired');
    })();

    return () => {
      logger.info('app', 'App unmounting, cleaning up event listeners');
      unlisteners.forEach((fn) => fn());
    };
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
    view: 'monitor' | 'device-config' | 'debug';
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
      <header className="flex-none bg-base-200 border-b border-surface-200 px-3 h-11 flex items-center gap-3 relative z-50">
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
          {IS_DEV && (
            <NavTab view="debug" label="Debug" icon={<Bug size={14} />} />
          )}
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
      {/* Both views are kept mounted; toggling visibility avoids remounting
          the LiveChart (which would restart the animation and lose viewport). */}
      <div className={clsx('flex flex-1 overflow-hidden', currentView !== 'monitor' && 'hidden')}>
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
      <div className={clsx('flex-1 overflow-hidden', currentView !== 'device-config' && 'hidden')}>
        <DeviceConfig />
      </div>
      {IS_DEV && (
        <div className={clsx('flex-1 overflow-hidden', currentView !== 'debug' && 'hidden')}>
          <DebugConsole />
        </div>
      )}

      {/* Status bar */}
      <StatusBar />
    </div>
  );
}
