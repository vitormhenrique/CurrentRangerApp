// commands/mod.rs — Tauri command handlers bridging frontend ↔ Rust backend.

use crate::data::{Marker, SampleStats};
use crate::metrics::{
    BatteryRuntimeInput, BatteryRuntimeResult, IntegrationInput, IntegrationResult,
    RequiredCapacityInput, RequiredCapacityResult,
};
use crate::serial::{self, PortInfo};
use crate::workspace::{AppSettings, SessionData, Workspace};
use crate::AppState;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, State};

// ─────────────────────────────────────────────────────────────────────────────
// Port discovery
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_ports() -> Vec<PortInfo> {
    serial::list_serial_ports()
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn connect_device(
    port: String,
    baud: Option<u32>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let baud = baud.unwrap_or(serial::DEFAULT_BAUD);
    let store_arc = state.store.clone();
    let mut mgr = state.serial.lock().await;
    mgr.connect(port, baud, app, store_arc).await
}

#[tauri::command]
pub async fn disconnect_device(state: State<'_, AppState>) -> Result<(), String> {
    let mut mgr = state.serial.lock().await;
    mgr.disconnect().await;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Device commands
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCommandRequest {
    /// Single ASCII character command (e.g. "u", "f", "1")
    pub command: String,
}

#[tauri::command]
pub async fn send_device_command(
    request: DeviceCommandRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ch = request
        .command
        .chars()
        .next()
        .ok_or_else(|| "Empty command".to_string())?;
    if !ch.is_ascii() {
        return Err("Only ASCII commands supported".to_string());
    }
    let mgr = state.serial.lock().await;
    mgr.send_command(ch as u8).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample data
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleBatchResponse {
    pub timestamps: Vec<f64>,
    pub amps: Vec<f64>,
    pub total: usize,
}

/// Return all samples. This is a bulk pull — real-time delivery uses events.
#[tauri::command]
pub async fn get_samples(state: State<'_, AppState>) -> Result<SampleBatchResponse, String> {
    let store = state.store.lock().await;
    Ok(SampleBatchResponse {
        timestamps: store.timestamps.clone(),
        amps: store.amps.clone(),
        total: store.total_pushed,
    })
}

#[tauri::command]
pub async fn get_stats(
    t_start: Option<f64>,
    t_end: Option<f64>,
    state: State<'_, AppState>,
) -> Result<SampleStats, String> {
    let store = state.store.lock().await;
    Ok(match (t_start, t_end) {
        (Some(t0), Some(t1)) => store.stats_window(t0, t1),
        _ => store.stats(),
    })
}

#[tauri::command]
pub async fn clear_samples(state: State<'_, AppState>) -> Result<(), String> {
    let mut store = state.store.lock().await;
    store.clear();
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceRequest {
    pub path: String,
    pub app_settings: AppSettings,
    pub markers: Vec<Marker>,
}

#[tauri::command]
pub async fn save_workspace(
    request: SaveWorkspaceRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let store = state.store.lock().await;
    let mgr = state.serial.lock().await;

    let samples: Vec<crate::workspace::SampleRecord> = store
        .timestamps
        .iter()
        .zip(store.amps.iter())
        .map(|(&t, &a)| crate::workspace::SampleRecord { t, a })
        .collect();

    let ws = Workspace {
        schema_version: crate::workspace::CURRENT_SCHEMA_VERSION,
        saved_at: Utc::now().to_rfc3339(),
        app_settings: request.app_settings,
        session: SessionData {
            samples,
            markers: request.markers,
            device_status: mgr.status.device_status.clone(),
            stats: Some(store.stats()),
        },
    };

    let path = PathBuf::from(&request.path);
    crate::workspace::save_workspace(&ws, &path).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceResponse {
    pub app_settings: AppSettings,
    pub markers: Vec<Marker>,
    pub sample_count: usize,
    pub timestamps: Vec<f64>,
    pub amps: Vec<f64>,
}

#[tauri::command]
pub async fn load_workspace(
    path: String,
    state: State<'_, AppState>,
) -> Result<LoadWorkspaceResponse, String> {
    let p = PathBuf::from(&path);
    let ws = crate::workspace::load_workspace(&p).map_err(|e| e.to_string())?;

    let timestamps: Vec<f64> = ws.session.samples.iter().map(|s| s.t).collect();
    let amps: Vec<f64> = ws.session.samples.iter().map(|s| s.a).collect();
    let sample_count = timestamps.len();

    // Load samples into store
    {
        let mut store = state.store.lock().await;
        store.clear();
        for (&t, &a) in timestamps.iter().zip(amps.iter()) {
            store.timestamps.push(t);
            store.amps.push(a);
            store.total_pushed += 1;
        }
        store.markers = ws.session.markers.clone();
    }

    Ok(LoadWorkspaceResponse {
        app_settings: ws.app_settings,
        markers: ws.session.markers,
        sample_count,
        timestamps,
        amps,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn export_csv(
    path: String,
    voltage_v: Option<f64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let store = state.store.lock().await;
    let samples: Vec<crate::workspace::SampleRecord> = store
        .timestamps
        .iter()
        .zip(store.amps.iter())
        .map(|(&t, &a)| crate::workspace::SampleRecord { t, a })
        .collect();
    let p = PathBuf::from(&path);
    crate::export::export_csv(&samples, &p, voltage_v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_json(
    path: String,
    voltage_v: Option<f64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let store = state.store.lock().await;
    let samples: Vec<crate::workspace::SampleRecord> = store
        .timestamps
        .iter()
        .zip(store.amps.iter())
        .map(|(&t, &a)| crate::workspace::SampleRecord { t, a })
        .collect();
    let p = PathBuf::from(&path);
    crate::export::export_json(&samples, &store.markers, &p, voltage_v)
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration & battery math
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn compute_integration(input: IntegrationInput) -> IntegrationResult {
    crate::metrics::integrate(&input)
}

#[tauri::command]
pub async fn compute_battery_runtime(
    input: BatteryRuntimeInput,
) -> Result<BatteryRuntimeResult, String> {
    crate::metrics::estimate_runtime(&input)
}

#[tauri::command]
pub async fn compute_required_capacity(
    input: RequiredCapacityInput,
) -> Result<RequiredCapacityResult, String> {
    crate::metrics::estimate_required_capacity(&input)
}
