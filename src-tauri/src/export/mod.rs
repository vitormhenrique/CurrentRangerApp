// export/mod.rs — CSV and JSON data export.

use crate::data::Marker;
use crate::workspace::SampleRecord;
use anyhow::Result;
use chrono::Utc;
use serde::Serialize;
use std::path::Path;

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

/// Export samples to CSV.
/// Format: `time_s,elapsed_s,current_a,current_ma,current_ua,current_na`
pub fn export_csv(
    samples: &[SampleRecord],
    path: &Path,
    voltage_v: Option<f64>,
) -> Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);

    // Metadata header
    writeln!(f, "# CurrentRanger export — {}", Utc::now().to_rfc3339())?;
    writeln!(
        f,
        "# Timestamps are host-side (no device timestamps in stock firmware)"
    )?;
    if let Some(v) = voltage_v {
        writeln!(f, "# Voltage for energy calculations: {} V", v)?;
    }
    writeln!(f, "#")?;

    // Column headers
    writeln!(
        f,
        "time_unix_s,elapsed_s,current_a,current_ma,current_ua,current_na"
    )?;

    let t0 = samples.first().map(|s| s.t).unwrap_or(0.0);
    for s in samples {
        let elapsed = s.t - t0;
        if !s.a.is_finite() {
            // NaN gap sentinel — write empty current fields to preserve the time break
            writeln!(f, "{:.6},{:.6},,,,", s.t, elapsed)?;
            continue;
        }
        let ma = s.a * 1e3;
        let ua = s.a * 1e6;
        let na = s.a * 1e9;
        writeln!(
            f,
            "{:.6},{:.6},{:.12e},{:.6},{:.3},{:.1}",
            s.t, elapsed, s.a, ma, ua, na
        )?;
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON export
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonExport<'a> {
    pub export_version: u32,
    pub exported_at: String,
    pub voltage_v: Option<f64>,
    /// Host-side note about timestamps
    pub timestamp_note: &'static str,
    pub sample_count: usize,
    pub samples: &'a [SampleRecord],
    pub markers: &'a [Marker],
}

pub fn export_json(
    samples: &[SampleRecord],
    markers: &[Marker],
    path: &Path,
    voltage_v: Option<f64>,
) -> Result<()> {
    let payload = JsonExport {
        export_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        voltage_v,
        timestamp_note:
            "Timestamps are assigned on the host at time of USB receipt. \
             No device-side timestamps exist in stock CurrentRanger firmware.",
        sample_count: samples.len(),
        samples,
        markers,
    };
    let json = serde_json::to_string_pretty(&payload)?;
    std::fs::write(path, json)?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker CSV export
// ─────────────────────────────────────────────────────────────────────────────

pub fn export_markers_csv(markers: &[Marker], path: &Path) -> Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    writeln!(f, "time_unix_s,label,category,color,note")?;
    for m in markers {
        writeln!(
            f,
            "{:.6},{},{:?},{},\"{}\"",
            m.timestamp,
            m.label,
            m.category,
            m.color,
            m.note.replace('"', "\"\"")
        )?;
    }
    Ok(())
}
