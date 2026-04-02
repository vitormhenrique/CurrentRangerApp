// serial/mod.rs — Serial port discovery, connection management, and reading.
//
// # Design
// SerialManager owns the connection state. When connected, it spawns a
// tokio task that reads lines from the port and emits Tauri events.
//
// # USB Logging Bootstrap
// The firmware defaults USB logging to OFF. On connect, we send 'u' to
// toggle it. If it was already ON from a previous session, that turns it
// OFF. We wait briefly for data; if none arrives, everything is fine (it's
// now ON). If nothing came but we already saw it disable itself, we send
// 'u' again. This matches the Python GUI reference implementation.
//
// # Thread Safety
// The actual port I/O runs in a tokio task; we communicate back via Tauri's
// app handle event emitter. The task is cancelled by dropping the
// JoinHandle or via a cancellation channel.

use crate::data::{Sample, SampleStore};
use crate::protocol::{self, DeviceStatus, LoggingFormat, ParsedLine, StatusUpdate};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, mpsc, watch};

pub const DEFAULT_BAUD: u32 = 230400;

// ─────────────────────────────────────────────────────────────────────────────
// Port info (sent to frontend)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub description: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

/// Enumerate available serial ports.
pub fn list_serial_ports() -> Vec<PortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let (desc, vid, pid) = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => (
                    info.product.clone().unwrap_or_default(),
                    Some(info.vid),
                    Some(info.pid),
                ),
                _ => (String::new(), None, None),
            };
            PortInfo {
                name: p.port_name,
                description: desc,
                vid,
                pid,
            }
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection state
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub state: ConnectionState,
    pub port: Option<String>,
    pub baud: Option<u32>,
    pub error: Option<String>,
    pub last_sample_ts: Option<f64>,
    pub sample_count: u64,
    pub device_status: DeviceStatus,
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands sent to the reader task
// ─────────────────────────────────────────────────────────────────────────────

pub enum ReaderCommand {
    /// Send a raw byte to the device (single char command)
    Send(u8),
    /// Stop the reader task
    Stop,
}

// ─────────────────────────────────────────────────────────────────────────────
// SerialManager
// ─────────────────────────────────────────────────────────────────────────────

pub struct SerialManager {
    pub status: ConnectionStatus,
    /// Channel to send commands into the reader task
    cmd_tx: Option<mpsc::Sender<ReaderCommand>>,
    /// Watch channel for logging format (shared with reader task)
    format_tx: Option<watch::Sender<LoggingFormat>>,
    reader_handle: Option<tokio::task::JoinHandle<()>>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            status: ConnectionStatus {
                state: ConnectionState::Disconnected,
                port: None,
                baud: None,
                error: None,
                last_sample_ts: None,
                sample_count: 0,
                device_status: DeviceStatus::default(),
            },
            cmd_tx: None,
            format_tx: None,
            reader_handle: None,
        }
    }

    /// Attempt to connect to `port_name` at `baud`.
    /// Returns error string on failure (does not panic).
    pub async fn connect(
        &mut self,
        port_name: String,
        baud: u32,
        app: AppHandle,
        store: Arc<Mutex<SampleStore>>,
    ) -> Result<(), String> {
        if self.status.state == ConnectionState::Connected {
            self.disconnect().await;
        }

        self.status.state = ConnectionState::Connecting;
        self.status.port = Some(port_name.clone());
        self.status.baud = Some(baud);
        self.status.error = None;
        self.emit_status(&app);

        // Open port — use a blocking call in a spawn_blocking to avoid blocking the async executor
        let port_name_clone = port_name.clone();
        let port_result = tokio::task::spawn_blocking(move || {
            serialport::new(&port_name_clone, baud)
                .timeout(Duration::from_millis(50))
                .open()
        })
        .await;

        let port = match port_result {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => {
                let msg = format!("Failed to open {}: {}", port_name, e);
                self.status.state = ConnectionState::Error;
                self.status.error = Some(msg.clone());
                self.emit_status(&app);
                return Err(msg);
            }
            Err(e) => {
                let msg = format!("Spawn error: {}", e);
                self.status.state = ConnectionState::Error;
                self.status.error = Some(msg.clone());
                self.emit_status(&app);
                return Err(msg);
            }
        };

        let (cmd_tx, cmd_rx) = mpsc::channel::<ReaderCommand>(64);
        let (format_tx, format_rx) = watch::channel(LoggingFormat::default());

        self.cmd_tx = Some(cmd_tx.clone());
        self.format_tx = Some(format_tx);
        self.status.state = ConnectionState::Connected;
        self.emit_status(&app);

        // Spawn the reader task
        let app_clone = app.clone();
        let handle = tokio::spawn(reader_task(port, cmd_rx, format_rx, app_clone, store));
        self.reader_handle = Some(handle);

        // Bootstrap: enable USB logging
        let _ = cmd_tx.send(ReaderCommand::Send(b'u')).await;

        Ok(())
    }

    /// Disconnect gracefully.
    pub async fn disconnect(&mut self) {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(ReaderCommand::Stop).await;
        }
        if let Some(h) = self.reader_handle.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
        }
        self.status.state = ConnectionState::Disconnected;
        self.status.port = None;
        self.status.baud = None;
    }

    /// Send a single-char command to the device.
    pub async fn send_command(&self, cmd: u8) -> Result<(), String> {
        if let Some(tx) = &self.cmd_tx {
            tx.send(ReaderCommand::Send(cmd))
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Not connected".to_string())
        }
    }

    fn emit_status(&self, app: &AppHandle) {
        let _ = app.emit("serial:status", &self.status);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader task (runs in tokio background)
// ─────────────────────────────────────────────────────────────────────────────

/// Long-running task that reads lines from the serial port and emits events.
async fn reader_task(
    mut port: Box<dyn serialport::SerialPort>,
    mut cmd_rx: mpsc::Receiver<ReaderCommand>,
    mut format_rx: watch::Receiver<LoggingFormat>,
    app: AppHandle,
    store: Arc<Mutex<SampleStore>>,
) {
    let mut buf = String::new();
    let mut byte_buf = [0u8; 512];
    let mut device_status = DeviceStatus::default();
    let mut sample_count: u64 = 0;
    let mut current_format = *format_rx.borrow();

    loop {
        // Check for incoming commands (non-blocking)
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                ReaderCommand::Send(b) => {
                    if let Err(e) = port.write_all(&[b]) {
                        log::warn!("Serial write error: {}", e);
                    }
                }
                ReaderCommand::Stop => {
                    log::info!("Reader task stopping");
                    return;
                }
            }
        }

        // Check for format change
        if format_rx.has_changed().unwrap_or(false) {
            current_format = *format_rx.borrow_and_update();
        }

        // Read available bytes
        match port.read(&mut byte_buf) {
            Ok(0) => {}
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&byte_buf[..n]);
                buf.push_str(&chunk);

                // Process complete lines
                while let Some(nl) = buf.find('\n') {
                    let line = buf[..nl].trim_end_matches('\r').to_string();
                    buf.drain(..=nl);

                    let parsed = protocol::parse_line(&line, current_format);

                    match &parsed {
                        ParsedLine::Sample { amps } => {
                            let sample = Sample::new(*amps);
                            sample_count += 1;

                            // Store in Rust-side ring buffer
                            {
                                let mut s = store.lock().await;
                                s.push(sample.clone());
                            }

                            let _ = app.emit("serial:sample", &sample);

                            // Emit periodic count update
                            if sample_count % 100 == 0 {
                                let _ = app.emit("serial:sample_count", sample_count);
                            }
                        }
                        ParsedLine::StatusUpdate { update } => {
                            apply_status_update(&mut device_status, update);
                            let _ = app.emit("serial:device_status", &device_status);
                            let _ = app.emit("serial:status_message", &line);
                        }
                        ParsedLine::Info { message } => {
                            let _ = app.emit("serial:info", message);
                        }
                        ParsedLine::Unknown { raw } if !raw.is_empty() => {
                            // Only log non-empty unknowns for debugging
                            let _ = app.emit("serial:unknown", raw);
                        }
                        _ => {}
                    }
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                // Normal — no data right now
            }
            Err(e) => {
                log::error!("Serial read error: {}", e);
                let _ = app.emit(
                    "serial:error",
                    format!("Serial read error: {}", e),
                );
                return;
            }
        }

        // Yield briefly to not spin at 100% CPU
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

/// Apply a status update to the device status snapshot.
fn apply_status_update(status: &mut DeviceStatus, update: &StatusUpdate) {
    match update {
        StatusUpdate::UsbLogging { enabled } => status.usb_logging = Some(*enabled),
        StatusUpdate::BtLogging { enabled } => status.bt_logging = Some(*enabled),
        StatusUpdate::LoggingFormat { format } => status.logging_format = Some(*format),
        StatusUpdate::AdcSamplingSpeed { speed } => status.adc_sampling_speed = Some(*speed),
        StatusUpdate::AutoOff { mode } => status.auto_off = Some(*mode),
        StatusUpdate::GpioRanging { enabled } => status.gpio_ranging_enabled = Some(*enabled),
        StatusUpdate::TouchDebug { .. } => {}
        StatusUpdate::SettingsReset => {
            status.usb_logging = Some(false);
            status.logging_format = Some(LoggingFormat::Exponent);
        }
        StatusUpdate::FirmwareVersion { version } => {
            status.firmware_version = Some(version.clone())
        }
        StatusUpdate::AdcOffset { value } => status.adc_offset = Some(*value),
        StatusUpdate::AdcGain { value } => status.adc_gain = Some(*value),
        StatusUpdate::LdoVoltage { value } => status.ldo_voltage = Some(*value),
    }
}
