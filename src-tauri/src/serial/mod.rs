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
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

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
/// Path where the cr-mock binary advertises its PTY slave path.
const MOCK_PORT_FILE: &str = "/tmp/cr-mock.port";

pub fn list_serial_ports() -> Vec<PortInfo> {
    log::debug!("list_serial_ports: enumerating OS serial ports");
    let mut ports: Vec<PortInfo> = serialport::available_ports()
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
        .collect();

    // Inject the mock PTY if cr-mock is running (it writes its slave path here).
    if let Ok(path) = std::fs::read_to_string(MOCK_PORT_FILE) {
        let path = path.trim().to_string();
        if !path.is_empty() && std::path::Path::new(&path).exists() {
            // Only add if not already present (avoids duplicates on real ports).
            if !ports.iter().any(|p| p.name == path) {
                log::info!("Mock device detected at {}", path);
                ports.insert(0, PortInfo {
                    name: path,
                    description: "CurrentRanger Mock".to_string(),
                    vid: None,
                    pid: None,
                });
            }
        }
    }

    ports
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection state
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

// ── PTY-aware port opening ────────────────────────────────────────────────────

/// Returns true for PTY slave device paths that the `serialport` crate cannot
/// open on macOS because IOSSIOSPEED (IOKit baud-rate ioctl) is unsupported.
///   macOS: /dev/ttysN   (N = one or more digits, no dot)
///   Linux: /dev/pts/N
fn is_pty_slave_path(path: &str) -> bool {
    let bare = path.trim_start_matches("/dev/");
    // macOS pseudo-terminals: ttys0, ttys12, …
    let is_mac_pty = bare.starts_with("ttys")
        && bare.len() > 4
        && bare[4..].chars().all(|c| c.is_ascii_digit());
    // Linux devpts: pts/0, pts/12, …
    let is_linux_pty = bare.starts_with("pts/")
        && bare[4..].chars().all(|c| c.is_ascii_digit());
    is_mac_pty || is_linux_pty
}

/// Open a PTY slave without using the IOSSIOSPEED ioctl.
/// We open the fd with libc, configure raw termios, then wrap it with
/// `serialport::TTYPort::from_raw_fd` which performs no additional ioctls.
#[cfg(unix)]
fn open_pty_slave(path: &str) -> Result<Box<dyn serialport::SerialPort>, String> {
    use std::os::unix::io::FromRawFd;

    let path_c = std::ffi::CString::new(path)
        .map_err(|e| format!("Invalid path {path}: {e}"))?;

    let fd = unsafe {
        libc::open(
            path_c.as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(format!(
            "Failed to open PTY {path}: {}",
            std::io::Error::last_os_error()
        ));
    }

    // Configure raw termios — baud rate is ignored by PTYs but must be valid.
    unsafe {
        let mut tios: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut tios) == 0 {
            libc::cfmakeraw(&mut tios);
            // B115200 is widely supported; PTY ignores the actual rate.
            libc::cfsetispeed(&mut tios, libc::B115200);
            libc::cfsetospeed(&mut tios, libc::B115200);
            libc::tcsetattr(fd, libc::TCSANOW, &tios);
        }

        // Clear O_NONBLOCK so reads block with timeout instead of busy-looping.
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags >= 0 {
            libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK);
            log::debug!("open_pty_slave: cleared O_NONBLOCK on fd {}", fd);
        }
    }

    // from_raw_fd wraps the fd without calling TIOCEXCL or IOSSIOSPEED.
    let mut port = unsafe { serialport::TTYPort::from_raw_fd(fd) };
    // Set a 100ms read timeout so the reader thread checks its command channel regularly.
    use serialport::SerialPort;
    if let Err(e) = port.set_timeout(Duration::from_millis(100)) {
        log::warn!("open_pty_slave: failed to set timeout: {}", e);
    }
    Ok(Box::new(port))
}

#[cfg(not(unix))]
fn open_pty_slave(path: &str) -> Result<Box<dyn serialport::SerialPort>, String> {
    Err(format!("PTY connections are not supported on this platform ({path})"))
}

pub struct SerialManager {
    pub status: ConnectionStatus,
    /// Channel to send commands into the reader thread
    cmd_tx: Option<std::sync::mpsc::Sender<ReaderCommand>>,
    /// Watch channel for logging format (shared with reader thread)
    format_tx: Option<watch::Sender<LoggingFormat>>,
    reader_handle: Option<std::thread::JoinHandle<()>>,
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
        store: Arc<std::sync::Mutex<SampleStore>>,
    ) -> Result<(), String> {
        log::info!("SerialManager::connect: port={}, baud={}", port_name, baud);
        if self.status.state == ConnectionState::Connected {
            log::info!("SerialManager::connect: already connected, disconnecting first");
            self.disconnect().await;
        }

        self.status.state = ConnectionState::Connecting;
        self.status.port = Some(port_name.clone());
        self.status.baud = Some(baud);
        self.status.error = None;
        log::debug!("SerialManager::connect: state → Connecting");
        self.emit_status(&app);

        // On macOS, prefer /dev/cu.* over /dev/tty.* to avoid blocking on DCD.
        // PTY slave paths (/dev/ttysN on macOS, /dev/pts/N on Linux) must NOT be
        // rewritten — they are not dot-separated and have no /dev/cu.* equivalent.
        let is_pty = is_pty_slave_path(&port_name);
        let port_name_adjusted = if cfg!(target_os = "macos")
            && port_name.contains("/dev/tty.")
            && !is_pty
        {
            let adjusted = port_name.replace("/dev/tty.", "/dev/cu.");
            log::info!("SerialManager::connect: macOS path rewrite {} → {}", port_name, adjusted);
            adjusted
        } else {
            if is_pty {
                log::info!("SerialManager::connect: PTY slave path detected: {}", port_name);
            }
            port_name.clone()
        };

        // PTY slaves (created by cr-mock) can't use serialport::open() because macOS
        // uses the IOSSIOSPEED IOKit ioctl to set the baud rate, which PTY slaves
        // don't support and returns ENOTTY ("not a typewriter").
        // For PTY paths we open the fd manually and wrap it with TTYPort::from_raw_fd,
        // which skips all IOKit ioctls and uses only standard POSIX termios.
        let open_result: Result<Box<dyn serialport::SerialPort>, String> =
            if is_pty_slave_path(&port_name_adjusted) {
                log::debug!("SerialManager::connect: opening PTY slave via raw fd");
                open_pty_slave(&port_name_adjusted)
            } else {
                log::debug!("SerialManager::connect: opening serial port via serialport crate");
                let port_name_clone = port_name_adjusted.clone();
                let r = tokio::task::spawn_blocking(move || {
                    serialport::new(&port_name_clone, baud)
                        .timeout(Duration::from_millis(100))
                        .data_bits(serialport::DataBits::Eight)
                        .stop_bits(serialport::StopBits::One)
                        .parity(serialport::Parity::None)
                        .flow_control(serialport::FlowControl::None)
                        .open()
                })
                .await;
                match r {
                    Ok(Ok(p))  => Ok(p),
                    Ok(Err(e)) => Err(format!("Failed to open {}: {}", port_name, e)),
                    Err(e)     => Err(format!("Spawn error: {}", e)),
                }
            };

        let port = match open_result {
            Ok(p) => {
                log::info!("SerialManager::connect: port opened successfully");
                p
            }
            Err(msg) => {
                log::error!("SerialManager::connect: failed to open port: {}", msg);
                self.status.state = ConnectionState::Error;
                self.status.error = Some(msg.clone());
                self.emit_status(&app);
                return Err(msg);
            }
        };

        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<ReaderCommand>();
        let (format_tx, format_rx) = watch::channel(LoggingFormat::default());

        self.cmd_tx = Some(cmd_tx);
        self.format_tx = Some(format_tx);
        self.status.state = ConnectionState::Connected;
        log::info!("SerialManager::connect: state → Connected, spawning reader thread");
        self.emit_status(&app);

        // Spawn a dedicated OS thread for serial I/O (blocking reads must not
        // run on the tokio executor).
        let app_clone = app.clone();
        let handle = std::thread::Builder::new()
            .name("serial-reader".into())
            .spawn(move || reader_thread(port, cmd_rx, format_rx, app_clone, store))
            .map_err(|e| format!("Failed to spawn reader thread: {}", e))?;
        self.reader_handle = Some(handle);

        Ok(())
    }

    /// Disconnect gracefully.
    pub async fn disconnect(&mut self) {
        log::info!("SerialManager::disconnect: starting graceful disconnect");
        if let Some(tx) = self.cmd_tx.take() {
            log::debug!("SerialManager::disconnect: sending Stop to reader thread");
            let _ = tx.send(ReaderCommand::Stop);
        }
        if let Some(h) = self.reader_handle.take() {
            log::debug!("SerialManager::disconnect: joining reader thread (5s timeout)");
            // Join the OS thread; use spawn_blocking so we don't block tokio.
            // The reader thread checks its channel every ~100ms (port read timeout),
            // so it should exit well within 5s.
            match tokio::time::timeout(
                Duration::from_secs(5),
                tokio::task::spawn_blocking(move || h.join()),
            )
            .await
            {
                Ok(Ok(Ok(()))) => {
                    log::info!("SerialManager::disconnect: reader thread joined cleanly");
                }
                Ok(Ok(Err(_panic))) => {
                    log::error!("SerialManager::disconnect: reader thread panicked during join");
                }
                Ok(Err(e)) => {
                    log::error!("SerialManager::disconnect: spawn_blocking failed: {}", e);
                }
                Err(_) => {
                    log::error!(
                        "SerialManager::disconnect: reader thread join timed out after 5s! \
                         Port fd may still be held by orphaned thread."
                    );
                }
            }
        }
        self.format_tx.take();
        self.status.state = ConnectionState::Disconnected;
        self.status.port = None;
        self.status.baud = None;
        self.status.error = None;
        // Reset device status so reconnect starts clean — the bootstrap will re-query
        self.status.device_status = DeviceStatus::default();
        log::info!("SerialManager::disconnect: state → Disconnected, device status reset");
    }

    /// Disconnect and emit status to the frontend.
    pub async fn disconnect_and_emit(&mut self, app: &AppHandle) {
        self.disconnect().await;
        self.emit_status(app);
    }

    /// Send a single-char command to the device.
    pub async fn send_command(&self, cmd: u8) -> Result<(), String> {
        if let Some(tx) = &self.cmd_tx {
            tx.send(ReaderCommand::Send(cmd))
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
// Reader thread (runs on a dedicated OS thread — blocking I/O is fine here)
// ─────────────────────────────────────────────────────────────────────────────

/// Batch event payload sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleBatchEvent {
    timestamps: Vec<f64>,
    amps: Vec<f64>,
}

/// How often we flush accumulated samples to the frontend (milliseconds).
const BATCH_INTERVAL_MS: u64 = 50;
/// Maximum samples before we force a flush.
const MAX_BATCH_SIZE: usize = 100;

/// Long-running function executed on a dedicated OS thread.
/// Reads serial data, parses lines, stores samples, and emits batched events.
fn reader_thread(
    mut port: Box<dyn serialport::SerialPort>,
    cmd_rx: std::sync::mpsc::Receiver<ReaderCommand>,
    mut format_rx: watch::Receiver<LoggingFormat>,
    app: AppHandle,
    store: Arc<std::sync::Mutex<SampleStore>>,
) {
    let mut buf = String::new();
    let mut byte_buf = [0u8; 1024];
    let mut device_status = DeviceStatus::default();
    let mut _sample_count: u64 = 0;
    let mut current_format = *format_rx.borrow();

    // Batch accumulators
    let mut batch_ts: Vec<f64> = Vec::with_capacity(128);
    let mut batch_amps: Vec<f64> = Vec::with_capacity(128);
    let mut last_emit = Instant::now();

    log::info!("Reader thread started, beginning USB logging bootstrap");

    // ─────────────────────────────────────────────────────────────────────
    // USB Logging Bootstrap
    //
    // Robust sequence:
    // 1. Sleep 200ms to let the port settle after open.
    // 2. Drain all buffered data (stale samples from a previous session).
    // 3. Send 'U' to query USB logging state (does NOT toggle).
    // 4. Read lines for up to 1s looking for USB_LOGGING_ENABLED/DISABLED,
    //    skipping anything that looks like sample data.
    // 5. If logging is off (or unknown), send 'u' to toggle it on.
    // 6. Drain again before entering the main loop.
    // ─────────────────────────────────────────────────────────────────────

    // 1. Let the port settle
    std::thread::sleep(Duration::from_millis(200));

    // 2. Drain stale data from the port buffer (time-limited to avoid
    //    eating live samples if device is already streaming)
    log::debug!("Bootstrap: draining stale data from port buffer");
    {
        let mut drain_buf = [0u8; 1024];
        let drain_deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < drain_deadline {
            match port.read(&mut drain_buf) {
                Ok(n) if n > 0 => {
                    log::debug!("Bootstrap: drained {} stale bytes", n);
                }
                _ => break,
            }
        }
    }

    // 3. Send 'U' to query USB logging state
    log::debug!("Bootstrap: sending 'U' (USB logging query)");
    if let Err(e) = port.write_all(b"U") {
        log::warn!("Bootstrap: failed to send USB logging query: {}", e);
    }
    let _ = port.flush();

    // 4. Read lines for up to 1s, looking for USB_LOGGING_ENABLED/DISABLED
    let mut response_buf = String::new();
    let mut raw_bytes = [0u8; 512];
    let bootstrap_deadline = Instant::now() + Duration::from_secs(1);
    let mut usb_state: Option<bool> = None; // Some(true) = ON, Some(false) = OFF

    log::debug!("Bootstrap: waiting for USB logging state response (1s timeout)");
    while Instant::now() < bootstrap_deadline {
        match port.read(&mut raw_bytes) {
            Ok(n) if n > 0 => {
                response_buf.push_str(&String::from_utf8_lossy(&raw_bytes[..n]));

                // Process complete lines
                while let Some(nl) = response_buf.find('\n') {
                    let line = response_buf[..nl].trim().to_string();
                    response_buf.drain(..=nl);

                    if line.is_empty() {
                        continue;
                    }

                    if line.contains("USB_LOGGING_ENABLED") {
                        log::info!("Bootstrap: got USB_LOGGING_ENABLED");
                        usb_state = Some(true);
                    } else if line.contains("USB_LOGGING_DISABLED") {
                        log::info!("Bootstrap: got USB_LOGGING_DISABLED");
                        usb_state = Some(false);
                    } else {
                        // Likely a sample line or other noise — skip it
                        log::debug!("Bootstrap: skipping line: {:?}", line);
                    }
                }

                // If we found the state, no need to wait longer
                if usb_state.is_some() {
                    break;
                }
            }
            _ => {
                // No data yet — keep waiting
            }
        }
    }

    // 5. Enable logging if it's off or unknown
    match usb_state {
        Some(true) => {
            log::info!("Bootstrap: USB logging already ON, no toggle needed");
        }
        Some(false) => {
            log::info!("Bootstrap: USB logging is OFF, sending 'u' to enable");
            if let Err(e) = port.write_all(b"u") {
                log::warn!("Bootstrap: failed to enable USB logging: {}", e);
            }
            let _ = port.flush();
            std::thread::sleep(Duration::from_millis(200));
        }
        None => {
            log::warn!("Bootstrap: no response to 'U' query within 1s, assuming OFF — sending 'u'");
            if let Err(e) = port.write_all(b"u") {
                log::warn!("Bootstrap: failed to enable USB logging: {}", e);
            }
            let _ = port.flush();
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    // 6. Brief drain to skip any bootstrap echo/response noise, but NOT
    //    an infinite loop — the device may already be streaming samples.
    log::debug!("Bootstrap: brief drain before main loop");
    {
        let mut drain_buf = [0u8; 1024];
        let drain_deadline = Instant::now() + Duration::from_millis(150);
        while Instant::now() < drain_deadline {
            match port.read(&mut drain_buf) {
                Ok(n) if n > 0 => {
                    log::debug!("Bootstrap: drained {} bytes in final drain", n);
                }
                _ => break,
            }
        }
    }
    log::info!("Bootstrap complete, entering main read loop");

    // ─────────────────────────────────────────────────────────────────────
    // Main read loop
    // ─────────────────────────────────────────────────────────────────────

    loop {
        // Check for incoming commands (non-blocking)
        match cmd_rx.try_recv() {
            Ok(ReaderCommand::Stop) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                flush_batch(&app, &mut batch_ts, &mut batch_amps);
                log::info!("Reader thread stopping");
                return;
            }
            Ok(ReaderCommand::Send(b)) => {
                if let Err(e) = port.write_all(&[b]) {
                    log::warn!("Serial write error: {}", e);
                }
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
        }

        // Check for format change
        if format_rx.has_changed().unwrap_or(false) {
            current_format = *format_rx.borrow_and_update();
        }

        // Read available bytes (blocks up to the port timeout, typically 100ms)
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
                            _sample_count += 1;

                            // Push to Rust-side store (for export / stats)
                            {
                                let mut s = store.lock().unwrap();
                                s.push(sample.clone());
                            }

                            // Accumulate for batched frontend delivery
                            batch_ts.push(sample.timestamp);
                            batch_amps.push(sample.amps);
                        }
                        ParsedLine::StatusUpdate { update } => {
                            log::info!("Status update: {:?}", update);
                            apply_status_update(&mut device_status, update);
                            let _ = app.emit("serial:device_status", &device_status);
                            let _ = app.emit("serial:status_message", &line);
                        }
                        ParsedLine::Info { message } => {
                            log::debug!("Info line: {}", message);
                            let _ = app.emit("serial:info", message);
                        }
                        ParsedLine::Unknown { raw } if !raw.is_empty() => {
                            log::debug!("Unknown serial line: {:?}", raw);
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
                flush_batch(&app, &mut batch_ts, &mut batch_amps);
                log::error!("Serial read error: {}", e);
                let _ = app.emit(
                    "serial:error",
                    format!("Serial read error: {}", e),
                );
                return;
            }
        }

        // Flush batch when enough samples collected or enough time elapsed
        if !batch_ts.is_empty()
            && (batch_ts.len() >= MAX_BATCH_SIZE
                || last_emit.elapsed() >= Duration::from_millis(BATCH_INTERVAL_MS))
        {
            flush_batch(&app, &mut batch_ts, &mut batch_amps);
            last_emit = Instant::now();
        }
    }
}

/// Emit a batch of samples to the frontend and clear the accumulators.
fn flush_batch(app: &AppHandle, batch_ts: &mut Vec<f64>, batch_amps: &mut Vec<f64>) {
    if batch_ts.is_empty() {
        return;
    }
    let event = SampleBatchEvent {
        timestamps: batch_ts.drain(..).collect(),
        amps: batch_amps.drain(..).collect(),
    };
    let _ = app.emit("serial:samples_batch", &event);
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
