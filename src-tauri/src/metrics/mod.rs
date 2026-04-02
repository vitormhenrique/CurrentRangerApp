// metrics/mod.rs — Charge/energy integration and battery estimation math.
//
// All calculations are host-side (firmware provides no integrated values).
// Voltage for energy calculations is always user-supplied.
//
// # Integration method
// Trapezoidal rule: for each consecutive pair of timestamped samples,
// charge += avg_current * delta_time. This is the standard numerical
// integral and matches what the Python reference effectively does.

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Integration input/output
// ─────────────────────────────────────────────────────────────────────────────

/// Input for integration: parallel arrays of timestamps and current values.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationInput {
    pub timestamps: Vec<f64>, // seconds since epoch (float)
    pub amps: Vec<f64>,
    /// User-supplied voltage (volts) for energy calculation
    pub voltage: f64,
}

/// Computed integration results.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationResult {
    pub charge_coulombs: f64,
    pub charge_mah: f64,
    pub charge_ah: f64,
    pub energy_joules: f64,
    pub energy_wh: f64,
    pub energy_mwh: f64,
    pub duration_s: f64,
    pub avg_amps: f64,
    pub sample_count: usize,
}

/// Compute charge and energy via the trapezoidal rule.
pub fn integrate(input: &IntegrationInput) -> IntegrationResult {
    let ts = &input.timestamps;
    let amps = &input.amps;
    let n = ts.len().min(amps.len());

    if n < 2 {
        return IntegrationResult {
            sample_count: n,
            avg_amps: amps.first().cloned().unwrap_or(0.0),
            ..Default::default()
        };
    }

    let duration_s = ts[n - 1] - ts[0];
    let mut charge_coulombs = 0.0f64;

    for i in 1..n {
        let dt = ts[i] - ts[i - 1];
        if dt <= 0.0 {
            continue;
        }
        let avg_i = (amps[i - 1] + amps[i]) * 0.5;
        charge_coulombs += avg_i * dt;
    }

    // Derived units
    let charge_ah = charge_coulombs / 3600.0;
    let charge_mah = charge_ah * 1000.0;
    let energy_joules = charge_coulombs * input.voltage;
    let energy_wh = energy_joules / 3600.0;
    let energy_mwh = energy_wh * 1000.0;
    let avg_amps = if duration_s > 0.0 {
        charge_coulombs / duration_s
    } else {
        amps[0]
    };

    IntegrationResult {
        charge_coulombs,
        charge_mah,
        charge_ah,
        energy_joules,
        energy_wh,
        energy_mwh,
        duration_s,
        avg_amps,
        sample_count: n,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Battery tools
// ─────────────────────────────────────────────────────────────────────────────

/// Inputs for battery runtime estimation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryRuntimeInput {
    /// Battery capacity in mAh
    pub capacity_mah: f64,
    /// Average current draw in amps (from measurement or user-input)
    pub avg_current_amps: f64,
    /// Regulator/circuit efficiency (0.0–1.0, default 1.0 = ideal)
    pub efficiency: f64,
    /// Usable depth of discharge (0.0–1.0, default 1.0 = full capacity usable)
    pub depth_of_discharge: f64,
    /// Aging/safety margin factor (0.0–1.0, default 1.0 = no margin)
    pub aging_margin: f64,
}

/// Result of runtime estimation.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryRuntimeResult {
    /// Estimated runtime in hours (conservative)
    pub runtime_hours: f64,
    pub runtime_minutes: f64,
    pub runtime_seconds: f64,
    /// Effective capacity after derating (mAh)
    pub effective_capacity_mah: f64,
    /// Effective current after efficiency (mA)
    pub effective_current_ma: f64,
}

pub fn estimate_runtime(input: &BatteryRuntimeInput) -> Result<BatteryRuntimeResult, String> {
    if input.avg_current_amps <= 0.0 {
        return Err("Average current must be positive".to_string());
    }
    if input.capacity_mah <= 0.0 {
        return Err("Battery capacity must be positive".to_string());
    }

    let efficiency = input.efficiency.clamp(0.01, 1.0);
    let dod = input.depth_of_discharge.clamp(0.01, 1.0);
    let aging = input.aging_margin.clamp(0.01, 1.0);

    let effective_capacity_mah = input.capacity_mah * dod * aging;
    let avg_current_ma = input.avg_current_amps * 1000.0;
    let effective_current_ma = avg_current_ma / efficiency;

    let runtime_hours = effective_capacity_mah / effective_current_ma;
    let runtime_minutes = runtime_hours * 60.0;
    let runtime_seconds = runtime_hours * 3600.0;

    Ok(BatteryRuntimeResult {
        runtime_hours,
        runtime_minutes,
        runtime_seconds,
        effective_capacity_mah,
        effective_current_ma,
    })
}

/// Inputs for required battery capacity estimation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredCapacityInput {
    /// Desired runtime in hours
    pub desired_runtime_hours: f64,
    /// Average current draw in amps
    pub avg_current_amps: f64,
    pub efficiency: f64,
    pub depth_of_discharge: f64,
    pub aging_margin: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredCapacityResult {
    /// Required capacity in mAh (conservative, after derating)
    pub required_capacity_mah: f64,
    pub required_capacity_ah: f64,
    /// What the cell must be rated at to meet the requirement
    pub rated_capacity_mah: f64,
}

pub fn estimate_required_capacity(
    input: &RequiredCapacityInput,
) -> Result<RequiredCapacityResult, String> {
    if input.avg_current_amps <= 0.0 {
        return Err("Average current must be positive".to_string());
    }
    if input.desired_runtime_hours <= 0.0 {
        return Err("Desired runtime must be positive".to_string());
    }

    let efficiency = input.efficiency.clamp(0.01, 1.0);
    let dod = input.depth_of_discharge.clamp(0.01, 1.0);
    let aging = input.aging_margin.clamp(0.01, 1.0);

    let avg_current_ma = input.avg_current_amps * 1000.0;
    let effective_current_ma = avg_current_ma / efficiency;
    let required_capacity_mah = effective_current_ma * input.desired_runtime_hours;
    let rated_capacity_mah = required_capacity_mah / (dod * aging);

    Ok(RequiredCapacityResult {
        required_capacity_mah,
        required_capacity_ah: required_capacity_mah / 1000.0,
        rated_capacity_mah,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    #[test]
    fn test_integrate_constant_current() {
        // 1 mA for 1 second = 1e-3 C = 1/3.6 mAh
        let input = IntegrationInput {
            timestamps: vec![0.0, 1.0],
            amps: vec![1e-3, 1e-3],
            voltage: 3.3,
        };
        let r = integrate(&input);
        assert!(approx_eq(r.charge_coulombs, 1e-3, 1e-9));
        assert!(approx_eq(r.charge_mah, 1e-3 / 3.6, 1e-9));
        assert!(approx_eq(r.energy_joules, 1e-3 * 3.3, 1e-9));
    }

    #[test]
    fn test_integrate_trapezoidal_ramp() {
        // Current ramps from 0 to 2 mA over 1 second
        // Integral = 0.5 * base * height = 0.5 * 1 * 2e-3 = 1e-3 C
        let input = IntegrationInput {
            timestamps: vec![0.0, 1.0],
            amps: vec![0.0, 2e-3],
            voltage: 1.0,
        };
        let r = integrate(&input);
        assert!(approx_eq(r.charge_coulombs, 1e-3, 1e-12));
    }

    #[test]
    fn test_integrate_empty() {
        let input = IntegrationInput {
            timestamps: vec![],
            amps: vec![],
            voltage: 3.3,
        };
        let r = integrate(&input);
        assert_eq!(r.sample_count, 0);
        assert!(approx_eq(r.charge_coulombs, 0.0, 1e-15));
    }

    #[test]
    fn test_battery_runtime_1ma_1000mah() {
        // 1000 mAh / 1 mA = 1000 hours (ideal)
        let input = BatteryRuntimeInput {
            capacity_mah: 1000.0,
            avg_current_amps: 1e-3,
            efficiency: 1.0,
            depth_of_discharge: 1.0,
            aging_margin: 1.0,
        };
        let r = estimate_runtime(&input).unwrap();
        assert!(approx_eq(r.runtime_hours, 1000.0, 0.001));
    }

    #[test]
    fn test_battery_runtime_with_derating() {
        // 1000 mAh, 1 mA, 90% efficiency, 80% DoD, 90% aging
        let input = BatteryRuntimeInput {
            capacity_mah: 1000.0,
            avg_current_amps: 1e-3,
            efficiency: 0.9,
            depth_of_discharge: 0.8,
            aging_margin: 0.9,
        };
        let r = estimate_runtime(&input).unwrap();
        // effective_capacity = 1000 * 0.8 * 0.9 = 720 mAh
        // effective_current = 1 / 0.9 = 1.111 mA
        // runtime = 720 / 1.111 = 648 h
        assert!(approx_eq(r.runtime_hours, 720.0 / (1.0 / 0.9), 0.01));
    }

    #[test]
    fn test_required_capacity_10h_at_10ma() {
        let input = RequiredCapacityInput {
            desired_runtime_hours: 10.0,
            avg_current_amps: 10e-3,
            efficiency: 1.0,
            depth_of_discharge: 1.0,
            aging_margin: 1.0,
        };
        let r = estimate_required_capacity(&input).unwrap();
        assert!(approx_eq(r.required_capacity_mah, 100.0, 0.001));
        assert!(approx_eq(r.rated_capacity_mah, 100.0, 0.001));
    }

    #[test]
    fn test_required_capacity_rejects_zero_current() {
        let input = RequiredCapacityInput {
            desired_runtime_hours: 10.0,
            avg_current_amps: 0.0,
            efficiency: 1.0,
            depth_of_discharge: 1.0,
            aging_margin: 1.0,
        };
        assert!(estimate_required_capacity(&input).is_err());
    }

    #[test]
    fn test_unit_conversions_coulombs_to_mah() {
        // 3600 C = 1 Ah = 1000 mAh
        let input = IntegrationInput {
            timestamps: vec![0.0, 3600.0],
            amps: vec![1.0, 1.0],
            voltage: 1.0,
        };
        let r = integrate(&input);
        assert!(approx_eq(r.charge_coulombs, 3600.0, 0.001));
        assert!(approx_eq(r.charge_ah, 1.0, 0.0001));
        assert!(approx_eq(r.charge_mah, 1000.0, 0.001));
    }
}
