// src/components/MarkersPanel.tsx — Marker list, add, edit, delete

import { useState } from 'react';
import { useAppStore } from '../store';
import {
  Marker,
  MarkerCategory,
  MARKER_COLORS,
  MARKER_LABELS,
} from '../types';

const CATEGORIES: MarkerCategory[] = [
  'note', 'boot', 'idle', 'sleep', 'radioTx', 'sensorSample', 'custom',
];

function MarkerRow({ marker }: { marker: Marker }) {
  const { updateMarker, removeMarker } = useAppStore();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(marker.label);
  const [note, setNote] = useState(marker.note);

  const save = () => {
    updateMarker(marker.id, { label, note });
    setEditing(false);
  };

  const ts = new Date(marker.timestamp * 1000);
  const timeStr = ts.toISOString().substr(11, 12);

  return (
    <div className="border border-surface-200 rounded p-2 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {/* Color swatch */}
        <span
          className="w-2.5 h-2.5 rounded-full flex-none"
          style={{ background: marker.color }}
        />
        {editing ? (
          <input
            className="input text-xs flex-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            autoFocus
          />
        ) : (
          <span className="text-xs font-medium flex-1 truncate">{marker.label}</span>
        )}
        <span className="text-xs text-text-subtle font-mono flex-none">{timeStr}</span>
      </div>

      {editing ? (
        <>
          <textarea
            className="input text-xs resize-none"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note…"
          />
          <div className="flex gap-1">
            <button className="btn btn-primary btn-sm flex-1" onClick={save}>Save</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          {marker.note && (
            <p className="text-xs text-text-muted leading-tight">{marker.note}</p>
          )}
          <div className="flex gap-1">
            <span
              className="badge text-xs flex-none"
              style={{ background: marker.color + '33', color: marker.color }}
            >
              {MARKER_LABELS[marker.category]}
            </span>
            <div className="flex-1" />
            <button
              className="btn btn-ghost btn-sm text-xs"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              className="btn btn-danger btn-sm text-xs"
              onClick={() => removeMarker(marker.id)}
            >
              ×
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function MarkersPanel() {
  const { markers, addMarker, lastSampleTs } = useAppStore();
  const [newLabel, setNewLabel] = useState('');
  const [newCategory, setNewCategory] = useState<MarkerCategory>('note');
  const [showAdd, setShowAdd] = useState(false);

  const addAtNow = () => {
    const ts = lastSampleTs ?? Date.now() / 1000;
    addMarker({
      timestamp: ts,
      label: newLabel || MARKER_LABELS[newCategory],
      note: '',
      category: newCategory,
      color: MARKER_COLORS[newCategory],
    });
    setNewLabel('');
    setShowAdd(false);
  };

  return (
    <div className="panel flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 mb-1">
        <span className="panel-title flex-1">Markers ({markers.length})</span>
        <button
          className="btn btn-ghost btn-sm text-xs"
          onClick={() => setShowAdd(!showAdd)}
        >
          + Add
        </button>
      </div>

      {showAdd && (
        <div className="border border-surface flex flex-col gap-1 rounded p-2 mb-2">
          <input
            className="input text-xs"
            placeholder="Label…"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
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
        {markers.length === 0 ? (
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
