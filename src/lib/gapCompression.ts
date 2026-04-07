// src/lib/gapCompression.ts — Compress out NaN gap regions from timestamp arrays

/**
 * Result of compressing NaN gaps out of a timestamped data series.
 *
 * - `compressedTs`: new timestamps with gap durations removed
 * - `gapPositions`: compressed-time X values where each gap was collapsed
 * - `cumulativeOffsets`: cumulative time removed at each gap (for reverse mapping)
 */
export interface GapCompressionResult {
  compressedTs: Float64Array;
  gapPositions: number[];
  cumulativeOffsets: number[];
}

/**
 * Walk through timestamps + amps, identify NaN gap sentinels, and produce
 * compressed timestamps that stitch acquisition segments together.
 *
 * Gap duration = time from last real sample before the NaN to the first
 * real sample after the NaN. That duration is subtracted from all
 * subsequent timestamps.
 */
export function compressGaps(ts: Float64Array, amps: Float64Array): GapCompressionResult {
  const n = ts.length;
  const compressedTs = new Float64Array(n);
  const gapPositions: number[] = [];
  const cumulativeOffsets: number[] = [];

  let cumOffset = 0;

  for (let i = 0; i < n; i++) {
    if (!isFinite(amps[i])) {
      // NaN gap sentinel — find the full extent of this NaN run
      const prevRealTs = i > 0 ? ts[i - 1] : ts[i];
      let nextIdx = i + 1;
      while (nextIdx < n && !isFinite(amps[nextIdx])) nextIdx++;

      // Compressed position of the gap boundary (before adding new offset)
      const gapCompressedPos = prevRealTs - cumOffset;

      if (nextIdx < n) {
        const gapDuration = ts[nextIdx] - prevRealTs;
        if (gapDuration > 0) {
          cumOffset += gapDuration;
          gapPositions.push(gapCompressedPos);
          cumulativeOffsets.push(cumOffset);
        }
      }

      // Set all NaN samples in this run to the gap boundary position
      // so that timestamp monotonicity is preserved for uPlot
      const end = Math.min(nextIdx, n);
      for (let j = i; j < end; j++) {
        compressedTs[j] = gapCompressedPos;
      }
      // Skip past the entire NaN run (loop increment handles +1)
      i = end - 1;
      continue;
    }
    compressedTs[i] = ts[i] - cumOffset;
  }

  return { compressedTs, gapPositions, cumulativeOffsets };
}

/**
 * Convert a real (wall-clock) timestamp to compressed-time space.
 */
export function realToCompressed(
  realTs: number,
  gapPositions: number[],
  cumulativeOffsets: number[],
): number {
  // Find the cumulative offset that applies at this real timestamp.
  // gapPositions are in compressed space, but offsets accumulate in real space.
  // We need to work with real-space gap boundaries.
  // The real-time boundary of gap i = gapPositions[i] + cumulativeOffsets[i]
  // (the compressed position + all removed time = original real position).
  let offset = 0;
  for (let i = 0; i < cumulativeOffsets.length; i++) {
    const realGapBoundary = gapPositions[i] + cumulativeOffsets[i];
    if (realTs >= realGapBoundary) {
      offset = cumulativeOffsets[i];
    } else {
      break;
    }
  }
  return realTs - offset;
}

/**
 * Convert a compressed timestamp back to real (wall-clock) space.
 */
export function compressedToReal(
  compTs: number,
  gapPositions: number[],
  cumulativeOffsets: number[],
): number {
  let offset = 0;
  for (let i = 0; i < gapPositions.length; i++) {
    if (gapPositions[i] <= compTs) {
      offset = cumulativeOffsets[i];
    } else {
      break;
    }
  }
  return compTs + offset;
}
