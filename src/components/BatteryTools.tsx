// src/components/BatteryTools.tsx — Runtime and required-capacity estimator

import { useState } from 'react';
import { api } from '../api/tauri';
import { BatteryRuntimeResult, RequiredCapacityResult, formatDuration } from '../types';
import { useAppStore } from '../store';

interface DeratInputs {
  efficiency: number;
  depthOfDischarge: number;
  agingMargin: number;
}

function DeratRow({
  label,
  field,
  inputs,
  setInputs,
}: {
  label: string;
  field: keyof DeratInputs;
  inputs: DeratInputs;
  setInputs: React.Dispatch<React.SetStateAction<DeratInputs>>;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-text-subtle flex-1">{label}</label>
      <input
        type="number"
        className="input text-xs w-16"
        min={1}
        max={100}
        step={1}
        value={Math.round(inputs[field] * 100)}
        onChange={(e) =>
          setInputs((p) => ({ ...p, [field]: Number(e.target.value) / 100 }))
        }
      />
      <span className="text-xs text-text-subtle w-3">%</span>
    </div>
  );
}

export default function BatteryTools() {
  const { viewStats } = useAppStore();
  const [mode, setMode] = useState<'runtime' | 'capacity'>('runtime');
  const [capacityMah, setCapacityMah] = useState(1000);
  const [desiredRuntimeH, setDesiredRuntimeH] = useState(24);
  const [manualCurrentMa, setManualCurrentMa] = useState('');
  const [derat, setDerat] = useState<DeratInputs>({
    efficiency: 1.0,
    depthOfDischarge: 1.0,
    agingMargin: 1.0,
  });
  const [runtimeResult, setRuntimeResult] = useState<BatteryRuntimeResult | null>(null);
  const [capacityResult, setCapacityResult] = useState<RequiredCapacityResult | null>(null);
  const [error, setError] = useState('');

  const avgCurrentAmps = manualCurrentMa
    ? Number(manualCurrentMa) / 1000
    : (viewStats?.avgAmps ?? 0);

  const compute = async () => {
    setError('');
    if (avgCurrentAmps <= 0) {
      setError('Current must be positive. Enter a manual value or capture data first.');
      return;
    }
    try {
      if (mode === 'runtime') {
        const r = await api.computeBatteryRuntime({
          capacityMah,
          avgCurrentAmps,
          ...derat,
        });
        setRuntimeResult(r);
        setCapacityResult(null);
      } else {
        const r = await api.computeRequiredCapacity({
          desiredRuntimeHours: desiredRuntimeH,
          avgCurrentAmps,
          ...derat,
        });
        setCapacityResult(r);
        setRuntimeResult(null);
      }
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  return (
    <div className="panel">
      <div className="panel-title">Battery Tools</div>

      {/* Mode toggle */}
      <div className="flex gap-1">
        <button
          className={`btn btn-sm flex-1 text-xs ${mode === 'runtime' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMode('runtime')}
        >
          Runtime Est.
        </button>
        <button
          className={`btn btn-sm flex-1 text-xs ${mode === 'capacity' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMode('capacity')}
        >
          Capacity Est.
        </button>
      </div>

      {/* Current source */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-text-subtle flex-1">
          Current (mA)
          {viewStats && !manualCurrentMa && (
            <span className="ml-1 text-accent-green">← from chart</span>
          )}
        </label>
        <input
          type="number"
          className="input text-xs w-24"
          placeholder="auto"
          value={manualCurrentMa}
          onChange={(e) => setManualCurrentMa(e.target.value)}
          min={0}
          step={0.001}
        />
      </div>

      {mode === 'runtime' ? (
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-subtle flex-1">Capacity (mAh)</label>
          <input
            type="number"
            className="input text-xs w-24"
            value={capacityMah}
            min={1}
            step={10}
            onChange={(e) => setCapacityMah(Number(e.target.value))}
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-subtle flex-1">Runtime (h)</label>
          <input
            type="number"
            className="input text-xs w-24"
            value={desiredRuntimeH}
            min={0.01}
            step={1}
            onChange={(e) => setDesiredRuntimeH(Number(e.target.value))}
          />
        </div>
      )}

      {/* Derating */}
      <details className="text-xs">
        <summary className="cursor-pointer text-text-muted">Derating factors</summary>
        <div className="mt-1 flex flex-col gap-1">
          <DeratRow label="Efficiency" field="efficiency" inputs={derat} setInputs={setDerat} />
          <DeratRow
            label="Depth of Discharge"
            field="depthOfDischarge"
            inputs={derat}
            setInputs={setDerat}
          />
          <DeratRow label="Aging Margin" field="agingMargin" inputs={derat} setInputs={setDerat} />
        </div>
      </details>

      <button className="btn btn-primary btn-sm" onClick={compute}>
        Estimate
      </button>

      {error && <p className="text-xs text-accent-red">{error}</p>}

      {runtimeResult && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs mt-1">
          <span className="text-text-subtle">Runtime</span>
          <span className="font-mono font-bold text-accent-green">
            {formatDuration(runtimeResult.runtimeSeconds)}
          </span>
          <span className="text-text-subtle">Eff. capacity</span>
          <span className="font-mono">{runtimeResult.effectiveCapacityMah.toFixed(1)} mAh</span>
          <span className="text-text-subtle">Eff. current</span>
          <span className="font-mono">{runtimeResult.effectiveCurrentMa.toFixed(3)} mA</span>
        </div>
      )}

      {capacityResult && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs mt-1">
          <span className="text-text-subtle">Required rated</span>
          <span className="font-mono font-bold text-accent-green">
            {capacityResult.ratedCapacityMah.toFixed(1)} mAh
          </span>
          <span className="text-text-subtle">Required net</span>
          <span className="font-mono">{capacityResult.requiredCapacityMah.toFixed(1)} mAh</span>
        </div>
      )}
    </div>
  );
}
