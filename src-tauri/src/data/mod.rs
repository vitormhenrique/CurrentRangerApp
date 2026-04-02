// data/mod.rs — In-memory sample store.
//
// Stores timestamped current samples in a ring buffer.
// Thread-safe via Mutex at the AppState level.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One timestamped current measurement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// Unix timestamp (seconds since epoch, float for sub-second precision)
    pub timestamp: f64,
    /// Current in amps
    pub amps: f64,
}

impl Sample {
    pub fn new(amps: f64) -> Self {
        let ts = Utc::now();
        Self {
            timestamp: ts.timestamp() as f64 + ts.timestamp_subsec_nanos() as f64 * 1e-9,
            amps,
        }
    }

    pub fn with_timestamp(amps: f64, ts: DateTime<Utc>) -> Self {
        Self {
            timestamp: ts.timestamp() as f64 + ts.timestamp_subsec_nanos() as f64 * 1e-9,
            amps,
        }
    }
}

/// A user-placed annotation marker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub timestamp: f64,
    pub label: String,
    pub note: String,
    pub category: MarkerCategory,
    pub color: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MarkerCategory {
    #[default]
    Note,
    Boot,
    Idle,
    Sleep,
    RadioTx,
    SensorSample,
    Custom,
}

/// Batch of samples returned to the frontend.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleBatch {
    /// Parallel arrays for performance (avoids per-sample object overhead in JS)
    pub timestamps: Vec<f64>,
    pub amps: Vec<f64>,
    /// Index of the first new sample since last call (0 = all are new)
    pub start_index: usize,
}

/// Simplified stats over a slice of samples.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SampleStats {
    pub count: usize,
    pub min_amps: f64,
    pub max_amps: f64,
    pub avg_amps: f64,
    pub duration_s: f64,
    pub rate_hz: f64,
}

/// Ring-buffer sample store. Capped at MAX_SAMPLES to bound memory use.
/// Oldest samples are dropped when the cap is reached.
pub struct SampleStore {
    /// Timestamps (seconds, float)
    pub timestamps: Vec<f64>,
    /// Current measurements (amps)
    pub amps: Vec<f64>,
    /// User annotations
    pub markers: Vec<Marker>,
    /// How many samples have been pushed ever (monotonic)
    pub total_pushed: usize,
    cap: usize,
}

const MAX_SAMPLES: usize = 2_000_000; // ~27 min at 1200 Hz

impl SampleStore {
    pub fn new() -> Self {
        Self {
            timestamps: Vec::with_capacity(4096),
            amps: Vec::with_capacity(4096),
            markers: Vec::new(),
            total_pushed: 0,
            cap: MAX_SAMPLES,
        }
    }

    /// Push a new sample. Drops the oldest if over cap.
    pub fn push(&mut self, sample: Sample) {
        if self.timestamps.len() >= self.cap {
            // Drain oldest 10% to amortise the cost
            let drain_count = self.cap / 10;
            self.timestamps.drain(..drain_count);
            self.amps.drain(..drain_count);
        }
        self.timestamps.push(sample.timestamp);
        self.amps.push(sample.amps);
        self.total_pushed += 1;
    }

    pub fn clear(&mut self) {
        self.timestamps.clear();
        self.amps.clear();
        self.total_pushed = 0;
        // Keep markers — user placed them intentionally
    }

    pub fn len(&self) -> usize {
        self.timestamps.len()
    }

    pub fn is_empty(&self) -> bool {
        self.timestamps.is_empty()
    }

    /// Return all samples as a batch (copies data).
    pub fn snapshot(&self) -> SampleBatch {
        SampleBatch {
            timestamps: self.timestamps.clone(),
            amps: self.amps.clone(),
            start_index: 0,
        }
    }

    /// Return only new samples since `since_index`.
    pub fn snapshot_since(&self, since_index: usize) -> SampleBatch {
        let start = since_index.min(self.len());
        SampleBatch {
            timestamps: self.timestamps[start..].to_vec(),
            amps: self.amps[start..].to_vec(),
            start_index: start,
        }
    }

    /// Compute stats over the full buffer.
    pub fn stats(&self) -> SampleStats {
        stats_for_slice(&self.timestamps, &self.amps)
    }

    /// Compute stats over a time window [t_start, t_end].
    pub fn stats_window(&self, t_start: f64, t_end: f64) -> SampleStats {
        let pairs: Vec<(f64, f64)> = self
            .timestamps
            .iter()
            .zip(self.amps.iter())
            .filter(|(&t, _)| t >= t_start && t <= t_end)
            .map(|(&t, &a)| (t, a))
            .collect();
        let ts: Vec<f64> = pairs.iter().map(|(t, _)| *t).collect();
        let am: Vec<f64> = pairs.iter().map(|(_, a)| *a).collect();
        stats_for_slice(&ts, &am)
    }
}

fn stats_for_slice(timestamps: &[f64], amps: &[f64]) -> SampleStats {
    let count = amps.len();
    if count == 0 {
        return SampleStats::default();
    }
    let min_amps = amps.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_amps = amps.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let avg_amps = amps.iter().sum::<f64>() / count as f64;
    let duration_s = if timestamps.len() >= 2 {
        timestamps.last().unwrap() - timestamps.first().unwrap()
    } else {
        0.0
    };
    let rate_hz = if duration_s > 0.0 {
        count as f64 / duration_s
    } else {
        0.0
    };
    SampleStats {
        count,
        min_amps,
        max_amps,
        avg_amps,
        duration_s,
        rate_hz,
    }
}
