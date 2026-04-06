// src/components/AppSettings.tsx — General application settings screen

import { useAppStore } from '../store';
import clsx from 'clsx';

// ─── helpers (same pattern as DeviceConfig) ─────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {subtitle && <p className="text-xs text-text-subtle mt-0.5">{subtitle}</p>}
    </div>
  );
}

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-surface-200 last:border-0">
      <div>
        <div className="text-sm text-text">{label}</div>
        {description && <div className="text-xs text-text-subtle mt-0.5 max-w-xs">{description}</div>}
      </div>
      <div className="flex items-center gap-2 flex-none ml-4">{children}</div>
    </div>
  );
}

function ToggleButton({
  active,
  onLabel = 'ON',
  offLabel = 'OFF',
  onClick,
}: {
  active: boolean;
  onLabel?: string;
  offLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        'btn btn-sm min-w-[56px]',
        active ? 'btn-success' : 'btn-ghost',
      )}
      onClick={onClick}
    >
      {active ? onLabel : offLabel}
    </button>
  );
}

// ─── main component ─────────────────────────────────────────────────────────

export default function AppSettings() {
  const { settings, setSettings } = useAppStore();

  return (
    <div className="h-full overflow-y-auto px-6 py-5 flex flex-col gap-6 w-full">
      {/* Page header */}
      <div>
        <h1 className="text-lg font-bold text-text">Application Settings</h1>
        <p className="text-xs text-text-subtle mt-0.5">
          General settings for the desktop application. These do not affect the device.
        </p>
      </div>

      {/* Chart section */}
      <div className="panel">
        <SectionHeader
          title="Chart"
          subtitle="Configure chart display and data visualization"
        />
        <Row
          label="Hide non-measurement time"
          description="Compress out idle gaps between acquisition segments so they appear stitched together. Gap positions are shown as indicators on the chart."
        >
          <ToggleButton
            active={settings.hideDeadTime}
            onClick={() => setSettings({ hideDeadTime: !settings.hideDeadTime })}
          />
        </Row>
      </div>
    </div>
  );
}
