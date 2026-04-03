# Workspaces and Export

## Workspaces

Workspaces save the entire session state to a `.crws` file (JSON format with schema versioning):

- All sample data (timestamps + current values)
- Markers and annotations
- App settings (voltage, logging format, time window)
- Device status snapshot

### Save

Click **Save** in the top bar to save the current session. Choose a file location and name.

### Open

Click **Open** to load a previously saved workspace. This replaces the current buffer with the saved data.

### Clear

Click **Clear** to delete all samples from the buffer. This requires a two-click confirmation:
1. First click changes the button to **"Confirm?"** (pulses red)
2. Click again within 3 seconds to confirm, or wait for it to auto-cancel

## Export

### CSV

Exports all samples as a CSV file with columns:
- `timestamp` (unix seconds)
- `amps` (current in amps)
- `voltage_v` (supply voltage, if set)

### JSON

Exports a structured JSON file containing:
- Sample array with timestamps and values
- Markers
- Metadata (export time, sample count)
