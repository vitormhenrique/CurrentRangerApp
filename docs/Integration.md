---
layout: default
title: Charge and Energy Integration
nav_order: 6
---

# Charge and Energy Integration

## Overview

Computes cumulative charge (coulombs, mAh) and energy (joules, mWh) from current measurements using trapezoidal integration over host-side timestamps.

## Data Source

The integration uses:
- **Selection range** (if active) — shown with a `selection` badge next to the title
- **All captured data** (if no selection)

This lets you compute charge/energy for a specific region by drag-selecting it first.

## Voltage Input

Enter the supply voltage (default 3.3V) used to compute energy from current:

```
Energy = Charge x Voltage
```

## How to Use

1. Set the **Voltage** field to your supply voltage
2. Optionally drag-select a time range on the chart
3. Click **Compute Integration**
4. Results appear below:

| Field | Description |
|-------|-------------|
| **Duration** | Time span of the data |
| **Avg Current** | Mean current over the window |
| **Charge (C)** | Total charge in coulombs |
| **Charge (mAh)** | Total charge in milliamp-hours |
| **Energy (J)** | Total energy in joules |
| **Energy (mWh)** | Total energy in milliwatt-hours |
| **Samples** | Number of samples used |

## Limitations

Timestamps are host-side (not from the device). Host scheduling jitter applies.
