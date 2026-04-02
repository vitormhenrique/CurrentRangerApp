#!/usr/bin/env python3
"""
CurrentRanger Real-Time Current Monitor
========================================
GUI tool for visualizing current draw from a LowPowerLab CurrentRanger
over USB serial.

Usage:
    python3 current_ranger_gui.py [--port /dev/cu.usbmodemXXXX]

Requirements:
    pip install pyserial matplotlib
"""

import argparse
import collections
import re
import threading
import time
import traceback
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from datetime import datetime

import serial
import serial.tools.list_ports
import matplotlib

matplotlib.use("TkAgg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.patches import Rectangle
from matplotlib.ticker import FuncFormatter
import numpy as np


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BAUD_RATE = 230400
SERIAL_TIMEOUT = 0.05  # 50ms read timeout
MAX_POINTS = 500000  # rolling buffer (~6 min at 1300 Hz)
MAX_DISPLAY_POINTS = 4000  # downsample to this for plotting
UPDATE_INTERVAL_MS = 50  # GUI refresh rate

# CurrentRanger scientific notation pattern: e.g. "1234E-6"
CR_PATTERN = re.compile(r"^(-?\d+\.?\d*)E([+-]?\d+)\s*$")

# Color palette (dark theme)
BG_COLOR = "#1e1e2e"
FG_COLOR = "#cdd6f4"
ACCENT = "#89b4fa"
ACCENT2 = "#a6e3a1"
GRID_COLOR = "#45475a"
PLOT_BG = "#181825"
TRACE_COLOR = "#89dceb"
AVG_COLOR = "#f9e2af"


def parse_current_ranger_line(line: str) -> float | None:
    """Parse a CurrentRanger serial line, return current in amps."""
    line = line.strip()
    if not line:
        return None
    m = CR_PATTERN.match(line)
    if m:
        mantissa = float(m.group(1))
        exponent = int(m.group(2))
        return mantissa * (10.0 ** exponent)
    try:
        return float(line)
    except ValueError:
        return None


def format_current(amps: float) -> str:
    """Human-readable current string with auto-ranging."""
    a = abs(amps)
    if a >= 1.0:
        return f"{amps:.3f} A"
    elif a >= 1e-3:
        return f"{amps * 1e3:.3f} mA"
    elif a >= 1e-6:
        return f"{amps * 1e6:.3f} uA"
    else:
        return f"{amps * 1e9:.1f} nA"


def smart_axis_formatter(val, _pos):
    """Format Y axis in mA."""
    return f"{val * 1e3:.2f}"


# ---------------------------------------------------------------------------
# Serial reader thread
# ---------------------------------------------------------------------------
class SerialReader(threading.Thread):
    """Background thread that reads CurrentRanger data over serial."""

    def __init__(self, port: str, baud: int = BAUD_RATE):
        super().__init__(daemon=True)
        self.port = port
        self.baud = baud
        self.ser: serial.Serial | None = None
        self.running = False
        self.lock = threading.Lock()
        self.timestamps: collections.deque = collections.deque(maxlen=MAX_POINTS)
        self.currents: collections.deque = collections.deque(maxlen=MAX_POINTS)
        self.error: str | None = None

    def connect(self):
        self.ser = serial.Serial(self.port, self.baud, timeout=SERIAL_TIMEOUT)
        time.sleep(0.2)
        self.ser.reset_input_buffer()
        # 'u' toggles USB logging — if it was already ON (left over from a
        # previous session), toggling turns it OFF. Send 'u', check for data,
        # and send again if nothing arrives.
        self.ser.write(b"u")
        time.sleep(0.3)
        if not self.ser.in_waiting:
            # No data flowing — logging was ON and we just turned it OFF.
            # Toggle again to turn it back ON.
            self.ser.write(b"u")
            time.sleep(0.1)
        self.ser.reset_input_buffer()

    def run(self):
        self.running = True
        try:
            self.connect()
        except Exception as e:
            self.error = str(e)
            self.running = False
            return

        while self.running:
            try:
                raw = self.ser.readline()
                if not raw:
                    continue
                line = raw.decode("ascii", errors="ignore").strip()
                if not line:
                    continue
                value = parse_current_ranger_line(line)
                if value is not None:
                    now = time.time()
                    with self.lock:
                        self.timestamps.append(now)
                        self.currents.append(value)
            except serial.SerialException as e:
                self.error = str(e)
                self.running = False
                break
            except Exception:
                continue

    def stop(self):
        self.running = False
        if self.ser and self.ser.is_open:
            try:
                self.ser.close()
            except Exception:
                pass

    def get_snapshot(self):
        with self.lock:
            return list(self.timestamps), list(self.currents)


# ---------------------------------------------------------------------------
# Main GUI Application
# ---------------------------------------------------------------------------
class CurrentRangerApp:
    def __init__(self, root: tk.Tk, initial_port: str | None = None):
        self.root = root
        self.root.title("CurrentRanger Monitor")
        self.root.geometry("1200x800")
        self.root.configure(bg=BG_COLOR)
        self.root.minsize(900, 600)

        self.reader: SerialReader | None = None
        self.time_window = 30.0  # seconds of visible data
        self.paused = False
        self._paused_ts = None   # snapshot of visible timestamps when paused
        self._paused_cur = None  # snapshot of visible currents when paused

        # Stats
        self.stat_current = tk.StringVar(value="---")
        self.stat_avg = tk.StringVar(value="---")
        self.stat_peak = tk.StringVar(value="---")
        self.stat_min = tk.StringVar(value="---")
        self.stat_samples = tk.StringVar(value="0")
        self.stat_rate = tk.StringVar(value="---")
        self.status_text = tk.StringVar(value="Disconnected")

        # Selection stats
        self.sel_avg = tk.StringVar(value="---")
        self.sel_peak = tk.StringVar(value="---")
        self.sel_min = tk.StringVar(value="---")
        self.sel_samples = tk.StringVar(value="---")
        self.sel_duration = tk.StringVar(value="---")

        self._build_ui(initial_port)
        self._setup_plot()

        # Auto-connect if a port was found (delay lets mainloop + animation start)
        if self.port_var.get():
            self.root.after(500, self._connect)

    # -----------------------------------------------------------------------
    # UI Construction
    # -----------------------------------------------------------------------
    def _build_ui(self, initial_port):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("Dark.TFrame", background=BG_COLOR)
        style.configure("Dark.TLabel", background=BG_COLOR, foreground=FG_COLOR,
                         font=("SF Mono", 11))
        style.configure("Title.TLabel", background=BG_COLOR, foreground=ACCENT,
                         font=("SF Mono", 13, "bold"))
        style.configure("Stat.TLabel", background=BG_COLOR, foreground=ACCENT2,
                         font=("SF Mono", 20, "bold"))
        style.configure("StatSmall.TLabel", background=BG_COLOR, foreground=FG_COLOR,
                         font=("SF Mono", 11))
        style.configure("Dark.TButton", font=("SF Mono", 11))
        style.configure("Dark.TCombobox", font=("SF Mono", 11))
        style.configure("Status.TLabel", background=GRID_COLOR, foreground=FG_COLOR,
                         font=("SF Mono", 10))

        # macOS menu bar
        menubar = tk.Menu(self.root)
        app_menu = tk.Menu(menubar, name="apple", tearoff=0)
        app_menu.add_command(label="About CurrentRanger Monitor",
                             command=lambda: messagebox.showinfo(
                                 "About", "CurrentRanger Monitor\n"
                                 "The Sasquatch Collective LLC\n"
                                 "https://sasq.io"))
        menubar.add_cascade(menu=app_menu)

        file_menu = tk.Menu(menubar, tearoff=0)
        file_menu.add_command(label="Export CSV\u2026",
                              command=self._export_csv)
        file_menu.add_separator()
        file_menu.add_command(label="Quit", command=self.on_close,
                              accelerator="Command+Q")
        menubar.add_cascade(label="File", menu=file_menu)

        self.root.config(menu=menubar)

        # Top toolbar
        toolbar = ttk.Frame(self.root, style="Dark.TFrame")
        toolbar.pack(fill=tk.X, padx=8, pady=(8, 4))

        ttk.Label(toolbar, text="Port:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(0, 4))
        self.port_var = tk.StringVar()
        self.port_combo = ttk.Combobox(toolbar, textvariable=self.port_var, width=25,
                                        style="Dark.TCombobox")
        self.port_combo.pack(side=tk.LEFT, padx=(0, 4))
        self._refresh_ports(initial_port)

        ttk.Button(toolbar, text="Refresh", style="Dark.TButton",
                   command=lambda: self._refresh_ports(None)).pack(side=tk.LEFT, padx=2)

        self.connect_btn = ttk.Button(toolbar, text="Connect", style="Dark.TButton",
                                       command=self._toggle_connect)
        self.connect_btn.pack(side=tk.LEFT, padx=8)

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=8)

        ttk.Label(toolbar, text="Window:", style="Dark.TLabel").pack(side=tk.LEFT, padx=(0, 4))
        self.window_var = tk.StringVar(value="30s")
        self.window_combo = ttk.Combobox(toolbar, textvariable=self.window_var, width=8,
                                          values=["5s", "10s", "30s", "60s", "5m", "All"],
                                          state="readonly", style="Dark.TCombobox")
        self.window_combo.pack(side=tk.LEFT, padx=(0, 8))
        self.window_combo.bind("<<ComboboxSelected>>", self._on_window_change)

        self.pause_btn = ttk.Button(toolbar, text="Pause", style="Dark.TButton",
                                     command=self._toggle_pause)
        self.pause_btn.pack(side=tk.LEFT, padx=2)

        ttk.Button(toolbar, text="Export CSV", style="Dark.TButton",
                   command=self._export_csv).pack(side=tk.LEFT, padx=2)

        ttk.Button(toolbar, text="Clear", style="Dark.TButton",
                   command=self._clear_data).pack(side=tk.LEFT, padx=2)

        # Main content area: plot left, stats right
        content = ttk.Frame(self.root, style="Dark.TFrame")
        content.pack(fill=tk.BOTH, expand=True, padx=8, pady=4)

        self.plot_frame = ttk.Frame(content, style="Dark.TFrame")
        self.plot_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        stats_frame = ttk.Frame(content, style="Dark.TFrame", width=220)
        stats_frame.pack(side=tk.RIGHT, fill=tk.Y, padx=(8, 0))
        stats_frame.pack_propagate(False)

        ttk.Label(stats_frame, text="LIVE STATS", style="Title.TLabel").pack(pady=(8, 12))
        self._make_stat(stats_frame, "Current", self.stat_current, big=True)
        self._make_stat(stats_frame, "Average", self.stat_avg)
        self._make_stat(stats_frame, "Peak", self.stat_peak)
        self._make_stat(stats_frame, "Minimum", self.stat_min)
        self._make_stat(stats_frame, "Samples", self.stat_samples)
        self._make_stat(stats_frame, "Rate", self.stat_rate)

        ttk.Separator(stats_frame, orient=tk.HORIZONTAL).pack(fill=tk.X, padx=8, pady=(4, 8))
        ttk.Label(stats_frame, text="SELECTION", style="Title.TLabel").pack(pady=(0, 8))
        self._make_stat(stats_frame, "Avg", self.sel_avg)
        self._make_stat(stats_frame, "Peak", self.sel_peak)
        self._make_stat(stats_frame, "Min", self.sel_min)
        self._make_stat(stats_frame, "Samples", self.sel_samples)
        self._make_stat(stats_frame, "Duration", self.sel_duration)

        status_bar = ttk.Frame(self.root, style="Dark.TFrame")
        status_bar.pack(fill=tk.X, padx=8, pady=(0, 4))
        ttk.Label(status_bar, textvariable=self.status_text,
                  style="Status.TLabel").pack(fill=tk.X, ipady=2)

    def _make_stat(self, parent, label, var, big=False):
        ttk.Label(parent, text=label, style="Dark.TLabel").pack(anchor=tk.W, padx=8)
        s = "Stat.TLabel" if big else "StatSmall.TLabel"
        ttk.Label(parent, textvariable=var, style=s).pack(anchor=tk.W, padx=16, pady=(0, 12))

    def _refresh_ports(self, preferred):
        ports = serial.tools.list_ports.comports()
        port_names = [p.device for p in ports]
        self.port_combo["values"] = port_names
        if preferred and preferred in port_names:
            self.port_var.set(preferred)
        elif port_names:
            for p in ports:
                if "usbmodem" in p.device.lower() or "currentranger" in (p.description or "").lower():
                    self.port_var.set(p.device)
                    break
            else:
                self.port_var.set(port_names[0])

    # -----------------------------------------------------------------------
    # Plot setup + FuncAnimation
    # -----------------------------------------------------------------------
    def _setup_plot(self):
        self.fig, self.ax = plt.subplots(figsize=(10, 5))
        self.fig.patch.set_facecolor(BG_COLOR)
        self.ax.set_facecolor(PLOT_BG)
        self.ax.tick_params(colors=FG_COLOR, labelsize=9)
        for spine in self.ax.spines.values():
            spine.set_color(GRID_COLOR)
        self.ax.set_xlabel("Time (s)", color=FG_COLOR, fontsize=10)
        self.ax.set_ylabel("Current (mA)", color=FG_COLOR, fontsize=10)
        self.ax.yaxis.set_major_formatter(FuncFormatter(smart_axis_formatter))
        self.ax.grid(True, color=GRID_COLOR, alpha=0.5, linestyle="--", linewidth=0.5)

        self.line_trace, = self.ax.plot([], [], color=TRACE_COLOR, linewidth=0.5,
                                         alpha=0.9, label="Current")
        self.line_avg, = self.ax.plot([], [], color=AVG_COLOR, linewidth=0.8,
                                       linestyle="--", alpha=0.7, label="Running Avg")

        # Selection highlight — persistent patch, toggled via visibility
        self._sel_rect = Rectangle((0, 0), 0, 1, transform=self.ax.get_xaxis_transform(),
                                    alpha=0.25, color=ACCENT, visible=False)
        self.ax.add_patch(self._sel_rect)
        self._sel_start_x = None  # plot-relative x of drag start
        self._sel_last_x = None   # plot-relative x of last mouse move
        self._sel_abs_t0 = None   # absolute timestamp of selection start
        self._sel_abs_t1 = None   # absolute timestamp of selection end
        self._plot_t0 = 0.0       # current plot origin (absolute timestamp)

        self.ax.legend(loc="upper right", fontsize=8, facecolor=PLOT_BG,
                       edgecolor=GRID_COLOR, labelcolor=FG_COLOR)
        self.fig.tight_layout(pad=2)

        self.canvas = FigureCanvasTkAgg(self.fig, master=self.plot_frame)
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)

        # Mouse events for selection and zoom
        self.canvas.mpl_connect("button_press_event", self._on_mouse_press)
        self.canvas.mpl_connect("button_release_event", self._on_mouse_release)
        self.canvas.mpl_connect("motion_notify_event", self._on_mouse_move)
        self.canvas.mpl_connect("scroll_event", self._on_scroll)

        self.canvas.draw()
        self._schedule_update()

    def _schedule_update(self):
        self.root.after(UPDATE_INTERVAL_MS, self._update_plot)

    def _update_plot(self):
        try:
            self._do_animate()
            # Use synchronous draw() instead of draw_idle(). draw_idle()
            # schedules a deferred after_idle callback whose execution can
            # collide with Cocoa menu tracking on macOS, freezing the UI.
            # Synchronous draw completes entirely within this after() callback.
            self.canvas.draw()
        except Exception as e:
            traceback.print_exc()
            self.status_text.set(f"Update error: {e}")
        self._schedule_update()

    def _do_animate(self):
        if not (self.reader and self.reader.running):
            return []

        ts, cur = self.reader.get_snapshot()
        if not cur:
            if self.reader and self.reader.error:
                self.status_text.set(f"Error: {self.reader.error}")
                self._disconnect()
            return []

        if self.paused:
            return self._render_paused()

        # Compute visible window
        if self.time_window > 0 and ts:
            cutoff = ts[-1] - self.time_window
            start_idx = 0
            for i, t in enumerate(ts):
                if t >= cutoff:
                    start_idx = i
                    break
            visible_ts = ts[start_idx:]
            visible_cur = cur[start_idx:]
        else:
            visible_ts = ts
            visible_cur = cur

        if not visible_cur:
            return []

        # Update stats
        now_val = visible_cur[-1]
        avg_val = sum(visible_cur) / len(visible_cur)
        peak_val = max(visible_cur)
        min_val = min(visible_cur)

        self.stat_current.set(format_current(now_val))
        self.stat_avg.set(format_current(avg_val))
        self.stat_peak.set(format_current(peak_val))
        self.stat_min.set(format_current(min_val))
        self.stat_samples.set(str(len(ts)))

        if len(visible_ts) > 1:
            dt = visible_ts[-1] - visible_ts[0]
            if dt > 0:
                self.stat_rate.set(f"{len(visible_ts) / dt:.0f} Hz")

        t0 = visible_ts[0]
        self._plot_t0 = t0
        plot_t = [t - t0 for t in visible_ts]
        plot_c = visible_cur

        self._render_lines(plot_t, plot_c)

        # Set axis limits for live scrolling
        self.ax.set_xlim(plot_t[0], plot_t[-1])
        margin = (peak_val - min_val) * 0.05
        if margin == 0:
            margin = abs(peak_val) * 0.1 or 1e-6
        self.ax.set_ylim(min_val - margin, peak_val + margin)

        # Update live selection
        if self._sel_abs_t0 is not None and self._sel_abs_t1 is not None:
            sx0 = self._sel_abs_t0 - t0
            sx1 = self._sel_abs_t1 - t0
            self._sel_rect.set_x(sx0)
            self._sel_rect.set_width(sx1 - sx0)
            self._sel_rect.set_visible(True)
            self._compute_selection_stats(visible_ts, visible_cur)

        # Check for errors
        if self.reader and self.reader.error:
            self.status_text.set(f"Error: {self.reader.error}")
            self._disconnect()

        return [self.line_trace, self.line_avg]

    def _render_paused(self):
        """Re-render lines from paused snapshot, respecting current viewport."""
        if not self._paused_ts:
            return []

        t0 = self._plot_t0
        xlim = self.ax.get_xlim()
        # Convert xlim (plot-relative) to absolute timestamps
        abs_lo = t0 + xlim[0]
        abs_hi = t0 + xlim[1]

        # Slice snapshot to viewport (with small margin for edge rendering)
        ts = self._paused_ts
        cur = self._paused_cur
        view_t = []
        view_c = []
        for t, c in zip(ts, cur):
            if abs_lo <= t <= abs_hi:
                view_t.append(t - t0)
                view_c.append(c)

        if view_t:
            self._render_lines(view_t, view_c)

        # Selection stats
        if self._sel_abs_t0 is not None and self._sel_abs_t1 is not None:
            self._compute_selection_stats(ts, cur)

        return [self.line_trace, self.line_avg]

    def _render_lines(self, plot_t, plot_c):
        """Downsample and set line data. plot_t/plot_c are the data to render."""
        # Determine max display points from actual plot pixel width.
        # 2x pixels gives one min+max pair per pixel — full envelope fidelity.
        try:
            px_width = self.ax.get_window_extent().width
            max_disp = max(int(px_width) * 2, 500)
        except Exception:
            max_disp = MAX_DISPLAY_POINTS

        n = len(plot_t)
        if n > max_disp:
            arr_t = np.asarray(plot_t)
            arr_c = np.asarray(plot_c)
            bucket_size = n // (max_disp // 2)
            trimmed = (n // bucket_size) * bucket_size
            t_buckets = arr_t[:trimmed].reshape(-1, bucket_size)
            c_buckets = arr_c[:trimmed].reshape(-1, bucket_size)
            idx_min = c_buckets.argmin(axis=1)
            idx_max = c_buckets.argmax(axis=1)
            nbuckets = t_buckets.shape[0]
            arange = np.arange(nbuckets)
            t_lo = t_buckets[arange, idx_min]
            t_hi = t_buckets[arange, idx_max]
            c_lo = c_buckets[arange, idx_min]
            c_hi = c_buckets[arange, idx_max]
            swap = t_lo > t_hi
            disp_t = np.empty(nbuckets * 2)
            disp_c = np.empty(nbuckets * 2)
            disp_t[0::2] = np.where(swap, t_hi, t_lo)
            disp_t[1::2] = np.where(swap, t_lo, t_hi)
            disp_c[0::2] = np.where(swap, c_hi, c_lo)
            disp_c[1::2] = np.where(swap, c_lo, c_hi)
            if trimmed < n:
                disp_t = np.concatenate([disp_t, arr_t[trimmed:]])
                disp_c = np.concatenate([disp_c, arr_c[trimmed:]])
        else:
            disp_t = plot_t
            disp_c = plot_c

        self.line_trace.set_data(disp_t, disp_c)

        # Running average
        if n > 10:
            win = min(50, n // 4) or 1
            kernel = np.ones(win) / win
            avg_full = np.convolve(plot_c, kernel, mode="same")
            if n > max_disp:
                stride = n // max_disp
                self.line_avg.set_data(plot_t[::stride], avg_full[::stride])
            else:
                self.line_avg.set_data(plot_t, avg_full)
        else:
            self.line_avg.set_data([], [])

    # -----------------------------------------------------------------------
    # Connection management
    # -----------------------------------------------------------------------
    def _toggle_connect(self):
        if self.reader and self.reader.running:
            self._disconnect()
        else:
            self._connect()

    def _connect(self):
        port = self.port_var.get()
        if not port:
            messagebox.showerror("Error", "No port selected")
            return
        self.reader = SerialReader(port)
        self.reader.start()
        self.root.after(300, self._check_connection)

    def _check_connection(self):
        if self.reader and self.reader.error:
            messagebox.showerror("Connection Error", self.reader.error)
            self.reader = None
            self.status_text.set("Connection failed")
            return
        if self.reader and self.reader.running:
            self.connect_btn.configure(text="Disconnect")
            self.status_text.set(f"Connected to {self.reader.port}")

    def _disconnect(self):
        if self.reader:
            self.reader.stop()
            self.reader = None
        self.connect_btn.configure(text="Connect")
        self.status_text.set("Disconnected")

    # -----------------------------------------------------------------------
    # Mouse interaction: selection and scroll zoom
    # -----------------------------------------------------------------------
    def _on_mouse_press(self, event):
        if event.inaxes != self.ax or event.button != 1:
            return
        self._sel_start_x = event.xdata
        self._sel_last_x = event.xdata
        self._sel_abs_t0 = None
        self._sel_abs_t1 = None
        self._sel_rect.set_visible(False)
        self._clear_selection_stats()

    def _on_mouse_move(self, event):
        if self._sel_start_x is None or event.xdata is None:
            return
        self._sel_last_x = event.xdata
        x0 = min(self._sel_start_x, self._sel_last_x)
        x1 = max(self._sel_start_x, self._sel_last_x)
        self._sel_rect.set_x(x0)
        self._sel_rect.set_width(x1 - x0)
        self._sel_rect.set_visible(True)
        # No draw call needed — FuncAnimation handles the next redraw

    def _on_mouse_release(self, event):
        if self._sel_start_x is None:
            return
        end_x = self._sel_last_x
        if end_x is None:
            self._sel_start_x = None
            return

        x0 = min(self._sel_start_x, end_x)
        x1 = max(self._sel_start_x, end_x)
        self._sel_start_x = None
        self._sel_last_x = None

        if x1 - x0 < 0.01:
            self._sel_rect.set_visible(False)
            self._clear_selection_stats()
            return

        # Convert plot-relative coords to absolute timestamps
        self._sel_abs_t0 = self._plot_t0 + x0
        self._sel_abs_t1 = self._plot_t0 + x1

    def _compute_selection_stats(self, ts, cur):
        t0, t1 = self._sel_abs_t0, self._sel_abs_t1
        if t0 is None or t1 is None:
            return
        if not ts:
            return
        sel_currents = [c for t, c in zip(ts, cur) if t0 <= t <= t1]
        if not sel_currents:
            self._clear_selection_stats()
            return
        sel_times = [t for t in ts if t0 <= t <= t1]
        avg = sum(sel_currents) / len(sel_currents)
        self.sel_avg.set(format_current(avg))
        self.sel_peak.set(format_current(max(sel_currents)))
        self.sel_min.set(format_current(min(sel_currents)))
        self.sel_samples.set(str(len(sel_currents)))
        duration = sel_times[-1] - sel_times[0] if len(sel_times) > 1 else 0
        self.sel_duration.set(f"{duration:.3f} s")
        self.status_text.set(
            f"Selection: {format_current(avg)} avg "
            f"over {duration:.3f}s ({len(sel_currents)} samples)"
        )

    def _clear_selection_stats(self):
        self._sel_abs_t0 = None
        self._sel_abs_t1 = None
        self._sel_rect.set_visible(False)
        for var in (self.sel_avg, self.sel_peak, self.sel_min,
                    self.sel_samples, self.sel_duration):
            var.set("---")

    def _on_scroll(self, event):
        if event.inaxes != self.ax:
            return
        base_scale = 1.3
        if event.button == "up":
            scale = 1 / base_scale
        elif event.button == "down":
            scale = base_scale
        else:
            return

        xlim = self.ax.get_xlim()
        xdata = event.xdata
        new_xrange = (xlim[1] - xlim[0]) * scale
        self.ax.set_xlim(
            xdata - new_xrange * (xdata - xlim[0]) / (xlim[1] - xlim[0]),
            xdata + new_xrange * (xlim[1] - xdata) / (xlim[1] - xlim[0]),
        )

        if not self.paused:
            self._toggle_pause()

    # -----------------------------------------------------------------------
    # Controls
    # -----------------------------------------------------------------------
    def _on_window_change(self, _event=None):
        val = self.window_var.get()
        mapping = {"5s": 5, "10s": 10, "30s": 30, "60s": 60, "5m": 300, "All": 0}
        self.time_window = mapping.get(val, 30)
        if self.paused:
            self._toggle_pause()
        self._clear_selection_stats()

    def _toggle_pause(self):
        self.paused = not self.paused
        self.pause_btn.configure(text="Resume" if self.paused else "Pause")
        if self.paused and self.reader:
            # Snapshot visible data so selection stats work while paused
            ts, cur = self.reader.get_snapshot()
            if self.time_window > 0 and ts:
                cutoff = ts[-1] - self.time_window
                for i, t in enumerate(ts):
                    if t >= cutoff:
                        ts = ts[i:]
                        cur = cur[i:]
                        break
            self._paused_ts = ts
            self._paused_cur = cur
        elif not self.paused:
            self._paused_ts = None
            self._paused_cur = None

    def _clear_data(self):
        if self.reader:
            with self.reader.lock:
                self.reader.timestamps.clear()
                self.reader.currents.clear()
        self.stat_current.set("---")
        self.stat_avg.set("---")
        self.stat_peak.set("---")
        self.stat_min.set("---")
        self.stat_samples.set("0")

    def _export_csv(self):
        if not self.reader:
            messagebox.showinfo("Export", "No data to export")
            return
        ts, cur = self.reader.get_snapshot()
        if not ts:
            messagebox.showinfo("Export", "No data to export")
            return

        # If a selection is active, export only the selected region
        if self._sel_abs_t0 is not None and self._sel_abs_t1 is not None:
            t0_sel, t1_sel = self._sel_abs_t0, self._sel_abs_t1
            paired = [(t, c) for t, c in zip(ts, cur) if t0_sel <= t <= t1_sel]
            if not paired:
                messagebox.showinfo("Export", "No samples in selection")
                return
            ts, cur = zip(*paired)

        filename = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv")],
            initialfile=f"current_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        )
        if not filename:
            return

        t0 = ts[0]
        with open(filename, "w") as f:
            f.write("time_s,current_a\n")
            for t, c in zip(ts, cur):
                f.write(f"{t - t0:.6f},{c:.12e}\n")
        self.status_text.set(f"Exported {len(ts)} samples to {filename}")

    def on_close(self):
        self._disconnect()
        self.root.quit()
        self.root.destroy()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="CurrentRanger Real-Time Monitor")
    parser.add_argument("--port", "-p", help="Serial port (e.g. /dev/cu.usbmodem1234)")
    args = parser.parse_args()

    root = tk.Tk()
    app = CurrentRangerApp(root, initial_port=args.port)
    root.protocol("WM_DELETE_WINDOW", app.on_close)

    try:
        root.createcommand("tk::mac::Quit", app.on_close)
    except Exception:
        pass

    try:
        root.lift()
        root.attributes("-topmost", True)
        root.after(100, lambda: root.attributes("-topmost", False))
    except Exception:
        pass

    root.mainloop()


if __name__ == "__main__":
    main()
