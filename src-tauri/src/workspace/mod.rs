// workspace/mod.rs — Workspace save/load with versioned JSON format.
//
// # Format
// A workspace is a single JSON file with a top-level `version` field.
// All fields are optional so partial workspaces can be loaded gracefully.
// Future migrations hook on the version field.
//
// # Atomic Writes
// We write to a `.tmp` file and rename atomically to avoid corruption on crash.

use crate::data::{Marker, Sample, SampleStats};
use crate::protocol::{DeviceStatus, LoggingFormat};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace data model
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub schema_version: u32,
    /// RFC 3339 timestamp of last save
    pub saved_at: String,
    pub app_settings: AppSettings,
    pub session: SessionData,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub voltage_v: f64,
    pub logging_format: LoggingFormat,
    pub time_window_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    pub samples: Vec<SampleRecord>,
    pub markers: Vec<Marker>,
    pub device_status: DeviceStatus,
    pub stats: Option<SampleStats>,
}

/// A flattened sample record for JSON storage (avoids nested objects).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SampleRecord {
    pub t: f64,
    pub a: f64,
}

impl From<&Sample> for SampleRecord {
    fn from(s: &Sample) -> Self {
        Self {
            t: s.timestamp,
            a: s.amps,
        }
    }
}

impl From<&SampleRecord> for Sample {
    fn from(r: &SampleRecord) -> Self {
        Self {
            timestamp: r.t,
            amps: r.a,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Save / Load
// ─────────────────────────────────────────────────────────────────────────────

pub fn save_workspace(workspace: &Workspace, path: &Path) -> Result<()> {
    let json = serde_json::to_string_pretty(workspace)?;

    // Atomic write: write to .tmp then rename
    let tmp_path = path.with_extension("tmp");
    std::fs::write(&tmp_path, &json)?;
    std::fs::rename(&tmp_path, path)?;

    Ok(())
}

pub fn load_workspace(path: &Path) -> Result<Workspace> {
    let json = std::fs::read_to_string(path)?;
    let ws: Workspace = serde_json::from_str(&json)?;
    let migrated = migrate(ws)?;
    Ok(migrated)
}

/// Apply schema migrations. Currently only version 1 exists.
fn migrate(mut ws: Workspace) -> Result<Workspace> {
    // Future: match on ws.schema_version and upgrade field by field
    if ws.schema_version > CURRENT_SCHEMA_VERSION {
        anyhow::bail!(
            "Workspace was saved with a newer version of the app (schema v{}). \
             Please update CurrentRanger Desktop.",
            ws.schema_version
        );
    }
    ws.schema_version = CURRENT_SCHEMA_VERSION;
    Ok(ws)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_workspace() -> Workspace {
        Workspace {
            schema_version: CURRENT_SCHEMA_VERSION,
            saved_at: "2026-04-02T00:00:00Z".to_string(),
            app_settings: AppSettings {
                voltage_v: 3.3,
                logging_format: LoggingFormat::Exponent,
                time_window_s: 30.0,
            },
            session: SessionData {
                samples: vec![
                    SampleRecord { t: 0.0, a: 1e-3 },
                    SampleRecord { t: 1.0, a: 2e-3 },
                ],
                markers: vec![],
                device_status: DeviceStatus::default(),
                stats: None,
            },
        }
    }

    #[test]
    fn test_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.crws");
        let ws = make_workspace();

        save_workspace(&ws, &path).unwrap();
        let loaded = load_workspace(&path).unwrap();

        assert_eq!(loaded.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(loaded.app_settings.voltage_v, ws.app_settings.voltage_v);
        assert_eq!(loaded.session.samples.len(), 2);
        assert!((loaded.session.samples[0].a - 1e-3).abs() < 1e-12);
        assert!((loaded.session.samples[1].a - 2e-3).abs() < 1e-12);
    }

    #[test]
    fn test_atomic_write_no_corruption() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.crws");
        let ws = make_workspace();

        // Save twice — second save should overwrite cleanly
        save_workspace(&ws, &path).unwrap();
        save_workspace(&ws, &path).unwrap();

        let loaded = load_workspace(&path).unwrap();
        assert_eq!(loaded.session.samples.len(), 2);
    }

    #[test]
    fn test_future_version_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("future.crws");
        let mut ws = make_workspace();
        ws.schema_version = 9999;

        let json = serde_json::to_string_pretty(&ws).unwrap();
        std::fs::write(&path, json).unwrap();

        assert!(load_workspace(&path).is_err());
    }
}
