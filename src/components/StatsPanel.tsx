// src/components/StatsPanel.tsx — Live stats and selection stats

import { useAppStore } from '../store';
import { formatCurrent, formatDuration } from '../types';

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="stat-label">{label}</span>
      <span className="stat-value font-mono">{value}</span>
    </div>
  );
}

export default function StatsPanel() {
  const { viewStats, selectionStats, totalSamples } = useAppStore();

  return (
    <div className="flex gap-3 flex-shrink-0">
      {/* Live window stats */}
      <div className="panel flex-1">
        <div className="panel-title">Window</div>
        <div className="grid grid-cols-4 gap-3">
          <StatItem
            label="Current"
            value={viewStats ? formatCurrent(viewStats.avgAmps) : '—'}
          />
          <StatItem
            label="Peak"
            value={viewStats ? formatCurrent(viewStats.maxAmps) : '—'}
          />
          <StatItem
            label="Min"
            value={viewStats ? formatCurrent(viewStats.minAmps) : '—'}
          />
          <StatItem
            label="Rate"
            value={viewStats ? `${viewStats.rateHz.toFixed(0)} Hz` : '—'}
          />
          <StatItem
            label="Samples"
            value={viewStats ? viewStats.count.toLocaleString() : '—'}
          />
          <StatItem
            label="Duration"
            value={viewStats ? formatDuration(viewStats.durationS) : '—'}
          />
          <StatItem
            label="Total"
            value={totalSamples.toLocaleString()}
          />
        </div>
      </div>

      {/* Selection stats */}
      <div className="panel flex-1">
        <div className="panel-title">Selection</div>
        {selectionStats ? (
          <div className="grid grid-cols-4 gap-3">
            <StatItem label="Avg" value={formatCurrent(selectionStats.avgAmps)} />
            <StatItem label="Peak" value={formatCurrent(selectionStats.maxAmps)} />
            <StatItem label="Min" value={formatCurrent(selectionStats.minAmps)} />
            <StatItem label="Duration" value={formatDuration(selectionStats.durationS)} />
            <StatItem label="Samples" value={selectionStats.count.toLocaleString()} />
            <StatItem label="Rate" value={`${selectionStats.rateHz.toFixed(0)} Hz`} />
          </div>
        ) : (
          <p className="text-xs text-text-subtle">
            Drag on the chart to select a region.
          </p>
        )}
      </div>
    </div>
  );
}
