// src/components/DebugConsole.tsx — Dev-only debug log viewer

import { useState, useRef, useEffect, useMemo } from 'react';
import { Copy, Trash2, ArrowDown } from 'lucide-react';
import clsx from 'clsx';
import {
  useLogStore,
  formatLogTimestamp,
  formatLogsAsText,
  type LogLevel,
  type LogEntry,
} from '../lib/logger';

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: 'text-text-subtle bg-surface',
  INFO: 'text-accent-blue bg-accent-blue/10',
  WARN: 'text-accent-yellow bg-accent-yellow/10',
  ERROR: 'text-accent-red bg-accent-red/10',
};

const ALL_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

export default function DebugConsole() {
  const entries = useLogStore((s) => s.entries);
  const clearLogs = useLogStore((s) => s.clear);

  const [enabledLevels, setEnabledLevels] = useState<Set<LogLevel>>(
    new Set(ALL_LEVELS),
  );
  const [sourceFilter, setSourceFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const sf = sourceFilter.toLowerCase();
    return entries.filter(
      (e) =>
        enabledLevels.has(e.level) &&
        (sf === '' || e.source.toLowerCase().includes(sf)),
    );
  }, [entries, enabledLevels, sourceFilter]);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const toggleLevel = (level: LogLevel) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  const copyAll = async () => {
    const text = formatLogsAsText(filtered);
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      // Fallback for environments where clipboard API is restricted
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }
  };

  // Unique sources for quick reference
  const sources = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) s.add(e.source);
    return [...s].sort();
  }, [entries]);

  return (
    <div className="h-full flex flex-col overflow-hidden p-2 gap-2">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap flex-none">
        {/* Level filters */}
        {ALL_LEVELS.map((level) => (
          <button
            key={level}
            className={clsx(
              'px-2 py-0.5 rounded text-xs font-mono font-medium transition-colors',
              enabledLevels.has(level)
                ? LEVEL_COLORS[level]
                : 'text-text-subtle bg-surface opacity-40',
            )}
            onClick={() => toggleLevel(level)}
          >
            {level}
          </button>
        ))}

        <div className="h-4 w-px bg-surface-200" />

        {/* Source filter */}
        <input
          className="input text-xs w-40 py-0.5"
          placeholder="Filter source..."
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          list="debug-sources"
        />
        <datalist id="debug-sources">
          {sources.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        <div className="flex-1" />

        <span className="text-xs text-text-subtle font-mono">
          {filtered.length}/{entries.length}
        </span>

        {/* Auto-scroll toggle */}
        <button
          className={clsx(
            'btn btn-ghost btn-sm',
            autoScroll && 'bg-accent-blue/10 text-accent-blue border-accent-blue/30',
          )}
          onClick={() => setAutoScroll(!autoScroll)}
          title="Auto-scroll"
        >
          <ArrowDown size={12} />
        </button>

        {/* Copy */}
        <button
          className={clsx(
            'btn btn-sm flex items-center gap-1',
            copyFeedback ? 'btn-success' : 'btn-ghost',
          )}
          onClick={copyAll}
          title="Copy all visible logs to clipboard"
        >
          <Copy size={12} />
          <span>{copyFeedback ? 'Copied!' : 'Copy'}</span>
        </button>

        {/* Clear */}
        <button
          className="btn btn-ghost btn-sm flex items-center gap-1 text-accent-red"
          onClick={clearLogs}
          title="Clear all logs"
        >
          <Trash2 size={12} />
          <span>Clear</span>
        </button>
      </div>

      {/* Log list */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto bg-base-100 rounded border border-surface-200 font-mono text-xs"
        onScroll={() => {
          if (!listRef.current) return;
          const el = listRef.current;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (autoScroll !== atBottom) setAutoScroll(atBottom);
        }}
      >
        {filtered.length === 0 ? (
          <div className="p-4 text-text-subtle text-center">
            No log entries{entries.length > 0 ? ' (try adjusting filters)' : ''}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {filtered.map((e) => (
                <LogRow key={e.id} entry={e} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <tr className="border-b border-surface-200/50 hover:bg-surface/30">
      <td className="px-2 py-0.5 text-text-subtle whitespace-nowrap align-top">
        {formatLogTimestamp(entry.timestamp)}
      </td>
      <td className="px-1 py-0.5 align-top">
        <span
          className={clsx(
            'inline-block w-12 text-center rounded px-1 py-px text-[10px] font-bold',
            LEVEL_COLORS[entry.level],
          )}
        >
          {entry.level}
        </span>
      </td>
      <td className="px-1 py-0.5 text-accent-teal whitespace-nowrap align-top">
        {entry.source}
      </td>
      <td className="px-2 py-0.5 text-text break-all">{entry.message}</td>
    </tr>
  );
}
