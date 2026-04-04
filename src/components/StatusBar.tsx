// src/components/StatusBar.tsx
import { Coffee, BookOpen } from 'lucide-react';
import { useAppStore } from '../store';

const DONATE_URL = 'https://www.paypal.com/donate/?business=NT46DHPPPSBBU&no_recurring=0&item_name=buy+me+a+coffee&currency_code=USD';
const DOCS_URL = 'https://vitormhenrique.github.io/CurrentRangerApp/';

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
      <div className="flex-1" />
      <a
        href={DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-text-subtle hover:text-accent-blue transition-colors"
        title="Documentation"
      >
        <BookOpen size={11} />
        <span>Docs</span>
      </a>
      <a
        href={DONATE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-text-subtle hover:text-accent-yellow transition-colors"
        title="Buy me a coffee"
      >
        <Coffee size={11} />
        <span>Buy me a coffee</span>
      </a>
    </footer>
  );
}
