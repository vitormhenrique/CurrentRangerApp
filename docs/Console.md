---
layout: default
title: Console
nav_order: 9
---

# Console

The **Console** tab provides a real-time log viewer for all application events. It is available in both development and production builds and is useful for troubleshooting connection issues, verifying device communication, and understanding the internal event flow.

## Opening the Console

Click the **Console** tab in the top navigation bar (next to Monitor and Device Config).

## Log Levels

Every log entry has a severity level. Use the level filter buttons in the toolbar to show or hide each level:

| Level | Color | Description |
|-------|-------|-------------|
| **DEBUG** | Grey | Verbose internal details (API calls, status payloads, chart lifecycle) |
| **INFO** | Blue | Normal operational events (connection, port discovery, USB logging state) |
| **WARN** | Yellow | Non-fatal issues (unsorted timestamps, bootstrap timeouts) |
| **ERROR** | Red | Failures (serial errors, command errors, connection failures) |

## Log Sources

Each entry is tagged with a source that identifies the subsystem that produced it:

| Source | What it covers |
|--------|---------------|
| `app` | Application lifecycle, port discovery, event listener wiring |
| `serial` | Connection status changes, device status updates, USB logging state |
| `api` | All Tauri command invocations (connect, disconnect, send command, etc.) |
| `DevicePanel` | Port refresh, connect/disconnect, command sends, USB logging toggle |
| `DeviceConfig` | Device configuration commands (range, toggle, calibration, reset) |
| `Workspace` | Save, load, CSV/JSON export |
| `LiveChart` | Chart initialisation, destroy, timestamp sorting |
| `Integration` | Charge/energy integration runs |
| `BatteryTools` | Battery runtime/capacity estimation runs |

Use the **source filter** text input to narrow the view to a specific subsystem (e.g. type `serial` to see only connection-related events).

## Toolbar Controls

| Control | Description |
|---------|-------------|
| **Level buttons** (DEBUG, INFO, WARN, ERROR) | Toggle visibility of each log level |
| **Source filter** | Free-text filter on the source column (with autocomplete) |
| **Entry count** | Shows `filtered / total` log entries |
| **Auto-scroll** (arrow icon) | When active, the list automatically scrolls to the latest entry. Scrolling up pauses auto-scroll; scrolling back to the bottom re-enables it. |
| **Copy** | Copies all currently visible (filtered) log entries to the clipboard as formatted text |
| **Clear** | Removes all log entries from the buffer |

## Log Buffer

The console keeps the most recent **2,000 log entries** in a ring buffer. Older entries are automatically discarded as new ones arrive. Clearing the console removes all entries.

## Typical Troubleshooting Workflows

### Connection issues

1. Filter by source `serial` or `api`
2. Attempt to connect
3. Look for error-level entries revealing the failure reason (port busy, permission denied, timeout, etc.)

### USB logging not starting

1. Filter by source `serial`
2. Look for bootstrap messages: `Bootstrap: got USB_LOGGING_ENABLED` or `Bootstrap: no response to 'U' query`
3. Check if USB logging state changes are being received from the device

### Data not appearing on chart

1. Check for `serial` source INFO entries confirming data flow
2. Look for WARN entries about unsorted timestamps
3. Verify the device status shows `usbLogging: true`
