// cr-mock/src/main.rs
//
// CurrentRanger R3 firmware mock with interactive TUI.
//
// Two threads
// ───────────
//   main   — TUI (ratatui/crossterm): waveform & parameter controls
//   serial — PTY I/O + sample generation (reads controls, writes samples)
//
// Shared state (Arc<Mutex<…>>)
// ────────────────────────────
//   SimConfig   — waveform type, display range, base/min/max   (TUI writes, serial reads)
//   DeviceInfo  — firmware state reflected from commands       (serial writes, TUI reads)
//   RecentSamples — ring of last ~60 emitted amps values       (serial writes, TUI reads)
//
// Usage
// ─────
//   cargo run                      auto-creates a PTY, path shown in header
//   cargo run -- /dev/ttyXXX       use an existing serial port

use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use rand::Rng;
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
    Frame, Terminal,
};
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

// ── Firmware constants ────────────────────────────────────────────────────────

const FW_VERSION: &str = "1.1.7";

const LOG_EXP: u8 = 0;
const LOG_NANOS: u8 = 1;
const LOG_MICROS: u8 = 2;
const LOG_MILLIS: u8 = 3;
const LOG_ADC: u8 = 4;

const ADC_SPEED_AVG: u8 = 0;
const ADC_SPEED_FAST: u8 = 1;
const ADC_SPEED_SLOW: u8 = 2;

const AUTOOFF_DEFAULT: u64 = 600;
const AUTOOFF_DISABLED: u64 = 0xFFFF_FFFF;
const AUTOOFF_SMART: u64 = 0xFFFE;

const ADC_OVERLOAD: f64 = 3850.0;
const ADCFULLRANGE: f64 = 4095.0;
const LDO_DEFAULT: f64 = 3.300;

// ── Simulation types (controlled by TUI) ─────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum WaveformType {
    Steady,
    Sine,
    Pulse,
    Sawtooth,
    Brownian,
    SleepWake,
    // ── New ──────────────────────────
    Random,       // independent uniform random sample each tick
    StepUp,       // N equal steps min→max, then snap back to min
    StepDown,     // N equal steps max→min, then snap back to max
    StepPingPong, // steps min→max→min (triangle staircase)
    ExpDecay,     // exponential decay from max→min, then resets
    Burst,        // short high-current bursts at random intervals
}

impl WaveformType {
    const ALL: &'static [WaveformType] = &[
        WaveformType::Steady,
        WaveformType::Sine,
        WaveformType::Pulse,
        WaveformType::Sawtooth,
        WaveformType::Brownian,
        WaveformType::SleepWake,
        WaveformType::Random,
        WaveformType::StepUp,
        WaveformType::StepDown,
        WaveformType::StepPingPong,
        WaveformType::ExpDecay,
        WaveformType::Burst,
    ];
    fn label(self) -> &'static str {
        match self {
            WaveformType::Steady      => "Steady DC",
            WaveformType::Sine        => "Sine Wave  (0.5 Hz)",
            WaveformType::Pulse       => "Pulse  (1 Hz, 10% duty)",
            WaveformType::Sawtooth    => "Sawtooth  (0.5 Hz)",
            WaveformType::Brownian    => "Brownian Noise",
            WaveformType::SleepWake   => "Sleep / Wake  (4 s period)",
            WaveformType::Random      => "Random  (uniform per sample)",
            WaveformType::StepUp      => "Step Up  (min → max, reset)",
            WaveformType::StepDown    => "Step Down  (max → min, reset)",
            WaveformType::StepPingPong=> "Step Ping-Pong  (min ↔ max)",
            WaveformType::ExpDecay    => "Exp Decay  (max → min, reset)",
            WaveformType::Burst       => "Burst  (random spikes on idle)",
        }
    }
}

/// The unit used to display and step the sim parameters.
/// This is independent of the device's active range.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SimRange { MA, UA, NA }

impl SimRange {
    fn label(self)        -> &'static str { match self { SimRange::MA => "mA", SimRange::UA => "µA", SimRange::NA => "nA" } }
    fn scale(self)        -> f64 { match self { SimRange::MA => 1e-3,  SimRange::UA => 1e-6, SimRange::NA => 1e-9 } }
    fn small_step(self)   -> f64 { match self { SimRange::MA => 1e-4,  SimRange::UA => 1e-6, SimRange::NA => 1e-8 } }
    fn large_step(self)   -> f64 { match self { SimRange::MA => 1e-3,  SimRange::UA => 1e-5, SimRange::NA => 1e-7 } }
    fn default_base(self) -> f64 { match self { SimRange::MA => 1e-3,  SimRange::UA => 500e-6, SimRange::NA => 500e-9 } }
    fn default_min(self)  -> f64 { match self { SimRange::MA => 0.5e-3, SimRange::UA => 100e-6, SimRange::NA => 100e-9 } }
    fn default_max(self)  -> f64 { match self { SimRange::MA => 4e-3,  SimRange::UA => 900e-6, SimRange::NA => 900e-9 } }

    fn fmt_amps(self, amps: f64) -> String {
        let v = amps / self.scale();
        match self {
            SimRange::MA => format!("{:>9.3} mA", v),
            SimRange::UA => format!("{:>9.2} µA", v),
            SimRange::NA => format!("{:>9.1} nA", v),
        }
    }
}

struct SimConfig {
    waveform:  WaveformType,
    sim_range: SimRange,
    base_amps: f64,
    min_amps:  f64,
    max_amps:  f64,
}

impl SimConfig {
    fn new() -> Self {
        let r = SimRange::UA;
        Self { waveform: WaveformType::Steady, sim_range: r,
               base_amps: r.default_base(), min_amps: r.default_min(), max_amps: r.default_max() }
    }
    fn set_range(&mut self, r: SimRange) {
        self.sim_range = r;
        self.base_amps = r.default_base();
        self.min_amps  = r.default_min();
        self.max_amps  = r.default_max();
    }
}

// ── Device info (mirrored from firmware state, read by TUI) ──────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum DevRange { MA, UA, NA }
impl DevRange { fn label(self) -> &'static str { match self { DevRange::MA => "mA", DevRange::UA => "µA", DevRange::NA => "nA" } } }

#[derive(Clone)]
struct DeviceInfo {
    usb_logging:    bool,
    logging_format: u8,
    dev_range:      DevRange,
    autorange:      bool,
    lpf:            bool,
    bias:           bool,
    slave_path:     String,
    connected:      bool,
    samples_sent:   u64,
    last_amps:      Option<f64>,
}

impl DeviceInfo {
    fn new() -> Self {
        Self { usb_logging: false, logging_format: LOG_EXP, dev_range: DevRange::MA,
               autorange: false, lpf: false, bias: false, slave_path: "…".into(),
               connected: false, samples_sent: 0, last_amps: None }
    }
    fn fmt_label(&self) -> &'static str {
        match self.logging_format {
            LOG_NANOS  => "NANOS",
            LOG_MICROS => "MICROS",
            LOG_MILLIS => "MILLIS",
            LOG_ADC    => "ADC",
            _          => "EXPONENT",
        }
    }
}

// ── Firmware protocol handler ─────────────────────────────────────────────────

struct Device {
    usb_logging:       bool,
    logging_format:    u8,
    adc_speed:         u8,
    autorange:         bool,
    lpf:               bool,
    bias:              bool,
    gpio_ranging:      bool,
    touch_debug:       bool,
    range:             DevRange,
    autooff_interval:  u64,
    offset_correction: i32,
    gain_correction:   u16,
    ldo_value:         f64,
    last_sample:       Instant,
}

impl Device {
    fn new() -> Self {
        Self { usb_logging: false, logging_format: LOG_EXP, adc_speed: ADC_SPEED_AVG,
               autorange: false, lpf: false, bias: false, gpio_ranging: false,
               touch_debug: false, range: DevRange::MA, autooff_interval: AUTOOFF_DEFAULT,
               offset_correction: 0, gain_correction: 2048, ldo_value: LDO_DEFAULT,
               last_sample: Instant::now() }
    }

    fn sample_interval(&self) -> Duration {
        match self.adc_speed {
            ADC_SPEED_FAST => Duration::from_millis(10),
            ADC_SPEED_SLOW => Duration::from_millis(80),
            _              => Duration::from_millis(20),
        }
    }

    fn handle_command(&mut self, cmd: u8) -> Vec<u8> {
        let mut o: Vec<u8> = Vec::new();
        match cmd {
            b'+' => { self.gain_correction   = self.gain_correction.saturating_add(1);
                      o.extend(format!("new gainCorrectionValue = {}\r\n",   self.gain_correction  ).as_bytes()); }
            b'-' => { self.gain_correction   = self.gain_correction.saturating_sub(1);
                      o.extend(format!("new gainCorrectionValue = {}\r\n",   self.gain_correction  ).as_bytes()); }
            b'*' => { self.offset_correction += 1;
                      o.extend(format!("new offsetCorrectionValue = {}\r\n", self.offset_correction).as_bytes()); }
            b'/' => { self.offset_correction -= 1;
                      o.extend(format!("new offsetCorrectionValue = {}\r\n", self.offset_correction).as_bytes()); }
            b'<' => { self.ldo_value -= 0.001; o.extend(format!("new LDO_Value = {:.3}\r\n", self.ldo_value).as_bytes()); }
            b'>' => { self.ldo_value += 0.001; o.extend(format!("new LDO_Value = {:.3}\r\n", self.ldo_value).as_bytes()); }
            b'u' => { self.usb_logging = !self.usb_logging;
                      o.extend(if self.usb_logging { b"USB_LOGGING_ENABLED\r\n"  as &[u8] }
                               else               { b"USB_LOGGING_DISABLED\r\n" }); }
            b'U' => { o.extend(if self.usb_logging { b"USB_LOGGING_ENABLED\r\n"  as &[u8] }
                               else               { b"USB_LOGGING_DISABLED\r\n" }); }
            b't' => { self.touch_debug = !self.touch_debug;
                      o.extend(if self.touch_debug { b"TOUCH_DEBUG_ENABLED\r\n"  as &[u8] }
                               else               { b"TOUCH_DEBUG_DISABLED\r\n" }); }
            b'g' => { self.gpio_ranging = !self.gpio_ranging;
                      o.extend(if self.gpio_ranging { b"GPIO_HEADER_RANGING_ENABLED\r\n"  as &[u8] }
                               else                { b"GPIO_HEADER_RANGING_DISABLED\r\n" }); }
            b'b' => { o.extend(b"BT_LOGGING_DISABLED\r\n"); }
            b'f' => { self.logging_format = if self.logging_format >= LOG_ADC { LOG_EXP } else { self.logging_format + 1 };
                      let l = match self.logging_format { LOG_EXP => "LOGGING_FORMAT_EXPONENT", LOG_NANOS => "LOGGING_FORMAT_NANOS",
                          LOG_MICROS => "LOGGING_FORMAT_MICROS", LOG_MILLIS => "LOGGING_FORMAT_MILLIS", _ => "LOGGING_FORMAT_ADC" };
                      o.extend(format!("{}\r\n", l).as_bytes()); }
            b's' => { self.adc_speed = if self.adc_speed >= ADC_SPEED_SLOW { ADC_SPEED_AVG } else { self.adc_speed + 1 };
                      let l = match self.adc_speed { ADC_SPEED_AVG => "ADC_SAMPLING_SPEED_AVG",
                          ADC_SPEED_FAST => "ADC_SAMPLING_SPEED_FAST", _ => "ADC_SAMPLING_SPEED_SLOW" };
                      o.extend(format!("{}\r\n", l).as_bytes()); }
            b'S' => { let l = match self.adc_speed { ADC_SPEED_AVG => "ADC_SAMPLING_SPEED_AVG",
                          ADC_SPEED_FAST => "ADC_SAMPLING_SPEED_FAST", _ => "ADC_SAMPLING_SPEED_SLOW" };
                      o.extend(format!("{}\r\n", l).as_bytes()); }
            b'a' => { let l = if self.autooff_interval == AUTOOFF_DEFAULT {
                              self.autooff_interval = AUTOOFF_DISABLED; "AUTOOFF_DISABLED"
                          } else if self.autooff_interval == AUTOOFF_DISABLED {
                              self.autooff_interval = AUTOOFF_SMART; "AUTOOFF_SMART"
                          } else {
                              self.autooff_interval = AUTOOFF_DEFAULT; "AUTOOFF_DEFAULT"
                          };
                      o.extend(format!("{}\r\n", l).as_bytes()); }
            b'1' => { self.autorange = false; self.range = DevRange::MA; }
            b'2' => { self.autorange = false; self.range = DevRange::UA; }
            b'3' => { self.autorange = false; self.range = DevRange::NA; }
            b'4' => { self.lpf = !self.lpf; if self.autorange && !self.lpf { self.autorange = false; } }
            b'5' => { self.bias = !self.bias; if self.autorange && self.bias { self.autorange = false; } }
            b'6' => { self.autorange = !self.autorange;
                      if self.autorange && self.bias { self.bias = false; }
                      if self.autorange && !self.lpf  { self.lpf = true; } }
            b'!' => { self.usb_logging = false;              o.extend(b"USB_LOGGING_DISABLED\r\n");
                      self.logging_format = LOG_EXP;         o.extend(b"LOGGING_FORMAT_EXPONENT\r\n");
                      self.touch_debug = false;              o.extend(b"TOUCH_DEBUG_DISABLED\r\n");
                      self.gpio_ranging = false;             o.extend(b"GPIO_HEADER_RANGING_DISABLED\r\n");
                                                             o.extend(b"BT_LOGGING_DISABLED\r\n");
                      self.adc_speed = ADC_SPEED_AVG;        o.extend(b"ADC_SAMPLING_SPEED_AVG\r\n");
                      self.autooff_interval = AUTOOFF_DEFAULT; o.extend(b"AUTOOFF_DEFAULT\r\n");
                      self.lpf = false; self.bias = false; self.autorange = false; self.range = DevRange::MA;
                      o.extend(b"SETTINGS_RESET\r\n"); }
            b'?' => { o.extend(self.print_menu()); }
            b'r' => { o.extend(b"\r\nRebooting to bootloader...\r\n"); }
            _ => {}
        }
        o
    }

    fn print_menu(&self) -> Vec<u8> {
        let autooff = match self.autooff_interval { AUTOOFF_DISABLED => "DISABLED".into(), AUTOOFF_SMART => "SMART".into(), v => v.to_string() };
        format!(
            "\r\nCurrentRanger R3 (firmware v. {})\r\n\
             \r\nADC calibration values:\r\nOffset={}\r\nGain={}\r\nLDO={:.3}\r\n\
             \r\nEEPROM Settings:\r\nLoggingFormat={}\r\nADCSamplingSpeed={}\r\nAutoOff={}\r\n\
             BT Logging: 0\r\nUSB Logging: {}\r\n\r\n\
             a = cycle Auto-Off function\r\nb = toggle BT/serial logging (230400baud)\r\n\
             f = cycle serial logging formats (exponent,nA,uA,mA/raw-ADC)\r\n\
             g = toggle GPIO range indication (SCK=mA,MISO=uA,MOSI=nA)\r\n\
             r = reboot into bootloader\r\ns = cycle ADC sampling speeds (0=average,faster,slower)\r\n\
             S = show current ADC sampling speed\r\nt = toggle touchpad serial output debug info\r\n\
             u = toggle USB/serial logging\r\nU = show USB/serial logging state\r\n\
             < = Calibrate LDO value (-1mV)\r\n> = Calibrate LDO value (+1mV)\r\n\
             + = Calibrate GAIN value (+1)\r\n- = Calibrate GAIN value (-1)\r\n\
             * = Calibrate OFFSET value (+1)\r\n/ = Calibrate OFFSET value (-1)\r\n\
             1 = range to MilliAmps (MA)\r\n2 = range to MicroAmps (UA)\r\n3 = range to NanoAmps (NA)\r\n\
             4 = toggle Low Pass Filter (LPF)\r\n5 = toggle BIAS (disables AutoRanging)\r\n\
             6 = toggle AutoRanging (disables BIAS)\r\n! = reset all runtime settings to defaults\r\n\
             ? = Print this menu and calib info\r\n\r\n",
            FW_VERSION,
            self.offset_correction, self.gain_correction, self.ldo_value,
            self.logging_format, self.adc_speed, autooff, self.usb_logging as u8,
        ).into_bytes()
    }

    fn format_sample(&self, amps: f64, read_diff: f64) -> Vec<u8> {
        let s = match self.logging_format {
            LOG_EXP    => { let (v, e) = match self.range { DevRange::MA => (amps*1e3,-3i32), DevRange::UA => (amps*1e6,-6), DevRange::NA => (amps*1e9,-9) };
                            format!("{:.4}e{}\r\n", v, e) }
            LOG_NANOS  => format!("{:.0}\r\n",   amps * 1e9),
            LOG_MICROS => format!("{:.3}\r\n",   amps * 1e6),
            LOG_MILLIS => format!("{:.6}\r\n",   amps * 1e3),
            _          => format!("{:.0}\r\n",   read_diff),
        };
        s.into_bytes()
    }

    fn maybe_autorange(&mut self, rd: f64) -> bool {
        if !self.autorange { return false; }
        if rd <= 6.0 {
            match self.range { DevRange::MA => { self.range = DevRange::UA; return true; } DevRange::UA => { self.range = DevRange::NA; return true; } _ => {} }
        } else if rd >= ADC_OVERLOAD {
            match self.range { DevRange::NA => { self.range = DevRange::UA; return true; } DevRange::UA => { self.range = DevRange::MA; return true; } _ => {} }
        }
        false
    }

    fn sync_info(&self, info: &Arc<Mutex<DeviceInfo>>) {
        if let Ok(mut d) = info.lock() {
            d.usb_logging    = self.usb_logging;
            d.logging_format = self.logging_format;
            d.dev_range      = self.range;
            d.autorange      = self.autorange;
            d.lpf            = self.lpf;
            d.bias           = self.bias;
        }
    }
}

// ── Waveform generator ────────────────────────────────────────────────────────

// Number of steps used by StepUp / StepDown / StepPingPong
const STEP_COUNT: u32 = 8;

struct WaveformGen {
    rng:           rand::rngs::ThreadRng,
    t:             f64,   // elapsed seconds (for phase-based waveforms)
    brownian_pos:  f64,
    prev_wave:     WaveformType,

    // StepUp / StepDown / StepPingPong
    step_idx:      u32,   // current step index (0..STEP_COUNT-1)
    step_dir_up:   bool,  // true = ascending (ping-pong)
    step_accum:    f64,   // time accumulated in the current step

    // ExpDecay
    decay_pos:     f64,   // current decaying value (amps)
    decay_started: bool,

    // Burst
    burst_active:  bool,
    burst_ttl:     f64,   // seconds remaining in burst
    burst_cooldown:f64,   // seconds until next burst is allowed
}

impl WaveformGen {
    fn new() -> Self {
        Self {
            rng: rand::thread_rng(),
            t: 0.0,
            brownian_pos: 0.0,
            prev_wave: WaveformType::Steady,
            step_idx: 0,
            step_dir_up: true,
            step_accum: 0.0,
            decay_pos: 0.0,
            decay_started: false,
            burst_active: false,
            burst_ttl: 0.0,
            burst_cooldown: 0.0,
        }
    }

    // Called whenever the waveform type changes so state is clean.
    fn reset_state(&mut self, base: f64, lo: f64, hi: f64) {
        self.t             = 0.0;
        self.brownian_pos  = base;
        self.step_idx      = 0;
        self.step_dir_up   = true;
        self.step_accum    = 0.0;
        self.decay_pos     = hi;
        self.decay_started = false;
        self.burst_active  = false;
        self.burst_ttl     = 0.0;
        self.burst_cooldown= self.rng.gen_range(0.5..2.0);
        let _ = (lo, hi); // suppress unused warning
    }

    fn next(&mut self, cfg: &SimConfig, dt: f64) -> f64 {
        self.t += dt;
        let base = cfg.base_amps;
        let lo   = cfg.min_amps.min(base);
        let hi   = cfg.max_amps.max(base);
        let span = (hi - lo).max(1e-15);

        if cfg.waveform != self.prev_wave {
            self.reset_state(base, lo, hi);
            self.prev_wave = cfg.waveform;
        }

        let raw = match cfg.waveform {
            // ── Existing ────────────────────────────────────────────────────
            WaveformType::Steady => base,

            WaveformType::Sine => {
                let phase = (self.t * std::f64::consts::TAU * 0.5).sin();
                lo + (phase + 1.0) / 2.0 * span
            }

            WaveformType::Pulse => {
                if (self.t * 1.0).fract() < 0.10 { hi } else { lo }
            }

            WaveformType::Sawtooth => {
                lo + (self.t / 2.0).fract() * span
            }

            WaveformType::Brownian => {
                let step = span * self.rng.gen_range(-0.03..0.03);
                self.brownian_pos = (self.brownian_pos + step).clamp(lo, hi);
                self.brownian_pos
            }

            WaveformType::SleepWake => {
                if (self.t % 4.0) / 4.0 >= 0.75 { hi } else { lo }
            }

            // ── New ─────────────────────────────────────────────────────────

            // Pure uniform random — every sample is independent.
            WaveformType::Random => {
                self.rng.gen_range(lo..=hi)
            }

            // Staircase min → max in STEP_COUNT equal steps, then reset.
            // Each step lasts 0.4 s.
            WaveformType::StepUp => {
                const STEP_HOLD: f64 = 0.4;
                self.step_accum += dt;
                if self.step_accum >= STEP_HOLD {
                    self.step_accum -= STEP_HOLD;
                    self.step_idx   = (self.step_idx + 1) % STEP_COUNT;
                }
                lo + (self.step_idx as f64 / (STEP_COUNT - 1) as f64) * span
            }

            // Staircase max → min in STEP_COUNT equal steps, then reset.
            WaveformType::StepDown => {
                const STEP_HOLD: f64 = 0.4;
                self.step_accum += dt;
                if self.step_accum >= STEP_HOLD {
                    self.step_accum -= STEP_HOLD;
                    self.step_idx   = (self.step_idx + 1) % STEP_COUNT;
                }
                hi - (self.step_idx as f64 / (STEP_COUNT - 1) as f64) * span
            }

            // Triangle staircase: min → max → min → …
            WaveformType::StepPingPong => {
                const STEP_HOLD: f64 = 0.4;
                self.step_accum += dt;
                if self.step_accum >= STEP_HOLD {
                    self.step_accum -= STEP_HOLD;
                    if self.step_dir_up {
                        if self.step_idx + 1 >= STEP_COUNT {
                            self.step_dir_up = false;
                            self.step_idx   = self.step_idx.saturating_sub(1);
                        } else {
                            self.step_idx += 1;
                        }
                    } else {
                        if self.step_idx == 0 {
                            self.step_dir_up = true;
                            self.step_idx    = 1;
                        } else {
                            self.step_idx -= 1;
                        }
                    }
                }
                lo + (self.step_idx as f64 / (STEP_COUNT - 1) as f64) * span
            }

            // Exponential decay from hi down to lo (τ ≈ 1 s), then instant reset.
            WaveformType::ExpDecay => {
                if !self.decay_started {
                    self.decay_pos     = hi;
                    self.decay_started = true;
                }
                // τ = 1 second; when within 2% of lo, reset
                let tau = 1.0_f64;
                self.decay_pos = lo + (self.decay_pos - lo) * (-dt / tau).exp();
                if (self.decay_pos - lo).abs() < span * 0.02 {
                    self.decay_pos = hi; // reset
                }
                self.decay_pos
            }

            // Long idle at `lo` (base), then a short burst at `hi`, repeat.
            // Burst duration: 50–150 ms.  Cooldown: 0.5–3 s.
            WaveformType::Burst => {
                if self.burst_active {
                    self.burst_ttl -= dt;
                    if self.burst_ttl <= 0.0 {
                        self.burst_active   = false;
                        self.burst_cooldown = self.rng.gen_range(0.5..3.0);
                    }
                    hi
                } else {
                    self.burst_cooldown -= dt;
                    if self.burst_cooldown <= 0.0 {
                        self.burst_active = true;
                        self.burst_ttl    = self.rng.gen_range(0.05..0.15);
                    }
                    lo
                }
            }
        };

        // Tiny noise: 0.1 % of span (keeps the sparkline alive even on step waveforms)
        let noise = self.rng.gen_range(-span * 0.001..span * 0.001);
        (raw + noise).max(0.0)
    }
}

fn amps_to_adc(amps: f64, range: DevRange) -> f64 {
    let scale = match range { DevRange::MA => 1.0, DevRange::UA => 1e-3, DevRange::NA => 1e-6 };
    let ldo_opt = (LDO_DEFAULT * 500.0) / ADCFULLRANGE;
    ((amps / scale) / ldo_opt).clamp(0.0, ADCFULLRANGE)
}

// ── PTY helpers ───────────────────────────────────────────────────────────────

#[cfg(unix)]
fn open_pty() -> Result<(std::fs::File, String), Box<dyn std::error::Error>> {
    use std::{ffi::CStr, os::unix::io::FromRawFd};
    let fd = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
    if fd < 0 { return Err("posix_openpt failed".into()); }
    if unsafe { libc::grantpt(fd)  } < 0 { return Err("grantpt failed".into()); }
    if unsafe { libc::unlockpt(fd) } < 0 { return Err("unlockpt failed".into()); }
    let ptr = unsafe { libc::ptsname(fd) };
    if ptr.is_null() { return Err("ptsname failed".into()); }
    let slave = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().to_string();
    Ok((unsafe { std::fs::File::from_raw_fd(fd) }, slave))
}

// ── Serial thread ─────────────────────────────────────────────────────────────

fn serial_thread(
    port_arg: Option<String>,
    cfg:    Arc<Mutex<SimConfig>>,
    info:   Arc<Mutex<DeviceInfo>>,
    recent: Arc<Mutex<VecDeque<f64>>>,
) {
    let res = match port_arg {
        Some(p) => run_on_serialport(&p, cfg, info, recent),
        None    => run_on_pty(cfg, info, recent),
    };
    if let Err(e) = res { eprintln!("Serial thread: {e}"); }
}

// Shared inner loop — drives Device + WaveformGen from either a PTY or real port.
fn io_loop<R: Read, W: Write>(
    mut reader: R,
    mut writer: W,
    cfg:    Arc<Mutex<SimConfig>>,
    info:   Arc<Mutex<DeviceInfo>>,
    recent: Arc<Mutex<VecDeque<f64>>>,
) {
    let mut device = Device::new();
    let boot = device.print_menu();
    let _ = writer.write_all(&boot);

    let mut gen        = WaveformGen::new();
    let mut buf        = [0u8; 256];
    let mut samples    = 0u64;
    let mut last_tick  = Instant::now();

    loop {
        // ── Inbound commands ──────────────────────────────────────────────
        match reader.read(&mut buf) {
            Ok(n) if n > 0 => {
                for &b in &buf[..n] {
                    let resp = device.handle_command(b);
                    if !resp.is_empty() { let _ = writer.write_all(&resp); }
                }
                device.sync_info(&info);
                if let Ok(mut d) = info.lock() { d.connected = true; }
            }
            Ok(_) => {}
            Err(ref e) if matches!(e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => { std::thread::sleep(Duration::from_millis(20)); }
        }

        // ── Sample emission ───────────────────────────────────────────────
        let now = Instant::now();
        let dt  = now.duration_since(last_tick).as_secs_f64();
        last_tick = now;

        if device.usb_logging && device.last_sample.elapsed() >= device.sample_interval() {
            device.last_sample = Instant::now();

            let amps = { let c = cfg.lock().unwrap(); gen.next(&c, dt) };
            let rd   = amps_to_adc(amps, device.range);

            if device.maybe_autorange(rd) {
                device.sync_info(&info);
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }

            let sample = device.format_sample(amps, rd);
            if writer.write_all(&sample).is_err() {
                std::thread::sleep(Duration::from_millis(50));
            }

            samples += 1;
            if let Ok(mut d) = info.lock() { d.samples_sent = samples; d.last_amps = Some(amps); }
            if let Ok(mut r) = recent.lock() { r.push_back(amps); if r.len() > 64 { r.pop_front(); } }
        }

        std::thread::sleep(Duration::from_millis(1));
    }
}

// ── PTY mode ──────────────────────────────────────────────────────────────────

#[cfg(unix)]
fn run_on_pty(
    cfg:    Arc<Mutex<SimConfig>>,
    info:   Arc<Mutex<DeviceInfo>>,
    recent: Arc<Mutex<VecDeque<f64>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::io::AsRawFd;

    let (master, slave_path) = open_pty()?;
    if let Ok(mut d) = info.lock() { d.slave_path = slave_path.clone(); }

    // Advertise the slave path so the app's port-list can find it.
    const MOCK_PORT_FILE: &str = "/tmp/cr-mock.port";
    std::fs::write(MOCK_PORT_FILE, &slave_path).ok();

    unsafe {
        let fd = master.as_raw_fd();
        let mut tios: libc::termios = std::mem::zeroed();
        libc::tcgetattr(fd, &mut tios);
        libc::cfmakeraw(&mut tios);
        libc::tcsetattr(fd, libc::TCSANOW, &tios);
        libc::fcntl(fd, libc::F_SETFL, libc::O_RDWR | libc::O_NONBLOCK);
    }

    let reader = master.try_clone()?;
    let writer = master.try_clone()?;
    io_loop(reader, writer, cfg, info, recent);

    // Clean up so the app stops showing the port after the mock exits.
    std::fs::remove_file(MOCK_PORT_FILE).ok();
    Ok(())
}

#[cfg(not(unix))]
fn run_on_pty(
    _cfg:    Arc<Mutex<SimConfig>>,
    _info:   Arc<Mutex<DeviceInfo>>,
    _recent: Arc<Mutex<VecDeque<f64>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    Err("PTY not supported on this platform — pass a port path as an argument.".into())
}

// ── Real serial port mode ─────────────────────────────────────────────────────

fn run_on_serialport(
    path:   &str,
    cfg:    Arc<Mutex<SimConfig>>,
    info:   Arc<Mutex<DeviceInfo>>,
    recent: Arc<Mutex<VecDeque<f64>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(mut d) = info.lock() { d.slave_path = path.to_string(); }
    let port = serialport::new(path, 230400)
        .timeout(Duration::from_millis(5))
        .data_bits(serialport::DataBits::Eight)
        .stop_bits(serialport::StopBits::One)
        .parity(serialport::Parity::None)
        .flow_control(serialport::FlowControl::None)
        .open()?;
    let reader = port.try_clone()?;
    io_loop(reader, port, cfg, info, recent);
    Ok(())
}

// ── TUI ───────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum ActiveField { Waveform, Range, Base, Min, Max }

impl ActiveField {
    fn next(self) -> Self { match self { ActiveField::Waveform => ActiveField::Range, ActiveField::Range => ActiveField::Base, ActiveField::Base => ActiveField::Min, ActiveField::Min => ActiveField::Max, ActiveField::Max => ActiveField::Waveform } }
    fn prev(self) -> Self { match self { ActiveField::Waveform => ActiveField::Max, ActiveField::Range => ActiveField::Waveform, ActiveField::Base => ActiveField::Range, ActiveField::Min => ActiveField::Base, ActiveField::Max => ActiveField::Min } }
}

struct TuiState {
    active:    ActiveField,
    sel_wave:  usize,  // index into WaveformType::ALL
}

impl TuiState { fn new() -> Self { Self { active: ActiveField::Waveform, sel_wave: 0 } } }

// ── Drawing ───────────────────────────────────────────────────────────────────

const C_ACCENT:   Color = Color::Cyan;
const C_ACTIVE:   Color = Color::Yellow;
const C_DIM:      Color = Color::DarkGray;
const C_OK:       Color = Color::Green;
const C_WARN:     Color = Color::Red;
const C_WAVE:     Color = Color::Magenta;

fn active_style(field: ActiveField, target: ActiveField) -> Style {
    if field == target { Style::default().fg(C_ACTIVE).add_modifier(Modifier::BOLD) }
    else               { Style::default().fg(Color::White) }
}

fn border_style(field: ActiveField, target: ActiveField) -> Style {
    if field == target { Style::default().fg(C_ACTIVE) } else { Style::default().fg(C_DIM) }
}

fn sparkline(values: &VecDeque<f64>, width: usize) -> String {
    if values.is_empty() || width == 0 { return " ".repeat(width); }
    let bars = "▁▂▃▄▅▆▇█";
    let bars_chars: Vec<char> = bars.chars().collect();
    let n_bars = bars_chars.len() as f64;
    let lo = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let span = (hi - lo).max(1e-15);

    // Sample `width` points evenly from the values
    let vals: Vec<f64> = if values.len() <= width {
        values.iter().cloned().collect()
    } else {
        (0..width).map(|i| {
            let idx = (i * (values.len() - 1)) / (width - 1).max(1);
            values[idx]
        }).collect()
    };

    vals.iter()
        .map(|&v| {
            let norm = ((v - lo) / span * (n_bars - 1.0)).round().clamp(0.0, n_bars - 1.0) as usize;
            bars_chars[norm]
        })
        .collect()
}

fn draw_ui(f: &mut Frame, tui: &TuiState, cfg: &SimConfig, dev: &DeviceInfo, recent: &VecDeque<f64>) {
    let area = f.area();

    // Outer vertical split: header | body | footer
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(10), Constraint::Length(4)])
        .split(area);

    draw_header(f, outer[0], dev);
    draw_body(f, outer[1], tui, cfg, dev, recent);
    draw_footer(f, outer[2], tui, dev);
}

fn draw_header(f: &mut Frame, area: Rect, dev: &DeviceInfo) {
    let conn_style = if dev.connected { Style::default().fg(C_OK) } else { Style::default().fg(C_DIM) };
    let log_style  = if dev.usb_logging { Style::default().fg(C_OK) } else { Style::default().fg(C_WARN) };

    let path_display = dev.slave_path.replace("/dev/", "");
    let line = Line::from(vec![
        Span::styled(" CR Mock ", Style::default().fg(C_ACCENT).add_modifier(Modifier::BOLD)),
        Span::styled(format!("fw v{}  ", FW_VERSION), Style::default().fg(C_DIM)),
        Span::styled("│  ", Style::default().fg(C_DIM)),
        Span::styled("port: ", Style::default().fg(C_DIM)),
        Span::styled(path_display, Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
        Span::styled("  │  ", Style::default().fg(C_DIM)),
        Span::styled(if dev.connected { "● CONNECTED" } else { "○ waiting…" }, conn_style),
        Span::styled("  │  ", Style::default().fg(C_DIM)),
        Span::styled(if dev.usb_logging { "▶ STREAMING" } else { "■ logging off" }, log_style),
    ]);
    let p = Paragraph::new(line)
        .block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(C_DIM)));
    f.render_widget(p, area);
}

fn draw_body(f: &mut Frame, area: Rect, tui: &TuiState, cfg: &SimConfig, dev: &DeviceInfo, recent: &VecDeque<f64>) {
    // Horizontal: waveform list | parameters + live output
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(40), Constraint::Min(0)])
        .split(area);

    draw_waveform_list(f, cols[0], tui, cfg);

    // Right vertical: parameters | live output
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(10), Constraint::Min(0)])
        .split(cols[1]);

    draw_params(f, right[0], tui, cfg);
    draw_live(f, right[1], tui, cfg, dev, recent);
}

fn draw_waveform_list(f: &mut Frame, area: Rect, tui: &TuiState, _cfg: &SimConfig) {
    let is_active = tui.active == ActiveField::Waveform;
    let items: Vec<ListItem> = WaveformType::ALL.iter().enumerate().map(|(i, wt)| {
        let selected = i == tui.sel_wave;
        let bullet = if selected { "● " } else { "○ " };
        let style = if selected {
            Style::default().fg(C_WAVE).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        };
        ListItem::new(Line::from(vec![
            Span::styled(bullet, style),
            Span::styled(wt.label(), style),
        ]))
    }).collect();

    let mut state = ListState::default();
    state.select(Some(tui.sel_wave));

    let block = Block::default()
        .title(Span::styled(" Waveform ", if is_active { Style::default().fg(C_ACTIVE).add_modifier(Modifier::BOLD) } else { Style::default().fg(C_DIM) }))
        .borders(Borders::ALL)
        .border_style(border_style(tui.active, ActiveField::Waveform));

    f.render_stateful_widget(
        List::new(items).block(block).highlight_style(Style::default().bg(Color::DarkGray)),
        area,
        &mut state,
    );
}

fn draw_params(f: &mut Frame, area: Rect, tui: &TuiState, cfg: &SimConfig) {
    let is_active = matches!(tui.active, ActiveField::Range | ActiveField::Base | ActiveField::Min | ActiveField::Max);
    let r = cfg.sim_range;

    // Range selector row
    let range_spans: Vec<Span> = [SimRange::MA, SimRange::UA, SimRange::NA].iter().map(|&sr| {
        let selected = sr == cfg.sim_range;
        let label = format!(" {} ", sr.label());
        if selected {
            Span::styled(label, Style::default().fg(Color::Black).bg(C_ACTIVE).add_modifier(Modifier::BOLD))
        } else {
            Span::styled(label, Style::default().fg(C_DIM))
        }
    }).collect();

    let field_val = |f: ActiveField, v: f64| -> Vec<Span<'static>> {
        let active = tui.active == f;
        let label = match f {
            ActiveField::Base => "  Base  ",
            ActiveField::Min  => "  Min   ",
            ActiveField::Max  => "  Max   ",
            _                 => "        ",
        };
        let val_str = r.fmt_amps(v);
        let hint = if active { "  ← ↑↓ →" } else { "" };
        vec![
            Span::styled(label,   Style::default().fg(C_DIM)),
            Span::styled(val_str, active_style(tui.active, f)),
            Span::styled(hint,    Style::default().fg(C_DIM)),
        ]
    };

    let range_line_label = Span::styled("  Range  ", Style::default().fg(C_DIM));
    let range_active = tui.active == ActiveField::Range;

    let lines: Vec<Line> = vec![
        Line::from(vec![Span::raw("")]),
        {
            let mut v = vec![range_line_label];
            v.extend(range_spans);
            if range_active { v.push(Span::styled("  ← ↑↓ →", Style::default().fg(C_DIM))); }
            Line::from(v)
        },
        Line::from(field_val(ActiveField::Base, cfg.base_amps)),
        Line::from(field_val(ActiveField::Min,  cfg.min_amps)),
        Line::from(field_val(ActiveField::Max,  cfg.max_amps)),
        Line::from(vec![Span::raw("")]),
        Line::from(vec![
            Span::styled("  Shift+↑↓ = 10× step", Style::default().fg(C_DIM)),
        ]),
    ];

    let block = Block::default()
        .title(Span::styled(" Parameters ", if is_active { Style::default().fg(C_ACTIVE).add_modifier(Modifier::BOLD) } else { Style::default().fg(C_DIM) }))
        .borders(Borders::ALL)
        .border_style(if is_active { Style::default().fg(C_ACTIVE) } else { Style::default().fg(C_DIM) });

    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn draw_live(f: &mut Frame, area: Rect, _tui: &TuiState, cfg: &SimConfig, dev: &DeviceInfo, recent: &VecDeque<f64>) {
    let inner_w = (area.width.saturating_sub(4)) as usize;
    let spark = sparkline(recent, inner_w.min(60));

    let last_str = dev.last_amps
        .map(|a| cfg.sim_range.fmt_amps(a))
        .unwrap_or_else(|| "—".into());

    let fmt_label = dev.fmt_label();

    let mut lines = vec![
        Line::from(vec![
            Span::styled("  Now: ", Style::default().fg(C_DIM)),
            Span::styled(last_str.trim().to_string(),
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
            Span::styled(format!("   {} samples   fmt:{}", dev.samples_sent, fmt_label),
                Style::default().fg(C_DIM)),
        ]),
        Line::from(vec![Span::raw("")]),
        Line::from(vec![Span::styled(format!("  {}", spark), Style::default().fg(C_ACCENT))]),
    ];

    // Last 6 values as text
    let vals: Vec<&f64> = recent.iter().rev().take(6).collect();
    if !vals.is_empty() {
        lines.push(Line::from(vec![Span::raw("")]));
        for v in vals.into_iter().rev() {
            lines.push(Line::from(vec![
                Span::styled(format!("  {}", cfg.sim_range.fmt_amps(*v).trim().to_string()),
                    Style::default().fg(C_DIM)),
            ]));
        }
    }

    let block = Block::default()
        .title(Span::styled(" Live Output ", Style::default().fg(C_DIM)))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(C_DIM));

    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn draw_footer(f: &mut Frame, area: Rect, _tui: &TuiState, dev: &DeviceInfo) {
    let log_col  = if dev.usb_logging { C_OK  } else { C_WARN };
    let conn_col = if dev.connected   { C_OK  } else { C_DIM  };
    let auto_col = if dev.autorange   { C_OK  } else { C_DIM  };
    let lpf_col  = if dev.lpf         { C_OK  } else { C_DIM  };
    let bias_col = if dev.bias        { C_OK  } else { C_DIM  };

    let status_line = Line::from(vec![
        Span::styled(" Device: ", Style::default().fg(C_DIM)),
        Span::styled(if dev.connected { "●" } else { "○" }, Style::default().fg(conn_col)),
        Span::styled("  LOG:", Style::default().fg(C_DIM)),
        Span::styled(if dev.usb_logging { "●" } else { "○" }, Style::default().fg(log_col)),
        Span::styled("  FMT:", Style::default().fg(C_DIM)),
        Span::styled(dev.fmt_label(), Style::default().fg(Color::White)),
        Span::styled("  RANGE:", Style::default().fg(C_DIM)),
        Span::styled(dev.dev_range.label(), Style::default().fg(Color::White)),
        Span::styled("  AUTO:", Style::default().fg(C_DIM)),
        Span::styled(if dev.autorange { "ON" } else { "OFF" }, Style::default().fg(auto_col)),
        Span::styled("  LPF:", Style::default().fg(C_DIM)),
        Span::styled(if dev.lpf  { "ON" } else { "OFF" }, Style::default().fg(lpf_col)),
        Span::styled("  BIAS:", Style::default().fg(C_DIM)),
        Span::styled(if dev.bias { "ON" } else { "OFF" }, Style::default().fg(bias_col)),
    ]);

    let key_line = Line::from(vec![
        Span::styled(" Tab", Style::default().fg(C_ACTIVE)),
        Span::styled("=next field  ", Style::default().fg(C_DIM)),
        Span::styled("↑↓", Style::default().fg(C_ACTIVE)),
        Span::styled("=waveform/value  ", Style::default().fg(C_DIM)),
        Span::styled("←→", Style::default().fg(C_ACTIVE)),
        Span::styled("=range/value  ", Style::default().fg(C_DIM)),
        Span::styled("Shift+↑↓", Style::default().fg(C_ACTIVE)),
        Span::styled("=10× step  ", Style::default().fg(C_DIM)),
        Span::styled("q", Style::default().fg(C_ACTIVE)),
        Span::styled("=quit", Style::default().fg(C_DIM)),
    ]);

    let block = Block::default().borders(Borders::ALL).border_style(Style::default().fg(C_DIM));
    f.render_widget(Paragraph::new(vec![status_line, key_line]).block(block), area);
}

// ── Key handling ──────────────────────────────────────────────────────────────

fn handle_key(
    key: crossterm::event::KeyEvent,
    tui: &mut TuiState,
    cfg: &Arc<Mutex<SimConfig>>,
) -> bool {
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let ctrl  = key.modifiers.contains(KeyModifiers::CONTROL);

    match key.code {
        KeyCode::Char('q') | KeyCode::Char('Q') if !ctrl => return true,
        KeyCode::Char('c') if ctrl                        => return true,

        KeyCode::Tab                  => { tui.active = tui.active.next(); }
        KeyCode::BackTab              => { tui.active = tui.active.prev(); }

        // Waveform navigation
        KeyCode::Up if tui.active == ActiveField::Waveform => {
            tui.sel_wave = if tui.sel_wave == 0 { WaveformType::ALL.len() - 1 } else { tui.sel_wave - 1 };
            let wt = WaveformType::ALL[tui.sel_wave];
            if let Ok(mut c) = cfg.lock() { c.waveform = wt; }
        }
        KeyCode::Down if tui.active == ActiveField::Waveform => {
            tui.sel_wave = (tui.sel_wave + 1) % WaveformType::ALL.len();
            let wt = WaveformType::ALL[tui.sel_wave];
            if let Ok(mut c) = cfg.lock() { c.waveform = wt; }
        }

        // Range cycling with ← →
        KeyCode::Left  | KeyCode::Right if tui.active == ActiveField::Range => {
            if let Ok(mut c) = cfg.lock() {
                let new_range = match (c.sim_range, key.code) {
                    (SimRange::MA, KeyCode::Right) | (SimRange::NA, KeyCode::Left)  => SimRange::UA,
                    (SimRange::UA, KeyCode::Right) | (SimRange::MA, KeyCode::Left)  => SimRange::NA,
                    (SimRange::UA, KeyCode::Left)  | (SimRange::NA, KeyCode::Right) => SimRange::MA,
                    _ => c.sim_range,
                };
                c.set_range(new_range);
            }
        }

        // Value adjustments for Base / Min / Max
        KeyCode::Up | KeyCode::Down | KeyCode::Left | KeyCode::Right
            if matches!(tui.active, ActiveField::Base | ActiveField::Min | ActiveField::Max) =>
        {
            let up = matches!(key.code, KeyCode::Up | KeyCode::Right);
            if let Ok(mut c) = cfg.lock() {
                let step = if shift { c.sim_range.large_step() } else { c.sim_range.small_step() };
                let delta = if up { step } else { -step };
                match tui.active {
                    ActiveField::Base => { c.base_amps = (c.base_amps + delta).max(0.0); }
                    ActiveField::Min  => { c.min_amps  = (c.min_amps  + delta).max(0.0); }
                    ActiveField::Max  => { c.max_amps  = (c.max_amps  + delta).max(0.0); }
                    _ => {}
                }
            }
        }

        // Number keys: quick waveform selection (1-9, then 0=10, then a=11, b=12)
        KeyCode::Char(c) => {
            let idx: Option<usize> = match c {
                '1'..='9' => Some((c as usize) - ('1' as usize)),
                '0'       => Some(9),
                'a' | 'A' => Some(10),
                'b' | 'B' => Some(11),
                _ => None,
            };
            if let Some(i) = idx {
                if i < WaveformType::ALL.len() {
                    tui.sel_wave = i;
                    let wt = WaveformType::ALL[i];
                    if let Ok(mut c) = cfg.lock() { c.waveform = wt; }
                }
            }
        }

        _ => {}
    }
    false
}

// ── TUI entry point ───────────────────────────────────────────────────────────

fn run_tui(
    cfg:    Arc<Mutex<SimConfig>>,
    info:   Arc<Mutex<DeviceInfo>>,
    recent: Arc<Mutex<VecDeque<f64>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;

    let backend  = CrosstermBackend::new(stdout);
    let mut term = Terminal::new(backend)?;
    let mut tui  = TuiState::new();

    loop {
        term.draw(|f| {
            let c = cfg.lock().unwrap();
            let d = info.lock().unwrap();
            let r = recent.lock().unwrap();
            draw_ui(f, &tui, &c, &d, &r);
        })?;

        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if handle_key(key, &mut tui, &cfg) { break; }
            }
        }
    }

    disable_raw_mode()?;
    execute!(term.backend_mut(), LeaveAlternateScreen)?;
    Ok(())
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let port_arg = args.get(1).cloned();

    let cfg    = Arc::new(Mutex::new(SimConfig::new()));
    let info   = Arc::new(Mutex::new(DeviceInfo::new()));
    let recent = Arc::new(Mutex::new(VecDeque::<f64>::with_capacity(64)));

    {
        let (c, i, r) = (cfg.clone(), info.clone(), recent.clone());
        std::thread::Builder::new()
            .name("serial".into())
            .spawn(move || serial_thread(port_arg, c, i, r))?;
    }

    // Brief pause so the serial thread can set up the PTY before the TUI draws
    std::thread::sleep(Duration::from_millis(80));

    run_tui(cfg, info, recent)?;
    Ok(())
}
