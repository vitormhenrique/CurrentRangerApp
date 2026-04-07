// src/lib/gapCompression.test.ts — Tests for gap compression algorithm
import { describe, it, expect } from 'vitest';
import { compressGaps, realToCompressed, compressedToReal } from './gapCompression';

function f64(...vals: number[]): Float64Array {
  return Float64Array.from(vals);
}

describe('compressGaps', () => {
  it('returns unchanged timestamps when there are no NaN gaps', () => {
    const ts   = f64(0, 1, 2, 3, 4);
    const amps = f64(1, 2, 3, 4, 5);
    const result = compressGaps(ts, amps);

    expect(Array.from(result.compressedTs)).toEqual([0, 1, 2, 3, 4]);
    expect(result.gapPositions).toEqual([]);
    expect(result.cumulativeOffsets).toEqual([]);
  });

  it('compresses a single NaN gap correctly', () => {
    // Measurement: t=0,1  gap: t=1.0001 (NaN)  measurement: t=5,6
    const ts   = f64(0, 1, 1.0001, 5, 6);
    const amps = f64(0.001, 0.001, NaN, 0.001, 0.001);
    const result = compressGaps(ts, amps);

    const c = Array.from(result.compressedTs);
    // First segment: [0, 1]
    expect(c[0]).toBeCloseTo(0);
    expect(c[1]).toBeCloseTo(1);
    // NaN sentinel should be at gap boundary (1), not negative
    expect(c[2]).toBeCloseTo(1);
    // Second segment stitched: starts at 1, ends at 2
    expect(c[3]).toBeCloseTo(1);
    expect(c[4]).toBeCloseTo(2);

    // Monotonicity check
    for (let i = 1; i < c.length; i++) {
      expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    }

    expect(result.gapPositions).toHaveLength(1);
    expect(result.cumulativeOffsets).toHaveLength(1);
  });

  it('compresses multiple NaN gaps correctly', () => {
    // Segment1: t=0,1  gap: t=1.0001 (NaN)  segment2: t=5,6  gap: t=6.0001 (NaN)  segment3: t=10,11
    const ts   = f64(0, 1, 1.0001, 5, 6, 6.0001, 10, 11);
    const amps = f64(0.001, 0.001, NaN, 0.001, 0.001, NaN, 0.001, 0.001);
    const result = compressGaps(ts, amps);

    const c = Array.from(result.compressedTs);
    // Segment1: [0, 1]
    expect(c[0]).toBeCloseTo(0);
    expect(c[1]).toBeCloseTo(1);
    // Gap sentinel at boundary
    expect(c[2]).toBeCloseTo(1);
    // Segment2 stitched: [1, 2]
    expect(c[3]).toBeCloseTo(1);
    expect(c[4]).toBeCloseTo(2);
    // Gap sentinel at boundary
    expect(c[5]).toBeCloseTo(2);
    // Segment3 stitched: [2, 3]
    expect(c[6]).toBeCloseTo(2);
    expect(c[7]).toBeCloseTo(3);

    // Monotonicity
    for (let i = 1; i < c.length; i++) {
      expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    }

    expect(result.gapPositions).toHaveLength(2);
    expect(result.cumulativeOffsets).toHaveLength(2);
  });

  it('handles consecutive NaN sentinels without double-counting', () => {
    // Multiple NaN sentinels in one gap
    const ts   = f64(0, 1, 1.0001, 1.0002, 1.0003, 5, 6);
    const amps = f64(0.001, 0.001, NaN, NaN, NaN, 0.001, 0.001);
    const result = compressGaps(ts, amps);

    const c = Array.from(result.compressedTs);
    // Segment1: [0, 1]
    expect(c[0]).toBeCloseTo(0);
    expect(c[1]).toBeCloseTo(1);
    // All NaN sentinels at gap boundary
    expect(c[2]).toBeCloseTo(1);
    expect(c[3]).toBeCloseTo(1);
    expect(c[4]).toBeCloseTo(1);
    // Segment2 stitched: [1, 2]
    expect(c[5]).toBeCloseTo(1);
    expect(c[6]).toBeCloseTo(2);

    // Monotonicity
    for (let i = 1; i < c.length; i++) {
      expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    }

    // Only ONE gap should be recorded
    expect(result.gapPositions).toHaveLength(1);
    expect(result.cumulativeOffsets).toHaveLength(1);
  });

  it('handles trailing NaN (measurement ended, no next segment)', () => {
    const ts   = f64(0, 1, 2, 2.0001);
    const amps = f64(0.001, 0.001, 0.001, NaN);
    const result = compressGaps(ts, amps);

    const c = Array.from(result.compressedTs);
    expect(c[0]).toBeCloseTo(0);
    expect(c[1]).toBeCloseTo(1);
    expect(c[2]).toBeCloseTo(2);
    // Trailing NaN — at boundary, no gap offset added (no next segment)
    expect(c[3]).toBeCloseTo(2);

    expect(result.gapPositions).toHaveLength(0);
    expect(result.cumulativeOffsets).toHaveLength(0);
  });
});

describe('realToCompressed', () => {
  it('returns same value when no gaps exist', () => {
    expect(realToCompressed(5, [], [])).toBe(5);
  });

  it('converts real timestamps after a gap correctly', () => {
    // From the single-gap test: gapPositions=[1], cumOffsets=[4], realGapBoundary = 1+4 = 5
    const gp = [1];
    const co = [4];

    // Before gap: no offset
    expect(realToCompressed(0, gp, co)).toBeCloseTo(0);
    expect(realToCompressed(1, gp, co)).toBeCloseTo(1);

    // At gap boundary (real=5 maps to compressed=1)
    expect(realToCompressed(5, gp, co)).toBeCloseTo(1);

    // After gap: offset applied
    expect(realToCompressed(6, gp, co)).toBeCloseTo(2);
  });

  it('converts with multiple gaps', () => {
    // Two gaps: gapPositions=[1, 2], cumOffsets=[4, 8]
    const gp = [1, 2];
    const co = [4, 8];

    expect(realToCompressed(0, gp, co)).toBeCloseTo(0);
    expect(realToCompressed(1, gp, co)).toBeCloseTo(1);  // before first gap
    expect(realToCompressed(5, gp, co)).toBeCloseTo(1);  // at first gap boundary (1+4=5)
    expect(realToCompressed(6, gp, co)).toBeCloseTo(2);  // between gaps
    expect(realToCompressed(10, gp, co)).toBeCloseTo(2); // at second gap boundary (2+8=10)
    expect(realToCompressed(11, gp, co)).toBeCloseTo(3); // after second gap
  });
});

describe('compressedToReal', () => {
  it('returns same value when no gaps exist', () => {
    expect(compressedToReal(5, [], [])).toBe(5);
  });

  it('converts compressed timestamps back to real space', () => {
    const gp = [1];
    const co = [4];

    // Before gap: no offset
    expect(compressedToReal(0, gp, co)).toBeCloseTo(0);

    // At gap boundary (compressed=1 → real=5, the post-gap value)
    expect(compressedToReal(1, gp, co)).toBeCloseTo(5);

    // After gap
    expect(compressedToReal(2, gp, co)).toBeCloseTo(6);
  });

  it('handles multiple gaps', () => {
    const gp = [1, 2];
    const co = [4, 8];

    expect(compressedToReal(0, gp, co)).toBeCloseTo(0);
    expect(compressedToReal(1, gp, co)).toBeCloseTo(5);
    expect(compressedToReal(2, gp, co)).toBeCloseTo(10);
    expect(compressedToReal(3, gp, co)).toBeCloseTo(11);
  });
});

describe('round-trip conversions', () => {
  it('realToCompressed → compressedToReal round-trips for post-gap timestamps', () => {
    const gp = [1, 2];
    const co = [4, 8];

    // Test timestamps that are clearly within a segment (not at gap boundaries)
    // real=5.5 is in the second segment, real=10.5 is in the third segment
    for (const real of [0.5, 5.5, 10.5, 15]) {
      const compressed = realToCompressed(real, gp, co);
      const backToReal = compressedToReal(compressed, gp, co);
      expect(backToReal).toBeCloseTo(real);
    }
  });

  it('compressedToReal → realToCompressed round-trips', () => {
    const gp = [1, 2];
    const co = [4, 8];

    // Test compressed timestamps that are not at gap boundaries
    for (const comp of [0, 0.5, 1.5, 2.5, 3]) {
      const real = compressedToReal(comp, gp, co);
      const backToComp = realToCompressed(real, gp, co);
      expect(backToComp).toBeCloseTo(comp);
    }
  });
});

describe('large dataset stress test', () => {
  it('handles 100k samples with 50 gaps and maintains monotonicity', () => {
    const N = 100_000;
    const ts = new Float64Array(N);
    const amps = new Float64Array(N);

    // Create 50 segments of ~2000 samples each, separated by NaN gaps
    let t = 0;
    const gapInterval = Math.floor(N / 50);
    for (let i = 0; i < N; i++) {
      ts[i] = t;
      if (i > 0 && i % gapInterval === 0) {
        amps[i] = NaN;
        t += 100; // huge gap of 100s
      } else {
        amps[i] = Math.random() * 0.01;
        t += 0.001; // 1ms between samples
      }
    }

    const result = compressGaps(ts, amps);

    // Verify monotonicity (allowing for floating-point epsilon)
    const eps = 1e-10;
    for (let i = 1; i < N; i++) {
      expect(result.compressedTs[i] + eps).toBeGreaterThanOrEqual(result.compressedTs[i - 1]);
    }

    // Verify all compressed timestamps are >= 0
    for (let i = 0; i < N; i++) {
      expect(result.compressedTs[i]).toBeGreaterThanOrEqual(0);
    }

    // Verify the total compressed range is much smaller than real range
    const realRange = ts[N - 1] - ts[0];
    const compRange = result.compressedTs[N - 1] - result.compressedTs[0];
    expect(compRange).toBeLessThan(realRange * 0.1); // gaps were ~98% of total time
  });
});
