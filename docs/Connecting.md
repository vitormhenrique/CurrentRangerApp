# Connecting to a Device

## Auto-Detection

On launch, the app scans serial ports and auto-selects the most likely CurrentRanger device based on:

- Port description containing "CurrentRanger"
- Adafruit USB Vendor ID (`0x239A`)
- macOS port names containing `usbmodem` or `cu.usb`
- Linux port names containing `ttyACM` or `ttyUSB`

Click the **refresh** button next to the port dropdown to re-scan.

## Manual Selection

Use the port dropdown to select any available serial port. The baud rate defaults to **230,400** (the firmware's default) but can be changed if needed.

## Connect / Disconnect

Click **Connect** to open the serial connection. The app will:

1. Open the serial port
2. Query the USB logging state (`U` command)
3. Enable USB logging if it's off (`u` command)
4. Query device info (`?` command) to populate the config panel
5. Begin streaming data to the chart

Click **Disconnect** to close the connection. Data already captured remains in the buffer.

## Reconnecting

When you reconnect, a gap is automatically inserted in the chart data so that lines from different sessions are not connected. The chart also auto-resumes.

## Status Badges

When connected, the left panel shows status badges:

| Badge | Meaning |
|-------|---------|
| **STREAM** (green) | USB logging on, chart running |
| **PAUSED** (yellow) | USB logging on, chart paused |
| **USB off** (dim) | USB logging disabled |
| **AUTO / MAN** | Autoranging on/off |
| **LPF** | Low-pass filter state |
| **BIAS** | Bidirectional mode state |
| **EXPONENT** | Current logging format |
