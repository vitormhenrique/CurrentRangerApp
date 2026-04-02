# CurrentRanger GUI

Real-time current monitoring GUI for the [LowPowerLab CurrentRanger](https://lowpowerlab.com/guide/currentranger/) USB precision current meter.

Connects over USB serial, parses the CurrentRanger's scientific notation output, and plots current draw in real time with a dark-themed Tk/Matplotlib interface.

<img width="1196" height="813" alt="image" src="https://github.com/user-attachments/assets/4f0720e0-f1db-4f39-af8b-4550e515cac5" />

<img width="1190" height="812" alt="image" src="https://github.com/user-attachments/assets/06385c00-1189-4063-b0cc-762d8700d793" />


## Features

- Auto-detects CurrentRanger serial port
- Real-time scrolling plot at ~1300 Hz sample rate
- Live stats: current, average, peak, minimum, sample count, sample rate
- Click-and-drag selection for stats on a region of the trace
- Scroll to zoom, pause to inspect
- Adjustable time window (5s, 10s, 30s, 60s, 5m, all)
- Export to CSV (full buffer, or just the selected region)
- Min/max envelope downsampling for smooth rendering of large datasets

## Requirements

- Python 3.10+
- A [LowPowerLab CurrentRanger](https://lowpowerlab.com/guide/currentranger/) connected via USB

## Install

```bash
pip install -r requirements.txt
```

## Usage

```bash
python current_ranger_gui.py
```

To specify a serial port manually:

```bash
python current_ranger_gui.py --port /dev/cu.usbmodem1234
```

## Platform support

Only tested on macOS. It should work on Linux and Windows, but the UI font (SF Mono) will fall back to a system default, and auto-detection of the serial port is tuned for macOS device names. You can always specify the port manually with `--port`.

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 [The Sasquatch Collective LLC](https://sasq.io)
