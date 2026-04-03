// src/components/MarkersPanel.tsx — Marker list, add, edit, delete

import { useState } from 'react';
import { useAppStore } from '../store';
import {
  Marker,
  MarkerCategory,
  MARKER_COLORS,
  MARKER_LABELS,
} from '../types';

function formatLocalHMS(unixS: number): string {
  const d = new Date(unixS * 1000);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const CATEGORIES: MarkerCategory[] = [
  'note', 'boot', 'idle', 'sleep', 'radioTx', 'sensorSample', 'custom',
];

function MarkerRow({ marker }: { marker: Marker }) {
  const { updateMarker, removeMarker, navigateToMarker } = useAppStore();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(marker.label);
  const [note, setNote] = useState(marker.note);
  const [color, setColor] = useState(marker.color);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLabel(marker.label);
    setNote(marker.note);
    setColor(marker.color);
    setEditing(true);
  };

  const save = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!label.trim()) return; // label is mandatory
    updateMarker(marker.id, { label: label.trim(), note, color });
    setEditing(false);
  };

  const isRange = marker.endTimestamp != null;
  const timeStr = formatLocalHMS(marker.timestamp);
  const durationStr = isRange
    ? (() => {
        const dur = marker.endTimestamp! - marker.timestamp;
        if (dur >= 3600) return `${(dur / 3600).toFixed(2)}h`;
        if (dur >= 60)   return `${(dur / 60).toFixed(2)}m`;
        if (dur >= 1)    return `${dur.toFixed(3)}s`;
        return `${(dur * 1000).toFixed(1)}ms`;
      })()
    : null;

  if (editing) {
    return (
      <div
        className="border border-accent-teal/40 rounded p-2 flex flex-col gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Color + label row */}
        <div className="flex items-center gap-2">
          <label
            className="w-5 h-5 rounded-full border-2 border-surface-200 cursor-pointer hover:ring-2 hover:ring-accent-teal/40 transition-all flex-none"
            style={{ background: color }}
          >
            <input
              type="color"
              className="sr-only"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
          <input
            className="input text-xs flex-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
            autoFocus
            placeholder="Label (required)"
          />
        </div>
        {/* Note */}
        <textarea
          className="input text-xs resize-none w-full"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
          placeholder="Note…"
        />
        {/* Buttons */}
        <div className="flex gap-1">
          <button
            className="btn btn-primary btn-sm flex-1 text-xs"
            onClick={save}
            disabled={!label.trim()}
          >
            Save
          </button>
          <button className="btn btn-ghost btn-sm text-xs" onClick={(e) => { e.stopPropagation(); setEditing(false); }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="border border-surface-200 rounded p-2 flex flex-col gap-1 cursor-pointer hover:border-accent-teal/40 transition-colors"
      onClick={() => navigateToMarker(marker)}
    >
      {/* Line 1: color + label */}
      <div className="flex items-center gap-2">
        <span
          className="w-2.5 h-2.5 rounded-full flex-none"
          style={{ background: marker.color }}
        />
        <span className="text-sm font-semibold flex-1 truncate text-text">{marker.label}</span>
      </div>

      {/* Line 2: timestamp + duration */}
      <div className="flex items-center gap-1.5 pl-[18px]">
        <span className="text-[11px] text-text-subtle font-mono">{timeStr}</span>
        {durationStr && (
          <span className="text-[11px] text-accent-teal font-mono">+{durationStr}</span>
        )}
      </div>

      {/* Line 3: edit + delete */}
      <div className="flex items-center gap-1 pl-[18px]">
        <span
          className="badge text-[10px] flex-none px-1 py-0"
          style={{ background: marker.color + '33', color: marker.color }}
        >
          {isRange ? '⟷ range' : MARKER_LABELS[marker.category]}
        </span>
        <div className="flex-1" />
        <button
          className="btn btn-ghost btn-sm text-xs py-0"
          onClick={startEdit}
        >
          Edit
        </button>
        <button
          className="btn btn-danger btn-sm text-xs py-0"
          onClick={(e) => { e.stopPropagation(); removeMarker(marker.id); }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

export default function MarkersPanel() {
  const { markers, addMarker, lastSampleTs } = useAppStore();
  const [newLabel, setNewLabel] = useState('');
  const [newCategory, setNewCategory] = useState<MarkerCategory>('note');
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState(false);

  const addAtNow = () => {
    if (!newLabel.trim()) {
      setAddError(true);
      return;
    }
    const ts = lastSampleTs ?? Date.now() / 1000;
    addMarker({
      timestamp: ts,
      label: newLabel.trim(),
      note: '',
      category: newCategory,
      color: MARKER_COLORS[newCategory],
    });
    setNewLabel('');
    setAddError(false);
    setShowAdd(false);
  };

  return (
    <div className="panel flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 mb-1">
        <span className="panel-title flex-1">Markers ({markers.length})</span>
        <button
          className={showAdd ? 'btn btn-ghost btn-sm text-xs text-accent-red' : 'btn btn-ghost btn-sm text-xs'}
          onClick={() => { setShowAdd(!showAdd); setAddError(false); }}
        >
          {showAdd ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showAdd && (
        <div className="border border-surface flex flex-col gap-1 rounded p-2 mb-2">
          <input
            className={`input text-xs ${addError ? 'ring-1 ring-accent-red' : ''}`}
            placeholder="Label (required)"
            value={newLabel}
            onChange={(e) => { setNewLabel(e.target.value); if (e.target.value.trim()) setAddError(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') addAtNow(); if (e.key === 'Escape') setShowAdd(false); }}
            autoFocus
          />
          {addError && <span className="text-[10px] text-accent-red">Label is required</span>}
          <select
            className="select text-xs"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as MarkerCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{MARKER_LABELS[c]}</option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" onClick={addAtNow}>
            Add at current time
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto flex flex-col gap-1">
        {markers.length === 0 && !showAdd ? (
          <p className="text-xs text-text-subtle text-center mt-4">
            No markers yet. Pause the chart and drag to select, or press "+ Add".
          </p>
        ) : (
          [...markers]
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((m) => <MarkerRow key={m.id} marker={m} />)
        )}
      </div>
    </div>
  );
}
