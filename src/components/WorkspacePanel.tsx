// src/components/WorkspacePanel.tsx — Save, load, and export

import { useState } from 'react';
import { Save, FolderOpen, Download, Trash2 } from 'lucide-react';
import { useAppStore } from '../store';
import { api, pickSaveCsv, pickSaveJson, pickSaveWorkspace, pickOpenWorkspace } from '../api/tauri';

export default function WorkspacePanel() {
  const { settings, markers, appendStatusLog, loadSamplesFromBackend, setMarkers, setSettings } =
    useAppStore();
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: unknown) {
      appendStatusLog(`Error: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const saveWs = () =>
    run(async () => {
      const path = await pickSaveWorkspace();
      if (!path) return;
      await api.saveWorkspace(path, settings, markers);
      appendStatusLog(`Workspace saved: ${path}`);
    });

  const loadWs = () =>
    run(async () => {
      const path = await pickOpenWorkspace();
      if (!path) return;
      const result = await api.loadWorkspace(path);
      loadSamplesFromBackend(result.timestamps, result.amps);
      setMarkers(result.markers);
      setSettings(result.appSettings);
      appendStatusLog(`Workspace loaded: ${path} (${result.sampleCount} samples)`);
    });

  const exportCsv = () =>
    run(async () => {
      const path = await pickSaveCsv();
      if (!path) return;
      await api.exportCsv(path, settings.voltageV);
      appendStatusLog(`CSV exported: ${path}`);
    });

  const exportJson = () =>
    run(async () => {
      const path = await pickSaveJson();
      if (!path) return;
      await api.exportJson(path, settings.voltageV);
      appendStatusLog(`JSON exported: ${path}`);
    });

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <button className="btn btn-ghost btn-sm text-xs flex items-center gap-1" onClick={saveWs} disabled={busy}>
        <Save size={12} /> Save
      </button>
      <button className="btn btn-ghost btn-sm text-xs flex items-center gap-1" onClick={loadWs} disabled={busy}>
        <FolderOpen size={12} /> Open
      </button>
      <div className="h-4 w-px bg-surface-200" />
      <button className="btn btn-ghost btn-sm text-xs flex items-center gap-1" onClick={exportCsv} disabled={busy}>
        <Download size={12} /> CSV
      </button>
      <button className="btn btn-ghost btn-sm text-xs flex items-center gap-1" onClick={exportJson} disabled={busy}>
        <Download size={12} /> JSON
      </button>
      <div className="h-4 w-px bg-surface-200" />
      <button
        className={`btn btn-sm text-xs flex items-center gap-1 ${confirmClear ? 'btn-danger animate-pulse' : 'btn-danger'}`}
        disabled={busy}
        onClick={() => {
          if (!confirmClear) {
            setConfirmClear(true);
            // Auto-cancel after 3 seconds
            setTimeout(() => setConfirmClear(false), 3000);
            return;
          }
          setConfirmClear(false);
          api.clearSamples().then(() => {
            useAppStore.getState().clearSamples();
            appendStatusLog('Samples cleared');
          });
        }}
      >
        <Trash2 size={12} /> {confirmClear ? 'Confirm?' : 'Clear'}
      </button>
    </div>
  );
}
