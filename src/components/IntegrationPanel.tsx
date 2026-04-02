// src/components/IntegrationPanel.tsx — Charge and energy integration

import { useState } from 'react';
import { useAppStore } from '../store';
import { api } from '../api/tauri';
import { formatCurrent, formatDuration } from '../types';

export default function IntegrationPanel() {
  const { settings, setSettings, integrationResult, setIntegrationResult, totalSamples } =
    useAppStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getSamples();
      const result = await api.computeIntegration({
        timestamps: data.timestamps,
        amps: data.amps,
        voltage: settings.voltageV,
      });
      setIntegrationResult(result);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const r = integrationResult;

  return (
    <div className="panel">
      <div className="panel-title">Charge / Energy</div>

      <div className="flex items-center gap-2">
        <label className="text-xs text-text-muted w-16">Voltage</label>
        <input
          type="number"
          className="input text-xs w-20"
          min={0.1}
          max={60}
          step={0.1}
          value={settings.voltageV}
          onChange={(e) => setSettings({ voltageV: Number(e.target.value) })}
        />
        <span className="text-xs text-text-muted">V</span>
      </div>

      <button
        className="btn btn-primary btn-sm"
        onClick={run}
        disabled={loading || totalSamples === 0}
      >
        {loading ? 'Computing…' : 'Compute Integration'}
      </button>

      {error && <p className="text-xs text-accent-red">{error}</p>}

      {r && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <Row label="Duration" value={formatDuration(r.durationS)} />
          <Row label="Avg Current" value={formatCurrent(r.avgAmps)} />
          <Row label="Charge (C)" value={r.chargeCoulombs.toExponential(3)} />
          <Row label="Charge (mAh)" value={r.chargeMah.toFixed(4)} />
          <Row label="Energy (J)" value={r.energyJoules.toExponential(3)} />
          <Row label="Energy (mWh)" value={r.energyMwh.toFixed(4)} />
          <Row label="Samples" value={r.sampleCount.toLocaleString()} />
        </div>
      )}

      <p className="text-xs text-text-subtle leading-tight mt-1">
        Timestamps are host-side. No device-side timing guaranteed.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-text-subtle">{label}</span>
      <span className="font-mono text-text">{value}</span>
    </>
  );
}
