// src/components/StatusBar.tsx
import { useAppStore } from '../store';

export default function StatusBar() {
  const { connectionStatus, totalSamples, lastSampleTs, statusLog } = useAppStore();
  const lastMsg = statusLog[statusLog.length - 1] ?? '';

  const stateColor =
    connectionStatus.state === 'Connected'
      ? 'text-accent-green'
      : connectionStatus.state === 'Error'
      ? 'text-accent-red'
      : connectionStatus.state === 'Connecting'
      ? 'text-accent-yellow animate-pulse-fast'
      : 'text-text-subtle';

  const age = lastSampleTs ? ((Date.now() / 1000 - lastSampleTs)).toFixed(1) : null;

  return (
    <footer className="flex-none h-7 bg-base-200 border-t border-surface-200 flex items-center px-3 gap-4 text-xs font-mono">
      <span className={stateColor}>{connectionStatus.state}</span>
      {connectionStatus.port && (
        <span className="text-text-muted">{connectionStatus.port}</span>
      )}
      <span className="text-text-subtle">{totalSamples.toLocaleString()} samples</span>
      {age && <span className="text-text-subtle">last: {age}s ago</span>}
      {connectionStatus.error && (
        <span className="text-accent-red truncate max-w-xs">{connectionStatus.error}</span>
      )}
      {lastMsg && (
        <span className="text-text-subtle truncate flex-1">{lastMsg}</span>
      )}
    </footer>
  );
}
