// src/components/LiveChart.tsx — Real-time uplot chart with minimap, markers and keyboard shortcuts

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useAppStore, getOrderedSlice } from '../store';
import { formatCurrentShort, MARKER_COLORS, MARKER_LABELS, MarkerCategory, Marker } from '../types';
import { api } from '../api/tauri';
import clsx from 'clsx';
import { Pause, Play, BookmarkPlus, X, MapPin, AlignCenter } from 'lucide-react';

const CHART_BG      = '#181825';
const MINIMAP_BG    = '#11111b';
const GRID_COLOR    = 'rgba(69,71,90,0.5)';
const TRACE_COLOR   = '#89dceb';
const TICK_COLOR    = '#a6adc8';
const MINIMAP_TRACE     = '#585b70';
const MINIMAP_VP_FILL   = 'rgba(137,220,235,0.08)';
const MINIMAP_VP_STROKE = 'rgba(137,220,235,0.45)';

const QUICK_CATEGORIES: MarkerCategory[] = ['note', 'boot', 'idle', 'sleep', 'radioTx', 'sensorSample'];

const TIME_WINDOWS = [
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
  { label: 'All', value: 0 },
];

/** Convert any CSS color (hex or rgb) to rgba with the given alpha. */
function colorWithAlpha(color: string, alpha: number): string {
  // Handle hex: #rgb, #rrggbb, #rrggbbaa
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  // Handle rgb(r,g,b) → rgba(r,g,b,alpha)
  if (color.startsWith('rgb(')) {
    return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  }
  return color;
}

function formatYAxis(amps: number): string {
  const a = Math.abs(amps);
  if (a === 0) return '0';
  if (a >= 1) return `${amps.toFixed(2)}A`;
  if (a >= 1e-3) return `${(amps * 1e3).toFixed(2)}mA`;
  if (a >= 1e-6) return `${(amps * 1e6).toFixed(2)}µA`;
  return `${(amps * 1e9).toFixed(1)}nA`;
}

export default function LiveChart() {
  const containerRef       = useRef<HTMLDivElement>(null);
  const plotRef            = useRef<uPlot | null>(null);
  const minimapRef         = useRef<HTMLCanvasElement>(null);
  const viewportRef        = useRef<[number, number] | null>(null);
  const cursorTsRef        = useRef<number | null>(null);
  const isHoveringRef      = useRef(false);
  const markersRef         = useRef<Marker[]>([]);
  const markerPopupOpenRef = useRef(false);
  const minimapDragging    = useRef(false);
  const pausedRef          = useRef(false);
  const connectedRef       = useRef(false);
  const disabledUsbOnPause = useRef(false);
  // Tracks whether a setScale('x') call is from our render loop (not user pan/zoom)
  const programmaticScale  = useRef(false);
  // Mirrors yAutoScale state for use inside uPlot hook closures
  const yAutoScaleRef      = useRef(true);

  const {
    paused,
    setPaused,
    timeWindowS,
    setTimeWindow,
    setViewStats,
    setSelectionStats,
    setSelectionRange,
    addMarker,
    updateMarker,
    markers,
  } = useAppStore();

  const isConnected = useAppStore((s) => s.connectionStatus.state === 'Connected');
  // Stop the rAF loop when on device-config to keep that view responsive
  const currentView = useAppStore((s) => s.currentView);

  const [liveValue, setLiveValue] = useState<number | null>(null);

  // Y-axis manual range state
  const [yAutoScale, setYAutoScale] = useState(true);
  const [yMin, setYMin] = useState('');
  const [yMax, setYMax] = useState('');

  // Marker popup state — editId is set when right-clicking an existing marker
  const [markerPopup, setMarkerPopup] = useState<{
    x: number;
    y: number;
    ts: number;
    tsEnd?: number;
    editId?: string; // if set, we're editing an existing marker
  } | null>(null);
  const [markerLabel,    setMarkerLabel]    = useState('');
  const [markerNote,     setMarkerNote]     = useState('');
  const [markerCategory, setMarkerCategory] = useState<MarkerCategory>('note');
  const [markerColor,    setMarkerColor]    = useState('');
  const markerInputRef = useRef<HTMLInputElement>(null);

  // Sync markerPopupOpenRef with popup state
  useEffect(() => { markerPopupOpenRef.current = markerPopup !== null; }, [markerPopup]);

  // Keep refs in sync for event handlers created in useLayoutEffect
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { connectedRef.current = isConnected; }, [isConnected]);
  useEffect(() => { yAutoScaleRef.current = yAutoScale; }, [yAutoScale]);

  // Sync markers ref and redraw when markers change
  useEffect(() => {
    markersRef.current = markers;
    plotRef.current?.redraw(false);
    drawMinimap();
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [markers]);

  // ── Chart initialisation ─────────────────────────────────────────────────

  useLayoutEffect(() => {
    if (!containerRef.current) return;

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      padding: [8, 12, 0, 0],
      legend: { show: false },
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
          size: 75,
        },
      ],
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      hooks: {
        setScale: [
          (u, scaleKey) => {
            if (scaleKey !== 'x') return;
            const { min, max } = u.scales.x;
            if (min != null && max != null) {
              viewportRef.current = [min, max];

              // Only react to user-initiated pan/zoom, not our own renderFrame calls
              if (!programmaticScale.current) {
                // Clear drag-selection box and store selection
                u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
                useAppStore.getState().setSelectionRange(null);
                useAppStore.getState().setSelectionStats(null);

                // Recompute Y scale from data visible in the new X range
                if (yAutoScaleRef.current) {
                  const { ts, amps } = getOrderedSlice(useAppStore.getState().sampleBuffer);
                  let yLo = Infinity, yHi = -Infinity;
                  for (let i = 0; i < ts.length; i++) {
                    if (ts[i] >= min && ts[i] <= max && isFinite(amps[i])) {
                      if (amps[i] < yLo) yLo = amps[i];
                      if (amps[i] > yHi) yHi = amps[i];
                    }
                  }
                  if (isFinite(yLo) && isFinite(yHi)) {
                    const yMargin = Math.max((yHi - yLo) * 0.1, Math.abs(yHi) * 0.1, 1e-6);
                    u.setScale('y', { min: yLo - yMargin, max: yHi + yMargin });
                  }
                }
              }
            }
            drawMinimap();
          },
        ],
        setCursor: [
          (u) => {
            const left = (u.cursor as { left?: number }).left;
            if (left != null && left >= 0) {
              const ts = u.posToVal(left, 'x');
              if (isFinite(ts)) cursorTsRef.current = ts;
            }
          },
        ],
        draw: [
          (u) => {
            const ctx = u.ctx;
            const { top, height, left, width } = u.bbox;
            ctx.save();
            for (const m of markersRef.current) {
              const x0 = u.valToPos(m.timestamp, 'x', true);
              const color = m.color || MARKER_COLORS[m.category as MarkerCategory] || '#cba6f7';
              if (m.endTimestamp != null) {
                const x1 = u.valToPos(m.endTimestamp, 'x', true);
                const xL = Math.min(x0, x1);
                const xR = Math.max(x0, x1);
                if (xR < left || xL > left + width) continue;
                ctx.fillStyle = colorWithAlpha(color, 0.18);
                ctx.fillRect(xL, top, xR - xL, height);
                ctx.setLineDash([4, 3]);
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.2;
                ctx.beginPath(); ctx.moveTo(xL, top); ctx.lineTo(xL, top + height); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(xR, top); ctx.lineTo(xR, top + height); ctx.stroke();
                ctx.setLineDash([]);
              } else {
                if (x0 < left || x0 > left + width) continue;
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x0, top + height); ctx.stroke();
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.moveTo(x0 - 5, top);
                ctx.lineTo(x0 + 5, top);
                ctx.lineTo(x0, top + 8);
                ctx.closePath(); ctx.fill();
              }
            }
            ctx.restore();
          },
        ],
        setSelect: [
          (u) => {
            const sel = u.select;
            if (sel.width <= 2) {
              setSelectionStats(null);
              setSelectionRange(null);
              return;
            }
            // Ignore drag selection during live capture
            if (connectedRef.current && !pausedRef.current) {
              u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
              return;
            }
            const t0 = u.posToVal(sel.left, 'x');
            const t1 = u.posToVal(sel.left + sel.width, 'x');
            setSelectionRange([t0, t1]);
            const { ts, amps } = getOrderedSlice(useAppStore.getState().sampleBuffer);
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

    const u = new uPlot(opts, [[], []], containerRef.current);
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

    // 'M' key → add marker at cursor (or selection range) while hovering
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key !== 'm' && e.key !== 'M') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!isHoveringRef.current) return;
      if (markerPopupOpenRef.current) return;
      const sel = u.select;
      const containerRect = containerRef.current!.getBoundingClientRect();
      if (sel.width > 4) {
        const t0 = u.posToVal(sel.left, 'x');
        const t1 = u.posToVal(sel.left + sel.width, 'x');
        setMarkerPopup({ x: containerRect.width / 2, y: 80, ts: t0, tsEnd: t1 });
      } else {
        const ts = cursorTsRef.current;
        if (ts == null) return;
        setMarkerPopup({ x: containerRect.width / 2, y: 80, ts });
      }
      setMarkerLabel('');
      setMarkerNote('');
      setMarkerCategory('note');
      setTimeout(() => markerInputRef.current?.focus(), 50);
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      ro.disconnect();
      window.removeEventListener('keydown', handleKeyDown);
      u.destroy();
      plotRef.current = null;
    };
  }, []);

  // ── Minimap ───────────────────────────────────────────────────────────────

  const drawMinimap = useCallback(() => {
    const canvas = minimapRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pxW = canvas.width;
    const pxH = canvas.height;
    const { ts, amps } = getOrderedSlice(useAppStore.getState().sampleBuffer);
    const n = ts.length;

    ctx.fillStyle = MINIMAP_BG;
    ctx.fillRect(0, 0, pxW, pxH);

    if (n < 2) return;
    const tMin = ts[0];
    const tMax = ts[n - 1];
    const tRange = tMax - tMin || 1;

    for (const m of markersRef.current) {
      if (m.endTimestamp == null) continue;
      const x0 = ((m.timestamp - tMin) / tRange) * pxW;
      const x1 = ((m.endTimestamp - tMin) / tRange) * pxW;
      ctx.fillStyle = colorWithAlpha(m.color || '#cba6f7', 0.25);
      ctx.fillRect(x0, 0, x1 - x0, pxH);
    }

    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!isFinite(amps[i])) continue;
      minV = Math.min(minV, amps[i]); maxV = Math.max(maxV, amps[i]);
    }
    if (!isFinite(minV)) return; // all NaN
    const aRange = (maxV - minV) || 1;
    const stride = Math.max(1, Math.ceil(n / pxW));
    ctx.beginPath();
    ctx.strokeStyle = MINIMAP_TRACE;
    ctx.lineWidth = 1;
    let drawing = false;
    for (let i = 0; i < n; i += stride) {
      // Check if ANY sample in this stride block is a NaN gap sentinel
      let hasGap = false;
      const blockEnd = Math.min(i + stride, n);
      for (let j = i; j < blockEnd; j++) {
        if (!isFinite(amps[j])) { hasGap = true; break; }
      }
      if (hasGap) { drawing = false; continue; } // pen up at gap
      const x = ((ts[i] - tMin) / tRange) * pxW;
      const y = pxH - ((amps[i] - minV) / aRange) * (pxH - 4) - 2;
      if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    for (const m of markersRef.current) {
      if (m.endTimestamp != null) continue;
      const x = ((m.timestamp - tMin) / tRange) * pxW;
      ctx.strokeStyle = m.color || '#cba6f7';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, pxH); ctx.stroke();
    }

    const vp = viewportRef.current;
    if (vp) {
      const vx0 = ((vp[0] - tMin) / tRange) * pxW;
      const vx1 = ((vp[1] - tMin) / tRange) * pxW;
      ctx.fillStyle = MINIMAP_VP_FILL;
      ctx.fillRect(vx0, 0, vx1 - vx0, pxH);
      ctx.strokeStyle = MINIMAP_VP_STROKE;
      ctx.lineWidth = 1;
      ctx.strokeRect(vx0, 0, vx1 - vx0, pxH);
    }
  }, []);

  const navigateMinimap = useCallback((clientX: number) => {
    const canvas = minimapRef.current;
    const u = plotRef.current;
    if (!canvas || !u) return;
    const rect = canvas.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const { ts } = getOrderedSlice(useAppStore.getState().sampleBuffer);
    if (ts.length < 2) return;
    const tMin = ts[0], tMax = ts[ts.length - 1];
    const center = tMin + pct * (tMax - tMin);
    const vp = viewportRef.current;
    const half = vp ? (vp[1] - vp[0]) / 2 : (timeWindowS || 30) / 2;
    u.setScale('x', { min: center - half, max: center + half });
    setPaused(true);
  }, [timeWindowS, setPaused]);

  const onMinimapMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    minimapDragging.current = true;
    navigateMinimap(e.clientX);
  }, [navigateMinimap]);

  const onMinimapMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!minimapDragging.current) return;
    navigateMinimap(e.clientX);
  }, [navigateMinimap]);

  const onMinimapMouseUp = useCallback(() => { minimapDragging.current = false; }, []);

  // ── Render loop ───────────────────────────────────────────────────────────

  const renderFrame = useCallback(() => {
    const u = plotRef.current;
    if (!u) return;

    const store = useAppStore.getState();
    const { ts: rawTs, amps: rawAmps } = getOrderedSlice(store.sampleBuffer);
    const n = rawTs.length;

    // If buffer is empty (e.g. after Clear), reset the chart and minimap
    if (n === 0) {
      u.setData([[], []], false);
      setLiveValue(null);
      setViewStats(null);
      viewportRef.current = null;
      drawMinimap();
      return;
    }

    // When live (not paused): slice to the time window (last N seconds).
    // When paused: feed ALL data so the user can scroll anywhere via minimap.
    let startIdx = 0;
    if (!paused && timeWindowS > 0) {
      const cutoff = rawTs[n - 1] - timeWindowS;
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

    // Update the live value readout (last finite value)
    for (let i = visN - 1; i >= 0; i--) {
      if (isFinite(visAmps[i])) { setLiveValue(visAmps[i]); break; }
    }

    // ── Downsample for display (min-max envelope per pixel) ──
    // NaN gaps: if any sample in a stride block is NaN, emit a NaN point
    // so uPlot breaks the line between acquisitions.
    const maxPts = Math.max((u.width - 60) * 2, 500);
    let dispTs: ArrayLike<number>, dispAmps: ArrayLike<number>;

    if (visN <= maxPts) {
      dispTs = visTs;
      dispAmps = visAmps;
    } else {
      const stride = Math.ceil(visN / (maxPts / 2));
      const outN = Math.ceil(visN / stride) * 2 + Math.ceil(visN / stride); // room for gaps
      const dTs = new Float64Array(outN);
      const dAmps = new Float64Array(outN);
      let out = 0;
      for (let i = 0; i + stride <= visN; i += stride) {
        // Check if this block contains a NaN gap sentinel
        let hasGap = false;
        for (let j = i; j < i + stride; j++) {
          if (!isFinite(visAmps[j])) { hasGap = true; break; }
        }
        if (hasGap) {
          // Emit a NaN point to break the line
          dTs[out] = visTs[i]; dAmps[out] = NaN; out++;
          continue;
        }
        let mn = Infinity, mx = -Infinity, mnI = i, mxI = i;
        for (let j = i; j < i + stride; j++) {
          if (visAmps[j] < mn) { mn = visAmps[j]; mnI = j; }
          if (visAmps[j] > mx) { mx = visAmps[j]; mxI = j; }
        }
        const first = mnI <= mxI ? mnI : mxI;
        const second = mnI <= mxI ? mxI : mnI;
        dTs[out] = visTs[first]; dAmps[out] = visAmps[first]; out++;
        dTs[out] = visTs[second]; dAmps[out] = visAmps[second]; out++;
      }
      dispTs = dTs.subarray(0, out);
      dispAmps = dAmps.subarray(0, out);
    }

    // Convert NaN in amps to null for uPlot (null = gap in the line)
    const tsArr = Array.from(dispTs);
    const ampsArr: (number | null)[] = Array.from(dispAmps).map((v) => (isFinite(v) ? v : null));

    // Flag our own setScale calls so the hook doesn't treat them as user pan
    programmaticScale.current = true;
    u.batch(() => {
      u.setData([tsArr, ampsArr] as uPlot.AlignedData, false);

      if (!paused) {
        // Live mode: scroll to show the time window at the tail
        const tMin = visTs[0];
        const tMax = visTs[visN - 1];
        const xPad = Math.max((tMax - tMin) * 0.01, 0.01);
        u.setScale('x', { min: tMin, max: tMax + xPad });
      } else {
        // Paused: preserve whatever viewport the user has scrolled to.
        // If there's no saved viewport yet (just paused), snap to the last
        // `timeWindowS` seconds of data so the view doesn't jump.
        const vp = viewportRef.current;
        if (vp) {
          u.setScale('x', { min: vp[0], max: vp[1] });
        } else {
          const tMax = visTs[visN - 1];
          const tMin = timeWindowS > 0 ? tMax - timeWindowS : visTs[0];
          u.setScale('x', { min: tMin, max: tMax });
        }
      }

      // Y-axis: when paused, compute from the current VIEWPORT, not all data
      const yData = visAmps;
      const yRange = paused ? viewportRef.current : null;

      if (!yAutoScale) {
        const yMinVal = parseFloat(yMin);
        const yMaxVal = parseFloat(yMax);
        if (isFinite(yMinVal) && isFinite(yMaxVal) && yMinVal < yMaxVal) {
          u.setScale('y', { min: yMinVal, max: yMaxVal });
        }
      } else {
        let yLo = Infinity, yHi = -Infinity;
        for (let i = 0; i < visN; i++) {
          const v = yData[i];
          if (!isFinite(v)) continue;
          // When paused, only consider data within the current viewport
          if (yRange && (visTs[i] < yRange[0] || visTs[i] > yRange[1])) continue;
          if (v < yLo) yLo = v;
          if (v > yHi) yHi = v;
        }
        if (isFinite(yLo) && isFinite(yHi)) {
          const yMargin = Math.max((yHi - yLo) * 0.1, Math.abs(yHi) * 0.1, 1e-6);
          u.setScale('y', { min: yLo - yMargin, max: yHi + yMargin });
        }
      }
    });
    programmaticScale.current = false;

    // Compute view stats, skipping NaN gap sentinels
    // When paused, scope stats to the viewport; when live, all visible data
    const statsRange = paused ? viewportRef.current : null;
    let sum = 0, mn = Infinity, mx = -Infinity, cnt = 0;
    for (let i = 0; i < visN; i++) {
      const v = visAmps[i];
      if (!isFinite(v)) continue;
      if (statsRange && (visTs[i] < statsRange[0] || visTs[i] > statsRange[1])) continue;
      sum += v; mn = Math.min(mn, v); mx = Math.max(mx, v); cnt++;
    }
    if (cnt > 0) {
      const t0 = statsRange ? statsRange[0] : visTs[0];
      const t1 = statsRange ? statsRange[1] : visTs[visN - 1];
      setViewStats({
        count: cnt,
        avgAmps: sum / cnt,
        minAmps: mn,
        maxAmps: mx,
        durationS: t1 - t0,
        rateHz: cnt / Math.max(t1 - t0, 1e-6),
      });
    }

    drawMinimap();
  }, [paused, timeWindowS, yAutoScale, yMin, yMax, setViewStats, drawMinimap]);

  // ── Animation loop — only runs when on monitor view ───────────────────────

  useEffect(() => {
    if (paused || currentView !== 'monitor') return;

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
  }, [paused, renderFrame, currentView]);

  // Render once when paused, when time window changes, or when switching back to monitor
  useEffect(() => {
    if (paused || currentView === 'monitor') renderFrame();
  }, [paused, renderFrame, currentView]);

  // Re-render when samples are cleared (totalSamples drops to 0)
  const totalSamples = useAppStore((s) => s.totalSamples);
  useEffect(() => {
    if (totalSamples === 0) renderFrame();
  }, [totalSamples, renderFrame]);

  // Navigate to a marker timestamp when requested from MarkersPanel
  const navigateTo = useAppStore((s) => s.navigateTo);
  useEffect(() => {
    if (!navigateTo) return;
    viewportRef.current = [navigateTo.tMin, navigateTo.tMax];
    useAppStore.getState().clearNavigateTo();
    // Render immediately so chart + minimap jump to the marker
    requestAnimationFrame(() => renderFrame());
  }, [navigateTo, renderFrame]);

  const confirmMarker = () => {
    if (!markerPopup) return;
    if (markerPopup.editId) {
      // Editing existing marker
      updateMarker(markerPopup.editId, {
        label: markerLabel || MARKER_LABELS[markerCategory],
        note: markerNote,
        category: markerCategory,
        color: markerColor || MARKER_COLORS[markerCategory],
      });
    } else {
      // Adding new marker
      addMarker({
        timestamp: markerPopup.ts,
        endTimestamp: markerPopup.tsEnd,
        label: markerLabel || MARKER_LABELS[markerCategory],
        note: markerNote,
        category: markerCategory,
        color: markerColor || MARKER_COLORS[markerCategory],
      });
    }
    setMarkerPopup(null);
  };

  // ── React-level pointer handlers (bypass native WebView context menu) ──────

  const handleChartClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const u = plotRef.current;
    if (!u || markerPopupOpenRef.current) return;

    const rect = u.over.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < 0 || px > rect.width) return;
    const ts = u.posToVal(px, 'x');
    if (!isFinite(ts)) return;

    const sel = u.select;

    // If there is an active drag-selection box, check whether the click is
    // inside or outside it.  Outside → clear selection.  Inside → ignore
    // (the setSelect hook already handled it).
    if (sel.width > 4) {
      const selLeft = sel.left;
      const selRight = sel.left + sel.width;
      if (px < selLeft || px > selRight) {
        // Click is outside the drag-selection → clear everything
        setSelectionRange(null);
        setSelectionStats(null);
        u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
      }
      return;
    }

    // Hit-test saved range markers → load their stats as selection
    const hit = markersRef.current.find(
      (m) => m.endTimestamp != null && ts >= m.timestamp && ts <= m.endTimestamp,
    );
    if (hit) {
      setSelectionRange([hit.timestamp, hit.endTimestamp!]);
      const { ts: bufTs, amps } = getOrderedSlice(useAppStore.getState().sampleBuffer);
      let sum = 0, mn = Infinity, mx = -Infinity, cnt = 0;
      for (let i = 0; i < bufTs.length; i++) {
        if (bufTs[i] >= hit.timestamp && bufTs[i] <= hit.endTimestamp! && isFinite(amps[i])) {
          sum += amps[i]; mn = Math.min(mn, amps[i]); mx = Math.max(mx, amps[i]); cnt++;
        }
      }
      if (cnt > 0) {
        setSelectionStats({
          count: cnt, avgAmps: sum / cnt, minAmps: mn, maxAmps: mx,
          durationS: hit.endTimestamp! - hit.timestamp,
          rateHz: cnt / Math.max(hit.endTimestamp! - hit.timestamp, 1e-6),
        });
      }
      return;
    }

    // Click on empty area → clear any active selection (store-level or uPlot-level)
    const hasStoreSelection = useAppStore.getState().selectionRange != null;
    if (hasStoreSelection) {
      setSelectionRange(null);
      setSelectionStats(null);
    }
    u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
  }, [setSelectionRange, setSelectionStats]);

  const handleChartContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const u = plotRef.current;
    if (!u || markerPopupOpenRef.current) return;

    const rect = u.over.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < 0 || px > rect.width) return;
    const ts = u.posToVal(px, 'x');
    if (!isFinite(ts)) return;

    const containerRect = containerRef.current!.getBoundingClientRect();
    const popX = e.clientX - containerRect.left;
    const popY = e.clientY - containerRect.top;

    // Inside active drag selection → range marker pre-filled with that selection
    const sel = u.select;
    if (sel.width > 4) {
      setMarkerLabel('');
      setMarkerNote('');
      setMarkerCategory('note');
      setMarkerColor('');
      const t0 = u.posToVal(sel.left, 'x');
      const t1 = u.posToVal(sel.left + sel.width, 'x');
      setMarkerPopup({ x: popX, y: popY, ts: t0, tsEnd: t1 });
      setTimeout(() => markerInputRef.current?.focus(), 50);
      return;
    }

    // Hit-test existing markers (range + point) → open EDIT mode
    const hitRange = markersRef.current.find(
      (m) => m.endTimestamp != null && ts >= m.timestamp && ts <= m.endTimestamp,
    );
    const hitPoint = !hitRange ? markersRef.current.find((m) => {
      if (m.endTimestamp != null) return false;
      const mx = u.valToPos(m.timestamp, 'x', true);
      const clickX = u.valToPos(ts, 'x', true);
      return Math.abs(mx - clickX) < 8; // 8px tolerance
    }) : null;
    const hit = hitRange || hitPoint;

    if (hit) {
      // Edit existing marker
      setMarkerLabel(hit.label);
      setMarkerNote(hit.note);
      setMarkerCategory(hit.category as MarkerCategory);
      setMarkerColor(hit.color);
      setMarkerPopup({ x: popX, y: popY, ts: hit.timestamp, tsEnd: hit.endTimestamp, editId: hit.id });
      setTimeout(() => markerInputRef.current?.focus(), 50);
      return;
    }

    // Empty area → new point marker
    setMarkerLabel('');
    setMarkerNote('');
    setMarkerCategory('note');
    setMarkerColor('');
    setMarkerPopup({ x: popX, y: popY, ts });
    setTimeout(() => markerInputRef.current?.focus(), 50);
  }, []);

  return (
    <div className="panel flex-1 overflow-hidden flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-shrink-0 mb-1">
        <span className="font-mono font-bold text-xl text-accent-teal min-w-[100px]">
          {liveValue !== null ? formatCurrentShort(liveValue) : '—'}
        </span>

        <div className="flex-1" />

        {/* Y-axis controls */}
        <div className="flex items-center gap-1">
          <button
            className={clsx('btn btn-sm btn-ghost px-2 text-xs', yAutoScale && 'bg-surface text-text')}
            onClick={() => setYAutoScale(true)}
            title="Auto Y-axis"
          >
            Y:Auto
          </button>
          <button
            className={clsx('btn btn-sm btn-ghost px-2 text-xs', !yAutoScale && 'bg-surface text-text')}
            onClick={() => {
              setYAutoScale(false);
              const st = useAppStore.getState().viewStats;
              if (st && !yMin && !yMax) {
                const margin = (st.maxAmps - st.minAmps) * 0.1 || 1e-6;
                setYMin((st.minAmps - margin).toExponential(2));
                setYMax((st.maxAmps + margin).toExponential(2));
              }
            }}
            title="Manual Y-axis"
          >
            Y:Manual
          </button>
          {!yAutoScale && (
            <>
              <input
                className="input text-xs w-20 font-mono"
                placeholder="Min (A)"
                value={yMin}
                onChange={(e) => setYMin(e.target.value)}
                title="Y min (amps)"
              />
              <input
                className="input text-xs w-20 font-mono"
                placeholder="Max (A)"
                value={yMax}
                onChange={(e) => setYMax(e.target.value)}
                title="Y max (amps)"
              />
            </>
          )}
        </div>

        <div className="h-4 w-px bg-surface-200" />

        {/* Time window */}
        <div className="flex gap-0.5">
          {TIME_WINDOWS.map((w) => (
            <button
              key={w.value}
              className={clsx(
                'btn btn-sm btn-ghost px-2 text-xs',
                timeWindowS === w.value && 'bg-surface text-text',
              )}
              onClick={() => {
                setTimeWindow(w.value);
                // Snap the viewport to show the selected time window
                const { ts } = getOrderedSlice(useAppStore.getState().sampleBuffer);
                if (ts.length > 1) {
                  const tMax = ts[ts.length - 1];
                  const tMin = w.value > 0 ? tMax - w.value : ts[0];
                  viewportRef.current = [tMin, tMax];
                  // Immediately re-render so chart + minimap reflect the new window
                  // Use requestAnimationFrame to ensure state has settled
                  requestAnimationFrame(() => renderFrame());
                }
              }}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* Pause / Resume */}
        <button
          className={clsx('btn btn-sm flex items-center gap-1', paused ? 'btn-primary' : 'btn-ghost')}
          onClick={async () => {
            const nextPaused = !paused;

            if (nextPaused) {
              // Pausing → snapshot the current viewport so renderFrame preserves it
              // (viewportRef is already set by the setScale hook, so nothing extra needed)
              setPaused(true);
            } else {
              // Resuming → clear selection, reset viewport so live mode takes over
              setSelectionRange(null);
              setSelectionStats(null);
              plotRef.current?.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
              viewportRef.current = null; // let live mode set the viewport
              setPaused(false);
            }

            const state = useAppStore.getState();
            if (state.connectionStatus.state === 'Connected') {
              if (nextPaused) {
                if (state.connectionStatus.deviceStatus.usbLogging === true) {
                  disabledUsbOnPause.current = true;
                  try { await api.sendDeviceCommand('u'); } catch { /* ignore */ }
                }
              } else {
                if (disabledUsbOnPause.current) {
                  disabledUsbOnPause.current = false;
                  // Re-enabling USB logging → gap is inserted by onSerialDeviceStatus handler
                  try { await api.sendDeviceCommand('u'); } catch { /* ignore */ }
                }
              }
            }
          }}
        >
          {paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
        </button>
      </div>

      {/* uPlot container */}
      <div
        className="flex-1 overflow-hidden rounded relative min-h-0"
        onMouseEnter={() => { isHoveringRef.current = true; }}
        onMouseLeave={() => { isHoveringRef.current = false; }}
        onClick={handleChartClick}
        onContextMenu={handleChartContextMenu}
      >
        <div
          ref={containerRef}
          className="w-full h-full"
          style={{ background: CHART_BG }}
        />

        {/* Marker add/edit popup */}
        {markerPopup && (
          <div
            className="absolute z-50 bg-base-200 border border-surface-200 rounded-lg shadow-lg p-3 flex flex-col gap-2 w-72"
            style={{
              left: Math.min(markerPopup.x + 8, (containerRef.current?.clientWidth ?? 400) - 288),
              top: Math.max(markerPopup.y - 8, 4),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-1.5 text-xs text-text-subtle font-mono">
              {markerPopup.editId
                ? <><BookmarkPlus size={11} className="text-accent-yellow" /> Edit marker</>
                : markerPopup.tsEnd != null
                  ? <><AlignCenter size={11} className="text-accent-teal" /> Range marker</>
                  : <><MapPin size={11} className="text-accent-teal" /> Point marker</>
              }
              <span className="ml-auto opacity-60">
                {new Date(markerPopup.ts * 1000).toISOString().substr(11, 12)}
                {markerPopup.tsEnd != null && ` – ${new Date(markerPopup.tsEnd * 1000).toISOString().substr(11, 12)}`}
              </span>
            </div>

            {/* Label */}
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

            {/* Note */}
            <textarea
              className="input text-xs resize-none"
              rows={2}
              placeholder="Note (optional)…"
              value={markerNote}
              onChange={(e) => setMarkerNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMarkerPopup(null);
              }}
            />

            {/* Category buttons */}
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
                  onClick={() => {
                    setMarkerCategory(cat);
                    setMarkerColor(MARKER_COLORS[cat]);
                  }}
                >
                  {MARKER_LABELS[cat]}
                </button>
              ))}
            </div>

            {/* Color picker row */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-subtle">Color</span>
              <label
                className="w-6 h-6 rounded-full border-2 border-surface-200 cursor-pointer hover:ring-2 hover:ring-accent-teal/40 transition-all flex-none"
                style={{ background: markerColor || MARKER_COLORS[markerCategory] }}
              >
                <input
                  type="color"
                  className="sr-only"
                  value={markerColor || MARKER_COLORS[markerCategory]}
                  onChange={(e) => setMarkerColor(e.target.value)}
                />
              </label>
              <span className="text-xs text-text-subtle font-mono opacity-60">
                {markerColor || MARKER_COLORS[markerCategory]}
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex gap-1">
              <button className="btn btn-primary btn-sm flex-1 text-xs flex items-center gap-1 justify-center" onClick={confirmMarker}>
                <BookmarkPlus size={12} /> {markerPopup.editId ? 'Save' : 'Add'}
              </button>
              <button className="btn btn-ghost btn-sm text-xs" onClick={() => setMarkerPopup(null)}>
                <X size={12} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Minimap */}
      <div className="relative flex-shrink-0 mt-1" style={{ height: '48px' }}>
        <canvas
          ref={minimapRef}
          className="w-full h-full rounded cursor-crosshair"
          style={{ display: 'block' }}
          width={800}
          height={48}
          onMouseDown={onMinimapMouseDown}
          onMouseMove={onMinimapMouseMove}
          onMouseUp={onMinimapMouseUp}
          onMouseLeave={onMinimapMouseUp}
        />
        <span className="absolute top-0.5 left-1.5 text-[9px] text-text-subtle opacity-40 pointer-events-none select-none">
          overview
        </span>
      </div>
    </div>
  );
}
