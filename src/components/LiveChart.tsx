// src/components/LiveChart.tsx — Real-time uplot chart with minimap, markers and keyboard shortcuts

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useAppStore, getOrderedSlice } from '../store';
import { formatCurrentShort, MARKER_COLORS, MARKER_LABELS, MarkerCategory, Marker } from '../types';
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

function formatYAxis(amps: number): string {
  const a = Math.abs(amps);
  if (a === 0) return '0';
  if (a >= 1) return `${amps.toFixed(2)}A`;
  if (a >= 1e-3) return `${(amps * 1e3).toFixed(2)}mA`;
  if (a >= 1e-6) return `${(amps * 1e6).toFixed(2)}µA`;
  return `${(amps * 1e9).toFixed(1)}nA`;
}

export default function LiveChart() {
  const containerRef  = useRef<HTMLDivElement>(null);
  const plotRef       = useRef<uPlot | null>(null);
  const minimapRef    = useRef<HTMLCanvasElement>(null);
  const viewportRef        = useRef<[number, number] | null>(null);
  const cursorTsRef        = useRef<number | null>(null);
  const isHoveringRef      = useRef(false);
  const markersRef         = useRef<Marker[]>([]);
  const markerPopupOpenRef = useRef(false);
  const minimapDragging    = useRef(false);

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
    markers,
  } = useAppStore();

  const [liveValue, setLiveValue] = useState<number | null>(null);

  // Marker popup state
  const [markerPopup, setMarkerPopup] = useState<{
    x: number;
    y: number;
    ts: number;
    tsEnd?: number;
  } | null>(null);
  const [markerLabel,    setMarkerLabel]    = useState('');
  const [markerNote,     setMarkerNote]     = useState('');
  const [markerCategory, setMarkerCategory] = useState<MarkerCategory>('note');
  const markerInputRef = useRef<HTMLInputElement>(null);

  // Sync markerPopupOpenRef with popup state
  useEffect(() => { markerPopupOpenRef.current = markerPopup !== null; }, [markerPopup]);

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
      height: containerRef.current.clientHeight - 0,
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
          size: 60,
        },
      ],
      scales: {
        x: { time: false }, // we use raw unix seconds — label as relative
        y: { auto: true },
      },
      hooks: {
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
                ctx.fillStyle = color.replace(')', ',0.08)').replace('rgb', 'rgba');
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
                // Triangle cap
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

    // Click on chart → hit-test range markers or open add-marker popup
    const canvas = containerRef.current.querySelector('canvas');
    const handleCanvasClick = (e: MouseEvent) => {
      const sel = u.select;
      if (sel.width > 4) return;

      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const px = e.clientX - rect.left;
      const ts = u.posToVal(px, 'x');
      if (!isFinite(ts)) return;

      // Hit-test range markers first
      const hit = markersRef.current.find(
        (m) => m.endTimestamp != null && ts >= m.timestamp && ts <= m.endTimestamp,
      );
      if (hit) {
        // Load that range's stats
        setSelectionRange([hit.timestamp, hit.endTimestamp!]);
        const { ts: bufTs, amps } = getOrderedSlice(sampleBuffer);
        let sum = 0, mn = Infinity, mx = -Infinity, cnt = 0;
        for (let i = 0; i < bufTs.length; i++) {
          if (bufTs[i] >= hit.timestamp && bufTs[i] <= hit.endTimestamp!) {
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

      const containerRect = containerRef.current!.getBoundingClientRect();
      setMarkerPopup({
        x: e.clientX - containerRect.left,
        y: e.clientY - containerRect.top,
        ts,
      });
      setMarkerLabel('');
      setMarkerNote('');
      setMarkerCategory('note');
      setTimeout(() => markerInputRef.current?.focus(), 50);
    };
    canvas?.addEventListener('click', handleCanvasClick);

    // 'M' key → add marker at cursor (or selection range)
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key !== 'm' && e.key !== 'M') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!isHoveringRef.current) return;
      if (markerPopupOpenRef.current) return;
      const sel = u.select;
      const containerRect = containerRef.current!.getBoundingClientRect();
      if (sel.width > 4) {
        const t0 = u.posToVal(sel.left, 'x');
        const t1 = u.posToVal(sel.left + sel.width, 'x');
        setMarkerPopup({
          x: containerRect.width / 2,
          y: 80,
          ts: t0,
          tsEnd: t1,
        });
      } else {
        const ts = cursorTsRef.current;
        if (ts == null) return;
        setMarkerPopup({
          x: containerRect.width / 2,
          y: 80,
          ts,
        });
      }
      setMarkerLabel('');
      setMarkerNote('');
      setMarkerCategory('note');
      setTimeout(() => markerInputRef.current?.focus(), 50);
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      ro.disconnect();
      canvas?.removeEventListener('click', handleCanvasClick);
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
    const { ts, amps } = getOrderedSlice(sampleBuffer);
    const n = ts.length;

    ctx.fillStyle = MINIMAP_BG;
    ctx.fillRect(0, 0, pxW, pxH);

    if (n < 2) return;
    const tMin = ts[0];
    const tMax = ts[n - 1];
    const tRange = tMax - tMin || 1;

    // Draw range markers as colored fills
    for (const m of markersRef.current) {
      if (m.endTimestamp == null) continue;
      const x0 = ((m.timestamp - tMin) / tRange) * pxW;
      const x1 = ((m.endTimestamp - tMin) / tRange) * pxW;
      ctx.fillStyle = (m.color || '#cba6f7').replace(')', ',0.25)').replace('rgb', 'rgba');
      ctx.fillRect(x0, 0, x1 - x0, pxH);
    }

    // Draw downsampled trace
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < n; i++) { minV = Math.min(minV, amps[i]); maxV = Math.max(maxV, amps[i]); }
    const aRange = (maxV - minV) || 1;
    const stride = Math.max(1, Math.ceil(n / pxW));
    ctx.beginPath();
    ctx.strokeStyle = MINIMAP_TRACE;
    ctx.lineWidth = 1;
    let first = true;
    for (let i = 0; i < n; i += stride) {
      const x = ((ts[i] - tMin) / tRange) * pxW;
      const y = pxH - ((amps[i] - minV) / aRange) * (pxH - 4) - 2;
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw point markers
    for (const m of markersRef.current) {
      if (m.endTimestamp != null) continue;
      const x = ((m.timestamp - tMin) / tRange) * pxW;
      ctx.strokeStyle = m.color || '#cba6f7';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, pxH); ctx.stroke();
    }

    // Draw viewport highlight
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
  }, [sampleBuffer]);

  const navigateMinimap = useCallback((clientX: number) => {
    const canvas = minimapRef.current;
    const u = plotRef.current;
    if (!canvas || !u) return;
    const rect = canvas.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const { ts } = getOrderedSlice(sampleBuffer);
    if (ts.length < 2) return;
    const tMin = ts[0], tMax = ts[ts.length - 1];
    const center = tMin + pct * (tMax - tMin);
    const vp = viewportRef.current;
    const half = vp ? (vp[1] - vp[0]) / 2 : (timeWindowS || 30) / 2;
    u.setScale('x', { min: center - half, max: center + half });
    setPaused(true);
  }, [sampleBuffer, timeWindowS, setPaused]);

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

    // Downsample for display (min-max envelope per pixel)
    const maxPts = Math.max((u.width - 60) * 2, 500);
    let dispTs: ArrayLike<number>, dispAmps: ArrayLike<number>;

    if (visN <= maxPts) {
      dispTs = visTs;
      dispAmps = visAmps;
    } else {
      const stride = Math.ceil(visN / (maxPts / 2));
      const outN = Math.ceil(visN / stride) * 2;
      const dTs = new Float64Array(outN);
      const dAmps = new Float64Array(outN);
      let out = 0;
      for (let i = 0; i + stride <= visN; i += stride) {
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

    u.setData([
      Array.from(dispTs),
      Array.from(dispAmps),
    ]);

    if (!paused) {
      const tMin = visTs[0];
      const tMax = visTs[visN - 1];
      u.setScale('x', { min: tMin, max: tMax });
      viewportRef.current = [tMin, tMax];
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

    drawMinimap();
  }, [sampleBuffer, paused, timeWindowS, setViewStats, drawMinimap]);

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
      endTimestamp: markerPopup.tsEnd,
      label: markerLabel || MARKER_LABELS[markerCategory],
      note: markerNote,
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
          className={clsx('btn btn-sm flex items-center gap-1', paused ? 'btn-primary' : 'btn-ghost')}
          onClick={() => setPaused(!paused)}
        >
          {paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
        </button>
      </div>

      {/* uPlot container — relative for popup positioning */}
      <div
        className="flex-1 overflow-hidden rounded relative min-h-0"
        onMouseEnter={() => { isHoveringRef.current = true; }}
        onMouseLeave={() => { isHoveringRef.current = false; }}
      >
        <div
          ref={containerRef}
          className="w-full h-full"
          style={{ background: CHART_BG }}
        />

        {/* Marker add popup */}
        {markerPopup && (
          <div
            className="absolute z-50 bg-base-200 border border-surface-200 rounded-lg shadow-lg p-3 flex flex-col gap-2 w-64"
            style={{
              left: Math.min(markerPopup.x + 8, (containerRef.current?.clientWidth ?? 400) - 268),
              top: Math.max(markerPopup.y - 8, 4),
            }}
          >
            <div className="flex items-center gap-1.5 text-xs text-text-subtle font-mono">
              {markerPopup.tsEnd != null
                ? <><AlignCenter size={11} className="text-accent-teal" /> Range marker</>
                : <><MapPin size={11} className="text-accent-teal" /> Point marker</>
              }
              <span className="ml-auto opacity-60">
                {new Date(markerPopup.ts * 1000).toISOString().substr(11, 12)}
                {markerPopup.tsEnd != null && ` – ${new Date(markerPopup.tsEnd * 1000).toISOString().substr(11, 12)}`}
              </span>
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
              <button className="btn btn-primary btn-sm flex-1 text-xs flex items-center gap-1 justify-center" onClick={confirmMarker}>
                <BookmarkPlus size={12} /> Add
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
