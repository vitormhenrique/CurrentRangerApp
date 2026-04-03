// protocol/mod.rs — CurrentRanger serial protocol parsing.
//
// The firmware (CR_R3.ino) outputs measurements in one of five formats
// depending on the LOGGING_FORMAT setting. We default-recommend EXPONENT
// because it is self-describing (unit encoded in exponent).
//
// Non-measurement lines (status messages) are also parsed here so the
// frontend can update the device settings model without polling.

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Logging format (mirrors firmware defines)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LoggingFormat {
    /// `<mantissa>E<exp>` — mantissa * 10^exp gives amps. Self-describing.
    Exponent,
    /// Raw integer nanoamps (nA)
    Nanos,
    /// Raw integer microamps (µA)
    Micros,
    /// Raw integer milliamps (mA)
    Millis,
    /// Raw 12-bit ADC count (0–4095). Range unknown without extra context.
    Adc,
}

impl Default for LoggingFormat {
    fn default() -> Self {
        Self::Exponent
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADC sampling speed
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AdcSamplingSpeed {
    #[default]
    Avg,
    Fast,
    Slow,
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-off mode
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AutoOff {
    #[default]
    Default,
    Disabled,
    Smart,
}

// ─────────────────────────────────────────────────────────────────────────────
// Device status snapshot
// ─────────────────────────────────────────────────────────────────────────────

/// Represents the known state of the device, updated by parsing status messages.
/// Fields are Option<> because we only learn them after querying.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub firmware_version: Option<String>,
    pub usb_logging: Option<bool>,
    pub bt_logging: Option<bool>,
    pub logging_format: Option<LoggingFormat>,
    pub adc_sampling_speed: Option<AdcSamplingSpeed>,
    pub auto_off: Option<AutoOff>,
    pub lpf_enabled: Option<bool>,
    pub bias_enabled: Option<bool>,
    pub autorange_enabled: Option<bool>,
    pub gpio_ranging_enabled: Option<bool>,
    pub adc_offset: Option<i32>,
    pub adc_gain: Option<u16>,
    pub ldo_voltage: Option<f32>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsed line variants
// ─────────────────────────────────────────────────────────────────────────────

/// Result of parsing one serial line from the device.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ParsedLine {
    /// A current measurement in amps. Timestamp is assigned by the host.
    Sample { amps: f64 },
    /// A device status update (e.g. "USB_LOGGING_ENABLED").
    StatusUpdate { update: StatusUpdate },
    /// The device sent a line we recognise but don't act on (e.g. menu text).
    Info { message: String },
    /// Unrecognised line — shown in the console for debugging.
    Unknown { raw: String },
}

/// Structured status updates we care about.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StatusUpdate {
    UsbLogging { enabled: bool },
    BtLogging { enabled: bool },
    LoggingFormat { format: LoggingFormat },
    AdcSamplingSpeed { speed: AdcSamplingSpeed },
    AutoOff { mode: AutoOff },
    GpioRanging { enabled: bool },
    TouchDebug { enabled: bool },
    SettingsReset,
    FirmwareVersion { version: String },
    AdcOffset { value: i32 },
    AdcGain { value: u16 },
    LdoVoltage { value: f32 },
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

/// Parse one UTF-8 line from the device.
///
/// The caller is responsible for stripping newlines. The active `format`
/// parameter is used to interpret numeric-only lines correctly.
pub fn parse_line(raw: &str, format: LoggingFormat) -> ParsedLine {
    let line = raw.trim();

    if line.is_empty() {
        return ParsedLine::Unknown {
            raw: line.to_string(),
        };
    }

    // Try measurement formats first
    if let Some(amps) = try_parse_measurement(line, format) {
        return ParsedLine::Sample { amps };
    }

    // Try status messages
    if let Some(update) = try_parse_status(line) {
        return ParsedLine::StatusUpdate { update };
    }

    // Firmware version / menu header
    if line.contains("CurrentRanger R3") {
        if let Some(v) = extract_firmware_version(line) {
            return ParsedLine::StatusUpdate {
                update: StatusUpdate::FirmwareVersion { version: v },
            };
        }
        return ParsedLine::Info {
            message: line.to_string(),
        };
    }

    // Known info-only lines (menu text, calib info)
    if line.starts_with("ADC calibration")
        || line.starts_with("EEPROM Settings")
        || line.starts_with("Offset=")
        || line.starts_with("Gain=")
        || line.starts_with("LDO=")
        || line.starts_with("LoggingFormat=")
        || line.starts_with("ADCSamplingSpeed=")
        || line.starts_with("AutoOff=")
        || line.starts_with("BT Logging:")
        || line.starts_with("USB Logging:")
        || line.starts_with("new ")
        || line.starts_with("Bluetooth")
        || line.starts_with("OLED")
        || line.starts_with("NO OLED")
    {
        // Extract calibration values from key=value lines
        if let Some(stripped) = line.strip_prefix("Offset=") {
            if let Ok(v) = stripped.trim().parse::<i32>() {
                return ParsedLine::StatusUpdate {
                    update: StatusUpdate::AdcOffset { value: v },
                };
            }
        }
        if let Some(stripped) = line.strip_prefix("Gain=") {
            if let Ok(v) = stripped.trim().parse::<u16>() {
                return ParsedLine::StatusUpdate {
                    update: StatusUpdate::AdcGain { value: v },
                };
            }
        }
        if let Some(stripped) = line.strip_prefix("LDO=") {
            if let Ok(v) = stripped.trim().parse::<f32>() {
                return ParsedLine::StatusUpdate {
                    update: StatusUpdate::LdoVoltage { value: v },
                };
            }
        }
        // Parse "LoggingFormat=N" where N is 0-4
        if let Some(stripped) = line.strip_prefix("LoggingFormat=") {
            let fmt = match stripped.trim() {
                "0" => Some(LoggingFormat::Exponent),
                "1" => Some(LoggingFormat::Nanos),
                "2" => Some(LoggingFormat::Micros),
                "3" => Some(LoggingFormat::Millis),
                "4" => Some(LoggingFormat::Adc),
                _ => None,
            };
            if let Some(f) = fmt {
                return ParsedLine::StatusUpdate {
                    update: StatusUpdate::LoggingFormat { format: f },
                };
            }
        }
        // Parse "ADCSamplingSpeed=N" where N is 0-2
        if let Some(stripped) = line.strip_prefix("ADCSamplingSpeed=") {
            let spd = match stripped.trim() {
                "0" => Some(AdcSamplingSpeed::Avg),
                "1" => Some(AdcSamplingSpeed::Fast),
                "2" => Some(AdcSamplingSpeed::Slow),
                _ => None,
            };
            if let Some(s) = spd {
                return ParsedLine::StatusUpdate {
                    update: StatusUpdate::AdcSamplingSpeed { speed: s },
                };
            }
        }
        // Parse "AutoOff=DISABLED|SMART|<number>"
        if let Some(stripped) = line.strip_prefix("AutoOff=") {
            let mode = match stripped.trim() {
                "DISABLED" => Some(AutoOff::Disabled),
                "SMART" => Some(AutoOff::Smart),
                _ => Some(AutoOff::Default),
            };
            if let Some(m) = mode {
                return ParsedLine::StatusUpdate {
                    update: StatusUpdate::AutoOff { mode: m },
                };
            }
        }
        // Parse "USB Logging: 0|1"
        if let Some(stripped) = line.strip_prefix("USB Logging:") {
            let enabled = stripped.trim() == "1";
            return ParsedLine::StatusUpdate {
                update: StatusUpdate::UsbLogging { enabled },
            };
        }
        // Parse "BT Logging: 0|1"
        if let Some(stripped) = line.strip_prefix("BT Logging:") {
            let enabled = stripped.trim() == "1";
            return ParsedLine::StatusUpdate {
                update: StatusUpdate::BtLogging { enabled },
            };
        }
        return ParsedLine::Info {
            message: line.to_string(),
        };
    }

    // Anything else: menu lines, etc
    if line.len() > 2 && (line.contains(" = ") || line.starts_with("  ") || line.starts_with("a ")
        || line.starts_with("b ")
        || line.starts_with("f ")
        || line.starts_with("s ")
        || line.starts_with("u ")
        || line.starts_with("?"))
    {
        return ParsedLine::Info {
            message: line.to_string(),
        };
    }

    ParsedLine::Unknown {
        raw: line.to_string(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurement parsing
// ─────────────────────────────────────────────────────────────────────────────

/// Try to parse a measurement line. Returns amps on success.
fn try_parse_measurement(line: &str, format: LoggingFormat) -> Option<f64> {
    match format {
        LoggingFormat::Exponent => parse_exponent_format(line),
        LoggingFormat::Nanos => parse_raw_numeric(line).map(|v| v * 1e-9),
        LoggingFormat::Micros => parse_raw_numeric(line).map(|v| v * 1e-6),
        LoggingFormat::Millis => parse_raw_numeric(line).map(|v| v * 1e-3),
        LoggingFormat::Adc => {
            // ADC counts: we store them as-is (no unit conversion possible
            // without knowing the current range). We encode as a special
            // "negative infinity" sentinel? No — just return None so callers
            // can treat ADC samples as raw. Actually store as raw f64 count.
            parse_raw_numeric(line)
        }
    }
}

/// Parse `<mantissa>E<exponent>` — the default firmware logging format.
///
/// Example: `1234E-6` = 1234 × 10^-6 A = 1.234 mA
/// Example: `456.7E-9` = 456.7 nA
///
/// The firmware outputs this without spaces. The exponent can be negative.
pub fn parse_exponent_format(line: &str) -> Option<f64> {
    // Find 'E' or 'e' separator — firmware may use either case depending on
    // version/format (e.g. "1234E-6" or "-0.40e-3")
    let e_pos = line.find('E').or_else(|| line.find('e'))?;
    let mantissa_str = &line[..e_pos];
    let exp_str = &line[e_pos + 1..];

    let mantissa: f64 = mantissa_str.parse().ok()?;
    let exponent: i32 = exp_str.parse().ok()?;

    Some(mantissa * 10f64.powi(exponent))
}

/// Parse a plain numeric line (integers or floats).
fn parse_raw_numeric(line: &str) -> Option<f64> {
    // Only accept lines that look purely numeric (with optional sign/dot)
    if line
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c == '+')
    {
        line.parse::<f64>().ok()
    } else {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status message parsing
// ─────────────────────────────────────────────────────────────────────────────

fn try_parse_status(line: &str) -> Option<StatusUpdate> {
    match line {
        "USB_LOGGING_ENABLED" => Some(StatusUpdate::UsbLogging { enabled: true }),
        "USB_LOGGING_DISABLED" => Some(StatusUpdate::UsbLogging { enabled: false }),
        "BT_LOGGING_ENABLED" => Some(StatusUpdate::BtLogging { enabled: true }),
        "BT_LOGGING_DISABLED" => Some(StatusUpdate::BtLogging { enabled: false }),
        "GPIO_HEADER_RANGING_ENABLED" => Some(StatusUpdate::GpioRanging { enabled: true }),
        "GPIO_HEADER_RANGING_DISABLED" => Some(StatusUpdate::GpioRanging { enabled: false }),
        "TOUCH_DEBUG_ENABLED" => Some(StatusUpdate::TouchDebug { enabled: true }),
        "TOUCH_DEBUG_DISABLED" => Some(StatusUpdate::TouchDebug { enabled: false }),
        "SETTINGS_RESET" => Some(StatusUpdate::SettingsReset),
        "LOGGING_FORMAT_EXPONENT" => Some(StatusUpdate::LoggingFormat {
            format: LoggingFormat::Exponent,
        }),
        "LOGGING_FORMAT_NANOS" => Some(StatusUpdate::LoggingFormat {
            format: LoggingFormat::Nanos,
        }),
        "LOGGING_FORMAT_MICROS" => Some(StatusUpdate::LoggingFormat {
            format: LoggingFormat::Micros,
        }),
        "LOGGING_FORMAT_MILLIS" => Some(StatusUpdate::LoggingFormat {
            format: LoggingFormat::Millis,
        }),
        "LOGGING_FORMAT_ADC" => Some(StatusUpdate::LoggingFormat {
            format: LoggingFormat::Adc,
        }),
        "ADC_SAMPLING_SPEED_AVG" => Some(StatusUpdate::AdcSamplingSpeed {
            speed: AdcSamplingSpeed::Avg,
        }),
        "ADC_SAMPLING_SPEED_FAST" => Some(StatusUpdate::AdcSamplingSpeed {
            speed: AdcSamplingSpeed::Fast,
        }),
        "ADC_SAMPLING_SPEED_SLOW" => Some(StatusUpdate::AdcSamplingSpeed {
            speed: AdcSamplingSpeed::Slow,
        }),
        "AUTOOFF_DEFAULT" => Some(StatusUpdate::AutoOff {
            mode: AutoOff::Default,
        }),
        "AUTOOFF_DISABLED" => Some(StatusUpdate::AutoOff {
            mode: AutoOff::Disabled,
        }),
        "AUTOOFF_SMART" => Some(StatusUpdate::AutoOff {
            mode: AutoOff::Smart,
        }),
        _ => None,
    }
}

fn extract_firmware_version(line: &str) -> Option<String> {
    // "CurrentRanger R3 (firmware v. 1.1.7)"
    let start = line.find("firmware v. ")? + "firmware v. ".len();
    let rest = &line[start..];
    let end = rest.find(')').unwrap_or(rest.len());
    let version = rest[..end].trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exponent_milli() {
        let a = parse_exponent_format("1234E-3").unwrap();
        assert!((a - 1.234).abs() < 1e-9);
    }

    #[test]
    fn test_exponent_micro() {
        let a = parse_exponent_format("500E-6").unwrap();
        assert!((a - 500e-6).abs() < 1e-15);
    }

    #[test]
    fn test_exponent_nano() {
        let a = parse_exponent_format("42E-9").unwrap();
        assert!((a - 42e-9).abs() < 1e-18);
    }

    #[test]
    fn test_exponent_negative_current() {
        let a = parse_exponent_format("-100E-6").unwrap();
        assert!((a - (-100e-6)).abs() < 1e-15);
    }

    #[test]
    fn test_exponent_with_decimal_mantissa() {
        // Firmware sometimes outputs fractional mantissa
        let a = parse_exponent_format("1.5E-3").unwrap();
        assert!((a - 1.5e-3).abs() < 1e-12);
    }

    #[test]
    fn test_nanos_format() {
        let result = parse_line("1000", LoggingFormat::Nanos);
        if let ParsedLine::Sample { amps } = result {
            assert!((amps - 1e-6).abs() < 1e-15);
        } else {
            panic!("expected Sample");
        }
    }

    #[test]
    fn test_micros_format() {
        let result = parse_line("1000", LoggingFormat::Micros);
        if let ParsedLine::Sample { amps } = result {
            assert!((amps - 1e-3).abs() < 1e-12);
        } else {
            panic!("expected Sample");
        }
    }

    #[test]
    fn test_status_usb_enabled() {
        let result = parse_line("USB_LOGGING_ENABLED", LoggingFormat::Exponent);
        assert!(matches!(
            result,
            ParsedLine::StatusUpdate {
                update: StatusUpdate::UsbLogging { enabled: true }
            }
        ));
    }

    #[test]
    fn test_status_logging_format() {
        let result = parse_line("LOGGING_FORMAT_NANOS", LoggingFormat::Exponent);
        assert!(matches!(
            result,
            ParsedLine::StatusUpdate {
                update: StatusUpdate::LoggingFormat {
                    format: LoggingFormat::Nanos
                }
            }
        ));
    }

    #[test]
    fn test_firmware_version_extraction() {
        let v = extract_firmware_version("CurrentRanger R3 (firmware v. 1.1.7)").unwrap();
        assert_eq!(v, "1.1.7");
    }

    #[test]
    fn test_empty_line_unknown() {
        let result = parse_line("", LoggingFormat::Exponent);
        assert!(matches!(result, ParsedLine::Unknown { .. }));
    }

    #[test]
    fn test_settings_reset() {
        let result = parse_line("SETTINGS_RESET", LoggingFormat::Exponent);
        assert!(matches!(
            result,
            ParsedLine::StatusUpdate {
                update: StatusUpdate::SettingsReset
            }
        ));
    }
}
