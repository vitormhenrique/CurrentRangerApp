// CurrentRanger Desktop App — lib.rs
// Root library crate wired into Tauri.

pub mod commands;
pub mod data;
pub mod export;
pub mod metrics;
pub mod protocol;
pub mod serial;
pub mod workspace;

use commands::*;
use data::SampleStore;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

/// Shared application state managed by Tauri.
pub struct AppState {
    pub serial: Arc<TokioMutex<serial::SerialManager>>,
    /// Arc so the reader thread can push samples directly.
    pub store: Arc<std::sync::Mutex<SampleStore>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging — RUST_LOG env var controls level (defaults to info)
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("CurrentRanger app starting");

    let state = AppState {
        serial: Arc::new(TokioMutex::new(serial::SerialManager::new())),
        store: Arc::new(std::sync::Mutex::new(SampleStore::new())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            list_ports,
            connect_device,
            disconnect_device,
            send_device_command,
            get_samples,
            get_stats,
            clear_samples,
            save_workspace,
            load_workspace,
            export_csv,
            export_json,
            compute_integration,
            compute_battery_runtime,
            compute_required_capacity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
