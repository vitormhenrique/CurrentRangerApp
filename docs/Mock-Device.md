---
layout: default
title: Mock Device
nav_order: 10
---

# Mock Device for Testing

## Overview

The `cr-mock` tool simulates a CurrentRanger R3 device over a virtual serial port (PTY). It responds to all firmware commands identically and generates configurable current waveforms.

## Running

```bash
# From the project root
just mock                      # auto-creates PTY, launches TUI
just mock-port /dev/ttyUSB0    # use a specific serial port
just mock-release              # optimized build
just dev-with-mock             # app + mock in tmux split panes
```

## TUI Controls

The mock runs an interactive terminal UI where you can configure the simulated waveform in real-time.

### Navigation

| Key | Action |
|-----|--------|
| **Tab / Shift+Tab** | Cycle fields: Waveform, Range, Base, Min, Max |
| **Up/Down** | Select waveform or adjust value |
| **Left/Right** | Cycle range (mA/uA/nA) or adjust value |
| **Shift+Up/Down** | 10x larger step for value fields |
| **1-9, 0, a, b** | Quick-select waveform by number |
| **q / Ctrl-C** | Quit |

### Waveforms

| # | Name | Description |
|---|------|-------------|
| 1 | Steady DC | Constant value at base |
| 2 | Sine Wave | 0.5 Hz sine between min and max |
| 3 | Pulse | 1 Hz, 10% duty cycle |
| 4 | Sawtooth | 0.5 Hz ramp from min to max |
| 5 | Brownian Noise | Random walk within min/max |
| 6 | Sleep/Wake | 4-second period: 75% at min, 25% at max |
| 7 | Random | Uniform random per sample |
| 8 | Step Up | Staircase min to max, then reset |
| 9 | Step Down | Staircase max to min, then reset |
| 0 | Step Ping-Pong | Triangle staircase min-max-min |
| a | Exp Decay | Exponential decay from max to min |
| b | Burst | Random short spikes on idle baseline |

### Parameters

- **Range** (mA/uA/nA): Sets the display units and default step sizes
- **Base**: The center/DC value for steady and noise waveforms
- **Min**: Lower bound for waveforms that sweep a range
- **Max**: Upper bound

## How It Works

The mock creates a POSIX pseudo-terminal (PTY) and writes the slave path to `/tmp/cr-mock.port`. The CurrentRanger app reads this file during port enumeration and adds it to the port list as "CurrentRanger Mock".

The mock implements the full firmware serial command protocol, including the USB logging bootstrap handshake.
