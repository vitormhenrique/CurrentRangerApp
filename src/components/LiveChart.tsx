// src/components/LiveChart.tsx — Real-time uplot chart with zoom/pan/selection

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useAppStore, getOrderedSlice } from '../store';
import { formatCurrentShort, MARKER_COLORS, MARKER_LABELS, MarkerCategory } from '../types';
import clsx from 'clsx';

const CHART_BG = '#181825';
const GRID_COLOR = 'rgba(69,71,90,0.5)';
const TRACE_COLOR = '#89dceb';
const AVG_COLOR = '#f9e2af';
const TICK_COLOR = '#a6adc8';

const QUICK_CATEGORIES: MarkerCategory[] = ['note', 'boot', 'idle', 'sleep', 'radioTx', 'sensorSample'];

const TIME_WINDOWS = [
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
  { label: 'All', value: 0 },
];

function formatYAxis(amps: number): string {
  const a = Math.abs(amps);
  if (a === 0) return '0';
  if (a >= 1) return `${amps.toFixed(2)}A`;
  if (a >= 1e-3) return `${(amps * 1e3).toFixed(2)}mA`;
  if (a >= 1e-6) return `${(amps * 1e6).toFixed(2)}µA`;
  return `${(amps * 1e9).toFixed(1)}nA`;
}

export default function LiveChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const {
    sampleBuffer,
    paused,
    setPaused,
    timeWindowS,
    setTimeWindow,
    setViewStats,
    setSelectionStats,
    setSelectionRange,
    addMarker,
  } = useAppStore();

  const [liveValue, setLiveValue] = useState<number | null>(null);

  // Marker popup state
  const [markerPopup, setMarkerPopup] = useState<{
    x: number;   // px from left of container
    y: number;   // px from top of container
    ts: number;  // unix timestamp
  } | null>(null);
  const [markerLabel, setMarkerLabel] = useState('');
  const [markerCategory, setMarkerCategory] = useState<MarkerCategory>('note');
  const markerInputRef = useRef<HTMLInputElement>(null);

  // ── Chart initialisation ─────────────────────────────────────────────────

  useLayoutEffect(() => {
    if (!containerRef.current) return;

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight - 0,
      padding: [8, 12, 0, 0],
      cursor: {
        show: true,
        sync: { key: 'main' },
        drag: { dist: 3, x: true, y: false, setScale: false },
      },
      series: [
        {},
        {
          label: 'Current',
          stroke: TRACE_COLOR,
          width: 1.2,
          points: { show: false },
          spanGaps: false,
        },
        {
          label: 'Avg',
          stroke: AVG_COLOR,
          width: 1,
          dash: [4, 4],
          points: { show: false },
        },
      ],
      axes: [
        {
          stroke: TICK_COLOR,
          grid: { stroke: GRID_COLOR, width: 0.5 },
          ticks: { stroke: GRID_COLOR, width: 0.5 },
          values: (_u, vals) =>
            vals.map((v) =>
              v == null ? '' : new Date(v * 1000).toISOString().substr(11, 8),
            ),
        },
        {
          stroke: TICK_COLOR,
          grid: { stroke: GRID_COLOR, width: 0.5 },
          ticks: { stroke: GRID_COLOR, width: 0.5 },
          values: (_u, vals) => vals.map((v) => (v == null ? '' : formatYAxis(v))),
          size: 60,
        },
      ],
      scales: {
        x: { time: false }, // we use raw unix seconds — label as relative
        y: { auto: true },
      },
      hooks: {
        setSelect: [
          (u) => {
            const sel = u.select;
            if (sel.width <= 2) {
              setSelectionStats(null);
              setSelectionRange(null);
              return;
            }
            const t0 = u.posToVal(sel.left, 'x');
            const t1 = u.posToVal(sel.left + sel.width, 'x');
            setSelectionRange([t0, t1]);
            // Compute selection stats from buffer
            const { ts, amps } = getOrderedSlice(sampleBuffer);
            let sum = 0, mn = Infinity, mx = -Infinity, cnt = 0;
            for (let i = 0; i < ts.length; i++) {
              if (ts[i] >= t0 && ts[i] <= t1) {
                sum += amps[i]; mn = Math.min(mn, amps[i]); mx = Math.max(mx, amps[i]); cnt++;
              }
            }
            if (cnt > 0) {
              setSelectionStats({
                count: cnt,
                avgAmps: sum / cnt,
                minAmps: mn,
                maxAmps: mx,
                durationS: t1 - t0,
                rateHz: cnt / Math.max(t1 - t0, 1e-6),
              });
            }
          },
        ],
      },
    };

    const u = new uPlot(opts, [[], [], []], containerRef.current);
    plotRef.current = u;

    const ro = new ResizeObserver(() => {
      if (containerRef.current && plotRef.current) {
        plotRef.current.setSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(containerRef.current);

    // Click on chart → open marker popup
    const canvas = containerRef.current.querySelector('canvas');
    const handleCanvasClick = (e: MouseEvent) => {
      // Ignore if user was dragging (selection)
      const sel = u.select;
      if (sel.width > 4) return;

      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const px = e.clientX - rect.left;
      const ts = u.posToVal(px, 'x');
      if (!isFinite(ts)) return;

      const containerRect = containerRef.current!.getBoundingClientRect();
      setMarkerPopup({
        x: e.clientX - containerRect.left,
        y: e.clientY - containerRect.top,
        ts,
      });
      setMarkerLabel('');
      setMarkerCategory('note');
      setTimeout(() => markerInputRef.current?.focus(), 50);
    };
    canvas?.addEventListener('click', handleCanvasClick);

    return () => {
      ro.disconnect();
      canvas?.removeEventListener('click', handleCanvasClick);
      u.destroy();
      plotRef.current = null;
    };
  }, []);

  // ── Render loop ───────────────────────────────────────────────────────────

  const renderFrame = useCallback(() => {
    const u = plotRef.current;
    if (!u) return;

    const { ts: rawTs, amps: rawAmps } = getOrderedSlice(sampleBuffer);
    const n = rawTs.length;
    if (n === 0) return;

    // Time window slice
    let startIdx = 0;
    if (timeWindowS > 0) {
      const cutoff = rawTs[n - 1] - timeWindowS;
      // Binary search for cutoff
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rawTs[mid] < cutoff) lo = mid + 1;
        else hi = mid;
      }
      startIdx = lo;
    }

    const visTs = rawTs.subarray(startIdx);
    const visAmps = rawAmps.subarray(startIdx);
    const visN = visTs.length;

    if (visN === 0) return;

    setLiveValue(visAmps[visN - 1]);

    // Compute simple windowed avg for the avg line
    const WIN = Math.min(50, Math.max(1, Math.floor(visN / 20)));
    const avgAmps = new Float64Array(visN);
    let windowSum = 0;
    for (let i = 0; i < visN; i++) {
      windowSum += visAmps[i];
      if (i >= WIN) windowSum -= visAmps[i - WIN];
      avgAmps[i] = windowSum / Math.min(i + 1, WIN);
    }

    // Downsample for display (min-max envelope per pixel)
    const maxPts = Math.max((u.width - 60) * 2, 500);
    let dispTs: ArrayLike<number>, dispAmps: ArrayLike<number>, dispAvg: ArrayLike<number>;

    if (visN <= maxPts) {
      dispTs = visTs;
      dispAmps = visAmps;
      dispAvg = avgAmps;
    } else {
      const stride = Math.ceil(visN / (maxPts / 2));
      const outN = Math.ceil(visN / stride) * 2;
      const dTs = new Float64Array(outN);
      const dAmps = new Float64Array(outN);
      const dAvg = new Float64Array(outN);
      let out = 0;
      for (let i = 0; i + stride <= visN; i += stride) {
        let mn = Infinity, mx = -Infinity, mnI = i, mxI = i, avgAcc = 0;
        for (let j = i; j < i + stride; j++) {
          if (visAmps[j] < mn) { mn = visAmps[j]; mnI = j; }
          if (visAmps[j] > mx) { mx = visAmps[j]; mxI = j; }
          avgAcc += avgAmps[j];
        }
        const first = mnI <= mxI ? mnI : mxI;
        const second = mnI <= mxI ? mxI : mnI;
        dTs[out] = visTs[first]; dAmps[out] = visAmps[first]; dAvg[out] = avgAmps[first]; out++;
        dTs[out] = visTs[second]; dAmps[out] = visAmps[second]; dAvg[out] = avgAcc / stride; out++;
      }
      dispTs = dTs.subarray(0, out);
      dispAmps = dAmps.subarray(0, out);
      dispAvg = dAvg.subarray(0, out);
    }

    u.setData([
      Array.from(dispTs),
      Array.from(dispAmps),
      Array.from(dispAvg),
    ]);

    if (!paused) {
      const tMin = visTs[0];
      const tMax = visTs[visN - 1];
      u.setScale('x', { min: tMin, max: tMax });
    }

    // Update view stats
    let sum = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < visN; i++) {
      sum += visAmps[i]; mn = Math.min(mn, visAmps[i]); mx = Math.max(mx, visAmps[i]);
    }
    setViewStats({
      count: visN,
      avgAmps: sum / visN,
      minAmps: mn,
      maxAmps: mx,
      durationS: visTs[visN - 1] - visTs[0],
      rateHz: visN / Math.max(visTs[visN - 1] - visTs[0], 1e-6),
    });
  }, [sampleBuffer, paused, timeWindowS, setViewStats]);

  // ── Animation loop ────────────────────────────────────────────────────────

  useEffect(() => {
    if (paused) return;

    let frameId: number;
    let lastRender = 0;
    const FPS = 30;
    const interval = 1000 / FPS;

    const tick = (t: number) => {
      if (t - lastRender >= interval) {
        renderFrame();
        lastRender = t;
      }
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frameId);
  }, [paused, renderFrame]);

  // When paused, re-render once so the chart shows the paused frame
  useEffect(() => {
    if (paused) renderFrame();
  }, [paused]);

  const confirmMarker = () => {
    if (!markerPopup) return;
    addMarker({
      timestamp: markerPopup.ts,
      label: markerLabel || MARKER_LABELS[markerCategory],
      note: '',
      category: markerCategory,
      color: MARKER_COLORS[markerCategory],
    });
    setMarkerPopup(null);
  };

  return (
    <div className="panel flex-1 overflow-hidden flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-shrink-0 mb-1">
        {/* Live value */}
        <span className="font-mono font-bold text-xl text-accent-teal min-w-[100px]">
          {liveValue !== null ? formatCurrentShort(liveValue) : '—'}
        </span>

        <div className="flex-1" />

        {/* Time window */}
        <div className="flex gap-0.5">
          {TIME_WINDOWS.map((w) => (
            <button
              key={w.value}
              className={clsx(
                'btn btn-sm btn-ghost px-2 text-xs',
                timeWindowS === w.value && 'bg-surface text-text',
              )}
              onClick={() => setTimeWindow(w.value)}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* Pause */}
        <button
          className={clsx('btn btn-sm', paused ? 'btn-primary' : 'btn-ghost')}
          onClick={() => setPaused(!paused)}
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
      </div>

      {/* uPlot container — relative for popup positioning */}
      <div className="flex-1 overflow-hidden rounded relative">
        <div
          ref={containerRef}
          className="w-full h-full"
          style={{ background: CHART_BG }}
        />

        {/* Marker add popup */}
        {markerPopup && (
          <div
            className="absolute z-50 bg-base-200 border border-surface-200 rounded-lg shadow-lg p-3 flex flex-col gap-2 w-56"
            style={{
              left: Math.min(markerPopup.x + 8, (containerRef.current?.clientWidth ?? 400) - 232),
              top: Math.max(markerPopup.y - 8, 4),
            }}
          >
            <div className="text-xs text-text-subtle font-mono">
              + Marker at {new Date(markerPopup.ts * 1000).toISOString().substr(11, 12)}
            </div>
            <input
              ref={markerInputRef}
              className="input text-xs"
              placeholder="Label (optional)…"
              value={markerLabel}
              onChange={(e) => setMarkerLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmMarker();
                if (e.key === 'Escape') setMarkerPopup(null);
              }}
            />
            <div className="flex gap-1 flex-wrap">
              {QUICK_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  className={clsx(
                    'text-xs rounded px-1.5 py-0.5 transition-colors',
                    markerCategory === cat
                      ? 'text-base-100'
                      : 'bg-surface text-text-muted hover:text-text',
                  )}
                  style={markerCategory === cat ? { background: MARKER_COLORS[cat] } : {}}
                  onClick={() => setMarkerCategory(cat)}
                >
                  {MARKER_LABELS[cat]}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              <button className="btn btn-primary btn-sm flex-1 text-xs" onClick={confirmMarker}>
                Add
              </button>
              <button className="btn btn-ghost btn-sm text-xs" onClick={() => setMarkerPopup(null)}>
                ✕
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
