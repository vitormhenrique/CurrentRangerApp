// src/lib/logger.ts — Lightweight debug logger with Zustand store for UI display
//
// Logs are stored in a ring buffer and optionally output to console (dev only).
// The DebugConsole component subscribes to the log store for live display.

import { create } from 'zustand';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  id: number;
  timestamp: number; // Date.now()
  level: LogLevel;
  source: string;
  message: string;
}

const MAX_LOG_ENTRIES = 2000;
const IS_DEV = import.meta.env.DEV;

// ─────────────────────────────────────────────────────────────────────────────
// Log store (separate from AppStore to avoid noise)
// ─────────────────────────────────────────────────────────────────────────────

interface LogStore {
  entries: LogEntry[];
  nextId: number;
  append: (level: LogLevel, source: string, message: string) => void;
  clear: () => void;
}

export const useLogStore = create<LogStore>((set, get) => ({
  entries: [],
  nextId: 1,
  clear: () => set({ entries: [], nextId: 1 }),
  append: (level, source, message) => {
    const { entries, nextId } = get();
    const entry: LogEntry = {
      id: nextId,
      timestamp: Date.now(),
      level,
      source,
      message,
    };
    const updated =
      entries.length >= MAX_LOG_ENTRIES
        ? [...entries.slice(entries.length - MAX_LOG_ENTRIES + 1), entry]
        : [...entries, entry];
    set({ entries: updated, nextId: nextId + 1 });
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Logger singleton
// ─────────────────────────────────────────────────────────────────────────────

function log(level: LogLevel, source: string, message: string) {
  useLogStore.getState().append(level, source, message);

  if (IS_DEV) {
    const tag = `[${source}]`;
    switch (level) {
      case 'DEBUG':
        console.debug(tag, message);
        break;
      case 'INFO':
        console.info(tag, message);
        break;
      case 'WARN':
        console.warn(tag, message);
        break;
      case 'ERROR':
        console.error(tag, message);
        break;
    }
  }
}

export const logger = {
  debug: (source: string, message: string) => log('DEBUG', source, message),
  info: (source: string, message: string) => log('INFO', source, message),
  warn: (source: string, message: string) => log('WARN', source, message),
  error: (source: string, message: string) => log('ERROR', source, message),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function formatLogTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function formatLogsAsText(entries: LogEntry[]): string {
  return entries
    .map(
      (e) =>
        `${formatLogTimestamp(e.timestamp)} [${e.level.padEnd(5)}] [${e.source}] ${e.message}`,
    )
    .join('\n');
}
