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
    log::debug!("list_ports: enumerating serial ports");
    let ports = serial::list_serial_ports();
    log::info!("list_ports: found {} port(s)", ports.len());
    for p in &ports {
        log::debug!("  port: {} desc={:?} vid={:?} pid={:?}", p.name, p.description, p.vid, p.pid);
    }
    ports
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
    log::info!("connect_device: port={}, baud={}", port, baud);
    let store_arc = state.store.clone();
    let mut mgr = state.serial.lock().await;
    let result = mgr.connect(port.clone(), baud, app, store_arc).await;
    match &result {
        Ok(()) => log::info!("connect_device: connected to {} successfully", port),
        Err(e) => log::error!("connect_device: failed to connect to {}: {}", port, e),
    }
    result
}

#[tauri::command]
pub async fn disconnect_device(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    log::info!("disconnect_device: disconnecting");
    let mut mgr = state.serial.lock().await;
    mgr.disconnect_and_emit(&app).await;
    log::info!("disconnect_device: done");
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
    log::debug!("send_device_command: {:?}", request.command);
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
    let store = state.store.lock().unwrap();
    log::debug!("get_samples: returning {} samples", store.total_pushed);
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
    let store = state.store.lock().unwrap();
    log::debug!("get_stats: t_start={:?}, t_end={:?}", t_start, t_end);
    Ok(match (t_start, t_end) {
        (Some(t0), Some(t1)) => store.stats_window(t0, t1),
        _ => store.stats(),
    })
}

#[tauri::command]
pub async fn clear_samples(state: State<'_, AppState>) -> Result<(), String> {
    log::info!("clear_samples: clearing all stored samples");
    let mut store = state.store.lock().unwrap();
    store.clear();
    Ok(())
}

#[tauri::command]
pub async fn mark_new_acquisition(state: State<'_, AppState>) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    if let Some(&last_ts) = store.timestamps.last() {
        store.timestamps.push(last_ts + 0.0001);
        store.amps.push(f64::NAN);
        store.total_pushed += 1;
        log::debug!("mark_new_acquisition: inserted NaN gap sentinel after ts={}", last_ts);
    }
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
    log::info!("save_workspace: path={}, markers={}", request.path, request.markers.len());
    // Lock store briefly (std Mutex — don't hold across await)
    let (samples, stats) = {
        let store = state.store.lock().unwrap();
        let samples: Vec<crate::workspace::SampleRecord> = store
            .timestamps
            .iter()
            .zip(store.amps.iter())
            .map(|(&t, &a)| crate::workspace::SampleRecord { t, a })
            .collect();
        let stats = store.stats();
        (samples, stats)
    };
    log::debug!("save_workspace: {} samples to save", samples.len());
    let mgr = state.serial.lock().await;

    let ws = Workspace {
        schema_version: crate::workspace::CURRENT_SCHEMA_VERSION,
        saved_at: Utc::now().to_rfc3339(),
        app_settings: request.app_settings,
        session: SessionData {
            samples,
            markers: request.markers,
            device_status: mgr.status.device_status.clone(),
            stats: Some(stats),
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
    log::info!("load_workspace: path={}", path);
    let p = PathBuf::from(&path);
    let ws = crate::workspace::load_workspace(&p).map_err(|e| e.to_string())?;

    let timestamps: Vec<f64> = ws.session.samples.iter().map(|s| s.t).collect();
    let amps: Vec<f64> = ws.session.samples.iter().map(|s| s.a).collect();
    let sample_count = timestamps.len();
    log::info!("load_workspace: loaded {} samples, {} markers", sample_count, ws.session.markers.len());

    // Load samples into store
    {
        let mut store = state.store.lock().unwrap();
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
    log::info!("export_csv: path={}, voltage={:?}", path, voltage_v);
    let store = state.store.lock().unwrap();
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
    log::info!("export_json: path={}, voltage={:?}", path, voltage_v);
    let store = state.store.lock().unwrap();
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
    log::debug!("compute_integration: {} samples, voltage={}", input.timestamps.len(), input.voltage);
    crate::metrics::integrate(&input)
}

#[tauri::command]
pub async fn compute_battery_runtime(
    input: BatteryRuntimeInput,
) -> Result<BatteryRuntimeResult, String> {
    log::debug!("compute_battery_runtime: capacity={}mAh, current={}A", input.capacity_mah, input.avg_current_amps);
    crate::metrics::estimate_runtime(&input)
}

#[tauri::command]
pub async fn compute_required_capacity(
    input: RequiredCapacityInput,
) -> Result<RequiredCapacityResult, String> {
    log::debug!("compute_required_capacity: runtime={}h, current={}A", input.desired_runtime_hours, input.avg_current_amps);
    crate::metrics::estimate_required_capacity(&input)
}
