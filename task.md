# CurrentRanger Desktop App — Task Tracker

## Architecture Decisions

- **Stack**: Rust + Tauri v2, React + TypeScript + Vite
- **Charting**: uplot (extremely fast for real-time 1M+ point rendering)
- **Styling**: Tailwind CSS (dark-mode first)
- **State**: Zustand (lightweight, composable)
- **Serial crate**: `serialport` (cross-platform, stable)
- **Async**: Tokio in Rust side (Tauri provides the runtime)
- **Workspace format**: JSON with schema version field (human-readable, migrateable)
- **Protocol baud**: 230400 (from firmware constant)
- **Protocol note**: Firmware has no device-side timestamps; host timestamps all samples.
  Autorange transitions are silent in the EXPONENT format — the format itself carries the unit.

## Protocol Quick Reference (from firmware CR_R3.ino)

| Command | Effect |
|---------|--------|
| `u` | Toggle USB logging on/off |
| `U` | Query USB logging state |
| `b` | Toggle BT logging on/off |
| `f` | Cycle logging format: EXPONENT→NANOS→MICROS→MILLIS→ADC |
| `s` | Cycle ADC sampling speed: AVG→FAST→SLOW |
| `S` | Query ADC sampling speed |
| `a` | Cycle auto-off: DEFAULT(600s)→DISABLED→SMART |
| `1` | Force mA range |
| `2` | Force µA range |
| `3` | Force nA range |
| `4` | Toggle LPF |
| `5` | Toggle BIAS/bidirectional |
| `6` | Toggle autoranging |
| `g` | Toggle GPIO range indication |
| `t` | Toggle touch debug |
| `r` | Reboot to bootloader |
| `+` | Gain correction +1 |
| `-` | Gain correction -1 |
| `*` | Offset correction +1 |
| `/` | Offset correction -1 |
| `<` | LDO calibration -1mV |
| `>` | LDO calibration +1mV |
| `!` | Reset all runtime settings |
| `?` | Print menu + calibration info |

### Logging Formats
- **EXPONENT** (default): `<mantissa>E<exponent>` → amps. e.g. `1234E-6` = 1.234 mA
- **NANOS**: raw integer nA value
- **MICROS**: raw integer µA value  
- **MILLIS**: raw integer mA value
- **ADC**: raw 12-bit ADC count (0–4095)

### Device Responses (non-data lines)
`USB_LOGGING_ENABLED`, `USB_LOGGING_DISABLED`, `BT_LOGGING_ENABLED`, etc.
`ADC_SAMPLING_SPEED_AVG/FAST/SLOW`, `LOGGING_FORMAT_EXPONENT/NANOS/MICROS/MILLIS/ADC`
`AUTOOFF_DEFAULT/DISABLED/SMART`, `CurrentRanger R3 (firmware v. X.X.X)`, `SETTINGS_RESET`

---

## Task List

### Phase 1 — Project Bootstrap
- [x] DONE — Fetch and study firmware + Python GUI reference
- [x] DONE — Create task.md
- [x] DONE — Create justfile
- [x] DONE — Create README
- [x] DONE — Create Tauri project skeleton (Cargo.toml, package.json, Vite config)
- [x] DONE — Create Rust module structure
- [x] DONE — Create frontend component stubs

### Phase 2 — Serial / Device Layer (Rust)
- [x] DONE — Port discovery command
- [x] DONE — Serial connection state machine (connect/disconnect/reconnect)
- [x] DONE — Background serial reader thread (tokio task)
- [x] DONE — Protocol parser (EXPONENT, NANOS, MICROS, MILLIS, ADC formats)
- [x] DONE — Device status/settings struct and parser
- [x] DONE — Tauri event emitter for samples + status messages
- [x] DONE — Commands: send_command, get_ports, connect, disconnect

### Phase 3 — Data Model & Integration
- [x] DONE — Sample store (ring buffer, thread-safe)
- [x] DONE — Charge integration (coulombs, mAh, Ah)
- [x] DONE — Energy integration (joules, Wh, mWh) with user voltage
- [x] DONE — Stats: min/max/avg/rate for visible window and selection
- [x] DONE — Unit conversion helpers

### Phase 4 — Frontend Core
- [x] DONE — App shell with dark theme + panel layout
- [x] DONE — Device panel (port select, connect/disconnect, command buttons)
- [x] DONE — Live uplot chart with scrolling, zoom, pan, cursor
- [x] DONE — Pause/resume view
- [x] DONE — Stats panel (live + selection stats)
- [x] DONE — Zustand store for all frontend state

### Phase 5 — Markers & Annotations
- [x] DONE — Marker data model (timestamp, label, color, category, note)
- [x] DONE — Add/edit/delete markers from UI
- [x] DONE — Markers rendered on chart (vertical lines)
- [x] DONE — Marker list panel

### Phase 6 — Battery Tools
- [x] DONE — Runtime estimator (capacity → estimated runtime)
- [x] DONE — Required capacity estimator (desired runtime → capacity)
- [x] DONE — Derating inputs (efficiency, DoD, aging margin)
- [x] DONE — Results UI

### Phase 7 — Workspace Persistence
- [x] DONE — Workspace data model (versioned JSON)
- [x] DONE — Save workspace (atomic write)
- [x] DONE — Load workspace (with migration hooks)
- [x] DONE — Workspace panel in UI

### Phase 8 — Export
- [x] DONE — CSV export (time, current, unit columns)
- [x] DONE — JSON export (structured with metadata)
- [x] DONE — Annotation/marker export
- [x] DONE — Export UI in toolbar

### Phase 9 — Testing
- [x] DONE — Parser unit tests
- [x] DONE — Integration math tests
- [x] DONE — Battery math tests
- [x] DONE — Workspace round-trip tests

### Phase 10 — Polish
- [ ] TODO — Connection health indicator (last sample age)
- [ ] TODO — Error recovery on serial disconnect
- [ ] TODO — Light mode support
- [ ] TODO — Keyboard shortcuts
- [ ] TODO — Tooltip polish

---

## Known Limitations (stock firmware)

1. **No device-side timestamps** — all timestamps are host-side. Jitter from host scheduling applies.
2. **Silent autorange transitions** — in EXPONENT format, range changes are encoded in the exponent. No explicit "now in µA range" message.
3. **USB logging must be explicitly enabled** — send `u` to toggle; app handles this automatically on connect.
4. **Bluetooth via HC-06** — separate UART, not relevant to USB connection.
5. **ADC format** requires knowing current range to convert to amps — avoided in default EXPONENT mode.
6. **Calibration commands (`+`,`-`,`*`,`/`,`<`,`>`)** persist to EEPROM — app warns before sending.
